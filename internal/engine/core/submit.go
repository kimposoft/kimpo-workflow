package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// TaskInput 任务动作入参。
type TaskInput struct {
	AppID   string
	Agg     *pb.InstanceAggregate
	TaskID  string
	Actor   ports.Actor
	Choices Choices
}

// checkActionable 动作权限（每次都做，不信任前端）：归属 → 状态 → 实例状态 → 是否当前站。
func checkActionable(l *loaded, task *pb.TaskRow, actor ports.Actor) error {
	if task == nil {
		return errf("NOT_FOUND", "task not found")
	}
	if task.GetAssigneeUserId() != actor.UserID {
		return errf("TASK_NOT_OWNED", "task %s belongs to user %d", task.GetTaskId(), task.GetAssigneeUserId())
	}
	inst := l.agg.GetInstance()
	switch inst.GetStatus() {
	case string(model.InstanceStatusEnded):
		return errf("INSTANCE_ENDED", "instance %s has ended", inst.GetWorkflowInstanceId())
	case string(model.InstanceStatusParked):
		return errf("INSTANCE_PARKED", "instance %s is parked on incident %s", inst.GetWorkflowInstanceId(), inst.GetParkedIncidentId())
	}
	if task.GetStatus() != string(model.TaskStatusPending) && task.GetStatus() != string(model.TaskStatusSaved) {
		return errf("TASK_NOT_ACTIONABLE", "task %s is %s", task.GetTaskId(), task.GetStatus())
	}
	if task.GetStepId() != inst.GetCurrentStepId() {
		return errf("TASK_NOT_ACTIONABLE", "task %s is not on the current step", task.GetTaskId())
	}
	return nil
}

// Save 暂存：任务转 SAVED，流程不动。
func (e *Engine) Save(ctx context.Context, in TaskInput) (*Decision, error) {
	l, err := loadCompiled(in.AppID, in.Agg)
	if err != nil {
		return nil, err
	}
	task := l.task(in.TaskID)
	if err := checkActionable(l, task, in.Actor); err != nil {
		return nil, err
	}
	// 审批任务没有「暂存」这一动作：审批不改内容，只有按钮。放行会让任务转 SAVED，
	// 上一站提交人撤销时被 G2「没有人暂存」误伤。与「审批站拒提交 / 拒回退」同一句话。
	// 判据走静态特征（Save），不写死「是不是审批」——加一类没有暂存动作的节点不用回头改这里。
	if step := l.step(task.GetStepId()); step != nil {
		if node := l.compiled.Node(step.GetNodeId()); node != nil && !traitsOf(node.KindOf()).Save {
			return nil, errf("TASK_NOT_ACTIONABLE", "step %s is an approval step, use PressButton", step.GetStepId())
		}
	}
	inst := cloneInstance(l.agg.GetInstance())
	t := cloneTask(task)
	now := e.now()
	t.Status = string(model.TaskStatusSaved)
	inst.LastActionAt = now
	b := newCS()
	b.instance(inst, inst.GetVersion())
	b.task(t)
	b.outbox(model.OutboxTaskSaved, l.agg, inst, []*pb.TaskRow{t})
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: inst,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus()}}, nil
}

// Submit 提交（T2 / T3 / T4 / T5 / T6：N2.2 / D 任一人 / L / C / N5.1；对发起任务 = 再次发起 N1.5 / G6）。
func (e *Engine) Submit(ctx context.Context, in TaskInput) (*Decision, error) {
	l, err := loadCompiled(in.AppID, in.Agg)
	if err != nil {
		return nil, err
	}
	task := l.task(in.TaskID)
	if err := checkActionable(l, task, in.Actor); err != nil {
		return nil, err
	}
	step := l.step(task.GetStepId())
	if step == nil || step.GetStatus() != string(model.StepStatusActive) {
		return nil, errf("TASK_NOT_ACTIONABLE", "step %s is not active", task.GetStepId())
	}
	// 审批站不走「提交」：动作必须来自按钮，否则就绕过了按钮校验、理由必填与结果 / 理由
	// 写字段三件事。这一条不能只靠前端不画提交按钮——接口是公开的。判据走静态特征（Submit）。
	if node := l.compiled.Node(step.GetNodeId()); node != nil && !traitsOf(node.KindOf()).Submit {
		return nil, errf("TASK_NOT_ACTIONABLE", "step %s is an approval step, use PressButton", step.GetStepId())
	}
	inst := cloneInstance(l.agg.GetInstance())
	expected := inst.GetVersion()
	now := e.now()
	t := cloneTask(task)
	s := cloneStep(step)
	t.Status, t.DoneAt, t.ActionCode = string(model.TaskStatusDone), now, string(model.TaskActionSubmit)
	s.PassedCount++
	inst.LastActionAt = now

	// 过关判定：判定唯一实现在 pass.go，办理与审批共用；分母是本步选中的办理人数。
	passed := passedEnough(s.GetPassRule(), s.GetPassRatio(), s.GetPassedCount(), s.GetAssigneeCount())
	b := newCS()
	b.instance(inst, expected)
	b.task(t)
	b.step(s)
	if !passed {
		b.outbox(model.OutboxTaskDone, l.agg, inst, []*pb.TaskRow{t})
		if err := checkInvariant(b, l.agg); err != nil {
			return nil, err
		}
		return &Decision{Changeset: b.cs, ExpectedVersion: expected, instance: inst, Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: s.GetStepId(), Status: inst.GetStatus()}}, nil
	}

	chosen, outcome, err := e.route(ctx, l, s.GetNodeId(), in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	if outcome != nil {
		if outcome.Kind == OutcomeRouteChoiceRequired {
			return &Decision{Outcome: *outcome}, nil
		}
		// 零命中：提交人任务转暂存，步骤不动。
		return e.parkSubmitter(l, inst, task, step, expected, *outcome)
	}
	// 过关：步骤关闭，其余待办撤销。
	s.Status, s.ClosedAt, s.Outcome, s.RouteLinkId = string(model.StepStatusPassed), now, string(model.StepOutcomeSubmitted), chosen.LinkID
	changed := []*pb.TaskRow{t}
	for _, o := range closeOtherOpenTasks(l, step.GetStepId(), t.GetTaskId(), model.TaskWithdrawStepPassed, now) {
		b.task(o)
		changed = append(changed, o)
	}
	b.outbox(model.OutboxStepPassed, l.agg, inst, changed)
	a, err := e.arrive(ctx, l, b, inst, s, arriveTarget{NodeID: chosen.ToNodeID, ViaLinkID: chosen.LinkID}, in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	if a.outcome != nil && a.outcome.Kind != OutcomeParked {
		// F6 停驻（OutcomeParked）不在这里分流：那一包变更集（步骤 + 事故 + 实例停驻）已经在 b 里，
		// 照常落库，只是最终结果报「已停驻」而不是「已提交」。
		if a.outcome.Kind == OutcomeAssigneeChoiceRequired {
			return &Decision{Outcome: *a.outcome}, nil
		}
		// C4 候选为空：提交人任务转暂存，步骤回到当前站。
		return e.parkSubmitter(l, cloneInstance(l.agg.GetInstance()), task, step, expected, *a.outcome)
	}
	// L9 支线：主线成功流转的那一刻，对每条指向末级辅助节点的出线求值，成立的各自触发一次。
	// 失败只记 warn，不回滚主线（见 branch.go 文件头）。
	branchSteps, branchStarts := e.fireBranches(ctx, l, b, inst, s, in.Actor)
	_ = branchSteps
	d := &Decision{Changeset: b.cs, ExpectedVersion: expected, PendingEndWrite: a.endWrite, instance: inst, tasks: append(changed, a.tasks...),
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus(), EndLabel: inst.GetEndLabel()}}
	if a.ended {
		d.Outcome.StepID = a.step.GetStepId()
	}
	d.PendingSubflowStarts = appendStarts(a.subflowStarts, branchStarts)
	if a.outcome != nil {
		d.Outcome = *a.outcome // F6 自动办理链超长：实例已停驻，结果如实报停驻
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return d, nil
}

// parkSubmitter 零命中 / 零候选：提交人任务转暂存（L4 / C4 saved=true），步骤保持 ACTIVE、实例仍进行中。
func (e *Engine) parkSubmitter(l *loaded, inst *pb.InstanceRow, task *pb.TaskRow, step *pb.StepRow, expected int64, outcome Outcome) (*Decision, error) {
	now := e.now()
	t := cloneTask(task)
	t.Status, t.DoneAt, t.ActionCode = string(model.TaskStatusSaved), nil, ""
	inst.LastActionAt = now
	b := newCS()
	b.instance(inst, expected)
	b.task(t)
	b.outbox(model.OutboxTaskSaved, l.agg, inst, []*pb.TaskRow{t})
	outcome.Saved = true
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return &Decision{Changeset: b.cs, ExpectedVersion: expected, instance: inst, Outcome: outcome}, nil
}
