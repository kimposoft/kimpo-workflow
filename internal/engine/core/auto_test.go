package core_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// f4『自动办理』夹具：发起 → 部门办理（王芳）→ 自动复核（李四，配自动办理条件 p-auto）
// → 财务终审（赵五）→ 结束。三站都无条件出线，条件真假由用例逐个摆。
func f4() *compile.CompiledDefinition {
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no", Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门办理", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{22}},
			{NodeID: "n5", NodeKind: "HANDLE", NodeName: "自动复核", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{33},
				AutoConditionPubID: "p-auto", AutoConditionDocJSON: `{"mode":"condition"}`},
			{NodeID: "n6", NodeKind: "HANDLE", NodeName: "财务终审", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{44}},
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n5", IsMain: true},
			{LinkID: "l3", FromNodeID: "n5", ToNodeID: "n6", IsMain: true},
			{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n2", IsMain: true},
		},
	}
}

// F1 条件为假：本站按人工走，派任务给李四。
func TestF1_ConditionFalseGoesManual(t *testing.T) {
	h := newHarness(t, f4())
	h.expr.Conditions["p-auto"] = false
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n5")
	wantEqual(t, "自动办理标记", h.current(agg).GetAutoHandled(), false)
	wantEqual(t, "李四待办", h.task(agg, liSi.UserID, "PENDING").GetStatus(), "PENDING")
}

// F2 / F3 条件为真：本站不派任务、记为系统自动办理，流程直接推到下一站。
func TestF2_AutoHandledStepCarriesNoTask(t *testing.T) {
	h := newHarness(t, f4())
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	auto := h.step(agg, "n5", "")
	wantEqual(t, "自动步骤状态", auto.GetStatus(), string(model.StepStatusPassed))
	wantEqual(t, "自动步骤结果", auto.GetOutcome(), string(model.StepOutcomeAuto))
	wantEqual(t, "自动办理标记", auto.GetAutoHandled(), true)
	if len(h.agg().GetTasks()) != 3 { // 发起 + 王芳 + 赵五，自动步骤一条任务都没有
		t.Fatalf("自动办理的步骤不该派任务：%v", taskLines(agg))
	}
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n6")
	wantEqual(t, "赵五待办", h.task(agg, zhaoWu.UserID, "PENDING").GetStatus(), "PENDING")
}

// F3 自动办理之后的节点若要选人，默认选中全部候选、不弹对话框。
func TestF3_AutoSelectsAllCandidates(t *testing.T) {
	c := f4()
	c.Nodes[3].StaticUserIDs = []int64{44, 22} // 财务终审两个候选
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)

	agg := h.agg()
	wantEqual(t, "本步选中人数", h.current(agg).GetAssigneeCount(), int32(2))
}

// F4 出线多条成立需要人选：停止自动办理，本站改按人工走。
func TestF4_MultipleRoutesStopsAuto(t *testing.T) {
	c := f4()
	c.Links = append(c.Links, compile.LinkCompiled{LinkID: "l5", FromNodeID: "n5", ToNodeID: "n2", IsMain: true})
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n5")
	wantEqual(t, "自动办理标记", h.current(agg).GetAutoHandled(), false)
	wantEqual(t, "李四待办", h.task(agg, liSi.UserID, "PENDING").GetStatus(), "PENDING")
}

// F5 出线一条都不成立：同 F4，改人工（由人来面对无路可走）。
func TestF5_NoRouteStopsAuto(t *testing.T) {
	c := f4()
	c.Links[2].ConditionPublicationID, c.Links[2].ConditionDocumentJSON = "p-l3", `{"mode":"condition"}`
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.expr.Conditions["p-l3"] = false
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n5")
	wantEqual(t, "自动办理标记", h.current(agg).GetAutoHandled(), false)
}

// F6 连续自动办理有上限：两个自动节点互相指向会形成死循环，超过上限即停下标为事故。
func TestF6_AutoChainLimitParks(t *testing.T) {
	c := f4()
	// n5 与 n6 都自动，且 n6 指回 n5，形成环。
	c.Nodes[3].AutoConditionPubID, c.Nodes[3].AutoConditionDocJSON = "p-auto", `{"mode":"condition"}`
	c.Links[3] = compile.LinkCompiled{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n5", IsMain: true}
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})

	wantKind(t, d, core.OutcomeParked)
	agg := h.agg()
	wantEqual(t, "实例状态", agg.GetInstance().GetStatus(), string(model.InstanceStatusParked))
	if len(agg.GetIncidents()) != 1 || agg.GetIncidents()[0].GetKind() != string(model.IncidentAutoChainLimit) {
		t.Fatalf("应挂一条自动办理链超长的事故，实得 %+v", agg.GetIncidents())
	}
	// 停驻那一步不该被标成「系统已自动办理」——它其实没被办掉。
	wantEqual(t, "停驻步骤的自动标记", h.current(agg).GetAutoHandled(), false)
}

// F7 条件求值报错视为假、改人工、流程不停。
func TestF7_EvalErrorGoesManual(t *testing.T) {
	h := newHarness(t, f4())
	h.expr.CondErr["p-auto"] = errors.New("expression service down")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n5")
	wantEqual(t, "李四待办", h.task(agg, liSi.UserID, "PENDING").GetStatus(), "PENDING")
}

// G8 提交到下一站之间经过了自动办理步骤的，照样可以撤销；自动步骤的记录作废。
func TestG8_WithdrawAcrossAutoStep(t *testing.T) {
	h := newHarness(t, f4())
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatalf("隔着自动步骤应当可以撤销：%v", err)
	}
	agg := h.agg()
	wantEqual(t, "自动步骤已作废", h.step(agg, "n5", "").GetStatus(), string(model.StepStatusWithdrawn))
	wantEqual(t, "下一站已作废", h.step(agg, "n6", "").GetStatus(), string(model.StepStatusWithdrawn))
	wantEqual(t, "当前站回到部门办理", h.current(agg).GetNodeId(), "n1")
	wantEqual(t, "王芳任务回待办", h.task(agg, wangFang.UserID, "PENDING").GetStatus(), "PENDING")
}

// G5 本步过关前每人可以撤回自己的提交，撤回后通过数减一，流程一步没动。
func TestG5_WithdrawOwnVoteBeforePass(t *testing.T) {
	c := f4()
	c.Nodes[1].StaticUserIDs = []int64{22, 44}
	c.Nodes[1].PassRule, c.Nodes[1].PassRatio = "RATIO", 100 // 两个人都通过才过关
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 44}})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "尚未过关", h.current(agg).GetNodeId(), "n1")
	wantEqual(t, "通过数", h.current(agg).GetPassedCount(), int32(1))

	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatalf("过关前应当可以撤回自己的提交：%v", err)
	}
	agg = h.agg()
	wantEqual(t, "撤回后通过数", h.current(agg).GetPassedCount(), int32(0))
	wantEqual(t, "任务回待办", h.task(agg, wangFang.UserID, "").GetStatus(), string(model.TaskStatusPending))
	wantEqual(t, "另一人不受影响", h.task(agg, zhaoWu.UserID, "").GetStatus(), string(model.TaskStatusPending))
}

// F6 停驻那条事故必须带停驻点：resume_point_json 是账本里的 JSON 列且非空，留空整笔提交会
// 死在数据库的「文档为空」上（表现是发起动作报「服务器内部错误」）。
func TestF6_ParkedIncidentCarriesResumePoint(t *testing.T) {
	c := f4()
	c.Nodes[3].AutoConditionPubID, c.Nodes[3].AutoConditionDocJSON = "p-auto", `{"mode":"condition"}`
	c.Links[3] = compile.LinkCompiled{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n5", IsMain: true}
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	incidents := h.agg().GetIncidents()
	if len(incidents) != 1 {
		t.Fatalf("应恰一条事故，实得 %d", len(incidents))
	}
	rp := incidents[0].GetResumePointJson()
	if rp == "" {
		t.Fatal("事故没带停驻点：落库时会被数据库按「JSON 文档为空」拒掉，整个动作变成系统错误")
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(rp), &got); err != nil {
		t.Fatalf("停驻点不是合法 JSON：%q（%v）", rp, err)
	}
	if got["action"] != "AUTO_CHAIN_LIMIT" || got["step_id"] == "" {
		t.Fatalf("停驻点应记下停在哪个节点的哪一步，实得 %v", got)
	}
}

// TestResumeAutoChainLimit_MultiCandidate AUTO_CHAIN_LIMIT 停驻点恢复——链条固定
// 停在 n5（深度 20 是偶数，n5/n6 交替第一个是 n5），把 n5 的候选改成两人，恢复后应按人工走 C
// 全选两人派发（AutoSelectAll，无人在场弹框）：事故 RESOLVED、实例回 RUNNING、当前站还是 n5
// 但两条待办都派出去了。
func TestResumeAutoChainLimit_MultiCandidate(t *testing.T) {
	c := f4()
	c.Nodes[3].AutoConditionPubID, c.Nodes[3].AutoConditionDocJSON = "p-auto", `{"mode":"condition"}`
	c.Links[3] = compile.LinkCompiled{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n5", IsMain: true}
	c.Nodes[2].StaticUserIDs = []int64{33, 44} // n5 候选改两人
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	parked := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, parked, core.OutcomeParked)
	incidentID := parked.Outcome.IncidentID

	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: h.agg(), IncidentID: incidentID, Actor: ports.Actor{UserID: 9, DisplayName: "管理员"}, Note: "已排查"})
	if err != nil {
		t.Fatalf("resume auto chain limit: %v", err)
	}
	h.rawCommit(rd.Changeset)
	wantKind(t, rd, core.OutcomeCommitted)

	agg := h.agg()
	wantEqual(t, "实例状态", agg.GetInstance().GetStatus(), string(model.InstanceStatusRunning))
	if agg.GetInstance().GetParkedIncidentId() != "" {
		t.Fatalf("恢复后不该再有停驻事故：%q", agg.GetInstance().GetParkedIncidentId())
	}
	cur := h.current(agg)
	wantEqual(t, "当前站仍是 n5", cur.GetNodeId(), "n5")
	wantEqual(t, "选中人数", cur.GetAssigneeCount(), int32(2))
	wantEqual(t, "李四待办", h.task(agg, liSi.UserID, "PENDING").GetStatus(), "PENDING")
	wantEqual(t, "赵五待办", h.task(agg, zhaoWu.UserID, "PENDING").GetStatus(), "PENDING")
	var resolved int
	for _, i := range agg.GetIncidents() {
		if i.GetIncidentId() == incidentID {
			wantEqual(t, "旧事故已解决", i.GetStatus(), string(model.IncidentStatusResolved))
			resolved++
		}
	}
	if resolved != 1 {
		t.Fatalf("旧事故应恰好一条且已解决，实得 %d", resolved)
	}
}

// TestResumeAutoChainLimit_NoCandidate 恢复时候选算出零人——步骤原地留 ACTIVE，
// 旧事故 RESOLVED 的同时立即再开一条同类事故重新停驻，交管理员下次再试。
func TestResumeAutoChainLimit_NoCandidate(t *testing.T) {
	c := f4()
	c.Nodes[3].AutoConditionPubID, c.Nodes[3].AutoConditionDocJSON = "p-auto", `{"mode":"condition"}`
	c.Links[3] = compile.LinkCompiled{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n5", IsMain: true}
	c.Nodes[2].StaticUserIDs = nil // n5 候选清空
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	parked := h.mustSubmit(wangFang, core.Choices{})
	incidentID := parked.Outcome.IncidentID

	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: h.agg(), IncidentID: incidentID, Actor: ports.Actor{UserID: 9}, Note: "再试一次"})
	if err != nil {
		t.Fatalf("resume auto chain limit with no candidate: %v", err)
	}
	h.rawCommit(rd.Changeset)
	wantKind(t, rd, core.OutcomeParked)
	if rd.Outcome.IncidentID == "" || rd.Outcome.IncidentID == incidentID {
		t.Fatalf("零候选应重新开一条新事故（不是复用旧事故 id）：%q vs 旧 %q", rd.Outcome.IncidentID, incidentID)
	}

	agg := h.agg()
	wantEqual(t, "实例仍停驻", agg.GetInstance().GetStatus(), string(model.InstanceStatusParked))
	wantEqual(t, "当前站仍是 n5", h.current(agg).GetNodeId(), "n5")
	var open, resolved int
	for _, i := range agg.GetIncidents() {
		switch i.GetStatus() {
		case string(model.IncidentStatusOpen):
			open++
		case string(model.IncidentStatusResolved):
			resolved++
		}
	}
	if open != 1 || resolved != 1 {
		t.Fatalf("应恰一条已解决旧事故与一条新开事故，实得 open=%d resolved=%d：%v", open, resolved, agg.GetIncidents())
	}
}

// 审批节点被自动办理通过时，结果绑定字段与理由绑定字段都不写入——没有人点按钮，
// 也就没有「这个按钮的结果标识」可写；系统替人走一步不等于替人表态。
func TestN3_5_AutoApproveWritesNoBoundFields(t *testing.T) {
	c := f4()
	// 把「自动复核」改成审批节点，配齐按钮与两个绑定字段，条件为真即自动通过。
	buttons, err := json.Marshal([]model.ApprovalButton{{ID: "b-ok", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "已通过"}})
	if err != nil {
		t.Fatal(err)
	}
	c.Nodes[2].NodeKind = "APPROVE"
	c.Nodes[2].ApproveButtonsJSON = string(buttons)
	c.Nodes[2].ResultFieldID, c.Nodes[2].ReasonFieldID = "f-status", "f-reason"

	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})

	if d.PendingApproveWrite != nil {
		t.Fatalf("自动通过不该写结果与理由，实得 %+v", d.PendingApproveWrite)
	}
	if len(h.rec.Writes) != 0 {
		t.Fatalf("自动通过不该对单据写任何字段，实得 %+v", h.rec.Writes)
	}
	auto := h.step(h.agg(), "n5", "")
	wantEqual(t, "自动办理标记", auto.GetAutoHandled(), true)
	wantEqual(t, "当前站", h.current(h.agg()).GetNodeId(), "n6")
}

// E5 回退目标是配了自动办理的节点时，到达后不触发自动办理，按人工走 C。
//
// 这条规则要能被触发，前提是「自动办理过的步骤可以被选作回退目标」——若把自动步骤从所有
// 回退档位里一并排除，这条规则就永远没有触发路径。判据分两半：
// 自动步骤在可选目标清单里；退过去之后那一步是人工的（派了任务、没标自动办理）。
func TestE5_BackToAutoNodeDoesNotReTriggerAuto(t *testing.T) {
	c := f4()
	allowed, err := json.Marshal([]model.WithdrawMethod{model.WithdrawMethodSpecified})
	if err != nil {
		t.Fatal(err)
	}
	c.Nodes[3].AllowedWithdrawsJSON = string(allowed) // 财务终审允许「回退到指定步骤」
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{}) // n5 自动通过，流程到 n6 赵五

	agg := h.agg()
	autoStep := h.step(agg, "n5", "")
	wantEqual(t, "n5 确实是自动办理的", autoStep.GetAutoHandled(), true)

	targets := core.BackTargets(agg)
	var found bool
	for _, s := range targets {
		if s.GetStepId() == autoStep.GetStepId() {
			found = true
		}
	}
	if !found {
		t.Fatalf("自动办理过的步骤应当可以被选作回退目标（否则 E5 永远触发不到），可选清单 %v", stepLines(&pb.InstanceAggregate{Steps: targets}))
	}

	// 赵五回退到那个自动节点。
	task := h.task(agg, zhaoWu.UserID, "PENDING")
	d, err := h.eng.Back(h.ctx(), core.BackInput{
		TaskInput: core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: zhaoWu},
		Method:    model.WithdrawMethodSpecified, TargetStepID: autoStep.GetStepId(), Comment: "请复核",
	})
	if err != nil {
		t.Fatalf("回退到自动节点应当被允许：%v", err)
	}
	h.commit(d)

	agg = h.agg()
	cur := h.current(agg)
	wantEqual(t, "当前站回到自动复核节点", cur.GetNodeId(), "n5")
	if cur.GetAutoHandled() {
		t.Fatal("E5：回退到达不该再触发自动办理——它又被系统一脚踩过去了，回退等于没回")
	}
	wantEqual(t, "该节点的人拿到待办", h.task(agg, liSi.UserID, "PENDING").GetStatus(), "PENDING")
}

// fAutoChain 生成一条纯自动办理的长链：发起 → n1 → n2 → … → nN（HANDLE，全部配自动条件为真）
// → 结束。发起节点直接接 22 个连续自动办理节点，在「发起」这一个动作里就命中连续自动办理
// 上限（不像 f4 那样要靠 n5/n6 互指的环、且要另外提交一次才触发），用来守住 Start 不得把
// 停驻结果错报成「已提交」。
func fAutoChain(n int) *compile.CompiledDefinition {
	c := &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no", Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
		},
	}
	prev := "n0"
	for i := 1; i <= n; i++ {
		id := fmt.Sprintf("n%d", i)
		c.Nodes = append(c.Nodes, compile.NodeCompiled{
			NodeID: id, NodeKind: "HANDLE", NodeName: fmt.Sprintf("自动节点%d", i), NoRouteHint: "没有可走的路线",
			PassRule: "ANY", StaticUserIDs: []int64{22},
			AutoConditionPubID: "p-auto", AutoConditionDocJSON: `{"mode":"condition"}`,
		})
		c.Links = append(c.Links, compile.LinkCompiled{LinkID: fmt.Sprintf("l%d", i), FromNodeID: prev, ToNodeID: id, IsMain: true})
		prev = id
	}
	end := fmt.Sprintf("n%d", n+1)
	c.Nodes = append(c.Nodes, compile.NodeCompiled{NodeID: end, NodeKind: "END", NodeName: "结束", EndLabel: "已完成"})
	c.Links = append(c.Links, compile.LinkCompiled{LinkID: fmt.Sprintf("l%d", n+1), FromNodeID: prev, ToNodeID: end, IsMain: true})
	return c
}

// TestStart_AutoChainLimitParked 发起接 22 个连续自动办理节点，连续自动办理上限停驻——发起的
// 最终结果必须如实报「已停驻」并带上事故 id，不能被 Start 末尾恒定的 OutcomeCommitted 盖掉（前端会把「实例其实已经 PARKED」误判成「已提交」）。
func TestStart_AutoChainLimitParked(t *testing.T) {
	h := newHarness(t, fAutoChain(25))
	h.expr.Conditions["p-auto"] = true
	d := h.mustStart(starter, core.Choices{})

	wantKind(t, d, core.OutcomeParked)
	if d.Outcome.IncidentID == "" {
		t.Fatal("F6 停驻的发起结果应当带事故 id，实得为空")
	}

	agg := h.agg()
	wantEqual(t, "实例状态", agg.GetInstance().GetStatus(), string(model.InstanceStatusParked))
	if len(agg.GetIncidents()) != 1 || agg.GetIncidents()[0].GetKind() != string(model.IncidentAutoChainLimit) {
		t.Fatalf("应挂一条自动办理链超长的事故，实得 %+v", agg.GetIncidents())
	}
}

// fAutoThenNoCandidate 发起 → 自动办理节点（条件为真）→ 人工节点（未配候选来源，零候选）。
func fAutoThenNoCandidate() *compile.CompiledDefinition {
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no", Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "自动办理", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{22},
				AutoConditionPubID: "p-auto", AutoConditionDocJSON: `{"mode":"condition"}`},
			{NodeID: "n2", NodeKind: "HANDLE", NodeName: "零候选节点", NoRouteHint: "没有可走的路线", PassRule: "ANY"}, // 未配 StaticUserIDs / SourcesJSON
			{NodeID: "n3", NodeKind: "END", NodeName: "结束", EndLabel: "已完成"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n2", IsMain: true},
			{LinkID: "l3", FromNodeID: "n2", ToNodeID: "n3", IsMain: true},
		},
	}
}

// TestStart_AutoThenNoCandidate 发起后第一跳先被自动办理带过一站，紧接着到达的人工
// 节点零候选——发起不能报 SYSTEM_ERROR（只把发起步骤状态改回 ACTIVE 而不把
// instance.current_step_id 从自动步骤那儿指回来，单令牌自检必打红），而应像 submit.go 的
// parkSubmitter 一样换一包干净的变更集，把实例整个重置回发起站：发起步骤回到 ACTIVE、发起
// 任务回到 SAVED，自动办理途中建的那一步不落库（流程终究没有真的停在那儿，落库反而会让
// 流转明细凭空多出一段从未发生过的记录——本用例断言账本里恰好只有发起这一条步骤）。
func TestStart_AutoThenNoCandidate(t *testing.T) {
	h := newHarness(t, fAutoThenNoCandidate())
	h.expr.Conditions["p-auto"] = true
	d := h.mustStart(starter, core.Choices{})

	wantKind(t, d, core.OutcomeNoCandidate)
	if !d.Outcome.Saved {
		t.Fatal("C4 零候选应当 saved=true")
	}

	agg := h.agg()
	wantEqual(t, "实例状态", agg.GetInstance().GetStatus(), string(model.InstanceStatusRunning))
	wantEqual(t, "当前站回到发起步", h.current(agg).GetNodeId(), "n0")
	wantEqual(t, "发起步骤状态", h.current(agg).GetStatus(), string(model.StepStatusActive))
	wantEqual(t, "发起任务转暂存", h.task(agg, starter.UserID, "SAVED").GetStatus(), string(model.TaskStatusSaved))
	// 自动办理途中建的那一步（n1）不落库。
	if len(agg.GetSteps()) != 1 {
		t.Fatalf("账本里不该有自动步骤残留，实得 %v", stepLines(agg))
	}
}
