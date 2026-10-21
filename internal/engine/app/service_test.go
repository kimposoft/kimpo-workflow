package engineapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// —— 夹具 ——

type fakeFreezer struct {
	calls int
	err   error
}

// Freeze 每条表达式冻结为 "pub:<expression_id>"。
func (f *fakeFreezer) Freeze(_ context.Context, in compile.FreezeInput) (compile.FreezeOutput, error) {
	f.calls++
	if f.err != nil {
		return compile.FreezeOutput{}, f.err
	}
	var out compile.FreezeOutput
	for _, sp := range in.Specs {
		out.Frozen = append(out.Frozen, compile.FrozenExpression{ExpressionID: sp.ExpressionID, PublicationID: "pub:" + sp.ExpressionID,
			ReferencedFields: []compile.FieldRef{{DataTableID: "dt-main", FieldID: "f-amount"}}})
	}
	return out, nil
}

type fixture struct {
	svc    *Service
	ledger *testkit.MemLedger
	expr   *testkit.FakeExpr
	rec    *testkit.FakeRecord
	fz     *fakeFreezer
	// launch 子流程非人工发起通道的假体；newFixture 默认不接，用到子流程的用例
	// 自己把它接到 f.svc.Launch 上（其余既有用例不碰这个字段，保持互不干扰）。
	launch *testkit.FakeLaunch
	// lease 编辑租约释放的假体：newFixture 默认接好，改派用例直接断言 f.lease.Calls。
	lease *testkit.FakeLease
	seq   int
}

var (
	starter  = ports.Actor{UserID: 1, DisplayName: "张三"}
	wangFang = ports.Actor{UserID: 22, DisplayName: "王芳"}
	designer = ports.Actor{UserID: 7, DisplayName: "设计者"}
)

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{ledger: testkit.NewMemLedger(), expr: testkit.NewFakeExpr(), rec: &testkit.FakeRecord{Serial: "PO0001", Exists: true}, fz: &fakeFreezer{}, launch: &testkit.FakeLaunch{}, lease: &testkit.FakeLease{}}
	ids := testkit.NewSeqIDs()
	clock := testkit.FixedClock{T: time.Date(2026, 9, 17, 3, 0, 0, 0, time.UTC)}
	f.svc = &Service{Ledger: f.ledger, Record: f.rec, Clock: clock, IDs: ids, Launch: f.launch, Lease: f.lease, Compiler: compile.New(nil, f.fz, testkit.AllTextMain("f-status"), nil),
		Engine: &core.Engine{Expr: f.expr, Candidate: testkit.StaticCandidate{}, Record: f.rec, Clock: clock, IDs: ids}}
	f.expr.Conditions["pub:l1"] = true
	return f
}

func (f *fixture) meta(actor ports.Actor) Meta {
	f.seq++
	return Meta{AppID: "app", RequestKey: "req-" + itoa(f.seq), Actor: actor}
}

func itoa(n int) string { return strconv.Itoa(n) }

func cfg(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// draftDoc 发起 → 部门审批（王芳）→ 结束「已通过」写 f-status；l1 带条件。
func draftDoc(t *testing.T) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "采购申请审批", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1", ConditionDoc: json.RawMessage(`{"mode":"condition"}`)}, {ID: "l2", From: "n1", To: "n2"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// threeStepDoc 三级链：发起 → 部门审批（王芳 22）→ 财务复核（李四 33）→ 结束；给撤销 / 会签类用例用
// （两站定义提交即直达结束，撤不出「下一站未被动过」的场景）。
func threeStepDoc(t *testing.T) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "三级审批", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "n3", Kind: model.NodeKindHandle, Name: "财务复核", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{33}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "n3"}, {ID: "l3", From: "n3", To: "n2"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// taskOf 聚合里某人处于某状态的任务 id（找不到 t.Fatal）。
func taskOf(t *testing.T, agg *pb.InstanceAggregate, userID int64, status string) string {
	t.Helper()
	for _, tk := range agg.GetTasks() {
		if tk.GetAssigneeUserId() == userID && tk.GetStatus() == status {
			return tk.GetTaskId()
		}
	}
	t.Fatalf("no task of user %d with status %s", userID, status)
	return ""
}

// published 走完 Create → SaveDraft → Publish，返回定义 id。
func (f *fixture) published(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	view, err := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "采购申请审批")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	id := view.Definition.GetDefinitionId()
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, draftDoc(t), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "f-no")
	if err != nil || len(res.Diagnostics) != 0 || res.VersionNo != 1 {
		t.Fatalf("publish: res %+v err %v", res, err)
	}
	return id
}

// publishDoc 走完 Create → SaveDraft → Publish（不冻结自动编号字段），供子流程用例搭两条独立
// 定义（父流程、目标流程各绑自己的模板）时复用；与 published() 不同，doc 由调用方自己给。
func (f *fixture) publishDoc(t *testing.T, templateID, name, doc string) string {
	t.Helper()
	ctx := context.Background()
	view, err := f.svc.CreateDefinition(ctx, f.meta(designer), templateID, name)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	id := view.Definition.GetDefinitionId()
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, doc, view.Definition.GetVersionNo())
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "")
	if err != nil || len(res.Diagnostics) != 0 {
		t.Fatalf("publish: %+v err %v", res, err)
	}
	return id
}

// subflowChildDoc 子流程目标流程：发起 → 结束，单步直达（不占用人工任务，Start 一步到底）；
// AllowManualStart 故意关闭——验证「允许人工发起关闭的流程也能被子流程发起」。
func subflowChildDoc(t *testing.T, templateID string) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "子流程目标", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "c0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: templateID, AllowManualStart: false, NoRouteHint: "无路可走"})},
			{ID: "c1", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "子流程已完成"})},
		},
		Links: []model.Link{{ID: "cl1", From: "c0", To: "c1"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// subflowChildDocWithStartCondition 子流程目标流程：发起（配一条发起条件 + 提示）→ 结束；供
// 「子流程发起不受发起条件限制」用例使用（人工与动作发起过这道闸，子流程发起不过）。fakeFreezer 把每条表达式冻结为 "pub:"+expression_id，配合
// f.expr.Conditions["pub:c0:start_cond"] 摆真假。
func subflowChildDocWithStartCondition(t *testing.T, templateID, hint string) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "子流程目标（带发起条件）", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "c0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{
				TargetTemplateID: templateID, AllowManualStart: false, NoRouteHint: "无路可走",
				StartCondition: json.RawMessage(`{"mode":"condition"}`), StartConditionHint: hint,
			})},
			{ID: "c1", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "子流程已完成"})},
		},
		Links: []model.Link{{ID: "cl1", From: "c0", To: "c1"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// subflowChildHandleDoc 子流程目标流程：发起 → 办理（assigneeUserID）→ 结束——比 subflowChildDoc
// 多一站，子实例不会在 Start 那一刻就自己结束，供需要观察「子实例仍在跑」中间状态的用例
// （等待档、回退强制结束）使用。
func subflowChildHandleDoc(t *testing.T, templateID string, assigneeUserID int64) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "子流程目标(办理)", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "c0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: templateID, AllowManualStart: false, NoRouteHint: "无路可走"})},
			{ID: "c1", Kind: model.NodeKindHandle, Name: "子流程办理", Config: cfg(t, model.HandleConfig{
				Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{assigneeUserID}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线",
			})},
			{ID: "c2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "子流程已完成"})},
		},
		Links: []model.Link{{ID: "cl1", From: "c0", To: "c1"}, {ID: "cl2", From: "c1", To: "c2"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// subflowParentDoc 发起 → 部门审批（王芳 22）→ 子流程 → 结束「已通过」（不写字段，避免两段式
// 与子流程两件事绞在一起）。
func subflowParentDoc(t *testing.T, childDefID string, wait bool, disposition model.SubflowDisposition, mappings []model.SubflowFieldMapping) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "父流程", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "sf", Kind: model.NodeKindSubflow, Name: "子流程", Config: cfg(t, model.SubflowConfig{TargetWorkflowID: childDefID, FieldMappings: mappings, Wait: wait, Disposition: disposition})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "sf"}, {ID: "l3", From: "sf", To: "n2"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// hasOutboxSuffix 发件箱种类清单（"seq/KIND"）里是否含某个 KIND。
func hasOutboxSuffix(kinds []string, kind string) bool {
	for _, k := range kinds {
		if strings.HasSuffix(k, "/"+kind) {
			return true
		}
	}
	return false
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if core.CodeOf(err) != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

// —— 定义面 ——

// TestDefinition_LifecycleCreateDraftPublish：新建（默认草稿只有发起节点）→ 存草稿（乐观锁）→ 发布（冻结 + 字段引用）→ 查询。
func TestDefinition_LifecycleCreateDraftPublish(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, err := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "采购申请审批")
	if err != nil {
		t.Fatal(err)
	}
	def := view.Definition
	if def.GetStatusCode() != "enabled" || def.GetLatestVersionNo() != 0 || def.GetVersionNo() != 1 || def.GetCreatedBy() != 7 {
		t.Fatalf("definition = %+v", def)
	}
	doc, err := model.Decode([]byte(def.GetDraftJson()))
	if err != nil || len(doc.Nodes) != 1 || doc.Nodes[0].Kind != model.NodeKindStart {
		t.Fatalf("default draft = %s err %v", def.GetDraftJson(), err)
	}
	// 乐观锁：带过期 version_no 保存 → VERSION_CONFLICT。
	_, err = f.svc.SaveDraft(ctx, f.meta(designer), def.GetDefinitionId(), draftDoc(t), 99)
	wantCode(t, err, "VERSION_CONFLICT")
	// 非法草稿 → 拒绝。
	_, err = f.svc.SaveDraft(ctx, f.meta(designer), def.GetDefinitionId(), `{"schema":"nope"}`, 1)
	wantCode(t, err, "INVALID_CHOICE")
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), def.GetDefinitionId(), draftDoc(t), 1)
	if err != nil || view.Definition.GetVersionNo() != 2 || view.Definition.GetDraftUpdatedAt() == nil {
		t.Fatalf("save draft: %+v err %v", view, err)
	}
	// 发布前 Validate：模板未发布 → K2；已发布 → 干净，且不冻结。
	diags, err := f.svc.Validate(ctx, f.meta(designer), def.GetDefinitionId(), "", false)
	if err != nil || len(diags) != 1 || diags[0].Code != "K2" {
		t.Fatalf("validate: %+v err %v", diags, err)
	}
	diags, err = f.svc.Validate(ctx, f.meta(designer), def.GetDefinitionId(), "", true)
	if err != nil || len(diags) != 0 || f.fz.calls != 0 {
		t.Fatalf("validate clean: %+v err %v calls %d", diags, err, f.fz.calls)
	}
	res, err := f.svc.Publish(ctx, f.meta(designer), def.GetDefinitionId(), 2, true, "f-no")
	if err != nil || len(res.Diagnostics) != 0 || res.VersionNo != 1 || res.VersionID == "" || f.fz.calls != 1 {
		t.Fatalf("publish: %+v err %v", res, err)
	}
	view, err = f.svc.GetDefinition(ctx, f.meta(designer), def.GetDefinitionId(), false)
	if err != nil || view.Definition.GetLatestVersionNo() != 1 || view.Definition.GetVersionNo() != 3 || view.Definition.GetDraftJson() != "" || len(view.Versions) != 1 {
		t.Fatalf("get: %+v err %v", view, err)
	}
	ver := view.Versions[0]
	if ver.GetVersionNo() != 1 || !ver.GetAllowManualStart() || ver.GetGraphJson() == "" || ver.GetCompiledJson() == "" || ver.GetPublishedBy() != 7 {
		t.Fatalf("version = %+v", ver)
	}
	compiled, err := compile.Decode([]byte(ver.GetCompiledJson()))
	if err != nil || compiled.Link("l1").ConditionPublicationID != "pub:l1" || compiled.SerialFieldID != "f-no" {
		t.Fatalf("compiled = %+v err %v", compiled, err)
	}
	// 字段引用：结束标识写入目标（end_label_target）+ 引导线条件引用（link_condition，来自冻结回报）。
	kinds := map[string]string{}
	for _, r := range f.ledger.FieldRefs[def.GetDefinitionId()] {
		kinds[r.GetRefKind()] = r.GetFieldId() + "@" + r.GetNodeId() + r.GetLinkId()
	}
	if len(kinds) != 2 || kinds["end_label_target"] != "f-status@n2" || kinds["link_condition"] != "f-amount@l1" {
		t.Fatalf("field refs = %+v", f.ledger.FieldRefs[def.GetDefinitionId()])
	}
	// 再发布一次 = 版本 2；DV2：草稿仍在。
	res, err = f.svc.Publish(ctx, f.meta(designer), def.GetDefinitionId(), view.Definition.GetVersionNo(), true, "")
	if err != nil || res.VersionNo != 2 {
		t.Fatalf("second publish: %+v err %v", res, err)
	}
	view, _ = f.svc.GetDefinition(ctx, f.meta(designer), def.GetDefinitionId(), true)
	if view.Definition.GetDraftJson() == "" || len(view.Versions) != 2 {
		t.Fatalf("draft must survive publish: %+v", view)
	}
	rows, err := f.svc.ListDefinitions(ctx, f.meta(designer), "tpl-1", false)
	if err != nil || len(rows) != 1 || rows[0].GetDraftJson() != "" {
		t.Fatalf("list: %+v err %v", rows, err)
	}
}

// TestDefinition_PublishRejectedByDiagnostics：结构检查不过 → 诊断返回、不建版本、不冻结。
func TestDefinition_PublishRejectedByDiagnostics(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "采购申请审批")
	id := view.Definition.GetDefinitionId()
	res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "")
	if err != nil || len(res.Diagnostics) == 0 || res.VersionNo != 0 || f.fz.calls != 0 {
		t.Fatalf("publish default draft must be rejected (L10/L11): %+v err %v", res, err)
	}
	if len(f.ledger.Versions[id]) != 0 {
		t.Fatalf("no version may be created")
	}
	// 冻结失败 → SYSTEM_ERROR。
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, draftDoc(t), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	f.fz.err = errors.New("host down")
	_, err = f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "")
	wantCode(t, err, "SYSTEM_ERROR")
}

// TestK1_L11_EndNeedsInline：K1 结构检查——每个结束节点都要有入线；孤立的结束节点（没有任何引导
// 线指向它）即使流程里另有一个正常的结束节点，也必须单独报 L11 并带上它自己的 node_id。
func TestK1_L11_EndNeedsInline(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "结构测试")
	id := view.Definition.GetDefinitionId()
	doc := model.Document{Schema: model.SchemaVersion, Name: "结构测试", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true})},
			{ID: "n1", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过"})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "孤立结束", Config: cfg(t, model.EndConfig{EndFlag: "异常"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, string(raw), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "")
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	var hit *model.Diagnostic
	for i := range res.Diagnostics {
		if res.Diagnostics[i].Code == "L11" && res.Diagnostics[i].NodeID == "n2" {
			hit = &res.Diagnostics[i]
		}
	}
	if hit == nil || res.VersionNo != 0 {
		t.Fatalf("must reject with L11 on n2: %+v", res.Diagnostics)
	}
	if len(f.ledger.Versions[id]) != 0 {
		t.Fatalf("no version may be created")
	}
}

// TestK1_PublishRejectsStructuralErrorsWithNodeIds：一份带两类结构错误的草稿（引导线指向不存在的
// 节点 + 主线节点没有主线出线）发布时，两条诊断都要各自带上定位它们的 link_id / node_id，不是只报
// 一条就了事；发布不建版本、不冻结表达式。
func TestK1_PublishRejectsStructuralErrorsWithNodeIds(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "结构测试2")
	id := view.Definition.GetDefinitionId()
	doc := model.Document{Schema: model.SchemaVersion, Name: "结构测试2", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "无主线出线", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}})},
		},
		Links: []model.Link{
			{ID: "l1", From: "n0", To: "n1"},
			{ID: "l2", From: "n1", To: "n-missing"},
		},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, string(raw), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "")
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	byCode := map[string]model.Diagnostic{}
	for _, d := range res.Diagnostics {
		byCode[d.Code] = d
	}
	if d, ok := byCode["LINK_ENDPOINT_UNKNOWN"]; !ok || d.LinkID != "l2" {
		t.Fatalf("want LINK_ENDPOINT_UNKNOWN on l2: %+v", res.Diagnostics)
	}
	if d, ok := byCode["L10"]; !ok || d.NodeID != "n1" {
		t.Fatalf("want L10 on n1: %+v", res.Diagnostics)
	}
	if res.VersionNo != 0 || f.fz.calls != 0 {
		t.Fatalf("must not build a version or freeze: %+v", res)
	}
	if len(f.ledger.Versions[id]) != 0 {
		t.Fatalf("no version may be created")
	}
}

// TestDefinition_SetEnabledBlocksStart：停用后发起被拒，启用恢复。
func TestDefinition_SetEnabledBlocksStart(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	if _, err := f.svc.SetEnabled(ctx, f.meta(designer), id, false); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{TemplateID: "tpl-1", RecordID: "rec-1"}})
	wantCode(t, err, "DEFINITION_DISABLED")
	if _, err := f.svc.SetEnabled(ctx, f.meta(designer), id, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{TemplateID: "tpl-1", RecordID: "rec-1"}}); err != nil {
		t.Fatalf("start after enable: %v", err)
	}
}

// TestDefinition_SaveDraftAndPublishRejectMissingExpectedVersion：
// expected_version_no <= 0 不再被当成「跳过乐观锁」，直接 INVALID_ARGUMENT，不落库。
func TestDefinition_SaveDraftAndPublishRejectMissingExpectedVersion(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "采购申请审批")
	id := view.Definition.GetDefinitionId()
	_, err := f.svc.SaveDraft(ctx, f.meta(designer), id, draftDoc(t), 0)
	wantCode(t, err, "INVALID_ARGUMENT")
	_, err = f.svc.SaveDraft(ctx, f.meta(designer), id, draftDoc(t), -1)
	wantCode(t, err, "INVALID_ARGUMENT")
	_, err = f.svc.Publish(ctx, f.meta(designer), id, 0, true, "")
	wantCode(t, err, "INVALID_ARGUMENT")
	view, err = f.svc.GetDefinition(ctx, f.meta(designer), id, true)
	if err != nil || view.Definition.GetVersionNo() != 1 {
		t.Fatalf("nothing must have committed: %+v err %v", view, err)
	}
}

// TestDefinition_ConcurrentPublishOnlyOneSucceeds：两次发布用同一个
// expected_version_no（模拟基于同一读到的版本号并发），只有一个成功，另一个必须 VERSION_CONFLICT；
// 旧实现会把「version_no 相等」误判成重放，静默丢掉后到者的发布。
func TestDefinition_ConcurrentPublishOnlyOneSucceeds(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "采购申请审批")
	id := view.Definition.GetDefinitionId()
	view, err := f.svc.SaveDraft(ctx, f.meta(designer), id, draftDoc(t), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	expected := view.Definition.GetVersionNo()
	res1, err := f.svc.Publish(ctx, f.meta(designer), id, expected, true, "")
	if err != nil || len(res1.Diagnostics) != 0 || res1.VersionNo != 1 {
		t.Fatalf("first publish: %+v err %v", res1, err)
	}
	_, err = f.svc.Publish(ctx, f.meta(designer), id, expected, true, "")
	wantCode(t, err, "VERSION_CONFLICT")
	// 定义只建了一个版本。
	view, err = f.svc.GetDefinition(ctx, f.meta(designer), id, false)
	if err != nil || len(view.Versions) != 1 {
		t.Fatalf("exactly one version must exist: %+v err %v", view, err)
	}
}

// TestDV5_TemplateUnpublishedRejectsPublish：目标模板未发布→ Publish 只回诊断，不建版本、
// 不冻结表达式（DV5：发布必须目标模板已发布，与 K1 结构检查一样走诊断通道而不是 gRPC 错误）。
func TestDV5_TemplateUnpublishedRejectsPublish(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "采购申请审批")
	id := view.Definition.GetDefinitionId()
	view, err := f.svc.SaveDraft(ctx, f.meta(designer), id, draftDoc(t), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), false, "")
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	found := false
	for _, d := range res.Diagnostics {
		if d.Code == "K2" {
			found = true
		}
	}
	if !found || res.VersionNo != 0 || f.fz.calls != 0 {
		t.Fatalf("publish must be rejected by K2, not frozen: %+v calls %d", res, f.fz.calls)
	}
	if len(f.ledger.Versions[id]) != 0 {
		t.Fatalf("no version may be created")
	}
}

// TestDV2_DraftSaveDoesNotTouchRunningInstance：DV2——设计器改草稿、发布新版本，不影响已在跑的
// 实例：实例仍绑定发起时那个版本号与那份编译产物，提交时走的还是旧版本的结束标识语义。
func TestDV2_DraftSaveDoesNotTouchRunningInstance(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t) // v1：结束标识「已通过」
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil {
		t.Fatal(err)
	}
	agg, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil {
		t.Fatal(err)
	}
	boundVersionNo, boundCompiled := agg.GetInstance().GetVersionNo(), agg.GetVersion().GetCompiledJson()

	// 设计者继续改草稿并发布 v2（结束标识改成「已通过-v2」）。
	view, err := f.svc.GetDefinition(ctx, f.meta(designer), id, true)
	if err != nil {
		t.Fatal(err)
	}
	newDoc := strings.Replace(draftDoc(t), "已通过", "已通过-v2", 1)
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, newDoc, view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	pub, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "f-no")
	if err != nil || len(pub.Diagnostics) != 0 || pub.VersionNo != 2 {
		t.Fatalf("publish v2: %+v err %v", pub, err)
	}

	// 运行中的实例仍绑在 v1：版本号、编译产物都不变。
	agg2, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil {
		t.Fatal(err)
	}
	if agg2.GetInstance().GetVersionNo() != boundVersionNo || agg2.GetVersion().GetCompiledJson() != boundCompiled {
		t.Fatalf("running instance must stay bound to v1: %+v", agg2.GetInstance())
	}
	// 提交按 v1 语义结束，标识是旧值「已通过」，不是新版本的「已通过-v2」。
	taskID := taskOf(t, agg2, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	if err != nil || res.Outcome.EndLabel != "已通过" {
		t.Fatalf("running instance must keep v1 semantics: %+v err %v", res, err)
	}
}

// —— 实例动作 ——

// TestInstance_StartSubmitEndWritesLabel：发起 → 提交 → 结束，结束标识经 Record 写入，结果带版本。
func TestInstance_StartSubmitEndWritesLabel(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	_, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: "nope", Record: ports.RecordRef{RecordID: "rec-1"}})
	wantCode(t, err, "NOT_FOUND")
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted || r.InstanceVersion != 1 || r.Replayed {
		t.Fatalf("start: %+v err %v", r, err)
	}
	agg, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || agg.GetInstance().GetTemplateId() != "tpl-1" || len(agg.GetTasks()) != 2 {
		t.Fatalf("detail: %+v err %v", agg, err)
	}
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	r, err = f.svc.Save(ctx, f.meta(wangFang), taskID)
	if err != nil || r.InstanceVersion != 2 {
		t.Fatalf("save: %+v err %v", r, err)
	}
	r, err = f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	// 两段式结束标识：版本 3 = 停驻占位，版本 4 = 写成后结束。
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted || r.Outcome.EndLabel != "已通过" || r.InstanceVersion != 4 {
		t.Fatalf("submit: %+v err %v", r, err)
	}
	if len(f.rec.Writes) != 1 || f.rec.Writes[0].FieldID != "f-status" || f.rec.Writes[0].TextValue != "已通过" {
		t.Fatalf("writes = %+v", f.rec.Writes)
	}
	// 经宿主 Record 的读写全部带上实例 ID（发起前读单据头用的是预分配、随后真正落库的同一个 ID）。
	instanceID := agg.GetInstance().GetWorkflowInstanceId()
	for _, ref := range append(append([]ports.RecordRef{}, f.rec.HeaderRefs...), f.rec.WriteRefs...) {
		if ref.WorkflowInstanceID != instanceID || ref.RecordID != "rec-1" {
			t.Fatalf("record ref = %+v, want instance %s / rec-1", ref, instanceID)
		}
	}
	if len(f.rec.HeaderRefs) == 0 || len(f.rec.WriteRefs) != 1 {
		t.Fatalf("header refs %d / write refs %d", len(f.rec.HeaderRefs), len(f.rec.WriteRefs))
	}
	// 同单据再发起。
	_, err = f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	wantCode(t, err, "RECORD_ALREADY_HAS_INSTANCE")
}

// TestStart_TemplateMismatchRejected：请求带的单据模板与定义绑定的模板不一致
// （例如把定义 A 的模板套到了单据 B 的 record_id 上），发起必须拒绝，不建实例、不落库。
func TestStart_TemplateMismatchRejected(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t) // 绑定 tpl-1
	_, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{TemplateID: "tpl-other", RecordID: "rec-1"}})
	wantCode(t, err, "INVALID_ARGUMENT")
	if f.ledger.Commits != 3 { // create + draft + publish；发起被拒不应新增 Commit
		t.Fatalf("commits = %d, must not touch ledger", f.ledger.Commits)
	}
	if _, err := f.ledger.LoadInstanceByRecord(ctx, "app", "rec-1"); err == nil {
		t.Fatalf("instance must not be created")
	}
	// 模板一致（或不传）时正常发起。
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{TemplateID: "tpl-1", RecordID: "rec-1"}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("start with matching template: %+v err %v", r, err)
	}
}

// TestStart_RecordNotFoundRejected：单据不存在不允许发起，避免抢占该单据唯一的
// 发起位；exists 恢复后可正常发起。
func TestStart_RecordNotFoundRejected(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	f.rec.Exists = false
	_, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-missing"}})
	wantCode(t, err, "NOT_FOUND")
	if _, err := f.ledger.LoadInstanceByRecord(ctx, "app", "rec-missing"); err == nil {
		t.Fatalf("instance must not be created")
	}
	f.rec.Exists = true
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-missing"}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("start once record exists: %+v err %v", r, err)
	}
}

// TestInstance_ReplaySameRequestKey：同 request_key 重放 → Replayed=true、版本不变、不重复写。
func TestInstance_ReplaySameRequestKey(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	r, _ := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	meta := f.meta(wangFang)
	r1, err := f.svc.Save(ctx, meta, taskID)
	if err != nil || r1.Replayed {
		t.Fatalf("first: %+v err %v", r1, err)
	}
	r2, err := f.svc.Save(ctx, meta, taskID)
	if err != nil || !r2.Replayed || r2.InstanceVersion != r1.InstanceVersion {
		t.Fatalf("replay: %+v err %v", r2, err)
	}
	// INSTANCE_STARTED / STEP_ARRIVED / NOTIFY(TASK_ASSIGNED，开关默认全开) / TASK_SAVED；重放不再追加。
	if len(f.ledger.Outbox) != 4 {
		t.Fatalf("outbox = %d", len(f.ledger.Outbox))
	}
}

// conflictOnce 第一次 Commit 前把实例版本推进一格（模拟并发写），触发 VERSION_CONFLICT 重试。
type conflictOnce struct {
	*testkit.MemLedger
	done bool
}

func (c *conflictOnce) Commit(ctx context.Context, appID string, in ports.CommitInput) (ports.CommitResult, error) {
	if !c.done && in.Changeset.GetInstance().GetExpectedVersion() > 0 {
		c.done = true
		id := in.Changeset.GetInstance().GetRow().GetWorkflowInstanceId()
		c.MemLedger.Instances[id].Version++
		c.MemLedger.Instances[id].LastRequestKey = "someone-else"
	}
	return c.MemLedger.Commit(ctx, appID, in)
}

// TestInstance_VersionConflictRetriesOnce：CAS 冲突用新聚合重决策一次后成功；第二次仍冲突则报 VERSION_CONFLICT。
func TestInstance_VersionConflictRetriesOnce(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	r, _ := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	wrapped := &conflictOnce{MemLedger: f.ledger}
	f.svc.Ledger = wrapped
	res, err := f.svc.Save(ctx, f.meta(wangFang), taskID)
	if err != nil || res.InstanceVersion != 3 || !wrapped.done {
		t.Fatalf("retry: %+v err %v", res, err)
	}
	// 永远冲突。
	always := &conflictAlways{MemLedger: f.ledger}
	f.svc.Ledger = always
	_, err = f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	wantCode(t, err, "VERSION_CONFLICT")
	if always.calls != 2 {
		t.Fatalf("commit attempts = %d, want 2", always.calls)
	}
}

type conflictAlways struct {
	*testkit.MemLedger
	calls int
}

func (c *conflictAlways) Commit(_ context.Context, _ string, _ ports.CommitInput) (ports.CommitResult, error) {
	c.calls++
	return ports.CommitResult{}, ports.ErrVersionConflict
}

// TestInstance_EndWriteFailureParksThenResumeByIncident：写结束标识失败 → Parked；按事故 id 恢复：再失败仍停驻，修好后结束。
func TestInstance_EndWriteFailureParksThenResumeByIncident(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	r, _ := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	f.rec.WriteErr = errors.New("aria down")
	r, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	if err != nil || r.Outcome.Kind != core.OutcomeParked || r.Outcome.IncidentID == "" {
		t.Fatalf("submit: %+v err %v", r, err)
	}
	incID := r.Outcome.IncidentID
	admin := ports.Actor{UserID: 9, SuperAdmin: true}
	r, err = f.svc.ResumeIncident(ctx, f.meta(admin), incID, "重试")
	if err != nil || r.Outcome.Kind != core.OutcomeParked {
		t.Fatalf("resume while broken: %+v err %v", r, err)
	}
	agg, _ = f.svc.GetDetail(ctx, f.meta(admin), agg.GetInstance().GetWorkflowInstanceId())
	if agg.GetIncidents()[0].GetAttempts() != 2 || agg.GetInstance().GetStatus() != "PARKED" {
		t.Fatalf("after failed resume: %+v", agg.GetIncidents()[0])
	}
	f.rec.WriteErr = nil
	r, err = f.svc.ResumeIncident(ctx, f.meta(admin), incID, "已修")
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted || r.Outcome.Status != "ENDED" {
		t.Fatalf("resume: %+v err %v", r, err)
	}
	if len(f.rec.Writes) != 1 {
		t.Fatalf("writes = %+v", f.rec.Writes)
	}
	_, err = f.svc.ResumeIncident(ctx, f.meta(admin), "inc-nope", "")
	wantCode(t, err, "NOT_FOUND")
}

// TestInstance_ChoiceRequiredDoesNotCommit：选人对话框返回时账本不动；带选择重调同一 request_key 落库。
func TestInstance_ChoiceRequiredDoesNotCommit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "多人审批")
	id := view.Definition.GetDefinitionId()
	doc := strings.Replace(draftDoc(t), `"user_ids":["22"]`, `"user_ids":["22","33"]`, 1)
	if !strings.Contains(doc, `["22","33"]`) {
		t.Fatalf("fixture replace failed: %s", doc)
	}
	view, err := f.svc.SaveDraft(ctx, f.meta(designer), id, doc, view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	if res, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, ""); err != nil || len(res.Diagnostics) != 0 {
		t.Fatalf("publish: %+v err %v", res, err)
	}
	meta := f.meta(starter)
	r, err := f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil || r.Outcome.Kind != core.OutcomeAssigneeChoiceRequired || f.ledger.Commits != 3 { // 3 = create + draft + publish
		t.Fatalf("start: %+v err %v commits %d", r, err, f.ledger.Commits)
	}
	r, err = f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}, Choices: core.Choices{SelectedAssignees: []int64{33}}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted || r.InstanceVersion != 1 {
		t.Fatalf("start with choice: %+v err %v", r, err)
	}
}

// ═══ 幂等前置（决策之前先查请求日志） ═══

// TestReplay_StartSameKeyReturnsCommitted：发起成功后用同一个 request_key 重放，必须直接回放
// Committed 结果（Replayed=true），而不是像旧实现那样落到 core.Start 的「单据已有实例」判断上
// 报 RECORD_ALREADY_HAS_INSTANCE。
func TestReplay_StartSameKeyReturnsCommitted(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	meta := f.meta(starter)
	r1, err := f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil || r1.Outcome.Kind != core.OutcomeCommitted || r1.Replayed {
		t.Fatalf("first start: %+v err %v", r1, err)
	}
	commits := f.ledger.Commits
	r2, err := f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil {
		t.Fatalf("replay must succeed, not RECORD_ALREADY_HAS_INSTANCE: %v", err)
	}
	if !r2.Replayed || r2.Outcome.Kind != core.OutcomeCommitted || r2.Outcome.WorkflowInstanceID != r1.Outcome.WorkflowInstanceID || r2.InstanceVersion != r1.InstanceVersion {
		t.Fatalf("replay: %+v", r2)
	}
	if f.ledger.Commits != commits {
		t.Fatalf("replay must not touch ledger: before %d after %d", commits, f.ledger.Commits)
	}
}

// TestReplay_SubmitSameKeyReturnsCommitted：提交成功（含结束标识写入）后同一个 request_key 重放，
// 回放的 Outcome 必须带上首次的 EndLabel（core.Outcome 整份存进 outcome_json 再原样解回）。
func TestReplay_SubmitSameKeyReturnsCommitted(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	r, _ := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	meta := f.meta(wangFang)
	r1, err := f.svc.Submit(ctx, meta, taskID, core.Choices{})
	if err != nil || r1.Outcome.Kind != core.OutcomeCommitted || r1.Replayed || r1.Outcome.EndLabel != "已通过" {
		t.Fatalf("first submit: %+v err %v", r1, err)
	}
	commits := f.ledger.Commits
	r2, err := f.svc.Submit(ctx, meta, taskID, core.Choices{})
	if err != nil || !r2.Replayed || r2.Outcome.Kind != core.OutcomeCommitted || r2.InstanceVersion != r1.InstanceVersion || r2.Outcome.EndLabel != "已通过" {
		t.Fatalf("replay: %+v err %v", r2, err)
	}
	if f.ledger.Commits != commits {
		t.Fatalf("replay must not touch ledger: before %d after %d", commits, f.ledger.Commits)
	}
}

// TestReplay_WithdrawSameKeyReturnsCommitted：撤销成功后同一个 request_key 重放，直接回放结果，
// 不重新决策（否则第二次会因为任务已不是 DONE 而报 TASK_NOT_ACTIONABLE）。
func TestReplay_WithdrawSameKeyReturnsCommitted(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, err := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "三级审批")
	if err != nil {
		t.Fatal(err)
	}
	id := view.Definition.GetDefinitionId()
	view, err = f.svc.SaveDraft(ctx, f.meta(designer), id, threeStepDoc(t), view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, "f-no"); err != nil {
		t.Fatal(err)
	}
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil {
		t.Fatal(err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), taskOf(t, agg, wangFang.UserID, "PENDING"), core.Choices{}); err != nil {
		t.Fatal(err)
	}
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	doneTaskID := taskOf(t, agg, wangFang.UserID, "DONE")
	meta := f.meta(wangFang)
	r1, err := f.svc.Withdraw(ctx, meta, doneTaskID)
	if err != nil || r1.Outcome.Kind != core.OutcomeCommitted || r1.Replayed {
		t.Fatalf("first withdraw: %+v err %v", r1, err)
	}
	commits := f.ledger.Commits
	r2, err := f.svc.Withdraw(ctx, meta, doneTaskID)
	if err != nil || !r2.Replayed || r2.InstanceVersion != r1.InstanceVersion {
		t.Fatalf("replay: %+v err %v", r2, err)
	}
	if f.ledger.Commits != commits {
		t.Fatalf("replay must not touch ledger: before %d after %d", commits, f.ledger.Commits)
	}
}

// TestReplay_SameKeyDifferentChoiceRejected：同一个 request_key 第一次带选人 [33] 提交成功，
// 第二次换成 [22] 重调——摘要不同，必须按请求键复用拒绝（INVALID_ARGUMENT），不能被当成重放
// 静默放行，也不能穿透到「单据已有实例」之类的状态判断。
func TestReplay_SameKeyDifferentChoiceRejected(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "多人审批")
	id := view.Definition.GetDefinitionId()
	doc := strings.Replace(draftDoc(t), `"user_ids":["22"]`, `"user_ids":["22","33"]`, 1)
	view, err := f.svc.SaveDraft(ctx, f.meta(designer), id, doc, view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, ""); err != nil {
		t.Fatal(err)
	}
	meta := f.meta(starter)
	r, err := f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}, Choices: core.Choices{SelectedAssignees: []int64{33}}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("start with choice 33: %+v err %v", r, err)
	}
	_, err = f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}, Choices: core.Choices{SelectedAssignees: []int64{22}}})
	wantCode(t, err, "INVALID_ARGUMENT")
}

// TestReplay_ChoiceRequiredThenSameKeyWithChoiceCommits：首次调用只命中候选选择对话框——不落库、
// 不记请求日志；带上选择用同一个 request_key 重调，必须正常提交且恰好落一次库（不是「重放」，
// 是这个请求键第一次真正落库）。
func TestReplay_ChoiceRequiredThenSameKeyWithChoiceCommits(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	view, _ := f.svc.CreateDefinition(ctx, f.meta(designer), "tpl-1", "多人审批")
	id := view.Definition.GetDefinitionId()
	doc := strings.Replace(draftDoc(t), `"user_ids":["22"]`, `"user_ids":["22","33"]`, 1)
	view, err := f.svc.SaveDraft(ctx, f.meta(designer), id, doc, view.Definition.GetVersionNo())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Publish(ctx, f.meta(designer), id, view.Definition.GetVersionNo(), true, ""); err != nil {
		t.Fatal(err)
	}
	meta := f.meta(starter)
	r, err := f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	if err != nil || r.Outcome.Kind != core.OutcomeAssigneeChoiceRequired {
		t.Fatalf("start without choice: %+v err %v", r, err)
	}
	commits := f.ledger.Commits
	r, err = f.svc.Start(ctx, meta, StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}, Choices: core.Choices{SelectedAssignees: []int64{33}}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted || r.Replayed {
		t.Fatalf("start with choice: %+v err %v", r, err)
	}
	if f.ledger.Commits != commits+1 {
		t.Fatalf("must commit exactly once: before %d after %d", commits, f.ledger.Commits)
	}
}

// TestService_RejectsMissingMeta：缺 app_id / request_key 直接 SYSTEM_ERROR，不碰账本。
func TestService_RejectsMissingMeta(t *testing.T) {
	f := newFixture(t)
	_, err := f.svc.Save(context.Background(), Meta{AppID: "app"}, "t")
	wantCode(t, err, "SYSTEM_ERROR")
	if f.ledger.Commits != 0 {
		t.Fatalf("ledger touched")
	}
}

// TestReplay_EndWriteTwoPhaseReturnsFinalResult：结束标识两段式——首段以主请求键
// 提交停驻，第二段以派生键提交结束；同一主键重放拿到的是最终的 COMMITTED / ENDED，而不是中间的停驻。
func TestReplay_EndWriteTwoPhaseReturnsFinalResult(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	r, _ := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	meta := f.meta(wangFang)
	r1, err := f.svc.Submit(ctx, meta, taskID, core.Choices{})
	if err != nil || r1.Outcome.Kind != core.OutcomeCommitted || r1.Outcome.Status != "ENDED" {
		t.Fatalf("submit: %+v err %v", r1, err)
	}
	// 主键 + 派生键各一条请求日志；写字段发生在首段提交之后。
	if found, _ := f.ledger.FindCommit(ctx, "app", meta.RequestKey); found == nil || found.InstanceVersion != r1.InstanceVersion-1 {
		t.Fatalf("primary commit = %+v", found)
	}
	if found, _ := f.ledger.FindCommit(ctx, "app", meta.RequestKey+endPhaseKeySuffix); found == nil || found.InstanceVersion != r1.InstanceVersion {
		t.Fatalf("derived commit = %+v", found)
	}
	commits := f.ledger.Commits
	r2, err := f.svc.Submit(ctx, meta, taskID, core.Choices{})
	if err != nil || !r2.Replayed || r2.Outcome.Kind != core.OutcomeCommitted || r2.Outcome.Status != "ENDED" || r2.InstanceVersion != r1.InstanceVersion {
		t.Fatalf("replay: %+v err %v", r2, err)
	}
	if f.ledger.Commits != commits || len(f.rec.Writes) != 1 {
		t.Fatalf("replay must not commit or write again: commits %d→%d writes %d", commits, f.ledger.Commits, len(f.rec.Writes))
	}
	// 详情标志：全部 INSTANCE_ENDED。
	_, flags, err := f.svc.GetDetailWithFlags(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || len(flags) != 2 {
		t.Fatalf("flags = %+v err %v", flags, err)
	}
	for _, fl := range flags {
		if fl.Withdrawable || fl.ReasonCode != "INSTANCE_ENDED" {
			t.Fatalf("flag = %+v", fl)
		}
	}
}

// TestEndWrite_FailureReplaysParked：首段之后写失败 → 派生 :park 提交改判 WRITE_FIELD_FAILED；同键重放返回停驻。
func TestEndWrite_FailureReplaysParked(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	id := f.published(t)
	r, _ := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: id, Record: ports.RecordRef{RecordID: "rec-1"}})
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	f.rec.WriteErr = errors.New("aria down")
	meta := f.meta(wangFang)
	r1, err := f.svc.Submit(ctx, meta, taskID, core.Choices{})
	if err != nil || r1.Outcome.Kind != core.OutcomeParked || r1.Outcome.IncidentID == "" {
		t.Fatalf("submit: %+v err %v", r1, err)
	}
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	inc := agg.GetIncidents()[0]
	if inc.GetKind() != "WRITE_FIELD_FAILED" || inc.GetAttempts() != 1 || agg.GetInstance().GetStatus() != "PARKED" {
		t.Fatalf("incident = %+v inst %s", inc, agg.GetInstance().GetStatus())
	}
	r2, err := f.svc.Submit(ctx, meta, taskID, core.Choices{})
	if err != nil || !r2.Replayed || r2.Outcome.Kind != core.OutcomeParked || r2.Outcome.IncidentID != r1.Outcome.IncidentID {
		t.Fatalf("replay: %+v err %v", r2, err)
	}
}

// —— 子流程 ——

// TestN6_SingleChild_NoWait_MainFieldsMapped：不等待 + 单子实例（第一层）。子流程节点用两个
// 主表字段做传递字段：断言建单恰一次、值齐、子实例 StartKind=SUBFLOW 且发起人是触发过关的
// 提交人、父实例链接行恰一条且字段齐、父实例发件箱含 SUBFLOW_STARTED；同 request_key
// 重放不重复建单（顶层动作的重放拦截在 commitLoop 之前，根本不会再跑一遍子流程发起）。
func TestN6_SingleChild_NoWait_MainFieldsMapped(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	mappings := []model.SubflowFieldMapping{
		{SourceFieldID: "f-amount", TargetFieldID: "f-child-amount"},
		{SourceFieldID: "f-title", TargetFieldID: "f-child-title"},
	}
	parentID := f.publishDoc(t, "tpl-1", "父流程", subflowParentDoc(t, childID, false, model.SubflowDispositionIgnore, mappings))
	f.rec.MainValues = []ports.FieldValue{{FieldID: "f-amount", TextValue: "500"}, {FieldID: "f-title", TextValue: "申购单"}}

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p1"}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("start parent: %+v err %v", r, err)
	}
	parentInstanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	submitMeta := f.meta(wangFang)
	res, err := f.svc.Submit(ctx, submitMeta, taskID, core.Choices{})
	if err != nil || res.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("submit: %+v err %v", res, err)
	}

	if len(f.launch.Created) != 1 {
		t.Fatalf("want exactly one CreateRecord call, got %d: %+v", len(f.launch.Created), f.launch.Created)
	}
	call := f.launch.Created[0]
	if call.TemplateID != "tpl-2" || call.OnBehalfOf.UserID != wangFang.UserID {
		t.Fatalf("create record call = %+v", call)
	}
	// 建单带上父实例 ID，宿主 LaunchService 据此核对父实例属于本引擎。
	if call.ParentWorkflowInstanceID != parentInstanceID {
		t.Fatalf("create record parent instance = %q, want %q", call.ParentWorkflowInstanceID, parentInstanceID)
	}
	wantValues := map[string]string{"f-child-amount": "500", "f-child-title": "申购单"}
	if len(call.Values) != len(wantValues) {
		t.Fatalf("values = %+v", call.Values)
	}
	for _, v := range call.Values {
		if wantValues[v.FieldID] != v.TextValue {
			t.Fatalf("value %s = %q, want %q", v.FieldID, v.TextValue, wantValues[v.FieldID])
		}
	}

	parentAgg, err := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	if err != nil || len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("links = %+v err %v", parentAgg.GetLinks(), err)
	}
	link := parentAgg.GetLinks()[0]
	if link.GetChildDefinitionId() != childID || link.GetWaitMode() != "NO_WAIT" || link.GetOrphanPolicy() != "IGNORE" || link.GetChildStatus() != "RUNNING" || link.GetParentWorkflowInstanceId() != parentInstanceID {
		t.Fatalf("link = %+v", link)
	}
	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), link.GetChildWorkflowInstanceId())
	if err != nil || childAgg.GetInstance().GetStartKind() != "SUBFLOW" || childAgg.GetInstance().GetStarterUserId() != wangFang.UserID {
		t.Fatalf("child = %+v err %v", childAgg.GetInstance(), err)
	}
	if kinds := f.ledger.OutboxKinds(parentInstanceID); !hasOutboxSuffix(kinds, "SUBFLOW_STARTED") {
		t.Fatalf("parent outbox must contain SUBFLOW_STARTED: %+v", kinds)
	}

	// 重放同 request_key：顶层动作本身在 commitLoop 之前就被拦下直接回放，子流程发起代码根本
	// 不会再跑一遍，Created 自然不增。
	res2, err := f.svc.Submit(ctx, submitMeta, taskID, core.Choices{})
	if err != nil || !res2.Replayed {
		t.Fatalf("replay: %+v err %v", res2, err)
	}
	if len(f.launch.Created) != 1 {
		t.Fatalf("replay must not create record again, got %d", len(f.launch.Created))
	}
}

// TestN6_LaunchBusinessRejectionIsNamedOnIncident：宿主按业务校验拒绝建单（必填缺失、「唯一」字段
// 重复、模板不可写……）时，停驻事件的错误码记 RECORD_WRITE_REJECTED 而不是笼统的 SYSTEM_ERROR——
// 管理员据此知道要改配置 / 数据，而不是等系统恢复；错误原文照旧保留供排查。
func TestN6_LaunchBusinessRejectionIsNamedOnIncident(t *testing.T) {
	f := newFixture(t)
	f.launch.Err = fmt.Errorf("%w: RECORD_WRITE_REJECTED: workflow launch: unique field conflict", ports.ErrRecordWriteRejected)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	parentID := f.publishDoc(t, "tpl-1", "父流程-业务拒绝", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p-rejected"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), taskOf(t, agg, wangFang.UserID, "PENDING"), core.Choices{}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	parentAgg, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || parentAgg.GetInstance().GetStatus() != "PARKED" {
		t.Fatalf("parent must be parked: %+v err %v", parentAgg.GetInstance(), err)
	}
	var inc *pb.IncidentRow
	for _, i := range parentAgg.GetIncidents() {
		if i.GetKind() == "SUBFLOW_START_FAILED" {
			inc = i
		}
	}
	if inc == nil {
		t.Fatalf("incident missing: %+v", parentAgg.GetIncidents())
	}
	if inc.GetErrorCode() != "RECORD_WRITE_REJECTED" {
		t.Fatalf("business rejection must be named on the incident, got %q", inc.GetErrorCode())
	}
	if !strings.Contains(inc.GetErrorMessage(), "unique field conflict") {
		t.Fatalf("original cause must be kept in error_message, got %q", inc.GetErrorMessage())
	}
}

// TestN6_LaunchFailureParksParent：建单失败（M5 SUBFLOW_START_FAILED）：父实例改判停驻、
// 事故行 resume_point_json 非空；用 Wait=true 让本次提交先稳稳停在子流程步骤本身（不往下走），
// 这样"停驻"改的是一个明确还在 RUNNING 的实例，不与「同一提交里恰好也跑到了结束节点」相混。
func TestN6_LaunchFailureParksParent(t *testing.T) {
	f := newFixture(t)
	f.launch.Err = errors.New("host down")
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	parentID := f.publishDoc(t, "tpl-1", "父流程2", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p2"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if res.Outcome.Kind != core.OutcomeParked || res.Outcome.IncidentID == "" {
		t.Fatalf("want parked outcome: %+v", res.Outcome)
	}
	parentAgg, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || parentAgg.GetInstance().GetStatus() != "PARKED" {
		t.Fatalf("parent must be parked: %+v err %v", parentAgg.GetInstance(), err)
	}
	var inc *pb.IncidentRow
	for _, i := range parentAgg.GetIncidents() {
		if i.GetKind() == "SUBFLOW_START_FAILED" {
			inc = i
		}
	}
	if inc == nil || inc.GetResumePointJson() == "" {
		t.Fatalf("incident missing or resume point empty: %+v", parentAgg.GetIncidents())
	}
	// 非业务拒绝类失败（宿主不可达等）仍记 SYSTEM_ERROR。
	if inc.GetErrorCode() != "SYSTEM_ERROR" {
		t.Fatalf("plain launch failure must be recorded as SYSTEM_ERROR, got %q", inc.GetErrorCode())
	}
	if len(f.launch.Created) != 0 {
		t.Fatalf("no record should be created on failure")
	}
	if len(parentAgg.GetLinks()) != 0 {
		t.Fatalf("no link should be committed on failure: %+v", parentAgg.GetLinks())
	}

	// SUBFLOW_START 停驻点恢复。宿主连接修好之后
	// （f.launch.Err 清空），管理员从事故清单点「继续」：事故 RESOLVED、实例回 RUNNING、
	// Decision.PendingSubflowStarts 重新算出来交给 ResumeIncident 内的 runSubflowStarts
	// 逐个再发一次——这次应该成功建单并挂上链接行，不再停驻。
	f.launch.Err = nil
	admin := ports.Actor{UserID: 9, DisplayName: "管理员"}
	rr, err := f.svc.ResumeIncident(ctx, f.meta(admin), inc.GetIncidentId(), "已修复宿主连接")
	if err != nil {
		t.Fatalf("resume subflow start: %v", err)
	}
	if rr.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("resume must succeed and commit, got %+v", rr.Outcome)
	}
	if len(f.launch.Created) != 1 {
		t.Fatalf("resume must relaunch exactly once, got %d", len(f.launch.Created))
	}
	parentAgg, err = f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || parentAgg.GetInstance().GetStatus() == "PARKED" || len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("parent must no longer be parked and must carry the new link: %+v err %v", parentAgg.GetInstance(), err)
	}
	var resolved bool
	for _, i := range parentAgg.GetIncidents() {
		if i.GetIncidentId() == inc.GetIncidentId() && i.GetStatus() == "RESOLVED" {
			resolved = true
		}
	}
	if !resolved {
		t.Fatalf("original incident must be resolved: %+v", parentAgg.GetIncidents())
	}
	// 恢复是管理员点的，但重新发起的子实例，发起人与目标单据创建人仍须是
	// 当初把父流程送到子流程节点的那位办理人（王芳），不是处理事故的管理员；姓名随恢复点取回，
	// 子实例默认摘要才带得上人名。
	if got := f.launch.Created[0].OnBehalfOf; got.UserID != wangFang.UserID || got.DisplayName != wangFang.DisplayName {
		t.Fatalf("relaunched record must be created on behalf of the original submitter, got %+v", got)
	}
	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), parentAgg.GetLinks()[0].GetChildWorkflowInstanceId())
	if err != nil {
		t.Fatalf("load child: %v", err)
	}
	if got := childAgg.GetInstance().GetStarterUserId(); got != wangFang.UserID {
		t.Fatalf("child starter must be the original submitter %d, not the admin who resumed, got %d", wangFang.UserID, got)
	}
	if !strings.Contains(inc.GetResumePointJson(), `"submitter_user_id":22`) {
		t.Fatalf("resume point must record the submitter, got %s", inc.GetResumePointJson())
	}
}

// TestSubflowStartIgnoresStartCondition：子流程发起不受目标流程发起条件限制。目标流程配了
// 发起条件且求值为假——人工来发起会被拦下，但作为子流程被父流程发起时照常建单、照常形成实例、
// 挂上链接，父流程不停驻。
func TestSubflowStartIgnoresStartCondition(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标-条件", subflowChildDocWithStartCondition(t, "tpl-2", "子流程金额超限，不能发起"))
	// 子流程发起节点（c0）的发起条件冻结为 pub:c0:start_cond（fakeFreezer 规则），摆假。
	f.expr.Conditions["pub:c0:start_cond"] = false
	parentID := f.publishDoc(t, "tpl-1", "父流程-子流程带发起条件", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	// 对照：同一条目标流程由动作来发起（夹具里它关了「允许人工发起」，人工入口本就进不来），
	// 发起条件照常拦下、不建实例——放开的只有子流程这一种发起。
	byAction, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: childID, Record: ports.RecordRef{RecordID: "rec-c-action"}, StartKind: model.StartKindAction})
	if err != nil {
		t.Fatalf("action start: %v", err)
	}
	if byAction.Outcome.Kind != core.OutcomeNoRoute || byAction.Outcome.WorkflowInstanceID != "" {
		t.Fatalf("action start must still be blocked by the start condition, got %+v", byAction.Outcome)
	}

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p-cond"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if res.Outcome.Kind == core.OutcomeParked {
		t.Fatalf("subflow start must not be blocked by the target's start condition: %+v", res.Outcome)
	}
	parentAgg, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || parentAgg.GetInstance().GetStatus() == "PARKED" {
		t.Fatalf("parent must not be parked: %+v err %v", parentAgg.GetInstance(), err)
	}
	if len(parentAgg.GetIncidents()) != 0 {
		t.Fatalf("no incident expected: %+v", parentAgg.GetIncidents())
	}
	if len(f.launch.Created) != 1 || len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("child record and link must be created, created=%d links=%+v", len(f.launch.Created), parentAgg.GetLinks())
	}
	// 子实例确实形成了，发起人 / 填报人是触发过关的办理人。
	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), parentAgg.GetLinks()[0].GetChildWorkflowInstanceId())
	if err != nil || childAgg.GetInstance().GetStartKind() != "SUBFLOW" || childAgg.GetInstance().GetStarterUserId() != wangFang.UserID {
		t.Fatalf("child instance must exist, be a SUBFLOW start and be started by the submitter: %+v err %v", childAgg.GetInstance(), err)
	}
	if f.launch.Created[0].OnBehalfOf.UserID != wangFang.UserID {
		t.Fatalf("child record must be filled on behalf of the submitter, got %+v", f.launch.Created[0].OnBehalfOf)
	}
}

// subflowChildTwoHandlersDoc 子流程目标流程：发起 → 办理（两个候选）→ 结束；routeTwice 为真时
// 发起节点再多连一条无条件出线直达结束——两条出线同时命中，发起要手选走向。
func subflowChildTwoHandlersDoc(t *testing.T, routeTwice bool) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "子流程目标(多候选)", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "c0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-2", AllowManualStart: false, NoRouteHint: "无路可走"})},
			{ID: "c1", Kind: model.NodeKindHandle, Name: "部门经理办理", Config: cfg(t, model.HandleConfig{
				Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{31, 32}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线",
			})},
			{ID: "c2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "子流程已完成"})},
		},
		Links: []model.Link{{ID: "cl1", From: "c0", To: "c1"}, {ID: "cl2", From: "c1", To: "c2"}},
	}
	if routeTwice {
		doc.Links = append(doc.Links, model.Link{ID: "cl3", From: "c0", To: "c2"})
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// TestN6_SubflowFirstNodeSelectsAllCandidates：目标流程第一个办理节点有多个候选
// ——子流程是随上一步提交在后台发起的，没有界面让人选办理人：直接选中全部候选、各派一条待办，
// 不指定给其中某一个人，父流程也不再因「要手选办理人」停驻（此前必停驻，事故原文即
// outcome=ASSIGNEE_CHOICE_REQUIRED）。
func TestN6_SubflowFirstNodeSelectsAllCandidates(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标-多候选", subflowChildTwoHandlersDoc(t, false))
	parentID := f.publishDoc(t, "tpl-1", "父流程-子流程多候选", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p-all"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskOf(t, agg, wangFang.UserID, "PENDING"), core.Choices{})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if res.Outcome.Kind == core.OutcomeParked {
		t.Fatalf("multiple candidates must not park the parent any more: %+v", res.Outcome)
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if len(parentAgg.GetIncidents()) != 0 || len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("want no incident and one link, incidents=%+v links=%+v", parentAgg.GetIncidents(), parentAgg.GetLinks())
	}
	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), parentAgg.GetLinks()[0].GetChildWorkflowInstanceId())
	if err != nil {
		t.Fatalf("load child: %v", err)
	}
	pending := map[int64]bool{}
	for _, task := range childAgg.GetTasks() {
		if task.GetStatus() == "PENDING" {
			pending[task.GetAssigneeUserId()] = true
		}
	}
	if len(pending) != 2 || !pending[31] || !pending[32] {
		t.Fatalf("every candidate must get a pending task, got %+v", pending)
	}
}

// TestN6_SubflowRouteChoiceParksWithReason：目标流程发起后两条出线同时命中、要手选走向——没有
// 界面让人选，没形成实例，父流程停驻。事故原因码记到「要手选走向」这一级，流程管理页
// 据此显示业务话原因，而不是只有一句 outcome=ROUTE_CHOICE_REQUIRED。
func TestN6_SubflowRouteChoiceParksWithReason(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标-要选走向", subflowChildTwoHandlersDoc(t, true))
	parentID := f.publishDoc(t, "tpl-1", "父流程-子流程要选走向", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p-route"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskOf(t, agg, wangFang.UserID, "PENDING"), core.Choices{})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if res.Outcome.Kind != core.OutcomeParked {
		t.Fatalf("want parked outcome: %+v", res.Outcome)
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	var inc *pb.IncidentRow
	for _, i := range parentAgg.GetIncidents() {
		if i.GetKind() == "SUBFLOW_START_FAILED" {
			inc = i
		}
	}
	if inc == nil {
		t.Fatalf("incident missing: %+v", parentAgg.GetIncidents())
	}
	if inc.GetErrorCode() != "SUBFLOW_ROUTE_CHOICE_REQUIRED" {
		t.Fatalf("no-instance outcome must be named on the incident, got %q", inc.GetErrorCode())
	}
	if !strings.Contains(inc.GetErrorMessage(), "outcome=ROUTE_CHOICE_REQUIRED") {
		t.Fatalf("error_message must keep the outcome, got %q", inc.GetErrorMessage())
	}
}

// TestN6_DetailRows_OnePerRow：来源含扩展表字段（第二层）——扩展表几行发几个子实例，主表值
// 每个都一样、扩展表值各取自己那一行；两行两个子实例、两条链接。
func TestN6_DetailRows_OnePerRow(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	mappings := []model.SubflowFieldMapping{
		{SourceFieldID: "f-amount", TargetFieldID: "f-child-amount"},
		{SourceTableID: "dt-items", SourceFieldID: "f-item-amount", TargetFieldID: "f-child-item-amount"},
	}
	parentID := f.publishDoc(t, "tpl-1", "父流程3", subflowParentDoc(t, childID, false, model.SubflowDispositionIgnore, mappings))
	f.rec.MainValues = []ports.FieldValue{{FieldID: "f-amount", TextValue: "500"}}
	f.rec.DetailRows = map[string][]ports.DetailRow{"dt-items": {
		{RecordID: "row-1", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "100"}}},
		{RecordID: "row-2", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "200"}}},
	}}

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p3"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	if len(f.launch.Created) != 2 {
		t.Fatalf("want two CreateRecord calls (one per detail row), got %d", len(f.launch.Created))
	}
	gotItemAmounts := map[string]bool{}
	for _, call := range f.launch.Created {
		var amount, itemAmount string
		for _, v := range call.Values {
			switch v.FieldID {
			case "f-child-amount":
				amount = v.TextValue
			case "f-child-item-amount":
				itemAmount = v.TextValue
			}
		}
		if amount != "500" {
			t.Fatalf("main field must repeat on every child, got %q: %+v", amount, call.Values)
		}
		gotItemAmounts[itemAmount] = true
	}
	if !gotItemAmounts["100"] || !gotItemAmounts["200"] {
		t.Fatalf("each child must carry its own detail row value: %+v", gotItemAmounts)
	}
	parentAgg, err := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if err != nil || len(parentAgg.GetLinks()) != 2 {
		t.Fatalf("links = %+v err %v", parentAgg.GetLinks(), err)
	}
	if parentAgg.GetLinks()[0].GetChildWorkflowInstanceId() == parentAgg.GetLinks()[1].GetChildWorkflowInstanceId() {
		t.Fatalf("two links must point at two distinct child instances: %+v", parentAgg.GetLinks())
	}
}

// TestN6_DetailRows_ZeroRows_NoLaunchContinuesNormally：扩展表零行时不发起子流程，节点按
// 「发起了零个」处理，父流程照常向后走到结束。
func TestN6_DetailRows_ZeroRows_NoLaunchContinuesNormally(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	mappings := []model.SubflowFieldMapping{{SourceTableID: "dt-items", SourceFieldID: "f-item-amount", TargetFieldID: "f-child-item-amount"}}
	parentID := f.publishDoc(t, "tpl-1", "父流程4", subflowParentDoc(t, childID, false, model.SubflowDispositionIgnore, mappings))
	// f.rec.DetailRows 不预置 "dt-items"：等价于该扩展表零行。

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p4"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	if err != nil || res.Outcome.Kind != core.OutcomeCommitted || res.Outcome.Status != "ENDED" {
		t.Fatalf("submit should continue straight through to end: %+v err %v", res, err)
	}
	if len(f.launch.Created) != 0 {
		t.Fatalf("zero detail rows must not launch any child, got %d", len(f.launch.Created))
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if len(parentAgg.GetLinks()) != 0 {
		t.Fatalf("no link expected: %+v", parentAgg.GetLinks())
	}
}

// subflowLoopParentDoc n1（王芳）→ sf（不等待）→ n3（李四，两条出线都无条件：l4 回 n1、l5 去
// 结束，多命中靠提交人在 Submit 时用 Choices.RouteLinkID 指定走哪条）→ n2 结束；n3 另允许
// 「回退到上一步」，供 E7 用例复用同一份拓扑。
func subflowLoopParentDoc(t *testing.T, childID string) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "父流程5", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "sf", Kind: model.NodeKindSubflow, Name: "子流程", Config: cfg(t, model.SubflowConfig{TargetWorkflowID: childID, Wait: false, Disposition: model.SubflowDispositionIgnore})},
			{ID: "n3", Kind: model.NodeKindHandle, Name: "财务复核", Config: cfg(t, model.HandleConfig{
				Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{33}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
				NoRouteHint: "没有可走的路线", AllowedWithdrawMethods: []model.WithdrawMethod{model.WithdrawMethodPreviousStep},
			})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{
			{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "sf"}, {ID: "l3", From: "sf", To: "n3"},
			{ID: "l4", From: "n3", To: "n1"}, {ID: "l5", From: "n3", To: "n2"},
		},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// TestN6_LoopWithoutBack_NoDuplicateLaunch：同一实例同一子流程节点只发起一次——
// 不经过任何回退，单纯靠图上的循环（n3 选路回 n1）第二次到达同一个子流程节点，第二次不应该
// 再发起。L3 多命中由提交人用 Choices.RouteLinkID 明确指定走哪条线。
func TestN6_LoopWithoutBack_NoDuplicateLaunch(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	parentID := f.publishDoc(t, "tpl-1", "父流程5", subflowLoopParentDoc(t, childID))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p5"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	instanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n1Task := taskOf(t, agg, wangFang.UserID, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task, core.Choices{}); err != nil {
		t.Fatalf("first submit at n1: %v", err)
	}
	if len(f.launch.Created) != 1 {
		t.Fatalf("first arrival at sf must launch once, got %d", len(f.launch.Created))
	}

	// 李四在财务复核站选路回 n1（不是回退，是正常提交走 l4）。
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n3Task := taskOf(t, agg, 33, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(ports.Actor{UserID: 33, DisplayName: "李四"}), n3Task, core.Choices{RouteLinkID: "l4"}); err != nil {
		t.Fatalf("submit at n3 routing back to n1: %v", err)
	}

	// 王芳在 n1 再次收到任务（同一节点第二次经过），提交后再次到达 sf——不应该再发起一次。
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n1Task2 := taskOf(t, agg, wangFang.UserID, "PENDING")
	if n1Task2 == n1Task {
		t.Fatalf("looping back must open a new task instance at n1, not reuse the old one")
	}
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task2, core.Choices{}); err != nil {
		t.Fatalf("second submit at n1: %v", err)
	}
	if len(f.launch.Created) != 1 {
		t.Fatalf("second arrival at the same subflow node without any back must not launch again, got %d calls: %+v", len(f.launch.Created), f.launch.Created)
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	if len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("still exactly one link expected: %+v", parentAgg.GetLinks())
	}

	// 收尾：李四这次选路去结束，走完整条流程，不留一个悬空的运行中用例。
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n3Task2 := taskOf(t, agg, 33, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(ports.Actor{UserID: 33, DisplayName: "李四"}), n3Task2, core.Choices{RouteLinkID: "l5"})
	if err != nil || res.Outcome.Status != "ENDED" {
		t.Fatalf("final submit to end: %+v err %v", res, err)
	}
}

// TestN6_BackPastSubflow_CancelsAndRelaunches：回退目标在子流程节点之前时，
// 该节点已发起的子流程实例连同链接一并处置（链接删除、子实例 ForceEnd）；再次到达同一个子
// 流程节点时重新发起。复用与上一条相同的拓扑，这次李四用「回退到上一步」而不是
// 选路回去。
func TestN6_BackPastSubflow_CancelsAndRelaunches(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// 用「办理」款子流程目标（不会在 Start 那一刻自己结束），这样回退发生时子实例确实还在跑，
	// 才能验出 ForceEnd（而不是子流程自己正常走完）。
	childID := f.publishDoc(t, "tpl-2", "子流程目标(办理)", subflowChildHandleDoc(t, "tpl-2", 44))
	parentID := f.publishDoc(t, "tpl-1", "父流程5b", subflowLoopParentDoc(t, childID))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p5b"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	instanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n1Task := taskOf(t, agg, wangFang.UserID, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task, core.Choices{}); err != nil {
		t.Fatalf("first submit at n1: %v", err)
	}
	if len(f.launch.Created) != 1 {
		t.Fatalf("first arrival at sf must launch once, got %d", len(f.launch.Created))
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	firstChildID := parentAgg.GetLinks()[0].GetChildWorkflowInstanceId()

	// 李四在财务复核站回退到上一步（人工步骤最近的是 n1，sf 不是人工步骤会被跳过）；
	// 目标 n1 的 seq 早于 sf，E7 判定 sf 已发起的子实例要一并处置。
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n3Task := taskOf(t, agg, 33, "PENDING")
	if _, err := f.svc.Back(ctx, f.meta(ports.Actor{UserID: 33, DisplayName: "李四"}), n3Task, BackInput{Method: model.WithdrawMethodPreviousStep}); err != nil {
		t.Fatalf("back to previous step: %v", err)
	}

	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	if len(parentAgg.GetLinks()) != 0 {
		t.Fatalf("E7: link to the cancelled subflow must be removed: %+v", parentAgg.GetLinks())
	}
	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), firstChildID)
	if err != nil || childAgg.GetInstance().GetStatus() != "ENDED" || childAgg.GetInstance().GetEndLabel() != "已终止" {
		t.Fatalf("E7: cancelled subflow instance must be force-ended: %+v err %v", childAgg.GetInstance(), err)
	}
	var childPendingTask *pb.TaskRow
	for _, tk := range childAgg.GetTasks() {
		if tk.GetAssigneeUserId() == 44 {
			childPendingTask = tk
		}
	}
	if childPendingTask == nil || childPendingTask.GetStatus() != "WITHDRAWN" || childPendingTask.GetWithdrawReason() != "TERMINATED" {
		t.Fatalf("E7: force-ended child's pending task must be withdrawn as TERMINATED: %+v", childPendingTask)
	}

	// 王芳在 n1 重新收到任务，再提交一次，再次到达 sf：重新发起。
	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	n1Task2 := taskOf(t, agg, wangFang.UserID, "PENDING")
	if n1Task2 == n1Task {
		t.Fatalf("back must reopen a new task instance, not the withdrawn one")
	}
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task2, core.Choices{}); err != nil {
		t.Fatalf("second submit at n1: %v", err)
	}
	if len(f.launch.Created) != 2 {
		t.Fatalf("after back-cancellation the next arrival must launch again, got %d calls: %+v", len(f.launch.Created), f.launch.Created)
	}
	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	if len(parentAgg.GetLinks()) != 1 || parentAgg.GetLinks()[0].GetChildWorkflowInstanceId() == firstChildID {
		t.Fatalf("a fresh link to a new child instance is expected: %+v", parentAgg.GetLinks())
	}
}

// TestN6_SubflowAfterWaitedSubflowIsLaunched：办理人提交 → 子流程 A（等待）→
// 子流程 B（不等待）→ 结束。A 结束后是系统回来推进父流程，这一跳到达的 B 必须与办理人提交时
// 到达的一样真的发起：建单、形成实例、挂链接。此前回推走的派生提交通道只提交变更集、不执行
// 待发起清单——B 从未发起、不开事故、不留链接，父流程那一步却已标成「已发起」。这一跳无人
// 在场，B 的发起人 / 填报人回溯到最近一位把流程往前送的真人：当初把流程送到 A 的办理人（王芳），
// 不是系统，也不是办完 A 的那个人。
func TestN6_SubflowAfterWaitedSubflowIsLaunched(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childAID := f.publishDoc(t, "tpl-2", "子流程目标A(办理)", subflowChildHandleDoc(t, "tpl-2", 44))
	childBID := f.publishDoc(t, "tpl-3", "子流程目标B", subflowChildDoc(t, "tpl-3"))
	parentDoc := model.Document{Schema: model.SchemaVersion, Name: "父流程-两个子流程相连", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "sfA", Kind: model.NodeKindSubflow, Name: "子流程A", Config: cfg(t, model.SubflowConfig{TargetWorkflowID: childAID, Wait: true, Disposition: model.SubflowDispositionIgnore})},
			{ID: "sfB", Kind: model.NodeKindSubflow, Name: "子流程B", Config: cfg(t, model.SubflowConfig{TargetWorkflowID: childBID, Wait: false, Disposition: model.SubflowDispositionIgnore})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "sfA"}, {ID: "l3", From: "sfA", To: "sfB"}, {ID: "l4", From: "sfB", To: "n2"}},
	}
	raw, _ := json.Marshal(parentDoc)
	parentID := f.publishDoc(t, "tpl-1", "父流程-两个子流程相连", string(raw))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p-chain"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	instanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), taskOf(t, agg, wangFang.UserID, "PENDING"), core.Choices{}); err != nil {
		t.Fatalf("submit at n1: %v", err)
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	if len(f.launch.Created) != 1 || len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("A must be launched and waited on, created=%d links=%+v", len(f.launch.Created), parentAgg.GetLinks())
	}

	// 赵六办完子流程 A → A 结束 → 系统回推父流程 → 到达子流程 B。
	zhaoLiu := ports.Actor{UserID: 44, DisplayName: "赵六"}
	childAAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentAgg.GetLinks()[0].GetChildWorkflowInstanceId())
	if _, err := f.svc.Submit(ctx, f.meta(zhaoLiu), taskOf(t, childAAgg, zhaoLiu.UserID, "PENDING"), core.Choices{}); err != nil {
		t.Fatalf("submit child A: %v", err)
	}

	if len(f.launch.Created) != 2 {
		t.Fatalf("B must be launched after the waited A ends, created=%d", len(f.launch.Created))
	}
	callB := f.launch.Created[1]
	if callB.TemplateID != "tpl-3" || callB.OnBehalfOf.UserID != wangFang.UserID {
		t.Fatalf("B's record must be created on tpl-3 on behalf of the last human submitter (22), got %+v", callB)
	}
	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	if len(parentAgg.GetIncidents()) != 0 {
		t.Fatalf("no incident expected: %+v", parentAgg.GetIncidents())
	}
	var linkB *pb.LinkRow
	for _, l := range parentAgg.GetLinks() {
		if l.GetChildDefinitionId() == childBID {
			linkB = l
		}
	}
	if linkB == nil {
		t.Fatalf("link to B missing: %+v", parentAgg.GetLinks())
	}
	childBAgg, err := f.svc.GetDetail(ctx, f.meta(starter), linkB.GetChildWorkflowInstanceId())
	if err != nil || childBAgg.GetInstance().GetStarterUserId() != wangFang.UserID {
		t.Fatalf("B must be started by the last human submitter (22), got %+v err %v", childBAgg.GetInstance(), err)
	}
	if parentAgg.GetInstance().GetStatus() != "ENDED" {
		t.Fatalf("parent must run through to the end after B (no-wait) is launched: %+v", parentAgg.GetInstance())
	}
}

// TestN6_WaitBothChildrenMustEndBeforeParentAdvances：等待档发起两个子实例（扩展表两行）
// 后父步骤停在子流程本身；只结束第一个子实例时父流程仍在等待；两个子实例都结束后父流程才
// 沿主线继续，一路走到结束。
func TestN6_WaitBothChildrenMustEndBeforeParentAdvances(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标(办理)", subflowChildHandleDoc(t, "tpl-2", 44))
	mappings := []model.SubflowFieldMapping{{SourceTableID: "dt-items", SourceFieldID: "f-item-amount", TargetFieldID: "f-child-item-amount"}}
	parentID := f.publishDoc(t, "tpl-1", "父流程6", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, mappings))
	f.rec.DetailRows = map[string][]ports.DetailRow{"dt-items": {
		{RecordID: "row-1", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "100"}}},
		{RecordID: "row-2", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "200"}}},
	}}

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p6"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	parentInstanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	n1Task := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task, core.Choices{})
	if err != nil {
		t.Fatalf("submit at n1: %v", err)
	}
	if res.Outcome.Kind != core.OutcomeCommitted || res.Outcome.Status != "RUNNING" {
		t.Fatalf("parent should be running and waiting at sf: %+v", res.Outcome)
	}
	if len(f.launch.Created) != 2 {
		t.Fatalf("want two children launched, got %d", len(f.launch.Created))
	}

	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	if len(parentAgg.GetLinks()) != 2 || parentAgg.GetInstance().GetCurrentNodeId() != "sf" {
		t.Fatalf("parent must be waiting at sf with two links: node=%s links=%+v", parentAgg.GetInstance().GetCurrentNodeId(), parentAgg.GetLinks())
	}
	childIDs := []string{parentAgg.GetLinks()[0].GetChildWorkflowInstanceId(), parentAgg.GetLinks()[1].GetChildWorkflowInstanceId()}

	// 只结束第一个子实例：父流程仍应停在子流程步骤。
	childAgg0, _ := f.svc.GetDetail(ctx, f.meta(starter), childIDs[0])
	childTask0 := taskOf(t, childAgg0, 44, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(ports.Actor{UserID: 44, DisplayName: "赵五"}), childTask0, core.Choices{}); err != nil {
		t.Fatalf("submit child0: %v", err)
	}
	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	if parentAgg.GetInstance().GetStatus() != "RUNNING" || parentAgg.GetInstance().GetCurrentNodeId() != "sf" {
		t.Fatalf("parent must still be waiting at sf after only one child ended: %+v", parentAgg.GetInstance())
	}
	var link0Status string
	for _, l := range parentAgg.GetLinks() {
		if l.GetChildWorkflowInstanceId() == childIDs[0] {
			link0Status = l.GetChildStatus()
		}
	}
	if link0Status != "ENDED" {
		t.Fatalf("link of the ended child must already show ENDED even while the sibling is still running: %s", link0Status)
	}

	// 结束第二个子实例：父流程应该推进到结束。
	childAgg1, _ := f.svc.GetDetail(ctx, f.meta(starter), childIDs[1])
	childTask1 := taskOf(t, childAgg1, 44, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(ports.Actor{UserID: 44, DisplayName: "赵五"}), childTask1, core.Choices{}); err != nil {
		t.Fatalf("submit child1: %v", err)
	}
	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	if parentAgg.GetInstance().GetStatus() != "ENDED" || parentAgg.GetInstance().GetEndLabel() != "已通过" {
		t.Fatalf("parent must advance to end once both children ended: %+v", parentAgg.GetInstance())
	}
	for _, l := range parentAgg.GetLinks() {
		if l.GetChildStatus() != "ENDED" {
			t.Fatalf("all links must be marked ended: %+v", parentAgg.GetLinks())
		}
	}
}

// TestN6_ForceEndOrphanedChildWhenParentEndsFirst：不等待档配了「强制结束」，父流程
// 自己先跑完（不等待，发起后立即向后走，一路到结束）时，尚未结束的子实例要被强制结束——
// 待办任务撤销（原因 TERMINATED）、对外显示「已终止」；父实例的链接行同步标为 ENDED。
func TestN6_ForceEndOrphanedChildWhenParentEndsFirst(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标(办理)", subflowChildHandleDoc(t, "tpl-2", 44))
	parentID := f.publishDoc(t, "tpl-1", "父流程7", subflowParentDoc(t, childID, false, model.SubflowDispositionForceEnd, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p7"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	n1Task := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task, core.Choices{})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if res.Outcome.Kind != core.OutcomeCommitted || res.Outcome.Status != "ENDED" {
		t.Fatalf("parent (not-wait) should reach end in the same commit: %+v", res.Outcome)
	}

	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if len(parentAgg.GetLinks()) != 1 {
		t.Fatalf("want one link: %+v", parentAgg.GetLinks())
	}
	link := parentAgg.GetLinks()[0]
	if link.GetOrphanPolicy() != "FORCE_END" {
		t.Fatalf("orphan policy = %s", link.GetOrphanPolicy())
	}

	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), link.GetChildWorkflowInstanceId())
	if err != nil || childAgg.GetInstance().GetStatus() != "ENDED" || childAgg.GetInstance().GetEndLabel() != "已终止" {
		t.Fatalf("child must be force-ended: %+v err %v", childAgg.GetInstance(), err)
	}
	var withdrawn *pb.TaskRow
	for _, tk := range childAgg.GetTasks() {
		if tk.GetAssigneeUserId() == 44 {
			withdrawn = tk
		}
	}
	if withdrawn == nil || withdrawn.GetStatus() != "WITHDRAWN" || withdrawn.GetWithdrawReason() != "TERMINATED" {
		t.Fatalf("child's pending task must be withdrawn as TERMINATED: %+v", withdrawn)
	}
	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	if parentAgg.GetLinks()[0].GetChildStatus() != "ENDED" {
		t.Fatalf("link child_status must become ENDED after force end: %+v", parentAgg.GetLinks())
	}
}

// TestN6_IgnoreDispositionLeavesChildRunning（对照组）：同一场景把处置换成「不管」
// （IGNORE），父流程先结束，子实例不受影响，照常留在自己的办理站。
func TestN6_IgnoreDispositionLeavesChildRunning(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标(办理)", subflowChildHandleDoc(t, "tpl-2", 44))
	parentID := f.publishDoc(t, "tpl-1", "父流程8", subflowParentDoc(t, childID, false, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p8"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	n1Task := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), n1Task, core.Choices{})
	if err != nil || res.Outcome.Status != "ENDED" {
		t.Fatalf("submit: %+v err %v", res, err)
	}

	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	link := parentAgg.GetLinks()[0]
	if link.GetOrphanPolicy() != "IGNORE" || link.GetChildStatus() != "RUNNING" {
		t.Fatalf("ignore disposition must leave the link's child_status alone: %+v", link)
	}
	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), link.GetChildWorkflowInstanceId())
	if err != nil || childAgg.GetInstance().GetStatus() != "RUNNING" {
		t.Fatalf("ignore disposition: child must keep running after the parent ended: %+v err %v", childAgg.GetInstance(), err)
	}
}

// subflowChainParentDoc 发起 → 部门审批（王芳 22）→ subA（子流程，不等待，主表字段）→
// subB（子流程，等待，扩展表字段）→ 结束：辅助链上连着两个子流程节点。
func subflowChainParentDoc(t *testing.T, childAID, childBID string) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "父流程(链式子流程)", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfg(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "subA", Kind: model.NodeKindSubflow, Name: "子流程A", Config: cfg(t, model.SubflowConfig{TargetWorkflowID: childAID, FieldMappings: []model.SubflowFieldMapping{{SourceFieldID: "f-amount", TargetFieldID: "f-child-amount"}}, Wait: false, Disposition: model.SubflowDispositionIgnore})},
			{ID: "subB", Kind: model.NodeKindSubflow, Name: "子流程B", Config: cfg(t, model.SubflowConfig{TargetWorkflowID: childBID, FieldMappings: []model.SubflowFieldMapping{{SourceTableID: "dt-items", SourceFieldID: "f-item-amount", TargetFieldID: "f-child-item-amount"}}, Wait: true, Disposition: model.SubflowDispositionIgnore})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{
			{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "subA"},
			{ID: "l3", From: "subA", To: "subB"}, {ID: "l4", From: "subB", To: "n2"},
		},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// TestN6_ChainedSubflowNodes_BothLaunch：辅助链上连着两个子流程节点（subA 不等待、主表字段；
// subB 等待、扩展表两行），同一次提交里连着走。守住 subA 的发起不能被 subB 顶掉（arrival
// 单槽位 subflowStart 被下游覆盖会导致账本里 subA 步骤 PASSED/LAUNCHED 却没有任何子实例与
// 链接行）。本用例断言 subA 恰一个子实例 + 一条链接、
// subB 恰两个子实例 + 两条链接，互不影响；且父实例发件箱含 SUBFLOW_STARTED。
func TestN6_ChainedSubflowNodes_BothLaunch(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childAID := f.publishDoc(t, "tpl-2", "子流程目标A", subflowChildDoc(t, "tpl-2"))
	childBID := f.publishDoc(t, "tpl-3", "子流程目标B(办理)", subflowChildHandleDoc(t, "tpl-3", 44))
	parentID := f.publishDoc(t, "tpl-1", "父流程(链式)", subflowChainParentDoc(t, childAID, childBID))
	f.rec.MainValues = []ports.FieldValue{{FieldID: "f-amount", TextValue: "500"}}
	f.rec.DetailRows = map[string][]ports.DetailRow{"dt-items": {
		{RecordID: "row-1", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "100"}}},
		{RecordID: "row-2", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "200"}}},
	}}

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-chain"}})
	if err != nil || r.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("start parent: %+v err %v", r, err)
	}
	parentInstanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	res, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{})
	if err != nil || res.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("submit: %+v err %v", res, err)
	}

	if len(f.launch.Created) != 3 {
		t.Fatalf("want 3 CreateRecord calls (subA x1 + subB x2), got %d: %+v", len(f.launch.Created), f.launch.Created)
	}

	parentAgg, err := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	var subAStepID, subBStepID string
	for _, s := range parentAgg.GetSteps() {
		switch s.GetNodeId() {
		case "subA":
			subAStepID = s.GetStepId()
		case "subB":
			subBStepID = s.GetStepId()
		}
	}
	if subAStepID == "" || subBStepID == "" {
		t.Fatalf("both subA and subB must have a step row: %+v", parentAgg.GetSteps())
	}
	var subALinks, subBLinks []*pb.LinkRow
	for _, l := range parentAgg.GetLinks() {
		switch l.GetParentStepId() {
		case subAStepID:
			subALinks = append(subALinks, l)
		case subBStepID:
			subBLinks = append(subBLinks, l)
		}
	}
	if len(subALinks) != 1 {
		t.Fatalf("subA (not-waiting, main fields) must launch exactly one child + one link, got %d: %+v", len(subALinks), parentAgg.GetLinks())
	}
	if len(subBLinks) != 2 {
		t.Fatalf("subB (waiting, 2 detail rows) must launch exactly two children + two links, got %d: %+v", len(subBLinks), parentAgg.GetLinks())
	}

	if parentAgg.GetInstance().GetCurrentNodeId() != "subB" {
		t.Fatalf("current node = %s, want subB (waiting subflow node holds the token)", parentAgg.GetInstance().GetCurrentNodeId())
	}
	if kinds := f.ledger.OutboxKinds(parentInstanceID); !hasOutboxSuffix(kinds, "SUBFLOW_STARTED") {
		t.Fatalf("parent outbox must contain SUBFLOW_STARTED: %+v", kinds)
	}
}
