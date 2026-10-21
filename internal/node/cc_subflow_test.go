package node

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

func ccNode(t *testing.T, cfg model.CCConfig) *model.Node {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal cc config: %v", err)
	}
	return &model.Node{ID: "c1", Kind: model.NodeKindCC, Name: "知会财务", Config: raw}
}

func subflowNode(t *testing.T, cfg model.SubflowConfig) *model.Node {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal subflow config: %v", err)
	}
	return &model.Node{ID: "s1", Kind: model.NodeKindSubflow, Name: "发起付款流程", Config: raw}
}

var expr = json.RawMessage(`{"mode":"value"}`)

// 抄送配全时不报诊断（收件人 + 一个渠道 + 标题 + 正文）。
func TestN4Validate_HappyPath(t *testing.T) {
	got := NewCCHandler().Validate(nil, ccNode(t, model.CCConfig{
		Recipients:  []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		Channels:    []model.NotifyChannel{model.NotifyChannelSystem},
		TitleExpr:   expr,
		ContentExpr: expr,
	}))
	if len(got) != 0 {
		t.Fatalf("配全的抄送不该有诊断，实得 %+v", got)
	}
}

// 抄送不走 C：**不校验办理方式**——它是辅助节点，没有人需要处理，配了办理方式也无从执行。
// 这条判据锁的是「别顺手把办理节点那套校验抄过来」。
func TestN4Validate_DoesNotRequireCompleteMode(t *testing.T) {
	got := codes(NewCCHandler().Validate(nil, ccNode(t, model.CCConfig{
		Recipients:  []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		Channels:    []model.NotifyChannel{model.NotifyChannelSystem},
		TitleExpr:   expr,
		ContentExpr: expr,
	})))
	for code := range got {
		if len(code) > 2 && code[:2] == "D_" {
			t.Fatalf("抄送不该产出办理方式类诊断，实得 %v", got)
		}
	}
	if got["NO_ROUTE_HINT_REQUIRED"] {
		t.Fatal("L6：抄送自己不配无路提示，不该要求它填")
	}
}

// 渠道：一个都没选要拒；选了三档之外的值要拒。
func TestN4Validate_Channels(t *testing.T) {
	base := model.CCConfig{
		Recipients:  []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		TitleExpr:   expr,
		ContentExpr: expr,
	}
	if !codes(NewCCHandler().Validate(nil, ccNode(t, base)))["N4_CHANNEL_REQUIRED"] {
		t.Fatal("一个渠道都没选应报 N4_CHANNEL_REQUIRED")
	}
	bad := base
	bad.Channels = []model.NotifyChannel{model.NotifyChannel("carrier_pigeon")}
	if !codes(NewCCHandler().Validate(nil, ccNode(t, bad)))["N4_CHANNEL_UNSUPPORTED"] {
		t.Fatal("三档之外的渠道应报 N4_CHANNEL_UNSUPPORTED")
	}
}

// 标题与正文都必填。空的 json.RawMessage 经一次序列化往返会变成字面量 null，判据要认得出来。
func TestN4Validate_TitleAndContentRequired(t *testing.T) {
	got := codes(NewCCHandler().Validate(nil, ccNode(t, model.CCConfig{
		Recipients: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		Channels:   []model.NotifyChannel{model.NotifyChannelSystem},
	})))
	if !got["N4_TITLE_REQUIRED"] || !got["N4_CONTENT_REQUIRED"] {
		t.Fatalf("标题与正文都没配应各报一条，实得 %v", got)
	}
}

// 子流程配全时不报诊断（目标流程 + 不等待 + 处置）。
func TestN6Validate_HappyPath(t *testing.T) {
	got := NewSubflowHandler().Validate(nil, subflowNode(t, model.SubflowConfig{
		TargetWorkflowID: "def-pay",
		Wait:             false,
		Disposition:      model.SubflowDispositionIgnore,
	}))
	if len(got) != 0 {
		t.Fatalf("配全的子流程不该有诊断，实得 %+v", got)
	}
}

// K3 第一条：传递字段的扩展表来源跨了两张表要拒；同一张表加主表字段混着不算跨。
func TestK3_MappingMustComeFromOneDetailTable(t *testing.T) {
	multi := model.SubflowConfig{TargetWorkflowID: "def-pay", Disposition: model.SubflowDispositionIgnore, FieldMappings: []model.SubflowFieldMapping{
		{SourceTableID: "t-items", SourceFieldID: "f-a", TargetFieldID: "g-a"},
		{SourceTableID: "t-fees", SourceFieldID: "f-b", TargetFieldID: "g-b"},
	}}
	if !codes(NewSubflowHandler().Validate(nil, subflowNode(t, multi)))["N6_MAPPING_MULTI_TABLE"] {
		t.Fatal("传递字段跨两张扩展表应报 N6_MAPPING_MULTI_TABLE")
	}

	oneTablePlusMain := model.SubflowConfig{TargetWorkflowID: "def-pay", Disposition: model.SubflowDispositionIgnore, FieldMappings: []model.SubflowFieldMapping{
		{SourceTableID: "t-items", SourceFieldID: "f-a", TargetFieldID: "g-a"},
		{SourceFieldID: "f-main", TargetFieldID: "g-main"}, // 主表字段：来源表 id 为空
	}}
	if codes(NewSubflowHandler().Validate(nil, subflowNode(t, oneTablePlusMain)))["N6_MAPPING_MULTI_TABLE"] {
		t.Fatal("一张扩展表 + 主表字段混着配是允许的，不该报跨表")
	}
}

// 传递字段没给目标字段：写不进去，发布期拒。
func TestN6Validate_MappingTargetRequired(t *testing.T) {
	cfg := model.SubflowConfig{TargetWorkflowID: "def-pay", Disposition: model.SubflowDispositionIgnore, FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main"},
	}}
	if !codes(NewSubflowHandler().Validate(nil, subflowNode(t, cfg)))["N6_MAPPING_TARGET_REQUIRED"] {
		t.Fatal("传递字段没给目标字段应报 N6_MAPPING_TARGET_REQUIRED")
	}
}

// K3 第三条：末级子流程只能不等待——末级节点不影响主线，等待无从谈起。
// 「末级」由图结构决定（没有出线），所以这条必须把 doc 传进来才测得到。
func TestK3_TerminalSubflowMustNotWait(t *testing.T) {
	cfg := model.SubflowConfig{TargetWorkflowID: "def-pay", Wait: true}
	n := subflowNode(t, cfg)

	terminal := &model.Document{Nodes: []model.Node{*n}, Links: []model.Link{{ID: "l1", From: "n1", To: n.ID}}}
	if !codes(NewSubflowHandler().Validate(terminal, n))["N6_TERMINAL_MUST_NOT_WAIT"] {
		t.Fatal("末级子流程配了「等待」应报 N6_TERMINAL_MUST_NOT_WAIT")
	}

	inline := &model.Document{Nodes: []model.Node{*n}, Links: []model.Link{
		{ID: "l1", From: "n1", To: n.ID}, {ID: "l2", From: n.ID, To: "n2"},
	}}
	if codes(NewSubflowHandler().Validate(inline, n))["N6_TERMINAL_MUST_NOT_WAIT"] {
		t.Fatal("穿插在主线里的子流程可以配「等待」，不该报末级限制")
	}
}

// 不等待时必须给出父流程结束后的处置；等待时不要求（面板置灰、运行期不看）。
func TestN6Validate_DispositionRequiredWhenNotWaiting(t *testing.T) {
	noWait := model.SubflowConfig{TargetWorkflowID: "def-pay", Wait: false}
	if !codes(NewSubflowHandler().Validate(nil, subflowNode(t, noWait)))["N6_DISPOSITION_REQUIRED"] {
		t.Fatal("不等待且没配处置应报 N6_DISPOSITION_REQUIRED")
	}
	waiting := model.SubflowConfig{TargetWorkflowID: "def-pay", Wait: true}
	if codes(NewSubflowHandler().Validate(nil, subflowNode(t, waiting)))["N6_DISPOSITION_REQUIRED"] {
		t.Fatal("等待档不要求配处置")
	}
}

// 目标流程必填。
func TestN6Validate_TargetRequired(t *testing.T) {
	cfg := model.SubflowConfig{Disposition: model.SubflowDispositionIgnore}
	if !codes(NewSubflowHandler().Validate(nil, subflowNode(t, cfg)))["N6_TARGET_REQUIRED"] {
		t.Fatal("没配目标流程应报 N6_TARGET_REQUIRED")
	}
}
