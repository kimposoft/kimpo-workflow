package compile

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// —— 夹具 ——

func cfgJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// f1Lite 发起 → 办理（王芳）→ 结束「已通过」写入 f-status；引导线 l1 有条件、l2 无条件。
func f1Lite(t *testing.T) *model.Document {
	t.Helper()
	return &model.Document{
		Schema: model.SchemaVersion, Name: "采购申请审批",
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfgJSON(t, model.HandleConfig{
				Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
				NoRouteHint: "审批后没有可走的路线", FieldPermissions: []model.FieldPermission{{TableID: "dt-main", FieldID: "f-pay", Grade: model.FieldGradeEdit}},
				ClearOnWithdraw: []model.ClearOnWithdrawField{{TableID: "dt-main", FieldID: "f-pay"}},
			})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{
			{ID: "l1", From: "n0", To: "n1", ConditionDoc: json.RawMessage(`{"mode":"condition"}`)},
			{ID: "l2", From: "n1", To: "n2"},
		},
	}
}

type fakeFreezer struct {
	got    FreezeInput
	out    FreezeOutput
	err    error
	called int
}

func (f *fakeFreezer) Freeze(_ context.Context, in FreezeInput) (FreezeOutput, error) {
	f.called++
	f.got = in
	return f.out, f.err
}

func hasCode(diags []model.Diagnostic, code, nodeID string) bool {
	for _, d := range diags {
		if d.Code == code && (nodeID == "" || d.NodeID == nodeID) {
			return true
		}
	}
	return false
}

func compileOK(t *testing.T, doc *model.Document, fz *fakeFreezer) Result {
	t.Helper()
	res, err := New(nil, fz, testkit.AllTextMain("f-status"), nil).Compile(context.Background(), Input{Document: doc, AppID: "app", TemplateID: "tpl-1", DefinitionID: "def-1", VersionNo: 1, TemplatePublished: true, SerialFieldID: "f-no"})
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return res
}

// —— K1 / L ——

// TestK1_L10_MainNodeNeedsMainOutline：办理节点没有出线 → L10。
func TestK1_L10_MainNodeNeedsMainOutline(t *testing.T) {
	doc := f1Lite(t)
	doc.Links = doc.Links[:1] // 去掉 n1 → n2
	res := compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "L10", "n1") || res.Compiled != nil {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	// 结束节点因此也没有入线 → L11。
	if !hasCode(res.Diagnostics, "L11", "n2") {
		t.Fatalf("end without inline should be L11: %+v", res.Diagnostics)
	}
}

// TestK1_L10_OnlyBranchLineRejected：只挂一条指向末级辅助节点（抄送）的支线 → L10。
// 抄送是受支持的节点类型（不报 NODE_KIND_UNSUPPORTED），但空配置的抄送自己会报
// 收件人 / 渠道 / 标题 / 正文四条必填——这里一并断言，确认「支持」不等于「不校验」。
func TestK1_L10_OnlyBranchLineRejected(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes = append(doc.Nodes, model.Node{ID: "cc", Kind: model.NodeKindCC, Config: cfgJSON(t, model.CCConfig{})})
	doc.Links = []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l3", From: "n1", To: "cc"}}
	res := compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "L10", "n1") {
		t.Fatalf("只挂一条支线的办理节点应报 L10，实得 %+v", res.Diagnostics)
	}
	if hasCode(res.Diagnostics, "NODE_KIND_UNSUPPORTED", "cc") {
		t.Fatalf("抄送是受支持的节点类型，不该报 NODE_KIND_UNSUPPORTED：%+v", res.Diagnostics)
	}
	for _, code := range []string{"A1_SOURCE_REQUIRED", "N4_CHANNEL_REQUIRED", "N4_TITLE_REQUIRED", "N4_CONTENT_REQUIRED"} {
		if !hasCode(res.Diagnostics, code, "cc") {
			t.Fatalf("空配置的抄送应报 %s，实得 %+v", code, res.Diagnostics)
		}
	}
}

// TestK1_L11_NoEndRejected：没有结束节点 → L11。
func TestK1_L11_NoEndRejected(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes = doc.Nodes[:2]
	doc.Links = doc.Links[:1]
	res := compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "L11", "") {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
}

// endFlowDoc 发起 → 审批 a1 → 结束 n2；a1 带一个「不通过并结束流程」按钮指向 endTarget，
// 另有一个没有任何入线的结束节点 n3（L11 放宽用例）。
func endFlowDoc(t *testing.T, endTarget string) *model.Document {
	t.Helper()
	return &model.Document{
		Schema: model.SchemaVersion, Name: "审批不通过即结束",
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "a1", Kind: model.NodeKindApprove, Name: "审批", Config: cfgJSON(t, model.ApproveConfig{
				Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}},
				CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
				Buttons: []model.ApprovalButton{
					{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove},
					{ID: "b2", Name: "不通过", Action: model.ButtonActionEndFlow, EndNodeID: endTarget},
				},
			})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "已通过", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
			{ID: "n3", Kind: model.NodeKindEnd, Name: "已拒绝", Config: cfgJSON(t, model.EndConfig{EndFlag: "已拒绝", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{
			{ID: "l1", From: "n0", To: "a1"},
			{ID: "l2", From: "a1", To: "n2"},
		},
	}
}

// TestL11_EndReferencedByButtonNeedsNoInline：结束节点没有入线但被审批按钮指定为目标 →
// 发布通过、无 L11；编译产物 approve_buttons_json 带 end_node_id。
func TestL11_EndReferencedByButtonNeedsNoInline(t *testing.T) {
	res := compileOK(t, endFlowDoc(t, "n3"), &fakeFreezer{})
	if hasCode(res.Diagnostics, "L11", "") || len(res.Diagnostics) != 0 || res.Compiled == nil {
		t.Fatalf("被按钮指向的无入线结束节点应放行，实得 %+v", res.Diagnostics)
	}
	var buttons string
	for _, nc := range res.Compiled.Nodes {
		if nc.NodeID == "a1" {
			buttons = nc.ApproveButtonsJSON
		}
	}
	if !strings.Contains(buttons, `"end_node_id":"n3"`) || !strings.Contains(buttons, `"action":"end_flow"`) {
		t.Fatalf("编译产物应带 end_flow 动作与 end_node_id，实得 %q", buttons)
	}
}

// TestL11_EndWithoutInlineAndNoButtonRef：结束节点既无入线又没有按钮指向 → 仍报 L11
// （按钮指向的是另一个结束节点 n2，n3 依旧悬空）。
func TestL11_EndWithoutInlineAndNoButtonRef(t *testing.T) {
	res := compileOK(t, endFlowDoc(t, "n2"), &fakeFreezer{})
	if !hasCode(res.Diagnostics, "L11", "n3") || res.Compiled != nil {
		t.Fatalf("无入线且无按钮指向的结束节点应报 L11，实得 %+v", res.Diagnostics)
	}
	if hasCode(res.Diagnostics, "L11", "n2") {
		t.Fatalf("n2 有入线，不应报 L11：%+v", res.Diagnostics)
	}
}

// TestK2_TemplateUnpublishedRejected：目标模板未发布 → K2，且不调冻结。
func TestK2_TemplateUnpublishedRejected(t *testing.T) {
	fz := &fakeFreezer{}
	res, err := New(nil, fz, testkit.AllTextMain("f-status"), nil).Compile(context.Background(), Input{Document: f1Lite(t), AppID: "app", TemplateID: "tpl-1", DefinitionID: "def-1", VersionNo: 1, TemplatePublished: false})
	if err != nil || !hasCode(res.Diagnostics, "K2", "") || fz.called != 0 {
		t.Fatalf("res = %+v err %v called %d", res, err, fz.called)
	}
}

// TestL1_MultiOutlinesAllowed：一个节点两条主线出线各自成立，都标 is_main。
func TestL1_MultiOutlinesAllowed(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes = append(doc.Nodes, model.Node{ID: "n3", Kind: model.NodeKindEnd, Config: cfgJSON(t, model.EndConfig{EndFlag: "已否决"})})
	doc.Links = append(doc.Links, model.Link{ID: "l3", From: "n1", To: "n3", ConditionDoc: json.RawMessage(`{"mode":"condition"}`)})
	fz := &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}, {ExpressionID: "l3", PublicationID: "p3"}}}}
	res := compileOK(t, doc, fz)
	if len(res.Diagnostics) != 0 {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	if len(res.Compiled.MainOutLinks("n1")) != 2 || res.Compiled.Link("l3").ConditionPublicationID != "p3" || res.Compiled.Link("l2").ConditionPublicationID != "" {
		t.Fatalf("compiled links = %+v", res.Compiled.Links)
	}
}

// TestL13_LinkName：连线名称经 Decode → 编译后原样出现在 LinkCompiled.LinkName（不参与选路，
// 只用于设计器展示）；超过 20 个字符（按 rune 计）发布拒绝，20 个字符（含中文）不拒。
func TestL13_LinkName(t *testing.T) {
	doc := f1Lite(t)
	doc.Links[0].Name = "条件通过"
	res := compileOK(t, doc, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if len(res.Diagnostics) != 0 {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	if res.Compiled.Link("l1").LinkName != "条件通过" {
		t.Fatalf("连线名称未透传进编译产物：%+v", res.Compiled.Link("l1"))
	}

	docTooLong := f1Lite(t)
	docTooLong.Links[0].Name = strings.Repeat("字", 21)
	resTooLong := compileOK(t, docTooLong, &fakeFreezer{})
	if !hasCode(resTooLong.Diagnostics, "LINK_NAME_TOO_LONG", "") {
		t.Fatalf("21 字连线名称应报 LINK_NAME_TOO_LONG：%+v", resTooLong.Diagnostics)
	}

	docBoundary := f1Lite(t)
	docBoundary.Links[0].Name = strings.Repeat("字", 20)
	resBoundary := compileOK(t, docBoundary, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if hasCode(resBoundary.Diagnostics, "LINK_NAME_TOO_LONG", "") {
		t.Fatalf("恰好 20 字的连线名称不该拒绝：%+v", resBoundary.Diagnostics)
	}
}

// —— 节点校验与支持面 ——

// TestA_SourceUnsupportedRejected：未知来源种类拒绝（已知来源全部放开）。
// 按比例办理不拒绝，只有百分比越界才拒。
func TestA_SourceUnsupportedRejected(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceKind("magic")}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModePercentage, PercentageBP: 6000}, NoRouteHint: "x"})
	res := compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "A_SOURCE_UNSUPPORTED", "n1") {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	if hasCode(res.Diagnostics, "D_RATIO_UNSUPPORTED", "n1") || hasCode(res.Diagnostics, "D_RATIO_OUT_OF_RANGE", "n1") {
		t.Fatalf("60%% 是合法比例，不该报办理方式相关诊断：%+v", res.Diagnostics)
	}
}

// TestD_RatioAcceptedAndBoundary：按比例办理——合法比例编译出 RATIO 规则与百分比；
// 不填百分比按 100% 处理；越界（0 以下/100 以上）发布拒绝。
func TestD_RatioAcceptedAndBoundary(t *testing.T) {
	base := func(bp int) *model.Document {
		doc := f1Lite(t)
		doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
			Assignees:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
			CompleteMode: model.CompleteMode{Kind: model.CompleteModePercentage, PercentageBP: bp},
			NoRouteHint:  "x",
		})
		return doc
	}
	frozen := func() *fakeFreezer {
		return &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}}
	}
	res := compileOK(t, base(6000), frozen())
	if hasCode(res.Diagnostics, "D_RATIO_OUT_OF_RANGE", "n1") {
		t.Fatalf("60%% 不该越界：%+v", res.Diagnostics)
	}
	var n1 *NodeCompiled
	for i := range res.Compiled.Nodes {
		if res.Compiled.Nodes[i].NodeID == "n1" {
			n1 = &res.Compiled.Nodes[i]
		}
	}
	if n1 == nil || n1.PassRule != string(model.PassRuleRatio) || n1.PassRatio != 60 {
		t.Fatalf("按比例应编译成 RATIO/60，实得 %+v", n1)
	}

	resDefault := compileOK(t, base(0), frozen())
	if hasCode(resDefault.Diagnostics, "D_RATIO_OUT_OF_RANGE", "n1") {
		t.Fatalf("不填百分比按 100%% 处理，不该拒绝：%+v", resDefault.Diagnostics)
	}
	for _, bp := range []int{50, 10001} {
		resBad := compileOK(t, base(bp), frozen())
		if !hasCode(resBad.Diagnostics, "D_RATIO_OUT_OF_RANGE", "n1") {
			t.Fatalf("百分比 %d 越界应拒绝：%+v", bp, resBad.Diagnostics)
		}
	}
}

// TestD_AllModeAcceptedAndEquivalentToPercentage100：「全部完成 / 会签」档——校验
// 放行（不看 PercentageBP，不做范围校验），编译产物与「按比例 100%」完全一致。
func TestD_AllModeAcceptedAndEquivalentToPercentage100(t *testing.T) {
	mkDoc := func(mode model.CompleteMode) *model.Document {
		doc := f1Lite(t)
		doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
			Assignees:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
			CompleteMode: mode,
			NoRouteHint:  "x",
		})
		return doc
	}
	frozen := func() *fakeFreezer {
		return &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}}
	}
	resAll := compileOK(t, mkDoc(model.CompleteMode{Kind: model.CompleteModeAll}), frozen())
	if len(resAll.Diagnostics) != 0 {
		t.Fatalf("「全部完成/会签」档应放行，不该有诊断：%+v", resAll.Diagnostics)
	}
	resPct := compileOK(t, mkDoc(model.CompleteMode{Kind: model.CompleteModePercentage, PercentageBP: 10000}), frozen())
	n1All, n1Pct := resAll.Compiled.Node("n1"), resPct.Compiled.Node("n1")
	if n1All.PassRule != n1Pct.PassRule || n1All.PassRatio != n1Pct.PassRatio || n1All.PassRule != string(model.PassRuleRatio) || n1All.PassRatio != 100 {
		t.Fatalf("all 档编译结果应与 percentage+10000 一致：all=%+v pct=%+v", n1All, n1Pct)
	}
}

// TestA_FiveSourceKindsAccepted：五种来源全部通过发布期校验（另有第六种「发起人」，
// 见下方追加的 initiator 条目——它没有必填项，理应和其余五种一样放行）；各自必填项为空报
// A1_SOURCE_EMPTY；未知匹配方式 / 关系档报 A_SOURCE_UNSUPPORTED。
func TestA_FiveSourceKindsAccepted(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{
		{Kind: model.AssigneeSourceUser, UserIDs: []int64{1}},
		{Kind: model.AssigneeSourceRole, RoleIDs: []string{"r1"}},
		{Kind: model.AssigneeSourceDepartment, DepartmentIDs: []string{"d1"}},
		{Kind: model.AssigneeSourceMainField, MainFieldID: "f-reviewer", MatchBy: model.AssigneeMatchByLoginName},
		{Kind: model.AssigneeSourceRelation, Relation: model.AssigneeRelationParentDeptMgr},
		{Kind: model.AssigneeSourceInitiator},
	}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "x"})
	res := compileOK(t, doc, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if hasCode(res.Diagnostics, "A_SOURCE_UNSUPPORTED", "n1") || hasCode(res.Diagnostics, "A1_SOURCE_EMPTY", "n1") {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{
		{Kind: model.AssigneeSourceRole},
		{Kind: model.AssigneeSourceMainField, MainFieldID: "f", MatchBy: model.AssigneeMatchBy("email")},
		{Kind: model.AssigneeSourceRelation, Relation: model.AssigneeRelation("cousin")},
	}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "x"})
	res = compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "A1_SOURCE_EMPTY", "n1") || !hasCode(res.Diagnostics, "A_SOURCE_UNSUPPORTED", "n1") {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
}

// TestNodeValidate_RequiredFields：发起缺目标模板 / 结束缺标识 / 办理缺来源。
func TestNodeValidate_RequiredFields(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[0].Config = cfgJSON(t, model.StartConfig{})
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{})
	doc.Nodes[2].Config = cfgJSON(t, model.EndConfig{})
	res := compileOK(t, doc, &fakeFreezer{})
	for _, want := range []struct{ code, node string }{{"N1_TARGET_TEMPLATE_REQUIRED", "n0"}, {"A1_SOURCE_REQUIRED", "n1"}, {"N5_END_FLAG_REQUIRED", "n2"}} {
		if !hasCode(res.Diagnostics, want.code, want.node) {
			t.Errorf("missing %s@%s in %+v", want.code, want.node, res.Diagnostics)
		}
	}
	// 「无路可走时的提示」是选填，三类节点全空也不得产这一条（反向锁——
	// 这两个节点的配置都是全空的）。
	for _, node := range []string{"n0", "n1"} {
		if hasCode(res.Diagnostics, "NO_ROUTE_HINT_REQUIRED", node) {
			t.Errorf("NO_ROUTE_HINT_REQUIRED@%s 已退役，不应再产出：%+v", node, res.Diagnostics)
		}
	}
}

// —— 冻结与字段引用 ——

// TestFreeze_FillsPublicationIDsAndSummary：冻结结果回填引导线与节点摘要；文档原样带进 compiled_json。
func TestFreeze_FillsPublicationIDsAndSummary(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22, 33}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "x", SummaryExpr: json.RawMessage(`{"mode":"value"}`)})
	fz := &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "pub-l1", ReferencedFields: []FieldRef{{DataTableID: "dt-main", FieldID: "f-amount"}}}, {ExpressionID: "n1:summary", PublicationID: "pub-sum"}}}}
	res := compileOK(t, doc, fz)
	if len(res.Diagnostics) != 0 {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	if fz.got.DefinitionID != "def-1" || fz.got.VersionNo != 1 || len(fz.got.Specs) != 2 || fz.got.Specs[0].Purpose != PurposeJudge || fz.got.Specs[1].Purpose != PurposeCompute {
		t.Fatalf("freeze input = %+v", fz.got)
	}
	c := res.Compiled
	if c.StartNodeID != "n0" || c.SerialFieldID != "f-no" || c.Link("l1").ConditionPublicationID != "pub-l1" || c.Link("l1").ConditionDocumentJSON != `{"mode":"condition"}` {
		t.Fatalf("compiled = %+v", c)
	}
	n1 := c.Node("n1")
	if n1.SummaryPublicationID != "pub-sum" || n1.SummaryDocumentJSON != `{"mode":"value"}` || len(n1.StaticUserIDs) != 2 || n1.PassRule != "ANY" || n1.NodeKind != "HANDLE" {
		t.Fatalf("n1 = %+v", n1)
	}
	if c.Node("n2").EndLabel != "已通过" || c.Node("n2").EndLabelFieldID != "f-status" {
		t.Fatalf("n2 = %+v", c.Node("n2"))
	}
	// 往返编码。
	raw, _ := c.Encode()
	back, err := Decode(raw)
	if err != nil || back.Node("n1").SummaryPublicationID != "pub-sum" {
		t.Fatalf("roundtrip: %v", err)
	}
	// 字段引用：条件引用 + 结束标识写入 + 权限 + 清空。
	kinds := map[string]int{}
	for _, r := range res.FieldRefs {
		kinds[r.RefKind]++
	}
	if kinds[RefKindLinkCondition] != 1 || kinds[RefKindEndLabelTarget] != 1 || kinds[RefKindFieldPerm] != 0 || kinds[RefKindClearOnBack] != 0 {
		t.Fatalf("field refs = %+v", res.FieldRefs)
	}
}

// TestFieldRef_Kinds：字段权限（非继承）与回退清空各登记一条。
func TestFieldRef_Kinds(t *testing.T) {
	res := compileOK(t, f1Lite(t), &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p"}}}})
	kinds := map[string]int{}
	for _, r := range res.FieldRefs {
		kinds[r.RefKind]++
	}
	if kinds[RefKindFieldPerm] != 1 || kinds[RefKindClearOnBack] != 1 || kinds[RefKindEndLabelTarget] != 1 {
		t.Fatalf("field refs = %+v", res.FieldRefs)
	}
}

// TestFreeze_StartConditionFillsPublicationIDAndHint：发起条件按 "<node>:start_cond" 槽位
// 冻结（PurposeJudge，照抄自动办理条件 "<node>:auto" 的做法）；提示文本直接摊平（不是表达式，
// 不必等冻结）；发起权限的主表字段来源同一次编译一并登记为 RefKindFieldPerm（与人员来源
// =主表字段同一登记口径），表达式引用到的字段登记为专属的 RefKindStartCondition。
func TestFreeze_StartConditionFillsPublicationIDAndHint(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[0].Config = cfgJSON(t, model.StartConfig{
		TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走",
		StartCondition: json.RawMessage(`{"mode":"condition"}`), StartConditionHint: "金额超限，不能发起",
		StartPermission: model.StartGrant{MainFieldID: "f-owner", MatchBy: model.AssigneeMatchByLoginName},
	})
	fz := &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{
		{ExpressionID: "l1", PublicationID: "pub-l1"},
		{ExpressionID: "n0:start_cond", PublicationID: "pub-start-cond", ReferencedFields: []FieldRef{{DataTableID: "dt-main", FieldID: "f-amount"}}},
	}}}
	res := compileOK(t, doc, fz)
	if len(res.Diagnostics) != 0 {
		t.Fatalf("diags = %+v", res.Diagnostics)
	}
	n0 := res.Compiled.Node("n0")
	if n0.StartConditionPubID != "pub-start-cond" || n0.StartConditionDocJSON != `{"mode":"condition"}` || n0.StartConditionHint != "金额超限，不能发起" {
		t.Fatalf("n0 = %+v", n0)
	}
	// 往返编码：新字段也要能从 compiled_json 原样读回来（运行期 engine/core/start.go 只读
	// compiled_json，不重新解析设计器文档）。
	raw, _ := res.Compiled.Encode()
	back, err := Decode(raw)
	if err != nil || back.Node("n0").StartConditionPubID != "pub-start-cond" || back.Node("n0").StartConditionHint != "金额超限，不能发起" {
		t.Fatalf("roundtrip: %v back=%+v", err, back.Node("n0"))
	}
	kinds := map[string]int{}
	for _, r := range res.FieldRefs {
		kinds[r.RefKind]++
	}
	if kinds[RefKindStartCondition] != 1 {
		t.Fatalf("发起条件表达式引用的字段应登记 RefKindStartCondition，实得 %+v", res.FieldRefs)
	}
	if kinds[RefKindFieldPerm] < 1 {
		t.Fatalf("发起权限主表字段来源应登记 RefKindFieldPerm，实得 %+v", res.FieldRefs)
	}
}

// TestNodeValidate_StartConditionHintRequired：编译层确认 node.Validate 的
// N1_START_CONDITION_HINT_REQUIRED 会跟着结构检查一起进 Result.Diagnostics（发布拒绝）。
func TestNodeValidate_StartConditionHintRequired(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[0].Config = cfgJSON(t, model.StartConfig{
		TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走",
		StartCondition: json.RawMessage(`{"mode":"condition"}`), // 没填 StartConditionHint
	})
	res := compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "N1_START_CONDITION_HINT_REQUIRED", "n0") {
		t.Fatalf("missing N1_START_CONDITION_HINT_REQUIRED in %+v", res.Diagnostics)
	}
}

// TestFreeze_IssuesLocateNodeAndSkipCompiled：宿主返回诊断 → 发布拒绝，诊断带上节点 / 引导线定位。
func TestFreeze_IssuesLocateNodeAndSkipCompiled(t *testing.T) {
	fz := &fakeFreezer{out: FreezeOutput{Issues: []model.Diagnostic{{Code: "EXPRESSION_INVALID", Arguments: map[string]string{"expression_id": "l1"}}}}}
	res := compileOK(t, f1Lite(t), fz)
	if res.Compiled != nil || len(res.Diagnostics) != 1 || res.Diagnostics[0].LinkID != "l1" {
		t.Fatalf("res = %+v", res)
	}
}

// TestDryRun_SkipsFreezer：Validate 只检查不冻结。
func TestDryRun_SkipsFreezer(t *testing.T) {
	fz := &fakeFreezer{}
	res, err := New(nil, fz, testkit.AllTextMain("f-status"), nil).Compile(context.Background(), Input{Document: f1Lite(t), TemplateID: "tpl-1", TemplatePublished: true, DryRun: true})
	if err != nil || len(res.Diagnostics) != 0 || fz.called != 0 || res.Compiled == nil {
		t.Fatalf("res = %+v err %v called %d", res, err, fz.called)
	}
}

// TestFreeze_HostErrorIsSystemError：宿主系统性失败 → 顶层 error（不是诊断）。
func TestFreeze_HostErrorIsSystemError(t *testing.T) {
	fz := &fakeFreezer{err: errors.New("db down")}
	_, err := New(nil, fz, testkit.AllTextMain("f-status"), nil).Compile(context.Background(), Input{Document: f1Lite(t), TemplateID: "tpl-1", TemplatePublished: true})
	if err == nil {
		t.Fatal("expected error")
	}
}

// TestSubflowPublishable：子流程运行期链路完整（app 层建单 → Start → 回写父子链接），
// 发布期不报 NODE_KIND_UNSUPPORTED。发布期放行与运行期能力必须一致：运行期没能力执行的
// 节点类型，发布期必须拒绝，否则实例跑到那一步什么都不会发生。
func TestSubflowPublishable(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes = append(doc.Nodes, model.Node{ID: "sf", Kind: model.NodeKindSubflow, Config: cfgJSON(t, model.SubflowConfig{
		TargetWorkflowID: "def-pay", Disposition: model.SubflowDispositionIgnore,
	})})
	doc.Links = append(doc.Links, model.Link{ID: "l-sf", From: "n1", To: "sf"})
	res := compileOK(t, doc, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if hasCode(res.Diagnostics, "NODE_KIND_UNSUPPORTED", "sf") {
		t.Fatalf("子流程运行期已补完，发布期不应再拒；实得 %+v", res.Diagnostics)
	}
	if res.Compiled == nil {
		t.Fatalf("子流程节点应能正常摊平进编译产物: %+v", res.Diagnostics)
	}
}
