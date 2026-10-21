package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// approve.go 是审批节点的运行期：审批人点一个按钮，引擎按按钮的动作把流程往后走或回退。
//
// 与办理节点的差别只有三处（其余——选人派发、过关判定、回退——都共用）：
//   - 审批不改表单内容，动作来自按钮而不是「提交」；
//   - 过关前要把按钮的结果标识与审批人填的理由写进绑定字段并保存单据；
//   - 零命中时按钮不生效、绑定字段不写、任务回到待办。
//
// 🔴 顺序是本文件的要害：**先求路、后写字段**。规则要求零命中时「已点的按钮不生效，绑定
// 字段不写入」——若按「先写字段再求路」的直觉实现，零命中那一刻字段已经被改掉了，审批人看到的
// 单据结果标识变了、流程却没走，属于用户可见的脏数据。因此这里的次序固定为：
//   校验按钮 → 校验理由 → 求路（overlay，不落库）→ 零命中直接回待办 → 有路才写字段 → 再提交。

// ApproveInput 审批动作入参：在任务动作的基础上多一个按钮与理由。
type ApproveInput struct {
	TaskInput
	ButtonID string
	Reason   string
	// TargetStepID 「回退到指定步骤」那一档按钮用：由审批人从本实例走过的步骤里选一个。
	TargetStepID string
}

// ApproveWrite 是「确认审批前要写进单据的字段」。app 层在提交变更集之前执行它：
// 写失败就整个动作失败、状态一点不动，不留「字段写了一半、流程没走」的中间态。
type ApproveWrite struct {
	// ResultFieldID / ResultTag 结果绑定字段与该按钮的结果标识；字段没配时 ResultFieldID 为空。
	ResultFieldID string
	ResultTag     string
	// ReasonFieldID / Reason 理由绑定字段与审批人填的理由；字段没配或没填理由时为空。
	ReasonFieldID string
	Reason        string
	NodeID        string
	StepID        string
}

// IsEmpty 没有任何字段要写（两个绑定字段都没配）。
func (w *ApproveWrite) IsEmpty() bool {
	return w == nil || (w.ResultFieldID == "" && w.ReasonFieldID == "")
}

// PressButton 审批人点按钮。
func (e *Engine) PressButton(ctx context.Context, in ApproveInput) (*Decision, error) {
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
	node := l.compiled.Node(step.GetNodeId())
	if node == nil || !traitsOf(node.KindOf()).Buttons {
		return nil, errf("TASK_NOT_ACTIONABLE", "step %s is not an approval step", step.GetStepId())
	}

	btn, err := approveButtonOf(node, in.ButtonID)
	if err != nil {
		return nil, err
	}
	// N3.2 需填理由的按钮必须带理由；不需要的按钮带了也不拦（写不写由绑定字段决定）。
	if btn.RequireReason && in.Reason == "" {
		return nil, errf("APPROVE_REASON_REQUIRED", "button %s requires a reason", btn.ID)
	}

	// 「不通过并结束流程」：不选路、不选人、不计票，直接走到按钮指定的结束节点。
	// 必须排在回退分流之前——它不是回退，进了 backByButton 会被当成未知回退方式。
	if btn.Action == model.ButtonActionEndFlow {
		return e.endByButton(ctx, l, in, step, task, btn)
	}

	// 回退类按钮（三档）走回退链路，由 back.go 统一执行 E 系规则；本文件只负责把按钮翻译成
	// 回退方式，不重复实现回退语义。
	if btn.Action != model.ButtonActionSubmitApprove {
		return e.backByButton(ctx, l, in, step, task, btn)
	}

	// ——「提交通过」——
	inst := cloneInstance(l.agg.GetInstance())
	expected := inst.GetVersion()
	now := e.now()
	t := cloneTask(task)
	s := cloneStep(step)
	// 动作码记成 BTN:<按钮 id>（账本形状已冻结），流转明细据此还原「他点的是哪个按钮」；
	// 理由写进 comment（E8 同一列）。
	t.Status, t.DoneAt, t.ActionCode, t.Comment = string(model.TaskStatusDone), now, model.TaskActionButton(btn.ID), in.Reason
	s.PassedCount++
	inst.LastActionAt = now

	passed := passedEnough(s.GetPassRule(), s.GetPassRatio(), s.GetPassedCount(), s.GetAssigneeCount())
	b := newCS()
	b.instance(inst, expected)
	b.task(t)
	b.step(s)

	write := approveWriteOf(node, btn, in.Reason, step)

	if !passed {
		// 还没到过关线：本人这一票记下（结果与理由照写，N3.3 的写入是「每个人点确认时」发生的，
		// 不是过关那一刻），流程不动。
		b.outbox(model.OutboxTaskDone, l.agg, inst, []*pb.TaskRow{t})
		if err := checkInvariant(b, l.agg); err != nil {
			return nil, err
		}
		return &Decision{Changeset: b.cs, ExpectedVersion: expected, PendingApproveWrite: write, instance: inst,
			Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: s.GetStepId(), Status: inst.GetStatus()}}, nil
	}

	// 过关线已到：先求路（overlay，不落库）。
	chosen, outcome, err := e.route(ctx, l, s.GetNodeId(), in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	if outcome != nil {
		if outcome.Kind == OutcomeRouteChoiceRequired {
			return &Decision{Outcome: *outcome}, nil
		}
		// N3.6 零命中：审批人的任务回到待办、已点的按钮不生效、绑定字段不写入。
		// 「不生效」在这里是字面意思——不落任何变更集：这一票不计数、任务仍是待办、步骤不动，
		// 也**不带** PendingApproveWrite（正是「绑定字段不写入」那一条）。审批人看到无路提示后
		// 可以改单据或改选别的按钮再来一次。这与办理节点零命中把提交人任务转暂存（parkSubmitter）
		// 刻意不同：办理是「已经提交过了，等条件变化」，审批是「这一下没按成」。
		return &Decision{Outcome: *outcome}, nil
	}

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
		// 下一步选不出人：本步已经过关，按办理节点同一口径把本人任务转暂存等人来看。
		return e.parkSubmitter(l, cloneInstance(l.agg.GetInstance()), task, step, expected, *a.outcome)
	}
	// L9 支线：主线成功流转的那一刻，对每条指向末级辅助节点的出线求值，成立的各自触发一次。
	// 失败只记 warn，不回滚主线（见 branch.go 文件头）。
	branchSteps, branchStarts := e.fireBranches(ctx, l, b, inst, s, in.Actor)
	_ = branchSteps
	d := &Decision{Changeset: b.cs, ExpectedVersion: expected, PendingEndWrite: a.endWrite, PendingApproveWrite: write,
		instance: inst, tasks: append(changed, a.tasks...),
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

// approveButtonOf 从编译产物里取按钮定义；按钮不存在直接拒（不接受前端自造按钮 id）。
func approveButtonOf(node *compile.NodeCompiled, buttonID string) (model.ApprovalButton, error) {
	var buttons []model.ApprovalButton
	if raw := node.ApproveButtonsJSON; raw != "" {
		if err := json.Unmarshal([]byte(raw), &buttons); err != nil {
			return model.ApprovalButton{}, errf("SYSTEM_ERROR", "node %s buttons: %v", node.NodeID, err)
		}
	}
	for _, b := range buttons {
		if b.ID == buttonID {
			return b, nil
		}
	}
	return model.ApprovalButton{}, errf("APPROVE_BUTTON_UNKNOWN", "node %s has no button %q", node.NodeID, buttonID)
}

// approveWriteOf 组装「确认时要写的字段」。两个绑定字段都没配时返回 nil（app 层据此跳过写入）。
func approveWriteOf(node *compile.NodeCompiled, btn model.ApprovalButton, reason string, step *pb.StepRow) *ApproveWrite {
	w := &ApproveWrite{NodeID: node.NodeID, StepID: step.GetStepId()}
	if node.ResultFieldID != "" {
		w.ResultFieldID, w.ResultTag = node.ResultFieldID, btn.ResultTag
	}
	if node.ReasonFieldID != "" && reason != "" {
		w.ReasonFieldID, w.Reason = node.ReasonFieldID, reason
	}
	if w.IsEmpty() {
		return nil
	}
	return w
}
