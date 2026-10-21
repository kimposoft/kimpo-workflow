package node

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

func approveNode(t *testing.T, cfg model.ApproveConfig) *model.Node {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal approve config: %v", err)
	}
	return &model.Node{ID: "a1", Kind: model.NodeKindApprove, Name: "财务审批", Config: raw}
}

func codes(diags []model.Diagnostic) map[string]bool {
	out := make(map[string]bool, len(diags))
	for _, d := range diags {
		out[d.Code] = true
	}
	return out
}

// 审批节点配全时不报任何诊断（审批人 + 一个按钮 + 无路提示）。
func TestApproveValidate_HappyPath(t *testing.T) {
	h := NewApproveHandler()
	got := h.Validate(nil, approveNode(t, model.ApproveConfig{
		Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		Buttons:      []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove}},
		NoRouteHint:  "没有可走的路线，请联系管理员",
	}))
	if len(got) != 0 {
		t.Fatalf("配全的审批节点不该有诊断，实得 %+v", got)
	}
}

// 一个按钮都没有 / 按钮没名字 / 动作不在四档之内，三种都要拒。
func TestApproveValidate_Buttons(t *testing.T) {
	h := NewApproveHandler()
	base := model.ApproveConfig{
		Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint:  "x",
	}

	noButtons := base
	if !codes(h.Validate(nil, approveNode(t, noButtons)))["N3_BUTTON_REQUIRED"] {
		t.Fatal("没有按钮应报 N3_BUTTON_REQUIRED")
	}

	unnamed := base
	unnamed.Buttons = []model.ApprovalButton{{ID: "b1", Action: model.ButtonActionSubmitApprove}}
	if !codes(h.Validate(nil, approveNode(t, unnamed)))["N3_BUTTON_NAME_REQUIRED"] {
		t.Fatal("按钮没名字应报 N3_BUTTON_NAME_REQUIRED")
	}

	badAction := base
	badAction.Buttons = []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonAction("approve_maybe")}}
	if !codes(h.Validate(nil, approveNode(t, badAction)))["N3_BUTTON_ACTION_UNSUPPORTED"] {
		t.Fatal("未知按钮动作应报 N3_BUTTON_ACTION_UNSUPPORTED")
	}
}

// 配了结果绑定字段却有按钮没填结果标识：确认时会把空串写进单据，等于清掉字段，发布期就要拒。
func TestApproveValidate_ResultTagRequiredWhenBound(t *testing.T) {
	h := NewApproveHandler()
	cfg := model.ApproveConfig{
		Approvers:     []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode:  model.CompleteMode{Kind: model.CompleteModeAny},
		Buttons:       []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "已通过"}, {ID: "b2", Name: "拒绝", Action: model.ButtonActionWithdrawSpecify}},
		ResultFieldID: "f-status",
		NoRouteHint:   "x",
	}
	if !codes(h.Validate(nil, approveNode(t, cfg)))["N3_BUTTON_RESULT_TAG_REQUIRED"] {
		t.Fatal("绑定了结果字段但按钮没填结果标识，应报 N3_BUTTON_RESULT_TAG_REQUIRED")
	}

	cfg.ResultFieldID = ""
	if codes(h.Validate(nil, approveNode(t, cfg)))["N3_BUTTON_RESULT_TAG_REQUIRED"] {
		t.Fatal("没绑定结果字段时，按钮不填结果标识是允许的")
	}
}

// 审批人来源与办理方式两套通用件与办理节点同一份实现：这里只验「确实接上了」，
// 具体档位的穷举在 assignee_rules 自己的测试里。
func TestApproveValidate_SharesAssigneeAndModeRules(t *testing.T) {
	h := NewApproveHandler()
	got := codes(h.Validate(nil, approveNode(t, model.ApproveConfig{
		CompleteMode: model.CompleteMode{Kind: model.CompleteModePercentage, PercentageBP: 50},
		Buttons:      []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove}},
		NoRouteHint:  "x",
	})))
	if !got["A1_SOURCE_REQUIRED"] {
		t.Fatal("一个审批人来源都没配应报 A1_SOURCE_REQUIRED")
	}
	if !got["D_RATIO_OUT_OF_RANGE"] {
		t.Fatal("0.5% 越界应报 D_RATIO_OUT_OF_RANGE")
	}
}

// 无路可走时的提示选填：选路零命中时没填就由填报层落系统默认提示，
// 发布期不拦。本用例是反向锁——其余必填项都配齐、只空着提示，不得再产任何诊断。
func TestApproveValidate_NoRouteHintOptional(t *testing.T) {
	h := NewApproveHandler()
	got := codes(NewApproveHandler().Validate(nil, approveNode(t, model.ApproveConfig{
		Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		Buttons:      []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove}},
	})))
	_ = h
	if got["NO_ROUTE_HINT_REQUIRED"] {
		t.Fatal("NO_ROUTE_HINT_REQUIRED 已退役，没填无路提示不应再报")
	}
	if len(got) != 0 {
		t.Fatalf("只空着无路提示不应产任何诊断，实得 %v", got)
	}
}

// —— 「不通过并结束流程」按钮 ——

// endFlowDoc 造一份带一个结束节点 e1 与一个非结束节点 h1 的文档，供 end_flow 目标校验用。
func endFlowDoc() *model.Document {
	return &model.Document{Nodes: []model.Node{
		{ID: "e1", Kind: model.NodeKindEnd},
		{ID: "h1", Kind: model.NodeKindHandle},
	}}
}

func endFlowCfg(endNodeID string) model.ApproveConfig {
	return model.ApproveConfig{
		Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		Buttons: []model.ApprovalButton{
			{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove},
			{ID: "b2", Name: "不通过", Action: model.ButtonActionEndFlow, EndNodeID: endNodeID},
		},
	}
}

// end_flow 动作合法：目标是本流程里的结束节点时不报任何诊断。
func TestApproveValidate_EndFlow_ValidTarget(t *testing.T) {
	got := NewApproveHandler().Validate(endFlowDoc(), approveNode(t, endFlowCfg("e1")))
	if len(got) != 0 {
		t.Fatalf("目标为结束节点不应有诊断，实得 %+v", got)
	}
}

// end_flow 没指定目标 → REQUIRED（带按钮定位信息）；不再报 ACTION_UNSUPPORTED。
func TestApproveValidate_EndFlow_TargetRequired(t *testing.T) {
	got := NewApproveHandler().Validate(endFlowDoc(), approveNode(t, endFlowCfg("")))
	c := codes(got)
	if !c["N3_BUTTON_END_TARGET_REQUIRED"] {
		t.Fatalf("缺目标应报 N3_BUTTON_END_TARGET_REQUIRED，实得 %+v", got)
	}
	if c["N3_BUTTON_END_TARGET_INVALID"] || c["N3_BUTTON_ACTION_UNSUPPORTED"] {
		t.Fatalf("缺目标只应报 REQUIRED，实得 %+v", got)
	}
	for _, d := range got {
		if d.Code == "N3_BUTTON_END_TARGET_REQUIRED" && (d.NodeID != "a1" || d.Arguments["button"] != "不通过") {
			t.Fatalf("诊断应带节点与按钮定位，实得 %+v", d)
		}
	}
}

// 目标不存在（含被删除）或不是结束节点 → INVALID。
func TestApproveValidate_EndFlow_TargetInvalid(t *testing.T) {
	h := NewApproveHandler()
	for name, target := range map[string]string{"不存在": "ghost", "非结束节点": "h1"} {
		got := h.Validate(endFlowDoc(), approveNode(t, endFlowCfg(target)))
		c := codes(got)
		if !c["N3_BUTTON_END_TARGET_INVALID"] || c["N3_BUTTON_END_TARGET_REQUIRED"] {
			t.Fatalf("%s：应只报 N3_BUTTON_END_TARGET_INVALID，实得 %+v", name, got)
		}
	}
}

// doc 为 nil（单节点校验）时不 panic：缺目标仍报 REQUIRED，有目标则跳过 INVALID 检查。
func TestApproveValidate_EndFlow_NilDoc(t *testing.T) {
	h := NewApproveHandler()
	if !codes(h.Validate(nil, approveNode(t, endFlowCfg(""))))["N3_BUTTON_END_TARGET_REQUIRED"] {
		t.Fatal("doc 为 nil 时缺目标仍应报 REQUIRED")
	}
	if got := h.Validate(nil, approveNode(t, endFlowCfg("whatever"))); len(got) != 0 {
		t.Fatalf("doc 为 nil 时应跳过 INVALID 检查，实得 %+v", got)
	}
}

// 旧四档动作行为不变（带 doc 校验也一样）；end_flow 按钮同样受结果标识必填规则约束。
func TestApproveValidate_EndFlow_LegacyActionsAndResultTag(t *testing.T) {
	h := NewApproveHandler()
	legacy := model.ApproveConfig{
		Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		Buttons: []model.ApprovalButton{
			{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove},
			{ID: "b2", Name: "退上一步", Action: model.ButtonActionWithdrawPrev},
			{ID: "b3", Name: "退发起人", Action: model.ButtonActionWithdrawInit},
			{ID: "b4", Name: "退指定步", Action: model.ButtonActionWithdrawSpecify},
		},
	}
	if got := h.Validate(endFlowDoc(), approveNode(t, legacy)); len(got) != 0 {
		t.Fatalf("旧四档动作不应有诊断，实得 %+v", got)
	}

	cfg := endFlowCfg("e1")
	cfg.ResultFieldID = "f-status"
	cfg.Buttons[0].ResultTag = "已通过"
	if !codes(h.Validate(endFlowDoc(), approveNode(t, cfg)))["N3_BUTTON_RESULT_TAG_REQUIRED"] {
		t.Fatal("绑定了结果字段时 end_flow 按钮没填结果标识应报 N3_BUTTON_RESULT_TAG_REQUIRED")
	}
}
