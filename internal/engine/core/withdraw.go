package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// Withdraw 撤销提交（T10：G1 / G2 / G4 / G10）：
//   - 只有把流程送到下一站的提交人能撤：S(k+1).entered_by == actor 且 actor 在 S(k) 有 DONE 任务；
//   - 实例已结束 → WITHDRAW_REJECTED_END；停驻 → INSTANCE_PARKED；
//   - 当前站不是 S(k) 送出去的那一站（已再往后走）→ WITHDRAW_REJECTED_TOUCHED；
//   - 下一站任一任务非待办（有人暂存 / 完成）→ WITHDRAW_REJECTED_TOUCHED；
//   - 效果：下一站任务全部 WITHDRAWN（PRIOR_WITHDRAWN），下一站步骤 WITHDRAWN 并记谁 / 何时，
//     S(k) 回 ACTIVE，撤销人任务回 PENDING（reopen_count+1），因过关而被撤销的其余任务恢复待办；表单不动。
func (e *Engine) Withdraw(ctx context.Context, in TaskInput) (*Decision, error) {
	l, err := loadCompiled(in.AppID, in.Agg)
	if err != nil {
		return nil, err
	}
	task := l.task(in.TaskID)
	if task == nil {
		return nil, errf("NOT_FOUND", "task not found")
	}
	if task.GetAssigneeUserId() != in.Actor.UserID {
		return nil, errf("TASK_NOT_OWNED", "task %s belongs to user %d", task.GetTaskId(), task.GetAssigneeUserId())
	}
	inst := l.agg.GetInstance()
	switch inst.GetStatus() {
	case string(model.InstanceStatusEnded):
		return nil, errf("WITHDRAW_REJECTED_END", "instance has ended")
	case string(model.InstanceStatusParked):
		return nil, errf("INSTANCE_PARKED", "instance is parked")
	}
	// G5 本步过关前：多人办理时每人可以撤回自己的提交，撤回后计数减一，流程根本没动过。
	// 这一支必须排在 withdrawCheck 前面——那套判定说的是「把流程送到下一站之后」的撤销，
	// 本步还没过关时压根没有下一站可撤。
	if myStep := l.step(task.GetStepId()); myStep != nil && myStep.GetStatus() == string(model.StepStatusActive) &&
		myStep.GetStepId() == inst.GetCurrentStepId() && task.GetStatus() == string(model.TaskStatusDone) {
		return e.withdrawVote(l, task, myStep)
	}
	prev, next, between, err := withdrawCheck(l, task)
	if err != nil {
		return nil, err
	}
	now := e.now()
	b := newCS()
	instRow := cloneInstance(inst)
	var changed []*pb.TaskRow
	for _, t := range l.tasksOfStep(next.GetStepId()) {
		c := cloneTask(t)
		c.Status, c.WithdrawnAt, c.WithdrawReason = string(model.TaskStatusWithdrawn), now, string(model.TaskWithdrawPriorWithdrawn)
		b.task(c)
		changed = append(changed, c)
	}
	n := cloneStep(next)
	n.Status, n.Outcome, n.ClosedAt, n.WithdrawnByUserId, n.WithdrawnAt = string(model.StepStatusWithdrawn), string(model.StepOutcomeWithdrawn), now, in.Actor.UserID, now
	b.step(n)
	// G8 中间经过的自动办理步骤一并作废——再次提交时会重新自动办理（条件可能已经因为改了单据
	// 而变了，照搬旧结果就成了「撤了个寂寞」）。
	for _, mid := range between {
		m := cloneStep(mid)
		m.Status, m.Outcome, m.ClosedAt, m.WithdrawnByUserId, m.WithdrawnAt = string(model.StepStatusWithdrawn), string(model.StepOutcomeWithdrawn), now, in.Actor.UserID, now
		b.step(m)
	}
	p := cloneStep(prev)
	p.Status, p.ClosedAt, p.Outcome, p.RouteLinkId = string(model.StepStatusActive), nil, "", ""
	if p.PassedCount > 0 {
		p.PassedCount--
	}
	b.step(p)
	mine := cloneTask(task)
	mine.Status, mine.DoneAt, mine.ActionCode, mine.ReopenCount = string(model.TaskStatusPending), nil, "", mine.GetReopenCount()+1
	b.task(mine)
	changed = append(changed, mine)
	for _, t := range l.tasksOfStep(prev.GetStepId()) {
		if t.GetTaskId() == task.GetTaskId() || t.GetWithdrawReason() != string(model.TaskWithdrawStepPassed) {
			continue
		}
		c := cloneTask(t)
		c.Status, c.WithdrawnAt, c.WithdrawReason, c.ReopenCount = string(model.TaskStatusPending), nil, "", c.GetReopenCount()+1
		b.task(c)
		changed = append(changed, c)
	}
	instRow.CurrentStepId, instRow.CurrentNodeId, instRow.CurrentNodeName = p.GetStepId(), p.GetNodeId(), p.GetNodeName()
	instRow.LastActionAt = now
	b.instance(instRow, inst.GetVersion())
	b.outbox(model.OutboxStepWithdrawn, l.agg, instRow, changed)
	// 被撤销：下一站待办人收到一条通知。开关读发起节点的 on_withdrawn
	// （提交人撤销的是他自己刚发起 / 送出的那次提交，语义上归发起节点）；渠道同一个节点的配置。
	startNotify := l.compiled.Node(l.compiled.StartNodeID).Notify()
	if startNotify.Enabled(model.NotifyKeyWithdrawn) {
		var recipients []int64
		for _, t := range l.tasksOfStep(next.GetStepId()) {
			recipients = append(recipients, t.GetAssigneeUserId())
		}
		b.notify(model.NotifyTaskWithdrawn, instRow, recipients, "", next.GetSummaryText(), next.GetNodeName(), startNotify.ChannelsOrDefault())
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: instRow.GetWorkflowInstanceId(), StepID: p.GetStepId(), Status: instRow.GetStatus()}}, nil
}

// WithdrawStart 撤销发起：= 对发起任务的撤销；非人工发起不可撤。
func (e *Engine) WithdrawStart(ctx context.Context, appID string, agg *pb.InstanceAggregate, actor ports.Actor) (*Decision, error) {
	if agg == nil || agg.GetInstance() == nil {
		return nil, errf("NOT_FOUND", "instance not found")
	}
	if agg.GetInstance().GetStartKind() != string(model.StartKindManual) {
		return nil, errf("WITHDRAW_REJECTED_NON_MANUAL_START", "instance was started by %s", agg.GetInstance().GetStartKind())
	}
	for _, t := range agg.GetTasks() {
		if t.GetTaskKind() == string(model.TaskKindStart) && t.GetAssigneeUserId() == actor.UserID {
			return e.Withdraw(ctx, TaskInput{AppID: appID, Agg: agg, TaskID: t.GetTaskId(), Actor: actor})
		}
	}
	return nil, errf("TASK_NOT_OWNED", "user %d did not start this instance", actor.UserID)
}

// withdrawVote G5 本步过关前撤回自己的一票：任务回到待办、本步通过数减一，步骤与实例都不动。
// 表单数据保持提交时的样子（G4 同一口径，引擎不碰单据）。
func (e *Engine) withdrawVote(l *loaded, task *pb.TaskRow, step *pb.StepRow) (*Decision, error) {
	inst := l.agg.GetInstance()
	now := e.now()
	instRow := cloneInstance(inst)
	instRow.LastActionAt = now
	s := cloneStep(step)
	if s.PassedCount > 0 {
		s.PassedCount--
	}
	t := cloneTask(task)
	t.Status, t.DoneAt, t.ActionCode, t.ReopenCount = string(model.TaskStatusPending), nil, "", t.GetReopenCount()+1
	b := newCS()
	b.instance(instRow, inst.GetVersion())
	b.step(s)
	b.task(t)
	b.outbox(model.OutboxTaskSaved, l.agg, instRow, []*pb.TaskRow{t})
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow, tasks: []*pb.TaskRow{t},
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: instRow.GetWorkflowInstanceId(), StepID: s.GetStepId(), Status: instRow.GetStatus()}}, nil
}

// withdrawCheck 撤销前置判定，Withdraw 与 TaskFlags 共用同一套口径：
// 任务须 DONE；上一站（任务所在步）须 PASSED；当前站须由它（可隔着若干自动办理步骤）送入；
// 当前站须由任务办理人送入；当前站不是结束；当前站任务全部仍待办。
// 返回 (上一站, 当前站, 中间的自动办理步骤, 错误)。
func withdrawCheck(l *loaded, task *pb.TaskRow) (*pb.StepRow, *pb.StepRow, []*pb.StepRow, error) {
	if task.GetStatus() != string(model.TaskStatusDone) {
		return nil, nil, nil, errf("TASK_NOT_ACTIONABLE", "task %s is %s, nothing to withdraw", task.GetTaskId(), task.GetStatus())
	}
	prev := l.step(task.GetStepId())
	next := l.activeStep()
	if prev == nil || next == nil {
		return nil, nil, nil, errf("SYSTEM_ERROR", "steps of task %s not found", task.GetTaskId())
	}
	if prev.GetStatus() != string(model.StepStatusPassed) {
		return nil, nil, nil, errf("WITHDRAW_REJECTED_TOUCHED", "flow has moved beyond the next station")
	}
	// 沿 entered_from 链往回走，看中间隔着什么。判据走静态特征表的 Withdraw 三档
	// （node/traits.go）：
	//   - block_launched（子流程）：不可撤销——子流程已经发起出去了，撤不回来；
	//   - pass（抄送）：已经发出去的不撤回，也不影响可撤销；
	//   - block_if_human（办理 / 审批）：自动办理的步骤照样可以撤（那条记录随撤销作废，
	//     再次提交时重新自动办理）；真有人办过就不能撤，流程真的被人往后推过了。
	var between []*pb.StepRow
	for cur := next; cur.GetEnteredFromStepId() != prev.GetStepId(); {
		src := l.step(cur.GetEnteredFromStepId())
		if src == nil || len(between) > autoChainLimit {
			return nil, nil, nil, errf("WITHDRAW_REJECTED_TOUCHED", "flow has moved beyond the next station")
		}
		switch traitsOfStep(src.GetNodeKind()).Withdraw {
		case node.WithdrawBlockLaunched:
			return nil, nil, nil, errf("WITHDRAW_REJECTED_SUBFLOW", "a sub-process was already started at step %s", src.GetStepId())
		case node.WithdrawPassThrough:
			// 抄送：跳过，继续往前找。
		default: // block_if_human（含未登记类型，保守按人工处理）
			if !src.GetAutoHandled() {
				return nil, nil, nil, errf("WITHDRAW_REJECTED_TOUCHED", "flow has moved beyond the next station")
			}
		}
		between = append(between, src)
		cur = src
	}
	if next.GetEnteredByUserId() != task.GetAssigneeUserId() {
		return nil, nil, nil, errf("TASK_NOT_OWNED", "next station was not sent by user %d", task.GetAssigneeUserId())
	}
	if next.GetNodeKind() == model.StepNodeKind(model.NodeKindEnd) {
		return nil, nil, nil, errf("WITHDRAW_REJECTED_END", "next station is the end")
	}
	for _, t := range l.tasksOfStep(next.GetStepId()) {
		if t.GetStatus() != string(model.TaskStatusPending) {
			return nil, nil, nil, errf("WITHDRAW_REJECTED_TOUCHED", "task %s on the next station is %s", t.GetTaskId(), t.GetStatus())
		}
	}
	return prev, next, between, nil
}

// TaskFlag 单个任务的派生标志（供任务中心「撤销」两态）。ReasonCode 只在不可撤销时给出：
// TASK_NOT_DONE | INSTANCE_ENDED | INSTANCE_PARKED | NOT_NEXT | NEXT_IS_END | NEXT_TOUCHED | NON_MANUAL_START。
type TaskFlag struct {
	TaskID       string
	Withdrawable bool
	ReasonCode   string
}

// stepStatusOf 取某步骤的状态（找不到返回空串）。
func stepStatusOf(l *loaded, stepID string) string {
	if s := l.step(stepID); s != nil {
		return s.GetStatus()
	}
	return ""
}

// TaskFlags 对聚合里每条任务算「可否撤销」——与 Withdraw 同一套判定（withdrawCheck），
// 但不需要操作人：撤销人恒为任务办理人本人。只读，不改聚合。
func TaskFlags(agg *pb.InstanceAggregate) []TaskFlag {
	if agg == nil || agg.GetInstance() == nil {
		return nil
	}
	l := &loaded{agg: agg}
	inst := agg.GetInstance()
	out := make([]TaskFlag, 0, len(agg.GetTasks()))
	for _, t := range agg.GetTasks() {
		f := TaskFlag{TaskID: t.GetTaskId()}
		switch {
		case t.GetStatus() != string(model.TaskStatusDone):
			f.ReasonCode = "TASK_NOT_DONE"
		case inst.GetStatus() == string(model.InstanceStatusEnded):
			f.ReasonCode = "INSTANCE_ENDED"
		case inst.GetStatus() == string(model.InstanceStatusParked):
			f.ReasonCode = "INSTANCE_PARKED"
		case t.GetTaskKind() == string(model.TaskKindStart) && inst.GetStartKind() != string(model.StartKindManual):
			f.ReasonCode = "NON_MANUAL_START"
		case t.GetStepId() == inst.GetCurrentStepId() && stepStatusOf(l, t.GetStepId()) == string(model.StepStatusActive):
			// G5 本步尚未过关：自己那一票随时可以撤回。
			f.Withdrawable = true
		default:
			_, _, _, err := withdrawCheck(l, t)
			switch CodeOf(err) {
			case "":
				f.Withdrawable = true
			case "WITHDRAW_REJECTED_END":
				f.ReasonCode = "NEXT_IS_END"
			case "WITHDRAW_REJECTED_TOUCHED":
				// 区分「流程已越过下一站」与「下一站有人动过」：前者上一站与当前站不相邻。
				prev, next := l.step(t.GetStepId()), l.activeStep()
				if prev == nil || next == nil || next.GetEnteredFromStepId() != prev.GetStepId() || prev.GetStatus() != string(model.StepStatusPassed) {
					f.ReasonCode = "NOT_NEXT"
				} else {
					f.ReasonCode = "NEXT_TOUCHED"
				}
			default:
				f.ReasonCode = "NOT_NEXT"
			}
		}
		out = append(out, f)
	}
	return out
}
