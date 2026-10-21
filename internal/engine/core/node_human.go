package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// node_human.go 是『办理/ 审批』两类人工节点共用的到达行为（经运行期注册表登记）。办理与审批的到达派发完全一样（算候选 → 建步骤 → 建任务 → 通知），只有任务种类
// 不同（任务中心据此显示「办理 / 审批」），所以两类节点共用同一个 arriveHuman，靠
// traitsOf(kind).TaskKind 分出任务种类，不必各写一份。
//
// 「允许哪几档回退」两类节点走不同的配置来源（办理读节点上勾选的清单，审批由按钮清单反推），
// 各自登记一个 backMethods。

// arriveHuman 到达办理 / 审批节点：
//   - F 自动办理：条件为真且出线恰一条成立时，本步不派人由系统直接往后推；
//   - 算候选（宿主 CandidateService）：0 人 NoCandidate；>1 人无选择 AssigneeChoiceRequired；
//     选择不在候选内 INVALID_CHOICE；
//   - 新建步骤（ACTIVE）与每人一条待办，逐任务追加通知。
func arriveHuman(e *Engine, ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor, seq int32) (*arrival, error) {
	now := e.now()
	// 回退到达的节点即使配了自动办理也不触发，按人工走 C——否则「请前面的人重做」会被
	// 系统一脚踩过去，回退等于没回。
	if !to.Returned {
		if a, handled, aerr := e.tryAutoHandle(ctx, l, b, inst, from, target, to, submitter, seq); aerr != nil {
			return nil, aerr
		} else if handled {
			return a, nil
		}
	}
	// 前手= 最近一个人工步骤实际办过的所有人；自动步骤没有人，继续往前找。多人办理
	// 时是那一步办过的全部人，不只是踩下过关那一脚的提交人（A3 要求逐个为基准算再取并集）。
	// 找不到（发起后的第一站）时回落到本次提交人，他就是发起人。
	prev := to.PrevActors
	if len(prev) == 0 {
		prev = previousHumanActors(l, b, from.GetStepId(), []int64{submitter.UserID})
	}
	// 来源里配了「发起人」档的话，把实例发起人并入静态用户 id 清单——宿主候选计算协议
	// 没有这一档，运行期在这里就地取值（initiator_source.go）。
	staticUserIDs := withInitiatorSource(target.StaticUserIDs, target.SourcesJSON, inst.GetStarterUserId())
	// 先按来源算候选，配了过滤器（RelationFilters 非空）再筛一道只留下满足关系的人；
	// 旧编译产物没有过滤器，这一步直接短路、按旧语义处理（relation_filter.go）。
	people, err := resolveCandidatesFiltered(ctx, e.Candidate, l.rec, target, staticUserIDs, prev, "candidates")
	if err != nil {
		return nil, err
	}
	if len(people) == 0 {
		return &arrival{outcome: &Outcome{Kind: OutcomeNoCandidate, Saved: true, NodeID: target.NodeID, NodeName: target.NodeName}}, nil
	}
	// 选择项先去重（同一人不生成两条待办、assignee_count 不虚增）；只要带了选择，
	// 哪怕候选只有一人也必须是候选子集（不再静默忽略）；多候选无选择才弹选人框。
	selected := uniqInt64(to.Choices.SelectedAssignees)
	chosen := people
	// F3 上一步是系统自动办理的，没有人在现场可以弹框，默认选中全部候选（selected 留空即
	// chosen = people）。
	if len(people) > 1 && len(selected) == 0 && !to.AutoSelectAll {
		return &arrival{outcome: &Outcome{Kind: OutcomeAssigneeChoiceRequired, NodeID: target.NodeID, NodeName: target.NodeName, ViaLinkID: to.ViaLinkID, Candidates: people}}, nil
	}
	if len(selected) > 0 {
		byID := map[int64]ports.Person{}
		for _, p := range people {
			byID[p.UserID] = p
		}
		chosen = nil
		for _, id := range selected {
			p, ok := byID[id]
			if !ok {
				return nil, errf("INVALID_CHOICE", "user %d is not a candidate of node %s", id, target.NodeID)
			}
			chosen = append(chosen, p)
		}
	}
	summary, err := e.summaryFor(ctx, l, target, submitter)
	if err != nil {
		return nil, err
	}
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), SeqNo: seq, NodeId: target.NodeID, NodeKind: target.NodeKind, NodeName: target.NodeName,
		Status: string(model.StepStatusActive), EnteredByUserId: submitter.UserID, EnteredAt: now, SummaryText: summary,
		PassRule: target.PassRule, PassRatio: target.PassRatio, AssigneeCount: int32(len(chosen)),
	}
	if from != nil {
		step.EnteredFromStepId = from.GetStepId()
	}
	// 任务种类由静态特征表给出（办理 / 审批的派发完全一样，只有这一处不同）。
	taskKind := string(traitsOf(target.KindOf()).TaskKind)
	var tasks []*pb.TaskRow
	for _, p := range chosen {
		tasks = append(tasks, &pb.TaskRow{
			TaskId: e.IDs.New("task"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: step.StepId, DefinitionId: inst.GetDefinitionId(), RecordId: inst.GetRecordId(),
			TaskKind: taskKind, AssigneeUserId: p.UserID, Status: string(model.TaskStatusPending), Title: summary, PendingSince: now,
		})
	}
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, target.NodeID, target.NodeName
	inst.LastActionAt = now
	b.step(step)
	for _, t := range tasks {
		b.task(t)
	}
	b.outbox(model.OutboxStepArrived, l.agg, inst, tasks)
	// 逐任务追加 NOTIFY，收件人 = 该任务办理人。回退到达发「被回退」（读到达节点的
	// on_returned 开关），正常流转发「收到任务」（读到达节点的 on_assigned 开关）——同一批人
	// 只发一条。开关与渠道在节点级，读的是 target（到达的那个节点）的
	// NodeCompiled.Notify()，不看 l.compiled.Notify。
	notify := target.Notify()
	event, key := model.NotifyTaskAssigned, model.NotifyKeyAssigned
	if to.Returned {
		event, key = model.NotifyTaskReturned, model.NotifyKeyReturned
	}
	if notify.Enabled(key) {
		channels := notify.ChannelsOrDefault()
		for _, t := range tasks {
			b.notify(event, inst, []int64{t.GetAssigneeUserId()}, t.GetTaskId(), summary, target.NodeName, channels)
		}
	}
	return &arrival{step: step, tasks: tasks}, nil
}

// backMethodsHandle 办理节点「允许哪几档回退」：读节点上勾选的清单。
func backMethodsHandle(nc *compile.NodeCompiled) []model.WithdrawMethod {
	var allowed []model.WithdrawMethod
	if nc.AllowedWithdrawsJSON != "" {
		_ = json.Unmarshal([]byte(nc.AllowedWithdrawsJSON), &allowed)
	}
	seen := map[model.WithdrawMethod]bool{}
	for _, m := range allowed {
		seen[m] = true
	}
	return orderBackMethods(seen)
}

// backMethodsApprove 审批节点「允许哪几档回退」：不另配清单，由按钮清单反推——配了对应动作
// 的按钮即那一档允许。
func backMethodsApprove(nc *compile.NodeCompiled) []model.WithdrawMethod {
	var buttons []model.ApprovalButton
	if nc.ApproveButtonsJSON != "" {
		_ = json.Unmarshal([]byte(nc.ApproveButtonsJSON), &buttons)
	}
	seen := map[model.WithdrawMethod]bool{}
	for _, btn := range buttons {
		seen[model.BackMethodOfButton(btn.Action)] = true
	}
	return orderBackMethods(seen)
}

// orderBackMethods 把「允许哪几档」的集合按固定顺序（上一步 / 发起人 / 指定步骤）展开，
// 不随按钮或清单的书写顺序漂——预告（Preview）与真正执行要看到同一份顺序。
func orderBackMethods(seen map[model.WithdrawMethod]bool) []model.WithdrawMethod {
	var out []model.WithdrawMethod
	for _, m := range []model.WithdrawMethod{model.WithdrawMethodPreviousStep, model.WithdrawMethodInitiator, model.WithdrawMethodSpecified} {
		if seen[m] {
			out = append(out, m)
		}
	}
	return out
}

// init 登记办理与审批两类节点的运行期行为：到达共用 arriveHuman，回退档各自的来源不同。
func init() {
	registerRuntime(model.NodeKindHandle, kindRuntime{arrive: arriveHuman, backMethods: backMethodsHandle})
	registerRuntime(model.NodeKindApprove, kindRuntime{arrive: arriveHuman, backMethods: backMethodsApprove})
}
