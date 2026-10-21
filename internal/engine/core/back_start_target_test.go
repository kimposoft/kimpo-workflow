package core_test

import (
	"encoding/json"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// —— 人工发起的实例里，发起步骤也是合法的回退目标 ——
//
// 若发起步骤不在「回退到指定步骤」的候选里，发起后的第一个人工节点若只勾了「回退到
// 指定步骤」（或「上一步 + 指定步骤」），办理面会弹出一个没有候选、永远点不了确认的回退框。
// 因此：发起步骤列入候选；「回退到上一步」在前面没有人工步骤时退到发起步骤；不论经哪一档
// 退到发起步骤，都让发起任务回到待办、不新开步骤。非人工发起的实例不适用。

// fAllBackMethods 把 f3 的第一站改成三档回退全开，用来验「上一步 / 指定步骤」都能退到发起步骤。
func fAllBackMethods() *compile.CompiledDefinition {
	c := f3()
	allowed, _ := json.Marshal([]model.WithdrawMethod{model.WithdrawMethodPreviousStep, model.WithdrawMethodInitiator, model.WithdrawMethodSpecified})
	c.Nodes[1].AllowedWithdrawsJSON = string(allowed)
	return c
}

// wantBackedToStart 断言一次回退落在发起步骤上：当前站就是原发起步骤（没有新开步骤），发起人
// 的发起任务回到待办且回到待办次数 +1，回退发生的那一步记为已回退。
func wantBackedToStart(t *testing.T, h *harness, startStepID, returnedNodeID string) {
	t.Helper()
	agg := h.agg()
	wantEqual(t, "当前站就是原发起步骤（不新开步骤）", h.current(agg).GetStepId(), startStepID)
	st := h.task(agg, starter.UserID, "PENDING")
	if st == nil {
		t.Fatalf("发起人应当重新拿到发起任务：%v", taskLines(agg))
	}
	wantEqual(t, "回到待办次数", st.GetReopenCount(), int32(1))
	wantEqual(t, "回退发生的那一步已回退", h.step(agg, returnedNodeID, "").GetStatus(), string(model.StepStatusReturned))
}

// 第一个人工节点上「回退到指定步骤」的候选就是发起步骤；选中后发起任务回到待办。
// 这一场景下候选不能为空。
func TestBackToStart_SpecifiedStepCanTargetStartStep(t *testing.T) {
	h := newHarness(t, fAllBackMethods())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	startStepID := h.step(agg, "n0", "").GetStepId()

	targets := core.BackTargets(agg)
	if len(targets) != 1 || targets[0].GetStepId() != startStepID {
		t.Fatalf("第一个人工节点的可选回退目标应当只有发起步骤，实得 %v", stepLines(&pb.InstanceAggregate{Steps: targets}))
	}

	d, err := h.back(wangFang, model.WithdrawMethodSpecified, startStepID, "请补充说明")
	if err != nil {
		t.Fatalf("回退到发起步骤应当被允许：%v", err)
	}
	h.commit(d)
	wantBackedToStart(t, h, startStepID, "n1")
	// 动作码仍记用户实际选的那一档（指定步骤），不因目标是发起步骤改记成「回退到发起人」。
	wantEqual(t, "动作码", h.task(h.agg(), wangFang.UserID, "DONE").GetActionCode(), string(model.TaskActionBackStep))

	// 发起人提交即再次发起，流程回到办理站。
	h.mustSubmit(starter, core.Choices{})
	wantEqual(t, "再次发起后的当前站", h.current(h.agg()).GetNodeId(), "n1")
}

// 前面没有任何办理 / 审批步骤时，「回退到上一步」退到发起步骤；预告里这一档也照常报给界面。
func TestBackToStart_PreviousStepFallsBackToStartStep(t *testing.T) {
	h := newHarness(t, fAllBackMethods())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	startStepID := h.step(agg, "n0", "").GetStepId()

	info, err := core.Preview(appID, agg, h.task(agg, wangFang.UserID, "PENDING").GetTaskId(), wangFang.UserID)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	var hasPrev bool
	for _, m := range info.AllowedBackMethods {
		if m == model.WithdrawMethodPreviousStep {
			hasPrev = true
		}
	}
	if !hasPrev {
		t.Fatalf("第一个人工节点勾了「回退到上一步」，预告应当把这一档报给界面，实得 %v", info.AllowedBackMethods)
	}

	d, err := h.back(wangFang, model.WithdrawMethodPreviousStep, "", "")
	if err != nil {
		t.Fatalf("回退到上一步应当退到发起步骤：%v", err)
	}
	h.commit(d)
	wantBackedToStart(t, h, startStepID, "n1")
}

// 审批节点的「回退到指定步骤」按钮同样可以选发起步骤；候选按到达顺序，发起步骤排第一。
func TestBackToStart_ApproveButtonCanTargetStartStep(t *testing.T) {
	h := atApprove(t)
	agg := h.agg()
	startStepID := h.step(agg, "n0", "").GetStepId()

	targets := core.BackTargets(agg)
	if len(targets) != 2 || targets[0].GetStepId() != startStepID || targets[1].GetNodeId() != "n1" {
		t.Fatalf("可选回退目标应当是发起步骤 + 部门办理，实得 %v", stepLines(&pb.InstanceAggregate{Steps: targets}))
	}

	d, err := h.press(liSi, "b-no", "金额不对", startStepID)
	if err != nil {
		t.Fatalf("按钮回退到发起步骤应当被允许：%v", err)
	}
	h.commit(d)
	wantBackedToStart(t, h, startStepID, "n4")
}

// 非人工发起的实例没有发起表单可回：发起步骤不进候选、点名它报「目标不合法」、
// 「回退到上一步」在前面没有人工步骤时照旧报「找不到目标」（与非人工发起的降级同源）。
func TestBackToStart_NonManualStartExcludesStartStep(t *testing.T) {
	h := newHarness(t, fAllBackMethods())
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter, StartKind: model.StartKindSubflow})
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)
	agg := h.agg()

	if targets := core.BackTargets(agg); len(targets) != 0 {
		t.Fatalf("非人工发起的实例，发起步骤不应当进候选，实得 %v", stepLines(&pb.InstanceAggregate{Steps: targets}))
	}
	_, err = h.back(wangFang, model.WithdrawMethodSpecified, h.step(agg, "n0", "").GetStepId(), "")
	wantCode(t, err, "BACK_TARGET_INVALID")
	_, err = h.back(wangFang, model.WithdrawMethodPreviousStep, "", "")
	wantCode(t, err, "BACK_TARGET_NOT_FOUND")
}

// 非人工发起的实例把「回退到发起人」降级为「回退到上一步」后，目标是一个
// 普通人工步骤，必须在目标节点新开一步，不能走「发起任务回到待办」那条路把旧步骤复活。
func TestBackToStart_DowngradedInitiatorBackOpensNewStep(t *testing.T) {
	h := newHarness(t, fInitiatorBackChain())
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter, StartKind: model.StartKindSubflow})
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)
	oldN1 := h.step(h.agg(), "n1", "ACTIVE").GetStepId()
	h.mustSubmit(wangFang, core.Choices{}) // n1 -> n3

	bd, err := h.back(liSi, model.WithdrawMethodInitiator, "", "")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(bd)

	cur := h.current(h.agg())
	wantEqual(t, "当前站", cur.GetNodeId(), "n1")
	if cur.GetStepId() == oldN1 {
		t.Fatal("降级后是普通的「回退到上一步」，应当在目标节点新开一步，不是复活旧步骤")
	}
}
