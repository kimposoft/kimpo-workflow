package compile

import (
	"context"
	"errors"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// subflowmap_test.go 测子流程的两道发布期闸：目标流程存在 / 同应用 / 已发布，以及传递字段来源
// 目标类型须相同或目标为文本。夹具口径：
//   - 本流程模板 "tpl-1"：f-main-text（主表文本）/ f-main-number（主表数字）/
//     f-main-date（主表已退役 date，仅用于「目标为已退役类型」用例）/ f-detail-text（扩展表
//     dt-items 文本）。
//   - 目标流程模板 "tpl-2"：f-child-text（主表文本）/ f-child-number（主表数字）/
//     f-child-date（主表已退役 date）/ f-child-detail（扩展表文本，用于「目标非主表」）。
//   - testkit.FakeFieldCatalog 忽略 template_id 参数，两边字段登记进同一份 Fields，
//     字段 id 全局唯一即可互不干扰（与 fieldtype_test.go 同款用法）。

func subflowTestCatalog() *testkit.FakeFieldCatalog {
	c := testkit.NewFakeFieldCatalog()
	c.Fields["f-main-text"] = ports.CatalogField{FieldID: "f-main-text", DataType: "text", TableRole: "main", DataTableID: "dt-main"}
	c.Fields["f-main-number"] = ports.CatalogField{FieldID: "f-main-number", DataType: "number", TableRole: "main", DataTableID: "dt-main"}
	c.Fields["f-main-date"] = ports.CatalogField{FieldID: "f-main-date", DataType: "date", TableRole: "main", DataTableID: "dt-main"}
	c.Fields["f-detail-text"] = ports.CatalogField{FieldID: "f-detail-text", DataType: "text", TableRole: "extension", DataTableID: "dt-items"}
	c.Fields["f-child-text"] = ports.CatalogField{FieldID: "f-child-text", DataType: "text", TableRole: "main", DataTableID: "dt-child-main"}
	c.Fields["f-child-number"] = ports.CatalogField{FieldID: "f-child-number", DataType: "number", TableRole: "main", DataTableID: "dt-child-main"}
	c.Fields["f-child-date"] = ports.CatalogField{FieldID: "f-child-date", DataType: "date", TableRole: "main", DataTableID: "dt-child-main"}
	c.Fields["f-child-detail"] = ports.CatalogField{FieldID: "f-child-detail", DataType: "text", TableRole: "extension", DataTableID: "dt-child-items"}
	return c
}

func subflowTestDefinitions() *testkit.FakeDefinitionCatalog {
	d := testkit.NewFakeDefinitionCatalog()
	d.Definitions["def-child-ok"] = &pb.DefinitionRow{DefinitionId: "def-child-ok", TemplateId: "tpl-2", LatestVersionNo: 3, StatusCode: "enabled"}
	d.Definitions["def-child-unpub"] = &pb.DefinitionRow{DefinitionId: "def-child-unpub", TemplateId: "tpl-2", LatestVersionNo: 0, StatusCode: "enabled"}
	d.Definitions["def-child-disabled"] = &pb.DefinitionRow{DefinitionId: "def-child-disabled", TemplateId: "tpl-2", LatestVersionNo: 2, StatusCode: "disabled"}
	return d
}

func subflowDoc(t *testing.T, nodeID string, cfg model.SubflowConfig) *model.Document {
	t.Helper()
	return &model.Document{
		Schema: model.SchemaVersion, Name: "N6.10 测试夹具",
		Nodes: []model.Node{{ID: nodeID, Kind: model.NodeKindSubflow, Name: "子流程", Config: cfgJSON(t, cfg)}},
	}
}

func onlyDiag(t *testing.T, diags []model.Diagnostic) model.Diagnostic {
	t.Helper()
	if len(diags) != 1 {
		t.Fatalf("期望恰好一条诊断，实得 %+v", diags)
	}
	return diags[0]
}

// —— K3：目标流程状态 ——

func TestSubflowMap_TargetMissing(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-not-exist"})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != targetNotPublishedCode || d.NodeID != "sf1" || d.Arguments["reason"] != "missing" || d.Arguments["target_workflow_id"] != "def-not-exist" {
		t.Fatalf("期望目标不存在诊断，实得 %+v", d)
	}
}

func TestSubflowMap_TargetUnpublished(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-unpub"})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != targetNotPublishedCode || d.Arguments["reason"] != "unpublished" {
		t.Fatalf("期望目标未发布诊断，实得 %+v", d)
	}
}

func TestSubflowMap_TargetDisabled(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-disabled"})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != targetNotPublishedCode || d.Arguments["reason"] != "disabled" {
		t.Fatalf("期望目标已停用诊断，实得 %+v", d)
	}
}

// —— N6.10：来源字段 ——

// TestSubflowMap_MainTableIDAsDetail：把主表 id 写进 SourceTableID（背景里点出的真实画法），
// 运行期 subflowParams 会把它当扩展表读成零行，编译期在这里先拦住。
func TestSubflowMap_MainTableIDAsDetail(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceTableID: "dt-main", SourceFieldID: "f-main-text", TargetFieldID: "f-child-text"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingSourceInvalidCode || d.Arguments["reason"] != "main_table_id_as_detail" {
		t.Fatalf("期望主表 id 当扩展表诊断，实得 %+v", d)
	}
}

func TestSubflowMap_SourceFieldMissing(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-not-registered", TargetFieldID: "f-child-text"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingSourceInvalidCode || d.Arguments["reason"] != "missing" {
		t.Fatalf("期望来源字段不存在诊断，实得 %+v", d)
	}
}

// TestSubflowMap_SourceNotMainWhenTableEmpty：SourceTableID 留空却指向一个实际在扩展表上的
// 字段——声明与实际所属表对不上。
func TestSubflowMap_SourceNotMainWhenTableEmpty(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-detail-text", TargetFieldID: "f-child-text"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingSourceInvalidCode || d.Arguments["reason"] != "not_main" {
		t.Fatalf("期望来源字段非主表诊断，实得 %+v", d)
	}
}

// TestSubflowMap_SourceTableMismatch：SourceTableID 给的表 id 与来源字段实际所属的扩展表不同。
func TestSubflowMap_SourceTableMismatch(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceTableID: "dt-other", SourceFieldID: "f-detail-text", TargetFieldID: "f-child-text"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingSourceInvalidCode || d.Arguments["reason"] != "table_mismatch" {
		t.Fatalf("期望来源表不一致诊断，实得 %+v", d)
	}
}

// —— N6.10：目标字段 ——

func TestSubflowMap_TargetFieldMissing(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-text", TargetFieldID: "f-not-registered"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingTargetInvalidCode || d.Arguments["reason"] != "missing" {
		t.Fatalf("期望目标字段不存在诊断，实得 %+v", d)
	}
}

func TestSubflowMap_TargetFieldNotMain(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-text", TargetFieldID: "f-child-detail"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingTargetInvalidCode || d.Arguments["reason"] != "not_main" {
		t.Fatalf("期望目标字段非主表诊断，实得 %+v", d)
	}
}

// —— N6.10：类型 ——

func TestSubflowMap_SameTypePasses(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-text", TargetFieldID: "f-child-text"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("同类型应放行，实得 %+v", diags)
	}
}

func TestSubflowMap_NumberToTextPasses(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-number", TargetFieldID: "f-child-text"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("目标为文本应放行，实得 %+v", diags)
	}
}

func TestSubflowMap_TextToNumberRejected(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-text", TargetFieldID: "f-child-number"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingTypeMismatchCode || d.Arguments["source_type"] != "text" || d.Arguments["target_type"] != "number" ||
		d.Arguments["source_field_id"] != "f-main-text" || d.Arguments["target_field_id"] != "f-child-number" {
		t.Fatalf("期望类型不一致诊断，实得 %+v", d)
	}
}

// TestSubflowMap_TargetDateRejected：目标为已退役类型 date 一律拒绝，即便来源恰好也是 date
// （两边类型字面相同，仍不能放行——退役档不能靠“类型相同”这条豁免通过）。
func TestSubflowMap_TargetDateRejected(t *testing.T) {
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-date", TargetFieldID: "f-child-date"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	d := onlyDiag(t, diags)
	if d.Code != mappingTypeMismatchCode || d.Arguments["target_type"] != "date" {
		t.Fatalf("目标为已退役类型应拒绝，实得 %+v", d)
	}
}

// —— 缓存与跳过 ——

// TestSubflowMap_MultipleNodesSameTargetCachedCalls：两个子流程节点指向同一目标，账本
// GetDefinition 与字段目录 ListFields 都应该只各查一次（前者按目标 id 缓存，后者按模板缓存）。
func TestSubflowMap_MultipleNodesSameTargetCachedCalls(t *testing.T) {
	catalog := subflowTestCatalog()
	defs := subflowTestDefinitions()
	c := New(nil, &fakeFreezer{}, catalog, defs)
	doc := &model.Document{
		Schema: model.SchemaVersion, Name: "多节点同目标",
		Nodes: []model.Node{
			{ID: "sf1", Kind: model.NodeKindSubflow, Config: cfgJSON(t, model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
				{SourceFieldID: "f-main-text", TargetFieldID: "f-child-text"},
			}})},
			{ID: "sf2", Kind: model.NodeKindSubflow, Config: cfgJSON(t, model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
				{SourceFieldID: "f-main-number", TargetFieldID: "f-child-text"},
			}})},
		},
	}
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("两个映射都应放行，实得 %+v", diags)
	}
	if len(defs.Calls) != 1 {
		t.Fatalf("两个子流程节点指向同一目标，账本应只查一次，实得 %v", defs.Calls)
	}
	if catalog.Calls != 2 {
		t.Fatalf("本模板 + 目标模板各查一次＝2 次，实得 %d 次（多节点不应重复查同一模板）", catalog.Calls)
	}
}

func TestSubflowMap_NilDefinitionsSkipsEntirely(t *testing.T) {
	// definitions 为 nil：即便文档里目标缺失、映射明显违规，也不应报任何诊断（仅测试场景）。
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), nil)
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-not-exist", FieldMappings: []model.SubflowFieldMapping{
		{SourceTableID: "dt-main", SourceFieldID: "f-main-text", TargetFieldID: "f-child-number"},
	}})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("definitions 为 nil 应整段跳过，实得 %+v", diags)
	}
}

func TestSubflowMap_NilCatalogSkipsEntirely(t *testing.T) {
	// catalog 为 nil：即便账本能查到目标，也没有字段目录可比类型，同样整段跳过。
	c := New(nil, &fakeFreezer{}, nil, subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-not-exist"})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("catalog 为 nil 应整段跳过，实得 %+v", diags)
	}
}

func TestSubflowMap_NoSubflowNodesSkipsNetworkCalls(t *testing.T) {
	catalog := subflowTestCatalog()
	defs := subflowTestDefinitions()
	c := New(nil, &fakeFreezer{}, catalog, defs)
	doc := &model.Document{Schema: model.SchemaVersion, Name: "无子流程节点", Nodes: []model.Node{
		{ID: "n0", Kind: model.NodeKindStart, Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
	}}
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 || len(defs.Calls) != 0 || catalog.Calls != 0 {
		t.Fatalf("没有子流程节点不该发起任何账本 / 目录调用，实得 diags=%+v defCalls=%v catalogCalls=%d", diags, defs.Calls, catalog.Calls)
	}
}

// TestSubflowMap_EmptyMappingsSkipsFieldCatalog：目标合规但没配传递字段——K3 仍要跑（确认目标
// 有效），但不应该为了 N6.10 白拉字段目录。
func TestSubflowMap_EmptyMappingsSkipsFieldCatalog(t *testing.T) {
	catalog := subflowTestCatalog()
	defs := subflowTestDefinitions()
	c := New(nil, &fakeFreezer{}, catalog, defs)
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok"})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("无传递字段不该报 N6.10，实得 %+v", diags)
	}
	if len(defs.Calls) != 1 {
		t.Fatalf("K3 仍应查一次账本，实得 %v", defs.Calls)
	}
	if catalog.Calls != 0 {
		t.Fatalf("无传递字段不该拉字段目录，实得 %d 次", catalog.Calls)
	}
}

func TestSubflowMap_TargetWorkflowIDEmptySkips(t *testing.T) {
	// 目标流程未填：node/subflow.go 已经报 N6_TARGET_REQUIRED，本层没有目标可查，干净跳过。
	catalog := subflowTestCatalog()
	defs := subflowTestDefinitions()
	c := New(nil, &fakeFreezer{}, catalog, defs)
	doc := subflowDoc(t, "sf1", model.SubflowConfig{})
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 || len(defs.Calls) != 0 {
		t.Fatalf("目标流程未填不该报本层诊断也不该查账本，实得 diags=%+v calls=%v", diags, defs.Calls)
	}
}

func TestSubflowMap_ConfigDecodeErrorSkips(t *testing.T) {
	// 配置解不开：node/subflow.go 的 Handler.Validate 已经报 NODE_CONFIG_INVALID，本层跳过
	// 这个节点，不额外报错也不 panic。
	catalog := subflowTestCatalog()
	defs := subflowTestDefinitions()
	c := New(nil, &fakeFreezer{}, catalog, defs)
	doc := &model.Document{Schema: model.SchemaVersion, Name: "配置损坏", Nodes: []model.Node{
		{ID: "sf1", Kind: model.NodeKindSubflow, Config: []byte(`{"target_workflow_id": `)},
	}}
	diags, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err != nil {
		t.Fatalf("subflowMappingChecks: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("配置损坏应静默跳过（留给结构检查报错），实得 %+v", diags)
	}
}

// —— 目录 / 账本调用失败：发布失败，不静默放行 ——

func TestSubflowMap_DefinitionsErrorFailsCompile(t *testing.T) {
	defs := subflowTestDefinitions()
	defs.Err = errors.New("ledger unavailable")
	c := New(nil, &fakeFreezer{}, subflowTestCatalog(), defs)
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok"})
	_, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err == nil {
		t.Fatal("账本调用失败应导致整体返回 error")
	}
}

func TestSubflowMap_CatalogErrorFailsCompile(t *testing.T) {
	catalog := subflowTestCatalog()
	catalog.Err = errors.New("template catalog unavailable")
	c := New(nil, &fakeFreezer{}, catalog, subflowTestDefinitions())
	doc := subflowDoc(t, "sf1", model.SubflowConfig{TargetWorkflowID: "def-child-ok", FieldMappings: []model.SubflowFieldMapping{
		{SourceFieldID: "f-main-text", TargetFieldID: "f-child-text"},
	}})
	_, err := c.subflowMappingChecks(context.Background(), "app", "tpl-1", doc)
	if err == nil {
		t.Fatal("目录调用失败应导致整体返回 error")
	}
}

// —— 端到端：走完整 Compile()，确认接线正确且 DryRun 同一条闸 ——

// subflowFullDoc 以 f1Lite 为底，追加一个挂在末级支线上的子流程节点（末级节点，Wait=false 合规），
// 传递字段刻意类型不一致，好断言诊断能从 Compile() 一路带出来。
func subflowFullDoc(t *testing.T) *model.Document {
	t.Helper()
	doc := f1Lite(t)
	doc.Nodes = append(doc.Nodes, model.Node{ID: "sf", Kind: model.NodeKindSubflow, Config: cfgJSON(t, model.SubflowConfig{
		TargetWorkflowID: "def-child-ok", Disposition: model.SubflowDispositionIgnore,
		FieldMappings: []model.SubflowFieldMapping{{SourceFieldID: "f-main-text", TargetFieldID: "f-child-number"}},
	})})
	doc.Links = append(doc.Links, model.Link{ID: "l-sf", From: "n1", To: "sf"})
	return doc
}

func TestSubflowMap_CompileIntegration_DryRunSameGate(t *testing.T) {
	for _, dryRun := range []bool{false, true} {
		dryRun := dryRun
		t.Run(map[bool]string{false: "publish", true: "dry_run"}[dryRun], func(t *testing.T) {
			catalog := subflowTestCatalog()
			catalog.Fields["f-status"] = ports.CatalogField{FieldID: "f-status", DataType: "text", TableRole: "main", DataTableID: "dt-main"}
			c := New(nil, &fakeFreezer{}, catalog, subflowTestDefinitions())
			res, err := c.Compile(context.Background(), Input{
				Document: subflowFullDoc(t), AppID: "app", TemplateID: "tpl-1", DefinitionID: "def-1", VersionNo: 1,
				TemplatePublished: true, DryRun: dryRun,
			})
			if err != nil {
				t.Fatalf("Compile: %v", err)
			}
			if !hasCode(res.Diagnostics, mappingTypeMismatchCode, "sf") {
				t.Fatalf("期望 N6.10 类型不一致诊断从 Compile 带出，实得 %+v", res.Diagnostics)
			}
			if res.Compiled != nil {
				t.Fatalf("命中 N6.10 应整体拒绝，不该有编译结果：%+v", res.Compiled)
			}
		})
	}
}
