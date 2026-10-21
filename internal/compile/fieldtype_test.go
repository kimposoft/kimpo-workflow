package compile

import (
	"context"
	"errors"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// approveEndDoc 发起 → 审批（结果绑定 f-result / 理由绑定 f-reason）→ 结束（标识写入
// f-status）：三个待检字段引用一次配齐（RefKindApproveBind ×2 + RefKindEndLabelTarget ×1），
// 结构上刻意干净（无引导线条件、无摘要/自动办理表达式），使得除 K4 外不产生别的诊断，
// 单测断言时不用先过滤噪音。
func approveEndDoc(t *testing.T) *model.Document {
	t.Helper()
	return &model.Document{
		Schema: model.SchemaVersion, Name: "K4 字段类型闸夹具",
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindApprove, Name: "审批", Config: cfgJSON(t, model.ApproveConfig{
				Approvers:     []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}},
				CompleteMode:  model.CompleteMode{Kind: model.CompleteModeAny},
				Buttons:       []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "approved"}},
				ResultFieldID: "f-result", ReasonFieldID: "f-reason",
				NoRouteHint: "无路可走",
			})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{
			{ID: "l1", From: "n0", To: "n1"},
			{ID: "l2", From: "n1", To: "n2"},
		},
	}
}

// compileWithCatalog 是本文件专用的编译入口：固定用 approveEndDoc + 传入的假目录，dryRun 由
// 调用方决定（DryRun 也要走同一闸，校验与发布口径一致）。
func compileWithCatalog(t *testing.T, catalog *testkit.FakeFieldCatalog, dryRun bool) (Result, error) {
	t.Helper()
	return New(nil, &fakeFreezer{}, catalog, nil).Compile(context.Background(), Input{
		Document: approveEndDoc(t), AppID: "app", TemplateID: "tpl-1", DefinitionID: "def-1", VersionNo: 1,
		TemplatePublished: true, DryRun: dryRun,
	})
}

// TestFieldType_AllMainTextPasses：三个绑定字段都是主表文本字段 → 放行，Diagnostics 为空。
func TestFieldType_AllMainTextPasses(t *testing.T) {
	catalog := testkit.AllTextMain("f-result", "f-reason", "f-status")
	res, err := compileWithCatalog(t, catalog, false)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if len(res.Diagnostics) != 0 {
		t.Fatalf("全部主表文本字段应放行，实得 %+v", res.Diagnostics)
	}
	if res.Compiled == nil {
		t.Fatal("放行时应有编译结果")
	}
	if catalog.Calls != 1 {
		t.Fatalf("目录应恰好被拉取一次（一次编译一次目录调用），实得 %d 次", catalog.Calls)
	}
}

// TestFieldType_DetailTableTextRejected：扩展表文本字段（table_role=extension）拒绝——
// K4 只认主表，哪怕类型是文本。
func TestFieldType_DetailTableTextRejected(t *testing.T) {
	catalog := testkit.AllTextMain("f-result", "f-reason", "f-status")
	catalog.Fields["f-status"] = ports.CatalogField{FieldID: "f-status", DataType: "text", TableRole: "extension"}
	res, err := compileWithCatalog(t, catalog, false)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	assertFieldTypeUnsupported(t, res.Diagnostics, "n2", "f-status")
}

// TestFieldType_MainNumberRejected：主表但类型是 number → 拒绝（正向白名单只认 text）。
func TestFieldType_MainNumberRejected(t *testing.T) {
	catalog := testkit.AllTextMain("f-result", "f-reason", "f-status")
	catalog.Fields["f-result"] = ports.CatalogField{FieldID: "f-result", DataType: "number", TableRole: "main"}
	res, err := compileWithCatalog(t, catalog, false)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	assertFieldTypeUnsupported(t, res.Diagnostics, "n1", "f-result")
}

// TestFieldType_RetiredTypesRejected：已退役的 boolean / date 字段类型不在白名单内，
// 绑定字段类型闸是正向白名单而非黑名单，退役档自然落在拒绝侧。
func TestFieldType_RetiredTypesRejected(t *testing.T) {
	for _, retired := range []string{"boolean", "date"} {
		t.Run(retired, func(t *testing.T) {
			catalog := testkit.AllTextMain("f-result", "f-reason", "f-status")
			catalog.Fields["f-reason"] = ports.CatalogField{FieldID: "f-reason", DataType: retired, TableRole: "main"}
			res, err := compileWithCatalog(t, catalog, false)
			if err != nil {
				t.Fatalf("Compile: %v", err)
			}
			assertFieldTypeUnsupported(t, res.Diagnostics, "n1", "f-reason")
		})
	}
}

// TestFieldType_MissingFieldRejected：字段目录里查不到该字段（如已被删除）→ 拒绝，
// arguments.reason = missing。
func TestFieldType_MissingFieldRejected(t *testing.T) {
	catalog := testkit.AllTextMain("f-result", "f-reason") // 故意不登记 f-status
	res, err := compileWithCatalog(t, catalog, false)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	var found bool
	for _, d := range res.Diagnostics {
		if d.Code == fieldTypeUnsupportedCode && d.NodeID == "n2" && d.Arguments["field_id"] == "f-status" {
			found = true
			if d.Arguments["reason"] != "missing" {
				t.Fatalf("字段不存在应标 reason=missing，实得 %+v", d.Arguments)
			}
		}
	}
	if !found {
		t.Fatalf("应报字段不存在，实得 %+v", res.Diagnostics)
	}
}

// TestFieldType_CatalogErrorFailsCompile：目录调用失败 → Compile 顶层返回 error（不是
// Diagnostics），发布失败但不静默放行。
func TestFieldType_CatalogErrorFailsCompile(t *testing.T) {
	catalog := testkit.AllTextMain("f-result", "f-reason", "f-status")
	catalog.Err = errors.New("template catalog unavailable")
	res, err := compileWithCatalog(t, catalog, false)
	if err == nil {
		t.Fatalf("目录报错应导致 Compile 返回 error，实得 res=%+v", res)
	}
}

// TestFieldType_DryRunSameGate：DryRun（Validate 端点）同样跑 K4 这一闸，校验口径与发布一致。
func TestFieldType_DryRunSameGate(t *testing.T) {
	catalog := testkit.AllTextMain("f-result", "f-reason")
	catalog.Fields["f-status"] = ports.CatalogField{FieldID: "f-status", DataType: "number", TableRole: "main"}
	res, err := compileWithCatalog(t, catalog, true)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	assertFieldTypeUnsupported(t, res.Diagnostics, "n2", "f-status")
	if res.Compiled != nil {
		t.Fatalf("DryRun 命中 K4 应整体拒绝，不该有编译结果：%+v", res.Compiled)
	}
}

// TestFieldType_NilCatalogSkipsGate：catalog 为 nil（仅单测场景）时整闸跳过，
// 即便字段类型明显不合规也不报——呼应 Compiler.catalog 字段注释「生产装配必须注入」。
func TestFieldType_NilCatalogSkipsGate(t *testing.T) {
	res, err := New(nil, &fakeFreezer{}, nil, nil).Compile(context.Background(), Input{
		Document: approveEndDoc(t), AppID: "app", TemplateID: "tpl-1", DefinitionID: "def-1", VersionNo: 1, TemplatePublished: true,
	})
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if len(res.Diagnostics) != 0 {
		t.Fatalf("catalog 为 nil 时应跳过 K4 闸，实得 %+v", res.Diagnostics)
	}
}

// TestFieldType_NoBindingRefsSkipsCatalogCall：文档没有任何待检字段引用（无绑定字段）时
// 不应该发起目录调用——避免每次编译白拉一次整张模板的字段目录。
func TestFieldType_NoBindingRefsSkipsCatalogCall(t *testing.T) {
	doc := &model.Document{
		Schema: model.SchemaVersion, Name: "无绑定字段",
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}},
	}
	catalog := testkit.NewFakeFieldCatalog()
	res, err := New(nil, &fakeFreezer{}, catalog, nil).Compile(context.Background(), Input{
		Document: doc, AppID: "app", TemplateID: "tpl-1", DefinitionID: "def-1", VersionNo: 1, TemplatePublished: true,
	})
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if len(res.Diagnostics) != 0 {
		t.Fatalf("无绑定字段不该报 K4：%+v", res.Diagnostics)
	}
	if catalog.Calls != 0 {
		t.Fatalf("无待检字段引用不该发起目录调用，实得 %d 次", catalog.Calls)
	}
}

func assertFieldTypeUnsupported(t *testing.T, diags []model.Diagnostic, nodeID, fieldID string) {
	t.Helper()
	for _, d := range diags {
		if d.Code == fieldTypeUnsupportedCode && d.NodeID == nodeID && d.Arguments["field_id"] == fieldID {
			return
		}
	}
	t.Fatalf("期望 %s 上字段 %s 报 %s，实得 %+v", nodeID, fieldID, fieldTypeUnsupportedCode, diags)
}
