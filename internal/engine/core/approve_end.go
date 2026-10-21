package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// approve_end.go 是审批按钮「不通过并结束流程」（end_flow）的运行期。
//
// 与「提交通过」的差别：
//   - 一票即结束：不计 PassedCount、不判过关线（不论或签 / 会签 / 按比例），不求路、不选人；
//   - 直达按钮指定的结束节点：走 arrive 的结束节点到达行为，与经引导线到达的结束处理完全相同
//     ，只是没有走线（步骤 RouteLinkId 留空）；
//   - 不触发 L9 支线；
//   - 同一步骤其余未完成任务（待办 / 暂存）撤销，原因 STEP_ENDED；已点过「同意」的任务保持 DONE。
//
// 结果标识 / 理由的写入不在这里做：与其他按钮一样经 Decision.PendingApproveWrite 交 app 层
// 在提交之前写单据；结束标识经 PendingEndWrite 走两段式。二者写同一字段时以结束标识为准
// （app 层先写审批字段、后写结束标识，后写者覆盖）。

// EndedByButtonInfo 「不通过并结束流程」决策的上报信息（见 Decision.EndedByButton）。
type EndedByButtonInfo struct {
	InstanceID string
	StepID     string
	TaskID     string
	ButtonID   string
	EndNodeID  string
	// WithdrawnTaskIDs 被撤销（原因 STEP_ENDED）的其余人待办 / 暂存任务 id。
	WithdrawnTaskIDs []string
}

// endByButton 执行「不通过并结束流程」。前置校验（归属、实例 / 步骤状态、按钮存在、理由必填）
// 已由 PressButton 完成。
func (e *Engine) endByButton(ctx context.Context, l *loaded, in ApproveInput, step *pb.StepRow, task *pb.TaskRow, btn model.ApprovalButton) (*Decision, error) {
	node := l.compiled.Node(step.GetNodeId())
	if node == nil {
		return nil, errf("SYSTEM_ERROR", "step %s points to unknown node %s", step.GetStepId(), step.GetNodeId())
	}
	// N3.11 运行期防御：目标必须在本版本编译产物里且是结束节点。发布期已校验，走到这里说明
	// 产物被改过或版本错配，按系统错误拒绝，不写任何状态。
	target := l.compiled.Node(btn.EndNodeID)
	if target == nil || target.KindOf() != model.NodeKindEnd {
		observabilityWarn(ctx, "workflow.engine.end_flow.target_invalid", "end_flow button target is missing or not an end node, click rejected",
			map[string]any{"workflow_instance_id": l.agg.GetInstance().GetWorkflowInstanceId(), "step_id": step.GetStepId(), "node_id": node.NodeID, "button_id": btn.ID, "end_node_id": btn.EndNodeID})
		return nil, errf("SYSTEM_ERROR", "button %s of node %s points to invalid end node %q", btn.ID, node.NodeID, btn.EndNodeID)
	}

	inst := cloneInstance(l.agg.GetInstance())
	expected := inst.GetVersion()
	now := e.now()
	t := cloneTask(task)
	s := cloneStep(step)
	// 任务行：DONE + BTN:<按钮 id> + 理由，写法同「提交通过」；一票否决，不计 PassedCount。
	t.Status, t.DoneAt, t.ActionCode, t.Comment = string(model.TaskStatusDone), now, model.TaskActionButton(btn.ID), in.Reason
	inst.LastActionAt = now
	// 本步结束：PASSED / SUBMITTED，没有走线所以 RouteLinkId 留空（不新增步骤结果枚举）。
	s.Status, s.ClosedAt, s.Outcome, s.RouteLinkId = string(model.StepStatusPassed), now, string(model.StepOutcomeSubmitted), ""

	b := newCS()
	b.instance(inst, expected)
	b.task(t)
	b.step(s)
	changed := []*pb.TaskRow{t}
	var withdrawn []string
	// 其余人尚未完成的任务（待办 / 暂存）撤销；已 DONE 的「同意」任务不动。
	for _, o := range closeOtherOpenTasks(l, step.GetStepId(), t.GetTaskId(), model.TaskWithdrawStepEnded, now) {
		b.task(o)
		changed = append(changed, o)
		withdrawn = append(withdrawn, o.GetTaskId())
	}
	b.outbox(model.OutboxStepPassed, l.agg, inst, changed)

	// 直达结束节点；from 传本审批步骤，arriveEnd 据此写 EnteredFromStepId（进度图画按钮直达段）。
	a, err := e.arrive(ctx, l, b, inst, s, arriveTarget{NodeID: btn.EndNodeID}, in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	// 不调 fireBranches：N3.10 该按钮不触发 L9 支线。
	d := &Decision{Changeset: b.cs, ExpectedVersion: expected, PendingEndWrite: a.endWrite,
		PendingApproveWrite: approveWriteOf(node, btn, in.Reason, step),
		instance:            inst, tasks: append(changed, a.tasks...),
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus(), EndLabel: inst.GetEndLabel()},
		EndedByButton: &EndedByButtonInfo{InstanceID: inst.GetWorkflowInstanceId(), StepID: step.GetStepId(), TaskID: task.GetTaskId(),
			ButtonID: btn.ID, EndNodeID: btn.EndNodeID, WithdrawnTaskIDs: withdrawn}}
	if a.ended {
		d.Outcome.StepID = a.step.GetStepId()
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return d, nil
}
