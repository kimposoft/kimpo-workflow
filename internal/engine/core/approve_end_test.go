package core_test

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// approve_end_test.go 覆盖审批按钮「不通过并结束流程」（end_flow）的引擎层。

// fEndFlow 夹具：发起 → 审批 n4（审批人 approvers，过关规则由 rule/ratio 定）→ 结束 n2「已通过」；
// n3「已拒绝」是没有入线的结束节点，只被 b-end 按钮指向。审批节点绑了结果与理由两个字段。
// endWriteField 是「已拒绝」结束节点的结束标识写入字段（空 = 不写）。
func fEndFlow(approvers []int64, rule string, ratio int32, endWriteField string) *compile.CompiledDefinition {
	buttons, _ := json.Marshal([]model.ApprovalButton{
		{ID: "b-ok", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "已通过"},
		{ID: "b-end", Name: "不通过并结束", Action: model.ButtonActionEndFlow, ResultTag: "审批未通过", RequireReason: true, EndNodeID: "n3"},
	})
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no", Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n4", NodeKind: "APPROVE", NodeName: "财务审批", NoRouteHint: "审批后没有可走的路线", PassRule: rule, PassRatio: ratio, StaticUserIDs: approvers,
				ApproveButtonsJSON: string(buttons), ResultFieldID: "f-status", ReasonFieldID: "f-reason"},
			{NodeID: "n2", NodeKind: "END", NodeName: "已通过", EndLabel: "已通过"},
			{NodeID: "n3", NodeKind: "END", NodeName: "已拒绝", EndLabel: "已拒绝", EndLabelFieldID: endWriteField},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n4", IsMain: true},
			{LinkID: "l2", FromNodeID: "n4", ToNodeID: "n2", IsMain: true},
		},
	}
}

// 单人审批点该按钮：实例直达 n3 结束；账本、进度图所需的关联都对；不产生新待办。
func TestN3_7_EndFlowSingleApprover(t *testing.T) {
	h := newHarness(t, fEndFlow([]int64{33}, "ANY", 100, ""))
	h.mustStart(starter, core.Choices{})
	apprStep := h.step(h.agg(), "n4", "ACTIVE")

	d, err := h.press(liSi, "b-end", "材料不合规", "")
	if err != nil {
		t.Fatalf("press: %v", err)
	}
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "outcome status", d.Outcome.Status, "ENDED")
	wantEqual(t, "outcome end label", d.Outcome.EndLabel, "已拒绝")
	// 结果标识与理由交给 app 层写进绑定字段。
	w := d.PendingApproveWrite
	if w == nil {
		t.Fatal("配了绑定字段，应交出待写内容")
	}
	wantEqual(t, "结果字段", w.ResultFieldID, "f-status")
	wantEqual(t, "结果标识", w.ResultTag, "审批未通过")
	wantEqual(t, "理由字段", w.ReasonFieldID, "f-reason")
	wantEqual(t, "理由", w.Reason, "材料不合规")
	if d.EndedByButton == nil || d.EndedByButton.EndNodeID != "n3" || d.EndedByButton.ButtonID != "b-end" {
		t.Fatalf("应带上报信息，实得 %+v", d.EndedByButton)
	}
	h.commit(d)

	agg := h.agg()
	inst := agg.GetInstance()
	wantEqual(t, "status", inst.GetStatus(), "ENDED")
	wantEqual(t, "end label", inst.GetEndLabel(), "已拒绝")
	wantEqual(t, "end node", inst.GetEndNodeId(), "n3")
	wantEqual(t, "current cleared", inst.GetCurrentStepId(), "")
	// 审批步骤 PASSED / SUBMITTED，没走线所以 RouteLinkId 为空；不计过关票。
	appr := h.step(agg, "n4", "PASSED")
	wantEqual(t, "审批步骤", appr.GetStepId(), apprStep.GetStepId())
	wantEqual(t, "审批步骤结果", appr.GetOutcome(), string(model.StepOutcomeSubmitted))
	wantEqual(t, "RouteLinkId", appr.GetRouteLinkId(), "")
	wantEqual(t, "PassedCount 不计", appr.GetPassedCount(), int32(0))
	// 结束步骤：ENDED，来源是审批步骤（进度图画按钮直达段用）。
	end := h.step(agg, "n3", "PASSED")
	wantEqual(t, "结束步骤结果", end.GetOutcome(), string(model.StepOutcomeEnded))
	wantEqual(t, "EnteredFromStepId", end.GetEnteredFromStepId(), apprStep.GetStepId())
	// 任务行。
	done := h.task(agg, liSi.UserID, "DONE")
	wantEqual(t, "动作码", done.GetActionCode(), "BTN:b-end")
	wantEqual(t, "说明", done.GetComment(), "材料不合规")
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" || tk.GetStatus() == "SAVED" {
			t.Fatalf("结束后不应有待办：%v", taskLines(agg))
		}
	}
}

// N3.8 会签：一人同意后另一人点该按钮，实例立即结束；剩余人任务撤销（STEP_ENDED），已同意者保持 DONE。
func TestN3_8_EndFlowVetoesMultiSign(t *testing.T) {
	h := newHarness(t, fEndFlow([]int64{22, 33, 44}, "RATIO", 100, ""))
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 33, 44}})
	// 王芳先同意（会签未到线，步骤仍 ACTIVE）。
	d, err := h.press(wangFang, "b-ok", "", "")
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)
	wantEqual(t, "仍在审批站", h.agg().GetInstance().GetStatus(), "RUNNING")

	// 李四点「不通过并结束」：不等赵五，整步立即结束。
	d, err = h.press(liSi, "b-end", "不通过", "")
	if err != nil {
		t.Fatal(err)
	}
	wantEqual(t, "撤销任务数", len(d.EndedByButton.WithdrawnTaskIDs), 1)
	h.commit(d)

	agg := h.agg()
	wantEqual(t, "status", agg.GetInstance().GetStatus(), "ENDED")
	wantEqual(t, "end node", agg.GetInstance().GetEndNodeId(), "n3")
	zhao := h.task(agg, zhaoWu.UserID, "")
	wantEqual(t, "赵五任务", zhao.GetStatus(), "WITHDRAWN")
	wantEqual(t, "撤销原因", zhao.GetWithdrawReason(), string(model.TaskWithdrawStepEnded))
	wang := h.task(agg, wangFang.UserID, "")
	wantEqual(t, "已同意者保持 DONE", wang.GetStatus(), "DONE")
	wantEqual(t, "已同意者动作码", wang.GetActionCode(), "BTN:b-ok")
	wantEqual(t, "点击者", h.task(agg, liSi.UserID, "").GetStatus(), "DONE")
}

// N3.8 或签 / 按比例：一人点该按钮即结束（不受过关线影响）。
func TestN3_8_EndFlowVetoesAnyAndRatio(t *testing.T) {
	cases := []struct {
		name  string
		rule  string
		ratio int32
	}{{"或签", "ANY", 100}, {"按比例", "RATIO", 67}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, fEndFlow([]int64{22, 33, 44}, c.rule, c.ratio, ""))
			h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 33, 44}})
			d, err := h.press(zhaoWu, "b-end", "否决", "")
			if err != nil {
				t.Fatal(err)
			}
			h.commit(d)
			agg := h.agg()
			wantEqual(t, "status", agg.GetInstance().GetStatus(), "ENDED")
			wantEqual(t, "end node", agg.GetInstance().GetEndNodeId(), "n3")
			for _, u := range []int64{22, 33} {
				tk := h.task(agg, u, "")
				wantEqual(t, "其余人任务", tk.GetStatus(), "WITHDRAWN")
				wantEqual(t, "撤销原因", tk.GetWithdrawReason(), string(model.TaskWithdrawStepEnded))
			}
		})
	}
}

// N3.9 目标结束节点配了写入字段：走两段式，结束标识最终落字段；结果绑定字段与结束写入字段
// 是同一字段（f-status）时，app 层先写结果标识、后写结束标识，以结束标识为准。
func TestN3_9_EndFlowEndWriteTwoPhase(t *testing.T) {
	h := newHarness(t, fEndFlow([]int64{33}, "ANY", 100, "f-status"))
	h.mustStart(starter, core.Choices{})
	d, err := h.press(liSi, "b-end", "不通过", "")
	if err != nil {
		t.Fatal(err)
	}
	if d.PendingEndWrite == nil || d.PendingEndWrite.FieldID != "f-status" || d.PendingEndWrite.Label != "已拒绝" {
		t.Fatalf("应带结束标识待写，实得 %+v", d.PendingEndWrite)
	}
	if d.PendingApproveWrite == nil || d.PendingApproveWrite.ResultFieldID != "f-status" {
		t.Fatalf("结果字段与结束写入字段同为 f-status：%+v", d.PendingApproveWrite)
	}
	h.commit(d)
	agg := h.agg()
	wantEqual(t, "status", agg.GetInstance().GetStatus(), "ENDED")
	wantEqual(t, "end label", agg.GetInstance().GetEndLabel(), "已拒绝")
	wantEqual(t, "writes", len(h.rec.Writes), 1)
	wantEqual(t, "write", h.rec.Writes[0].FieldID+"="+h.rec.Writes[0].TextValue, "f-status=已拒绝")
	inc := agg.GetIncidents()[0]
	wantEqual(t, "incident", inc.GetStatus(), "RESOLVED")
}

// N3.11 运行期防御：目标不存在 / 不是结束节点 → SYSTEM_ERROR，账本无任何变化。
func TestN3_11_EndFlowRuntimeTargetInvalid(t *testing.T) {
	for name, target := range map[string]string{"目标不存在": "ghost", "目标不是结束节点": "n4"} {
		t.Run(name, func(t *testing.T) {
			c := fEndFlow([]int64{33}, "ANY", 100, "")
			buttons, _ := json.Marshal([]model.ApprovalButton{
				{ID: "b-end", Name: "不通过并结束", Action: model.ButtonActionEndFlow, ResultTag: "x", EndNodeID: target},
			})
			c.Nodes[1].ApproveButtonsJSON = string(buttons)
			h := newHarness(t, c)
			h.mustStart(starter, core.Choices{})
			before := h.agg()
			verBefore := before.GetInstance().GetVersion()
			nTasks, nSteps := len(before.GetTasks()), len(before.GetSteps())

			d, err := h.press(liSi, "b-end", "", "")
			wantCode(t, err, "SYSTEM_ERROR")
			if d != nil {
				t.Fatalf("被拒时不应有决策：%+v", d)
			}
			after := h.agg()
			wantEqual(t, "version", after.GetInstance().GetVersion(), verBefore)
			wantEqual(t, "tasks", len(after.GetTasks()), nTasks)
			wantEqual(t, "steps", len(after.GetSteps()), nSteps)
			wantEqual(t, "status", after.GetInstance().GetStatus(), before.GetInstance().GetStatus())
			wantEqual(t, "任务仍待办", h.task(after, liSi.UserID, "PENDING").GetStatus(), "PENDING")
		})
	}
}

// N3.10 该按钮不触发 L9 支线；同一节点点「同意」则照常触发（对照）。
func TestN3_10_EndFlowDoesNotFireBranch(t *testing.T) {
	// build 造一份审批节点挂了支线抄送的实例，停在审批站。
	build := func() *harness {
		c := fEndFlow([]int64{33}, "ANY", 100, "")
		c.Nodes = append(c.Nodes, ccNodeCompiled("cc1", "知会财务", []int64{44}, true))
		c.Links = append(c.Links, compile.LinkCompiled{LinkID: "l-cc", FromNodeID: "n4", ToNodeID: "cc1", IsMain: false})
		h := newHarness(t, c)
		presetCCText(h, "cc1")
		h.mustStart(starter, core.Choices{})
		return h
	}
	pressCommit := func(h *harness, buttonID, reason string) {
		d, err := h.press(liSi, buttonID, reason, "")
		if err != nil {
			t.Fatalf("press %s: %v", buttonID, err)
		}
		h.commit(d)
	}
	// 对照：同意 → 支线触发（抄送行落库）。
	ok := build()
	pressCommit(ok, "b-ok", "")
	if len(ccRowsOf(ok.agg())) == 0 {
		t.Fatal("对照：点同意应触发支线抄送")
	}
	// 不通过并结束 → 支线不触发。
	end := build()
	pressCommit(end, "b-end", "不通过")
	agg := end.agg()
	wantEqual(t, "status", agg.GetInstance().GetStatus(), "ENDED")
	if rows := ccRowsOf(agg); len(rows) != 0 {
		t.Fatalf("不应触发支线抄送，实得 %+v", rows)
	}
	for _, s := range agg.GetSteps() {
		if s.GetNodeId() == "cc1" {
			t.Fatalf("不应有抄送步骤：%v", stepLines(agg))
		}
	}
}

// N5.3 结束后：对该实例撤销发起、回退、再点按钮均被拒。
func TestN5_3_EndedByButtonRejectsFurtherActions(t *testing.T) {
	h := newHarness(t, fEndFlow([]int64{22, 33}, "RATIO", 100, ""))
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 33}})
	d, err := h.press(wangFang, "b-end", "不通过", "")
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)
	agg := h.agg()
	wantEqual(t, "status", agg.GetInstance().GetStatus(), "ENDED")

	// 再点按钮：被撤销的任务与已结束实例都拒（按实例已结束报）。
	_, err = h.eng.PressButton(h.ctx(), core.ApproveInput{
		TaskInput: core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, liSi.UserID, "").GetTaskId(), Actor: liSi},
		ButtonID:  "b-ok",
	})
	wantCode(t, err, "INSTANCE_ENDED")
	// 回退：同样被拒。
	_, err = h.eng.Back(h.ctx(), core.BackInput{
		TaskInput: core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, liSi.UserID, "").GetTaskId(), Actor: liSi},
		Method:    model.WithdrawMethodInitiator,
	})
	wantCode(t, err, "INSTANCE_ENDED")
	// 撤销发起：被拒。
	if _, err := h.eng.WithdrawStart(h.ctx(), appID, agg, starter); err == nil {
		t.Fatal("已结束的实例不应能撤销发起")
	}
	// 撤回已点击的一票也被拒。
	if _, err := h.eng.Withdraw(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, wangFang.UserID, "DONE").GetTaskId(), Actor: wangFang}); err == nil {
		t.Fatal("已结束的实例不应能撤回一票")
	}
}
