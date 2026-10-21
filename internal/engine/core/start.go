package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// StartInput 发起入参。Existing 非 nil 表示该单据已有实例（P1 拒绝）。
type StartInput struct {
	AppID      string
	Definition *pb.DefinitionRow
	Version    *pb.DefinitionVersionRow // 最新已发布版本；nil = 从未发布
	Existing   *pb.InstanceAggregate
	Record     ports.RecordRef
	Actor      ports.Actor
	StartKind  model.StartKind
	Choices    Choices
	// WorkflowInstanceID 预分配的实例 ID：app 层在读单据头之前先分配，使发起路径上经宿主
	// Record 的读取也能带上实例 ID（实例尚未落库，宿主按单据反查归属）；为空时本函数自行分配。
	WorkflowInstanceID string
}

// Start 发起（T1：N1.5 / N1.7 / DV1 / DV4 / DV5 / P1 / L2 / C1～C4 / H）：
//   - 定义停用 → DEFINITION_DISABLED；无已发布版本 → DEFINITION_NOT_PUBLISHED；单据已有实例 → RECORD_ALREADY_HAS_INSTANCE；
//   - 发起条件不满足 → 不建实例，NoRoute{saved:false}（与 N1.4 同一回传口径）；求值报错 → ROUTE_EVAL_FAILED；
//     子流程发起不求值发起条件；
//   - 建实例（绑定最新版本）、发起步骤、发起任务（即建即完成 N1.5），对发起节点主线出线求路；
//   - 零命中 → 不建实例，NoRoute{saved:false}；多命中无选择 → RouteChoiceRequired（不落库）；
//   - 到达下一站：候选空 → 实例仍建、发起任务转暂存；多候选无选择 → AssigneeChoiceRequired（不落库）。
func (e *Engine) Start(ctx context.Context, in StartInput) (*Decision, error) {
	if in.Definition == nil {
		return nil, errf("NOT_FOUND", "definition not found")
	}
	if in.Definition.GetStatusCode() != string(model.DefinitionStatusEnabled) {
		return nil, errf("DEFINITION_DISABLED", "definition %s is disabled", in.Definition.GetDefinitionId())
	}
	if in.Version == nil || in.Version.GetVersionNo() <= 0 {
		return nil, errf("DEFINITION_NOT_PUBLISHED", "definition %s has no published version", in.Definition.GetDefinitionId())
	}
	if in.Existing != nil && in.Existing.GetInstance() != nil {
		return nil, errf("RECORD_ALREADY_HAS_INSTANCE", "record %s already has instance %s", in.Record.RecordID, in.Existing.GetInstance().GetWorkflowInstanceId())
	}
	if in.StartKind == "" {
		in.StartKind = model.StartKindManual
	}
	compiled, err := compile.Decode([]byte(in.Version.GetCompiledJson()))
	if err != nil {
		return nil, errf("SYSTEM_ERROR", "compiled_json invalid: %v", err)
	}
	now := e.now()
	instanceID := in.WorkflowInstanceID
	if instanceID == "" {
		instanceID = e.IDs.New("inst")
	}
	inst := &pb.InstanceRow{
		WorkflowInstanceId: instanceID, DefinitionId: in.Definition.GetDefinitionId(), VersionId: in.Version.GetVersionId(), VersionNo: in.Version.GetVersionNo(),
		TemplateId: in.Record.TemplateID, RecordId: in.Record.RecordID, Status: string(model.InstanceStatusRunning), StartKind: string(in.StartKind),
		StarterUserId: in.Actor.UserID, LastActionAt: now,
	}
	startNode := compiled.Node(compiled.StartNodeID)
	if startNode == nil {
		return nil, errf("SYSTEM_ERROR", "compiled definition has no start node")
	}
	// 发起节点关闭了「允许人工发起」时，只许非人工通道（动作 / 子流程）发起；
	// 人工发起入口（宿主网关的三处界面）一律被拒。是否人工由调用方传入的 StartKind 决定——
	// 引擎不猜、不看谁在调用，只认这一个标志（子流程发起走 StartKindSubflow，天然放行）。
	if in.StartKind == model.StartKindManual && !startNode.AllowManualStart {
		return nil, errf("DEFINITION_MANUAL_START_DISABLED", "definition %s has manual start disabled", in.Definition.GetDefinitionId())
	}
	rec := in.Record
	rec.AppID = in.AppID
	rec.WorkflowInstanceID = inst.WorkflowInstanceId // 发起路径上的单据读取同样带实例 ID
	// 发起条件在建实例前求值一次，人工发起与动作发起一视同仁；**子流程发起不受发起条件
	// 限制**——要不要发起子流程由父流程的设计者在父流程里决定，目标
	// 流程自己的发起条件只约束「有人来发起它」的场合，与 N1.3「允许人工发起」对子流程不生效是
	// 同一个道理。此前三种发起一视同仁，子流程因此发不起来会把父流程停驻。
	// 没配条件（PubID 与 DocJSON 都空）直接放行。
	if in.StartKind != model.StartKindSubflow && (startNode.StartConditionPubID != "" || startNode.StartConditionDocJSON != "") {
		ok, err := e.Expr.EvaluateCondition(ctx, rec, startNode.StartConditionPubID, startNode.StartConditionDocJSON, in.Actor)
		if err != nil {
			// 求值本身报错不按「不满足」处理（同 L12 引导线条件求值报错口径：提交失败并提示，
			// 不是「无路可走」那种暂存/停表单）。复用 ROUTE_EVAL_FAILED——两者语义都是「闸门/
			// 引导线条件运行期算不出结果」，宿主网关已有该码到 409 + 固定提示文案的映射，不必
			// 为此新增错误码（也避免了新增 gRPC WorkflowErrorCode 枚举值）。
			return nil, errf("ROUTE_EVAL_FAILED", "start condition of node %s: %v", startNode.NodeID, err)
		}
		if !ok {
			// N1.7 不满足：与 N1.4「无路可走」同一口径回传——不建实例、不落库，Hint 是设计者写的
			// 「不满足发起条件时的提示」，绝不透出表达式原文；发起条件只是闸门，不参与「用哪条
			// 流程」的选择，所以这里直接拒绝这次发起，不去尝试路由或换一条流程。子流程发起
			// 走不到这里（上面按 StartKind 整段跳过）。
			return &Decision{Outcome: Outcome{Kind: OutcomeNoRoute, Hint: startNode.StartConditionHint, Saved: false}}, nil
		}
	}
	summary, err := e.startStepSummary(ctx, rec, compiled, in.Version, in.Actor)
	if err != nil {
		return nil, err
	}
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.WorkflowInstanceId, SeqNo: 1, NodeId: startNode.NodeID, NodeKind: startNode.NodeKind, NodeName: startNode.NodeName,
		Status: string(model.StepStatusActive), EnteredByUserId: in.Actor.UserID, EnteredAt: now, SummaryText: summary, PassRule: string(model.PassRuleAny), PassRatio: 100, AssigneeCount: 1,
	}
	task := &pb.TaskRow{
		TaskId: e.IDs.New("task"), WorkflowInstanceId: inst.WorkflowInstanceId, StepId: step.StepId, DefinitionId: inst.DefinitionId, RecordId: inst.RecordId,
		TaskKind: string(model.TaskKindStart), AssigneeUserId: in.Actor.UserID, Status: string(model.TaskStatusDone), Title: summary, PendingSince: now, DoneAt: now, ActionCode: string(model.TaskActionSubmit),
	}
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, startNode.NodeID, startNode.NodeName

	// 合成一份聚合供选路 / 到达用（新实例账本里还没有）。
	l := &loaded{agg: &pb.InstanceAggregate{Instance: inst, Steps: []*pb.StepRow{step}, Tasks: []*pb.TaskRow{task}, Version: in.Version}, compiled: compiled, rec: rec}

	chosen, outcome, err := e.route(ctx, l, startNode.NodeID, in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	if outcome != nil {
		if outcome.Kind == OutcomeNoRoute {
			outcome.Saved = false // 发起零命中：不发起、停在表单
		}
		return &Decision{Outcome: *outcome}, nil
	}
	b := newCS()
	b.instance(inst, 0)
	b.outbox(model.OutboxInstanceStarted, l.agg, inst, []*pb.TaskRow{task})
	step.Status, step.ClosedAt, step.Outcome, step.RouteLinkId, step.PassedCount = string(model.StepStatusPassed), now, string(model.StepOutcomeSubmitted), chosen.LinkID, 1
	b.step(step)
	b.task(task)
	// 子流程是随上一步办理人的提交在后台发起的，没有界面让人选办理人——第一站
	// 算出多个候选时直接选中全部候选、各派一条待办，不指定给其中某一个人，也不再回
	// AssigneeChoiceRequired 让父流程停驻（与 F3 自动办理之后、等待档回推两处无人在场同一口径）。
	// 人工发起 / 动作发起照旧弹选人框。
	a, err := e.arrive(ctx, l, b, inst, step, arriveTarget{NodeID: chosen.ToNodeID, ViaLinkID: chosen.LinkID, AutoSelectAll: in.StartKind == model.StartKindSubflow}, in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	if a.outcome != nil {
		switch a.outcome.Kind {
		case OutcomeAssigneeChoiceRequired:
			return &Decision{Outcome: *a.outcome}, nil
		case OutcomeNoCandidate:
			// 下一站零候选——新开一包干净的变更集，把实例整个重置回发起站（与 submit.go
			// parkSubmitter 同一口径），不沿用 b 里已经积累的自动办理步骤／发件箱：那些步骤
			// 到达前虽然建了，但流程终究没有真的停在那儿，落库会让流转明细凭空多出一段从未
			// 发生过的自动办理记录。发起步骤回到 ACTIVE、发起任务回到 SAVED，
			// instance.current_step_id 指回发起步——只把步骤状态改回 ACTIVE 而不把这个指针从
			// 自动步骤那儿指回来，单令牌自检必打红，整个发起报 SYSTEM_ERROR。
			step.Status, step.ClosedAt, step.Outcome, step.RouteLinkId, step.PassedCount = string(model.StepStatusActive), nil, "", "", 0
			task.Status, task.DoneAt, task.ActionCode = string(model.TaskStatusSaved), nil, ""
			inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, startNode.NodeID, startNode.NodeName
			inst.LastActionAt = now
			nb := newCS()
			nb.instance(inst, 0)
			nb.step(step)
			nb.task(task)
			nb.outbox(model.OutboxInstanceStarted, l.agg, inst, []*pb.TaskRow{task})
			nb.outbox(model.OutboxTaskSaved, l.agg, inst, []*pb.TaskRow{task})
			d := &Decision{Changeset: nb.cs, Outcome: *a.outcome, instance: inst}
			if err := checkInvariant(nb, l.agg); err != nil {
				return nil, err
			}
			return d, nil
		}
	}
	d := &Decision{Changeset: b.cs, PendingEndWrite: a.endWrite, instance: inst, tasks: a.tasks,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.WorkflowInstanceId, StepID: inst.CurrentStepId, Status: inst.Status, EndLabel: inst.EndLabel}}
	if a.ended {
		d.Outcome.StepID = a.step.GetStepId()
	}
	// 发起后第一跳就落在子流程节点时不能丢——其余动作（提交 / 回退 / 按钮）都已经在各自
	// 文件里挂了这一行，发起是最后一处没挂的（见 subflow.go 头注释）。
	d.PendingSubflowStarts = appendStarts(a.subflowStarts, nil)
	if a.outcome != nil {
		d.Outcome = *a.outcome // F6 自动办理链超长：实例已停驻（发起时直接命中同样如实报停驻，带上 incident_id），不是「已提交」
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return d, nil
}
