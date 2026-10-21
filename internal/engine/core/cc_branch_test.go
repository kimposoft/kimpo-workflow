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

// ccNodeCompiled 一个配齐的抄送节点（收件人 = 指定用户；两个渠道；标题与正文各一条发布物）。
func ccNodeCompiled(id, name string, recipients []int64, terminal bool) compile.NodeCompiled {
	channels, _ := json.Marshal([]model.NotifyChannel{model.NotifyChannelSystem, model.NotifyChannelEmail})
	return compile.NodeCompiled{
		NodeID: id, NodeKind: "CC", NodeName: name, StaticUserIDs: recipients,
		CCChannelsJSON:     string(channels),
		TitlePublicationID: "p-" + id + "-title", TitleDocumentJSON: `{"mode":"value"}`,
		ContentPublicationID: "p-" + id + "-body", ContentDocumentJSON: `{"mode":"value"}`,
		IsTerminalAuxiliary: terminal,
	}
}

// f5 抄送夹具：发起 → 部门办理（王芳）→ 结束；办理节点另挂一条**支线**指向末级抄送 cc1。
func f5() *compile.CompiledDefinition {
	c := &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no", Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门办理", NoRouteHint: "办理后没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{22}},
			ccNodeCompiled("cc1", "知会财务", []int64{33, 44}, true),
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n2", IsMain: true},
			{LinkID: "l-cc", FromNodeID: "n1", ToNodeID: "cc1", IsMain: false}, // 支线
		},
	}
	return c
}

// f6 穿插抄送夹具：发起 → 部门办理 → 抄送 cc2（有出线，穿插在主线里）→ 财务复核 → 结束。
func f6() *compile.CompiledDefinition {
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no", Notify: model.DefaultNotifySettings(),
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门办理", NoRouteHint: "办理后没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{22}},
			ccNodeCompiled("cc2", "知会财务", []int64{33}, false),
			{NodeID: "n3", NodeKind: "HANDLE", NodeName: "财务复核", NoRouteHint: "复核后没有可走的路线", PassRule: "ANY", StaticUserIDs: []int64{44}},
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "cc2", IsMain: true},
			{LinkID: "l3", FromNodeID: "cc2", ToNodeID: "n3", IsMain: true},
			{LinkID: "l4", FromNodeID: "n3", ToNodeID: "n2", IsMain: true},
		},
	}
}

func presetCCText(h *harness, nodeIDs ...string) {
	for _, id := range nodeIDs {
		h.expr.Computed["p-"+id+"-title"] = "采购申请待知会"
		h.expr.Computed["p-"+id+"-body"] = "张三发起的采购申请，请查看"
	}
}

func ccRowsOf(agg *pb.InstanceAggregate) []*pb.CcRow { return agg.GetCcs() }

// N4.1 / N4.2 支线抄送：主线成功流转那一刻触发，一收件人一渠道一行；步骤到达即关闭，
// 实例的当前站仍是主线那一站。
func TestN4_1_BranchCCWritesOneRowPerRecipientPerChannel(t *testing.T) {
	h := newHarness(t, f5())
	presetCCText(h, "cc1")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	rows := ccRowsOf(agg)
	if len(rows) != 4 { // 两个收件人 × 两个渠道
		t.Fatalf("应写 4 行抄送（2 收件人 × 2 渠道），实得 %d：%+v", len(rows), rows)
	}
	for _, r := range rows {
		if r.GetStatus() != string(model.CCReceiptStatusUnread) || r.GetTitle() == "" || r.GetBody() == "" {
			t.Fatalf("抄送行应是未读且带标题正文，实得 %+v", r)
		}
	}
	// 末级抄送不影响主线：实例已经走到结束。
	wantEqual(t, "实例状态", agg.GetInstance().GetStatus(), "ENDED")
	cc := h.step(agg, "cc1", "")
	wantEqual(t, "抄送步骤状态", cc.GetStatus(), string(model.StepStatusPassed))
	wantEqual(t, "抄送步骤结果", cc.GetOutcome(), string(model.StepOutcomeNotified))
	if len(h.agg().GetTasks()) != 2 { // 发起 + 王芳；抄送不派任务
		t.Fatalf("抄送不该派任务，实得 %v", taskLines(agg))
	}
	kinds := h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId())
	var sawCC bool
	for _, k := range kinds {
		if len(k) > 8 && k[len(k)-7:] == "CC_SENT" {
			sawCC = true
		}
	}
	if !sawCC {
		t.Fatalf("应追加一条 CC_SENT 发件箱行，实得 %v", kinds)
	}
}

// N4.3 收件人为空：不写抄送行、不发通知，流程照常向后走。
func TestN4_3_EmptyRecipientsStillFlows(t *testing.T) {
	c := f5()
	c.Nodes[2].StaticUserIDs = nil // 抄送算不出人
	h := newHarness(t, c)
	presetCCText(h, "cc1")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	if len(ccRowsOf(agg)) != 0 {
		t.Fatalf("收件人为空不该写抄送行，实得 %+v", ccRowsOf(agg))
	}
	wantEqual(t, "流程照常走完", agg.GetInstance().GetStatus(), "ENDED")
	// 抄送步骤本身还是要留痕（P5 流转明细里看得到「走过这一步、没人可知会」）。
	wantEqual(t, "抄送步骤仍然落行", h.step(agg, "cc1", "").GetOutcome(), string(model.StepOutcomeNotified))
}

// L9 主线零命中暂存时，一条支线都不触发——「主线成功流转」是支线的前提。
func TestL9_BranchDoesNotFireWhenMainLineHasNoRoute(t *testing.T) {
	c := f5()
	c.Links[1].ConditionPublicationID, c.Links[1].ConditionDocumentJSON = "p-l2", `{"mode":"condition"}`
	h := newHarness(t, c)
	presetCCText(h, "cc1")
	h.expr.Conditions["p-l2"] = false
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})

	wantKind(t, d, core.OutcomeNoRoute)
	agg := h.agg()
	if len(ccRowsOf(agg)) != 0 {
		t.Fatalf("主线零命中时支线不该触发，实得 %+v", ccRowsOf(agg))
	}
	for _, s := range agg.GetSteps() {
		if s.GetNodeId() == "cc1" {
			t.Fatalf("主线零命中时不该落抄送步骤：%v", stepLines(agg))
		}
	}
}

// L9 支线条件不成立时不触发；成立才触发。
func TestL9_BranchConditionDecidesFiring(t *testing.T) {
	c := f5()
	c.Links[2].ConditionPublicationID, c.Links[2].ConditionDocumentJSON = "p-lcc", `{"mode":"condition"}`
	h := newHarness(t, c)
	presetCCText(h, "cc1")
	h.expr.Conditions["p-lcc"] = false
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if len(ccRowsOf(h.agg())) != 0 {
		t.Fatal("支线条件不成立时不该触发抄送")
	}
}

// 🔴 支线失败不回滚主线：抄送的标题表达式求不出来，主线该走还是要走。
func TestL9_BranchFailureDoesNotBreakMainLine(t *testing.T) {
	h := newHarness(t, f5())
	// 刻意不预置 p-cc1-title：FakeExpr 对未预置的发布物报 ErrExpressionInvalid。
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "主线照常走完", agg.GetInstance().GetStatus(), "ENDED")
	if len(ccRowsOf(agg)) != 0 {
		t.Fatalf("抄送失败不该留下半截抄送行，实得 %+v", ccRowsOf(agg))
	}
}

// L2 / N4.2 穿插在主线里的抄送：发完继续沿主线走到下一站。
func TestL2_InlineCCContinuesAlongMainLine(t *testing.T) {
	h := newHarness(t, f6())
	presetCCText(h, "cc2")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	wantEqual(t, "当前站", h.current(agg).GetNodeId(), "n3")
	wantEqual(t, "财务复核拿到待办", h.task(agg, zhaoWu.UserID, "PENDING").GetStatus(), "PENDING")
	wantEqual(t, "抄送步骤已关闭", h.step(agg, "cc2", "").GetStatus(), string(model.StepStatusPassed))
	if len(ccRowsOf(agg)) != 2 { // 一个收件人 × 两个渠道
		t.Fatalf("应写 2 行抄送，实得 %d", len(ccRowsOf(agg)))
	}
}

// L6 抄送自己不配无路提示：抄送后零命中时，提示取上溯到的最近可办理节点的设置。
func TestL6_NoRouteHintComesFromUpstreamHandleNode(t *testing.T) {
	c := f6()
	c.Links[2].ConditionPublicationID, c.Links[2].ConditionDocumentJSON = "p-l3", `{"mode":"condition"}`
	h := newHarness(t, c)
	presetCCText(h, "cc2")
	h.expr.Conditions["p-l3"] = false
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})

	wantKind(t, d, core.OutcomeNoRoute)
	wantEqual(t, "无路提示上溯到部门办理", d.Outcome.Hint, "办理后没有可走的路线")
}

// L6 连续两个抄送时一直上溯到最近的可办理节点。
func TestL6_HintWalksUpThroughConsecutiveCCs(t *testing.T) {
	c := f6()
	c.Nodes = append(c.Nodes, ccNodeCompiled("cc3", "再知会一次", []int64{33}, false))
	c.Links = []compile.LinkCompiled{
		{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
		{LinkID: "l2", FromNodeID: "n1", ToNodeID: "cc2", IsMain: true},
		{LinkID: "l3", FromNodeID: "cc2", ToNodeID: "cc3", IsMain: true},
		{LinkID: "l4", FromNodeID: "cc3", ToNodeID: "n3", IsMain: true, ConditionPublicationID: "p-l4", ConditionDocumentJSON: `{"mode":"condition"}`},
		{LinkID: "l5", FromNodeID: "n3", ToNodeID: "n2", IsMain: true},
	}
	h := newHarness(t, c)
	presetCCText(h, "cc2", "cc3")
	h.expr.Conditions["p-l4"] = false
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})

	wantKind(t, d, core.OutcomeNoRoute)
	wantEqual(t, "隔着两个抄送仍上溯到部门办理", d.Outcome.Hint, "办理后没有可走的路线")
}

// 撤销时经过的抄送步骤不影响可撤销（已发出的抄送不撤回）。
func TestG3_CCInBetweenDoesNotBlockWithdraw(t *testing.T) {
	h := newHarness(t, f6())
	presetCCText(h, "cc2")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})

	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatalf("中间只隔着抄送应当可以撤销：%v", err)
	}
	agg := h.agg()
	wantEqual(t, "当前站回到部门办理", h.current(agg).GetNodeId(), "n1")
	if len(ccRowsOf(agg)) != 2 {
		t.Fatalf("G3：已发出的抄送不撤回，行还应在，实得 %d", len(ccRowsOf(agg)))
	}
}

var _ = ports.FieldWrite{}
