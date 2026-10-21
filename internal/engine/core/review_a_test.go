package core_test

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// review_a_test.go 是引擎四项边界规则的判据（审批站拒回退、上步处理人回溯等）。

// 审批站不接受「回退」这个动作——审批的回退只能来自按钮，否则跳过了理由必填、
// 结果 / 理由写字段，动作码也记成 BACK_* 而不是 BTN:<id>。与「审批站拒提交」同一句话。
func TestN3_ApproveStepRejectsBack(t *testing.T) {
	h := atApprove(t)
	// n4 配了「退回上一步」按钮，直接调 Back 带同一档回退方式也必须被拒。
	_, err := h.back(liSi, model.WithdrawMethodPreviousStep, "", "绕过按钮")
	wantCode(t, err, "TASK_NOT_ACTIONABLE")
	// 被拒后账本一动不动：审批任务仍是待办。
	wantEqual(t, "任务状态", h.task(h.agg(), liSi.UserID, "").GetStatus(), "PENDING")
}

// 审批任务没有「暂存」这一动作（审批不改内容，没有暂存）。放行会让任务转 SAVED，
// 上一站提交人撤销时被 G2「没有人暂存」误伤。
func TestN3_ApproveStepRejectsSave(t *testing.T) {
	h := atApprove(t)
	_, err := h.save(liSi)
	wantCode(t, err, "TASK_NOT_ACTIONABLE")
	wantEqual(t, "任务状态", h.task(h.agg(), liSi.UserID, "").GetStatus(), "PENDING")
}

// 回退类按钮确认时同样要把结果标识与理由写进绑定字段——规则写的是「确认时」，
// 不分按钮种类。审批人点「拒绝」后单据上的「审批结果」要变成「已拒绝」、理由要进「审批意见」。
func TestN3_3_BackButtonWritesResultAndReason(t *testing.T) {
	h := atApprove(t)
	target := h.step(h.agg(), "n1", "").GetStepId()
	d, err := h.press(liSi, "b-no", "金额超预算", target)
	if err != nil {
		t.Fatalf("press b-no: %v", err)
	}
	w := d.PendingApproveWrite
	if w == nil {
		t.Fatal("回退类按钮确认时也应交出一份待写内容（结果 + 理由）")
	}
	wantEqual(t, "结果字段", w.ResultFieldID, "f-status")
	wantEqual(t, "结果标识", w.ResultTag, "已拒绝")
	wantEqual(t, "理由字段", w.ReasonFieldID, "f-reason")
	wantEqual(t, "理由", w.Reason, "金额超预算")

	h.commit(d)
	agg := h.agg()
	wantEqual(t, "动作码", h.task(agg, liSi.UserID, "DONE").GetActionCode(), "BTN:b-no")
	wantEqual(t, "审批步结果", h.step(agg, "n4", "").GetStatus(), string(model.StepStatusReturned))
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n1")
}

// A4 反向：回退按钮在目标站选不出人时回退不成立，绑定字段也不能写——否则单据上写着
// 「已拒绝」，流程却还停在审批站。
func TestN3_3_BackButtonNoCandidateDoesNotWrite(t *testing.T) {
	h := atApprove(t)
	h.cand.Force, h.cand.Forced = true, nil // 目标站零候选
	target := h.step(h.agg(), "n1", "").GetStepId()
	d, err := h.press(liSi, "b-no", "金额超预算", target)
	if err != nil {
		t.Fatalf("press b-no: %v", err)
	}
	wantKind(t, d, core.OutcomeNoCandidate)
	if d.PendingApproveWrite != nil {
		t.Fatal("回退不成立时绑定字段不写入")
	}
}

// fA5 四站链：发起 → 部门办理（王芳）→ 财务复核（李四）→ 总经理审批（赵五）→ 结束。
// 用来验 A5「上步处理人」在三站以上的链上取的是**紧邻的上一站**的人。
func fA5() *compile.CompiledDefinition {
	c := f2()
	c.Nodes = append(c.Nodes, compile.NodeCompiled{NodeID: "n5", NodeKind: "HANDLE", NodeName: "总经理审批", PassRule: "ANY", PassRatio: 100, StaticUserIDs: []int64{44}})
	c.Links = []compile.LinkCompiled{
		{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
		{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n3", IsMain: true},
		{LinkID: "l3", FromNodeID: "n3", ToNodeID: "n5", IsMain: true},
		{LinkID: "l4", FromNodeID: "n5", ToNodeID: "n2", IsMain: true},
	}
	return c
}

// 三站以上的链上，「上步处理人」是刚刚提交的那一站办过的人，不是更早一站的人。
// 若只从决策前快照回溯，本次提交人的任务在快照里仍是 PENDING，于是会算成上上一站
// （两站流程恰好靠发起人兜底看不出来；三站链期望 [李四]，错误实现会得到 [王芳]）。
func TestA5_ThreeStationChain(t *testing.T) {
	h := newHarness(t, fA5())
	h.mustStart(starter, core.Choices{})
	// 王芳提交 → 到达财务复核：前手是王芳（本次提交人，与快照无关）。
	h.cand.LastPrev = nil
	h.mustSubmit(wangFang, core.Choices{})
	if len(h.cand.LastPrev) != 1 || h.cand.LastPrev[0] != wangFang.UserID {
		t.Fatalf("到达财务复核时的前手应是王芳 %d，实得 %v", wangFang.UserID, h.cand.LastPrev)
	}
	// 李四提交 → 到达总经理审批：前手是李四，不是王芳。
	h.cand.LastPrev = nil
	h.mustSubmit(liSi, core.Choices{})
	if len(h.cand.LastPrev) != 1 || h.cand.LastPrev[0] != liSi.UserID {
		t.Fatalf("到达总经理审批时的前手应是李四 %d，实得 %v", liSi.UserID, h.cand.LastPrev)
	}
	wantEqual(t, "当前站", h.current(h.agg()).GetNodeId(), "n5")
}

// A5 多人：上一站两人一起办、由第二个人踩过关线时，前手是这一步办过的**全部**人（含本次提交人）。
func TestA5_MultiActorStepIncludesSubmitter(t *testing.T) {
	c := fA5()
	c.Nodes[1].StaticUserIDs = []int64{22, 44} // 部门办理：王芳 + 赵五，全部通过
	c.Nodes[1].PassRule, c.Nodes[1].PassRatio = "RATIO", 100
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 44}})
	h.mustSubmit(zhaoWu, core.Choices{})
	h.cand.LastPrev = nil
	h.mustSubmit(wangFang, core.Choices{}) // 过关线
	got := h.cand.LastPrev
	if len(got) != 2 {
		t.Fatalf("前手应是部门办理两人 [44 22]，实得 %v", got)
	}
	seen := map[int64]bool{got[0]: true, got[1]: true}
	if !seen[22] || !seen[44] {
		t.Fatalf("前手应包含王芳与赵五，实得 %v", got)
	}
}
