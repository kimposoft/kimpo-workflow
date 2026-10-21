package core_test

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// —— 非人工发起的实例遇「回退到发起人」运行期降级为「回退到上一步」 ——

// fInitiatorBackChain 三站链：发起 → 部门审批（王芳，无回退配置）→ 财务复核（李四，允许「回退到发起人」）→
// 结束；财务复核允许的回退方式配的是「回退到发起人」，用来验证非人工发起时它被降级。
func fInitiatorBackChain() *compile.CompiledDefinition {
	allowed, _ := json.Marshal([]model.WithdrawMethod{model.WithdrawMethodInitiator})
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no",
		Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门审批", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{22}},
			{NodeID: "n3", NodeKind: "HANDLE", NodeName: "财务复核", NoRouteHint: "没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{33}, AllowedWithdrawsJSON: string(allowed)},
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n3", IsMain: true},
			{LinkID: "l3", FromNodeID: "n3", ToNodeID: "n2", IsMain: true},
		},
	}
}

// TestBackDowngrade_NonManualStartDowngradesInitiatorBack：子流程发起的实例（StartKind=SUBFLOW）在财务
// 复核站按「回退到发起人」，运行期应降级为「回退到上一步」——目标是最近的人工步骤 n1，而不是
// 发起步骤；流转明细里李四那条已完成任务的说明带固定文案前缀；动作码仍记原方式 BACK_START。
func TestBackDowngrade_NonManualStartDowngradesInitiatorBack(t *testing.T) {
	h := newHarness(t, fInitiatorBackChain())
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter, StartKind: model.StartKindSubflow})
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)
	h.mustSubmit(wangFang, core.Choices{}) // n1 -> n3

	bd, err := h.back(liSi, model.WithdrawMethodInitiator, "", "补充说明")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(bd)

	// 目标应是 n1（最近的人工步骤）：王芳重新收到一条待办任务。
	reopened := h.task(h.agg(), wangFang.UserID, "PENDING")
	if reopened == nil {
		t.Fatal("want a reopened task at n1")
	}
	// 李四那条已完成（回退）任务的说明带固定文案前缀，动作码仍记原方式。
	doneTask := h.task(h.agg(), liSi.UserID, "DONE")
	const want = "无发起人，已按回退到上一步处理；补充说明"
	if doneTask.GetComment() != want {
		t.Fatalf("comment = %q, want %q", doneTask.GetComment(), want)
	}
	if doneTask.GetActionCode() != "BACK_START" {
		t.Fatalf("action code = %q, want BACK_START (动作码仍记原按钮/原方式)", doneTask.GetActionCode())
	}
}

// TestBackDowngrade_NonManualStartNoPreviousHumanStep：子流程发起的实例在第一个人工步骤就配了「回退到
// 发起人」且提交人立即点回退——降级目标是「最近的人工步骤」，但发起之后第一站之前没有任何
// 人工步骤，只能报 BACK_TARGET_NOT_FOUND（与人工发起、真的没有上一步时同一错误码）。
func TestBackDowngrade_NonManualStartNoPreviousHumanStep(t *testing.T) {
	c := fInitiatorBackChain()
	// 把「允许回退到发起人」直接配在第一站 n1 上，跳过财务复核。
	allowed, _ := json.Marshal([]model.WithdrawMethod{model.WithdrawMethodInitiator})
	c.Nodes[1].AllowedWithdrawsJSON = string(allowed)
	h := newHarness(t, c)
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter, StartKind: model.StartKindAction})
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)

	_, err = h.back(wangFang, model.WithdrawMethodInitiator, "", "")
	wantCode(t, err, "BACK_TARGET_NOT_FOUND")
}

// TestBackDowngrade_ManualStartInitiatorBackGoesToStart：对照组——人工发起的实例按「回退到发起人」不降级，
// 依旧回到发起步骤本身（发起人重新收到发起任务，与撤销发起同一口径，不新开步骤）。
func TestBackDowngrade_ManualStartInitiatorBackGoesToStart(t *testing.T) {
	h := newHarness(t, fInitiatorBackChain())
	h.mustStart(starter, core.Choices{}) // StartKind 默认 MANUAL
	h.mustSubmit(wangFang, core.Choices{})

	bd, err := h.back(liSi, model.WithdrawMethodInitiator, "", "")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(bd)

	starterTask := h.task(h.agg(), starter.UserID, "PENDING")
	if starterTask == nil {
		t.Fatal("want the start task reopened for the starter")
	}
	doneTask := h.task(h.agg(), liSi.UserID, "DONE")
	if doneTask.GetComment() != "" {
		t.Fatalf("manual start must not be downgraded, comment should stay empty: %q", doneTask.GetComment())
	}
}
