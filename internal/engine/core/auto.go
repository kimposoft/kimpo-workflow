package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/observability"
)

// auto.go 是『自动办理』的唯一实现。办理与审批节点可以配一条判断表达式：流程到达时
// 先求值，为真就不派给人，由系统直接把流程往后推一站。
//
// 三条容易做反的地方，都在下面各自的注释里写清了为什么：
//   - F4 / F5 停止自动办理时**不能**留下一条自动步骤：那一步最终是人在办，账本上必须是人工步骤；
//   - F6 的上限是防死循环（两个自动节点互指），所以计数只能按「本次流转连续自动了几步」算，
//     不是按实例历史上自动过几步算；
//   - F7 求值报错按假处理并继续（记 warn），不是让提交失败——自动办理是省事的，不是必须的。

// autoChainLimit 一次流转里连续自动办理步骤的上限（20 步）。
const autoChainLimit = 20

// tryAutoHandle 尝试对到达的办理 / 审批节点做自动办理。
//
// 返回 (arrival, handled, err)：handled=false 表示这一站按人工走，调用方
// 继续原来的选人派发；handled=true 表示自动办理已经把流程推到了后面某一站（或按 F6 停驻）。
func (e *Engine) tryAutoHandle(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor, seq int32) (*arrival, bool, error) {
	if target.AutoConditionPubID == "" && target.AutoConditionDocJSON == "" {
		return nil, false, nil // F1 条件不填：人工
	}
	ok, err := e.Expr.EvaluateCondition(ctx, l.rec, target.AutoConditionPubID, target.AutoConditionDocJSON, submitter)
	if err != nil {
		// F7 求值报错视为假、改人工、记 warn、流程不停——自动办理是为了省事，不该因为它挂掉整条流程。
		observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.auto_condition_failed",
			"auto-complete condition failed to evaluate, falling back to manual",
			map[string]any{"node_id": target.NodeID, "workflow_instance_id": inst.GetWorkflowInstanceId(), "error": err.Error()})
		return nil, false, nil
	}
	if !ok {
		return nil, false, nil // F1 求值为假：人工
	}

	// F6 连续自动办理上限：到达这一站时前面已经连着自动了 autoChainLimit 步，停下标为事故。
	// 计数是「本次流转连续自动了几步」（arriveTarget.AutoDepth 随递归累加，人工一插就归零），
	// 因为要防的是两个自动节点互相指向的死循环，不是实例一辈子自动过多少次。
	if to.AutoDepth >= autoChainLimit {
		return e.parkAutoChain(l, b, inst, from, target, submitter, seq), true, nil
	}

	// F2 条件为真：先对出线求值再决定——F4（多条成立要人选）与 F5（一条都不成立）都要改人工，
	// 而改人工就不能在账本上留下一条「系统自动办理」的步骤，所以求路必须发生在建步骤之前。
	chosen, outcome, err := e.route(ctx, l, target.NodeID, submitter, Choices{})
	if err != nil {
		return nil, false, err // L12 求路系统性失败：与人工提交同一口径，不吞
	}
	if outcome != nil {
		return nil, false, nil // 停止自动办理，本站改人工
	}

	now := e.now()
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), SeqNo: seq, NodeId: target.NodeID, NodeKind: target.NodeKind, NodeName: target.NodeName,
		Status: string(model.StepStatusPassed), EnteredByUserId: submitter.UserID, EnteredAt: now, ClosedAt: now,
		Outcome: string(model.StepOutcomeAuto), AutoHandled: true, RouteLinkId: chosen.LinkID,
	}
	if from != nil {
		step.EnteredFromStepId = from.GetStepId()
	}
	summary, err := e.summaryFor(ctx, l, target, submitter)
	if err != nil {
		// 摘要求值失败与人工到达同一口径（H3 到达时求一次，求不出就整个动作失败）：自动办理
		// 是「系统替人按了提交」，它按坏了不该被悄悄咽下——那会留下一条摘要为空的步骤，
		// 流转明细从此少一句话，而且没人知道为什么。
		return nil, false, err
	}
	step.SummaryText = summary
	b.step(step)
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, target.NodeID, target.NodeName
	inst.LastActionAt = now

	// F3 走这条线继续往下。下一站要选人时默认选中全部候选、不弹对话框——自动办理的前提就是
	// 没有人在现场，弹框给谁看。
	return e.arriveAfterAuto(ctx, l, b, inst, step, chosen, to, submitter)
}

// arriveAfterAuto 自动办理之后继续到达下一站。
func (e *Engine) arriveAfterAuto(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, via *compile.LinkCompiled, to arriveTarget, submitter ports.Actor) (*arrival, bool, error) {
	a, err := e.arrive(ctx, l, b, inst, from, arriveTarget{
		NodeID: via.ToNodeID, ViaLinkID: via.LinkID, AutoSelectAll: true, AutoDepth: to.AutoDepth + 1,
	}, submitter, Choices{})
	if err != nil {
		return nil, false, err
	}
	return a, true, nil
}

// parkAutoChain F6 超过连续自动办理上限：在本节点开一条**人工形态**的步骤（不标自动办理、不派任务），
// 实例停驻并挂 AUTO_CHAIN_LIMIT 事故，交管理员按 M3 处理。不标自动办理是故意的——这一步最终没有
// 被系统办掉，标上会让流转明细谎报「系统已自动办理」。
func (e *Engine) parkAutoChain(l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, submitter ports.Actor, seq int32) *arrival {
	now := e.now()
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), SeqNo: seq, NodeId: target.NodeID, NodeKind: target.NodeKind, NodeName: target.NodeName,
		Status: string(model.StepStatusActive), EnteredByUserId: submitter.UserID, EnteredAt: now,
	}
	if from != nil {
		step.EnteredFromStepId = from.GetStepId()
	}
	incident := &pb.IncidentRow{
		IncidentId: e.IDs.New("inc"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: step.StepId,
		Kind: string(model.IncidentAutoChainLimit), Status: string(model.IncidentStatusOpen), OpenedAt: now,
		ErrorCode: "AUTO_CHAIN_LIMIT", ErrorMessage: "continuous auto-complete steps exceeded the limit",
		// 停驻点必填：resume_point_json 是 JSON 列，留空整笔提交会死在「文档为空」。
		// 这一档的停驻点记「停在哪个节点的哪一步」，管理员处理事故时据此定位（恢复动作见
		// ResumeIncident）。
		ResumePointJson: resumePoint{Action: "AUTO_CHAIN_LIMIT", NodeID: target.NodeID, StepID: step.StepId}.json(),
	}
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, target.NodeID, target.NodeName
	inst.Status, inst.ParkedIncidentId, inst.LastActionAt = string(model.InstanceStatusParked), incident.IncidentId, now
	b.step(step)
	b.incident(incident)
	b.outbox(model.OutboxInstanceParked, l.agg, inst, nil)
	return &arrival{step: step, outcome: &Outcome{Kind: OutcomeParked, IncidentID: incident.IncidentId, WorkflowInstanceID: inst.GetWorkflowInstanceId(), NodeID: target.NodeID, NodeName: target.NodeName}}
}
