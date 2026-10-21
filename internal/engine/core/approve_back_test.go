package core_test

import (
	"encoding/json"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// f3 夹具：发起 → 部门办理（王芳，可回退到发起人 / 指定步骤，回退清空金额）
//
//	→ 财务审批（李四，三个按钮：同意 / 拒绝并退回指定步骤 / 退回上一步）→ 结束。
//
// 审批节点绑了结果与理由两个字段，用来验 N3.3 的写入内容与 N3.6 的「不写入」。
func f3() *compile.CompiledDefinition {
	buttons, _ := json.Marshal([]model.ApprovalButton{
		{ID: "b-ok", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "已通过"},
		{ID: "b-no", Name: "拒绝", Action: model.ButtonActionWithdrawSpecify, ResultTag: "已拒绝", RequireReason: true},
		{ID: "b-prev", Name: "退回上一步", Action: model.ButtonActionWithdrawPrev, ResultTag: "退回"},
	})
	allowed, _ := json.Marshal([]model.WithdrawMethod{model.WithdrawMethodInitiator, model.WithdrawMethodSpecified})
	clear, _ := json.Marshal([]model.ClearOnWithdrawField{{TableID: "t-main", FieldID: "f-amount"}})
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no",
		Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门办理", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{22},
				AllowedWithdrawsJSON: string(allowed), ClearOnWithdrawJSON: string(clear)},
			{NodeID: "n4", NodeKind: "APPROVE", NodeName: "财务审批", NoRouteHint: "审批后没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{33},
				ApproveButtonsJSON: string(buttons), ResultFieldID: "f-status", ReasonFieldID: "f-reason"},
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n4", IsMain: true},
			{LinkID: "l3", FromNodeID: "n4", ToNodeID: "n2", IsMain: true},
		},
	}
}

// press 审批人点按钮（不自动提交，交由调用方决定是否落库）。
func (h *harness) press(actor ports.Actor, buttonID, reason, targetStepID string) (*core.Decision, error) {
	h.t.Helper()
	agg := h.agg()
	var task *pb.TaskRow
	for _, t := range agg.GetTasks() {
		if t.GetAssigneeUserId() == actor.UserID && (t.GetStatus() == "PENDING" || t.GetStatus() == "SAVED") {
			task = t
		}
	}
	if task == nil {
		h.t.Fatalf("user %d has no actionable task: %v", actor.UserID, taskLines(agg))
	}
	return h.eng.PressButton(h.ctx(), core.ApproveInput{
		TaskInput: core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: actor},
		ButtonID:  buttonID, Reason: reason, TargetStepID: targetStepID,
	})
}

func (h *harness) back(actor ports.Actor, method model.WithdrawMethod, targetStepID, comment string) (*core.Decision, error) {
	h.t.Helper()
	agg := h.agg()
	var task *pb.TaskRow
	for _, t := range agg.GetTasks() {
		if t.GetAssigneeUserId() == actor.UserID && (t.GetStatus() == "PENDING" || t.GetStatus() == "SAVED") {
			task = t
		}
	}
	if task == nil {
		h.t.Fatalf("user %d has no actionable task: %v", actor.UserID, taskLines(agg))
	}
	return h.eng.Back(h.ctx(), core.BackInput{
		TaskInput: core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: actor},
		Method:    method, TargetStepID: targetStepID, Comment: comment,
	})
}

// 走到审批站：发起 → 王芳提交。
func atApprove(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t, f3())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	return h
}

// N3.1 审批节点到达时按 C 选人派发，派的是「审批」种类的任务。
func TestN3_1_ApproveTaskDispatched(t *testing.T) {
	h := atApprove(t)
	agg := h.agg()
	task := h.task(agg, liSi.UserID, "PENDING")
	wantEqual(t, "任务种类", task.GetTaskKind(), string(model.TaskKindApprove))
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n4")
}

// N3.2 需填理由的按钮不填理由直接拒；不需要的按钮不受影响。
func TestN3_2_ReasonRequired(t *testing.T) {
	h := atApprove(t)
	_, err := h.press(liSi, "b-no", "", h.step(h.agg(), "n1", "").GetStepId())
	wantCode(t, err, "APPROVE_REASON_REQUIRED")

	if _, err := h.press(liSi, "b-ok", "", ""); err != nil {
		t.Fatalf("不需填理由的按钮不该被拦：%v", err)
	}
}

// 按钮 id 不在节点的按钮清单里：直接拒，不接受前端自造按钮。
func TestN3_UnknownButtonRejected(t *testing.T) {
	h := atApprove(t)
	_, err := h.press(liSi, "b-ghost", "", "")
	wantCode(t, err, "APPROVE_BUTTON_UNKNOWN")
}

// N3.3 确认时把按钮的结果标识与理由交给 app 层写进绑定字段；动作码记成 BTN:<按钮 id>、
// 理由写进流转明细的说明列。
func TestN3_3_ApproveWriteAndActionCode(t *testing.T) {
	h := atApprove(t)
	d, err := h.press(liSi, "b-ok", "同意，金额无误", "")
	if err != nil {
		t.Fatalf("press: %v", err)
	}
	w := d.PendingApproveWrite
	if w == nil {
		t.Fatal("配了结果与理由绑定字段，应当交出一份待写内容")
	}
	wantEqual(t, "结果字段", w.ResultFieldID, "f-status")
	wantEqual(t, "结果标识", w.ResultTag, "已通过")
	wantEqual(t, "理由字段", w.ReasonFieldID, "f-reason")
	wantEqual(t, "理由", w.Reason, "同意，金额无误")

	h.commit(d)
	done := h.task(h.agg(), liSi.UserID, "DONE")
	wantEqual(t, "动作码", done.GetActionCode(), "BTN:b-ok")
	wantEqual(t, "说明", done.GetComment(), "同意，金额无误")
}

// N3.6 零命中：按钮不生效——不落任何变更集、绑定字段不写、任务仍是待办。
func TestN3_6_NoRouteDoesNotWriteFields(t *testing.T) {
	c := f3()
	// 审批出线挂一个求值为假的条件，制造零命中。
	c.Links[2].ConditionPublicationID, c.Links[2].ConditionDocumentJSON = "p-l3", `{"mode":"condition"}`
	h := newHarness(t, c)
	h.expr.Conditions["p-l3"] = false
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	d, err := h.press(liSi, "b-ok", "同意", "")
	if err != nil {
		t.Fatalf("press: %v", err)
	}
	wantKind(t, d, core.OutcomeNoRoute)
	if d.Changeset != nil {
		t.Fatal("零命中不该落库：按钮不生效")
	}
	if d.PendingApproveWrite != nil {
		t.Fatal("零命中时绑定字段不写入")
	}
	wantEqual(t, "无路提示", d.Outcome.Hint, "审批后没有可走的路线")

	// 账本里任务仍是待办，可以改数据后再点。
	wantEqual(t, "任务状态", h.task(h.agg(), liSi.UserID, "").GetStatus(), "PENDING")
}

// 审批的「退回上一步」走回退链路，目标是最近的人工步骤（部门办理），
// 该步在目标节点新开一步重新派发，原审批步记为已回退。
func TestN3_4_BackToPreviousStepByButton(t *testing.T) {
	h := atApprove(t)
	approveStep := h.step(h.agg(), "n4", "ACTIVE")
	d, err := h.press(liSi, "b-prev", "金额不对，请重填", "")
	if err != nil {
		t.Fatalf("press b-prev: %v", err)
	}
	h.commit(d)

	agg := h.agg()
	wantEqual(t, "审批步结果", h.step(agg, "n4", "").GetStatus(), string(model.StepStatusReturned))
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n1")
	if h.current(agg).GetStepId() == approveStep.GetStepId() {
		t.Fatal("回退应当在目标节点新开一步，不是复活旧步骤")
	}
	// 目标步骤按 C5 重新派发，王芳重新拿到待办。
	wantEqual(t, "王芳待办", h.task(agg, wangFang.UserID, "PENDING").GetStatus(), "PENDING")
	// E8 回退说明进流转明细。
	wantEqual(t, "回退说明", h.task(agg, liSi.UserID, "DONE").GetComment(), "金额不对，请重填")
}

// E1 节点没勾选的回退方式，运行期不能用。
func TestE1_MethodNotAllowed(t *testing.T) {
	h := newHarness(t, f3())
	h.mustStart(starter, core.Choices{})
	// n1 只允许「回退到发起人」「回退到指定步骤」，没允许「回退到上一步」。
	_, err := h.back(wangFang, model.WithdrawMethodPreviousStep, "", "")
	wantCode(t, err, "BACK_METHOD_NOT_ALLOWED")
}

// E2 回退时清空：节点配了清单，回退时交 app 层先清空并保存单据。
func TestE2_ClearOnWithdraw(t *testing.T) {
	h := newHarness(t, f3())
	h.mustStart(starter, core.Choices{})
	d, err := h.back(wangFang, model.WithdrawMethodInitiator, "", "请补充说明")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	if d.PendingClearWrite == nil || len(d.PendingClearWrite.Fields) != 1 {
		t.Fatalf("应当交出一份待清空字段清单，实得 %+v", d.PendingClearWrite)
	}
	wantEqual(t, "清空字段", d.PendingClearWrite.Fields[0].FieldID, "f-amount")
}

// N1.5 回退到发起人：发起任务回到待办（不新开步骤），发起人提交即再次发起。
func TestE_BackToInitiatorReopensStartTask(t *testing.T) {
	h := newHarness(t, f3())
	h.mustStart(starter, core.Choices{})
	startStepID := h.step(h.agg(), "n0", "").GetStepId()

	d, err := h.back(wangFang, model.WithdrawMethodInitiator, "", "请补充说明")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(d)

	agg := h.agg()
	wantEqual(t, "当前站", h.current(agg).GetStepId(), startStepID)
	st := h.task(agg, starter.UserID, "PENDING")
	wantEqual(t, "回到待办次数", st.GetReopenCount(), int32(1))
	wantEqual(t, "办理步已回退", h.step(agg, "n1", "").GetStatus(), string(model.StepStatusReturned))

	// 再次提交即再次发起，流程回到办理站。
	h.mustSubmit(starter, core.Choices{})
	wantEqual(t, "再次发起后的当前站", h.current(h.agg()).GetNodeId(), "n1")
}

// E6 回退到指定步骤：目标必须是本实例走过的、在本步之前的办理 / 审批步骤；人工发起的实例
// 另含发起步骤（退到发起步骤的行为见 back_start_target_test.go）。
func TestE6_SpecifiedStepTargets(t *testing.T) {
	h := atApprove(t)
	agg := h.agg()
	targets := core.BackTargets(agg)
	if len(targets) != 2 || targets[0].GetNodeId() != "n0" || targets[1].GetNodeId() != "n1" {
		t.Fatalf("可选回退目标应是发起 + 部门办理两步（按到达顺序），实得 %v", stepLines(&pb.InstanceAggregate{Steps: targets}))
	}

	// 不在本步之前的步骤不是合法目标：点名当前这一步自己。
	_, err := h.press(liSi, "b-no", "金额不对", h.step(agg, "n4", "ACTIVE").GetStepId())
	wantCode(t, err, "BACK_TARGET_INVALID")

	// 不给目标也不行。
	_, err = h.press(liSi, "b-no", "金额不对", "")
	wantCode(t, err, "BACK_TARGET_REQUIRED")
}

// D4 / E4 多人办理时一人回退，整步立即回退，其余人未完成的任务撤销。
func TestD4_BackWithdrawsSiblingTasks(t *testing.T) {
	c := f3()
	c.Nodes[1].StaticUserIDs = []int64{22, 44} // 部门办理两个人
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 44}})

	d, err := h.back(wangFang, model.WithdrawMethodInitiator, "", "")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(d)

	other := h.task(h.agg(), zhaoWu.UserID, "")
	wantEqual(t, "同步其余任务状态", other.GetStatus(), string(model.TaskStatusWithdrawn))
	wantEqual(t, "撤销原因", other.GetWithdrawReason(), string(model.TaskWithdrawStepReturned))
}

// C5 回退后目标步骤重新选人时，「上一步处理人」这一类来源要以**回退人**为基准——不是从账本
// 往前找到的某个更早的人。这一条只有关系型来源才看得出来，所以用 RecordingCandidate 直接验
// 引擎传给候选计算的前手清单。
func TestC5_BackPassesBackActorAsPreviousHandler(t *testing.T) {
	h := atApprove(t)
	h.cand.LastPrev = nil
	d, err := h.press(liSi, "b-prev", "请重填", "")
	if err != nil {
		t.Fatalf("press b-prev: %v", err)
	}
	h.commit(d)
	if len(h.cand.LastPrev) != 1 || h.cand.LastPrev[0] != liSi.UserID {
		t.Fatalf("回退后重新选人时的前手应当是回退人 %d，实得 %v", liSi.UserID, h.cand.LastPrev)
	}
}

// 审批站不接受「提交」这个动作：接口是公开的，只靠前端不画提交按钮挡不住——绕过去就等于
// 跳过了按钮校验、理由必填与结果 / 理由写字段三件事。
func TestN3_SubmitRejectedOnApprovalStep(t *testing.T) {
	h := atApprove(t)
	_, err := h.submit(liSi, core.Choices{})
	wantCode(t, err, "TASK_NOT_ACTIONABLE")
}
