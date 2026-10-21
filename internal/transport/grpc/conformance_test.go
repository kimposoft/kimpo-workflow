package grpc

// conformance_test.go —— 官方引擎接入 SDK 一致性套件的端到端部分（含错误码约定）。
//
// 链路：填报层 + 设计层，gRPC server → engineapp.Service → hostclient（生产适配器，经 plugin.WorkflowHostFrom(ctx)
// 取宿主客户端）→ SDK workflowconformance 宿主替身（FakeLedger 按宿主规则盖章、乐观锁、CAS，并在 Commit 时跑
// 版本行与发件箱一致性检查，不合规按宿主同码拒绝；FakeRecord 核对单据读写带 workflow_instance_id）。
//
// 本文件锁三件事：
//  1. 官方 manifest 过 manifestlint（含 capabilities.workflow_engine 形状与三条硬约束）；
//  2. 发布 → 发起 → 办理 → 结束（含结束标识两段式写入）全程每笔变更集、每条发件箱行都过 SDK 校验，
//     Record 读写全部带上实例 ID、且是该实例的单据；
//  3. 引擎返回的业务错误合乎 "CODE: " 前缀约定，网关视角码与 HTTP 状态正确。

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"
	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/manifestlint"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin/plugintest/workflowconformance"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin/workflowengine"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
	"github.com/kimposoft/kimpo-workflow/internal/transport/hostclient"
)

// officialEnginePluginID 是官方流程引擎的插件 ID（宿主盖章与绑定都用它）。
const officialEnginePluginID = "com.kimposoft.workflow"

// TestManifestConformance：仓库根 manifest.json 过 SDK manifestlint（error 级即失败），并真实声明
// capabilities.workflow_engine（六类节点、六项能力）——宿主据此判合格引擎，不再走官方旧包过渡兼容。
func TestManifestConformance(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	// manifestlint 按第三方口径体检：官方保留命名空间（com.kimposoft.*）与「workflow-designer 挂载点不支持沙箱档」
	// 只对第三方包成立（官方签名包可用保留命名空间、前端在宿主内运行），其余 error 级一律失败。
	for _, f := range manifestlint.Lint(manifestlint.Package{Manifest: raw}) {
		switch {
		case f.Code == "reserved_plugin_namespace":
			continue
		case f.Severity == manifestlint.SeverityError:
			t.Errorf("manifest: %s %s: %s", f.Code, f.Path, f.Message)
		default:
			t.Logf("manifest %s: %s %s: %s", f.Severity, f.Code, f.Path, f.Message)
		}
	}
	var m struct {
		Capabilities struct {
			WorkflowEngine *workflowenginev1.WorkflowEngineCapabilities `json:"workflow_engine"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	decl := m.Capabilities.WorkflowEngine
	if decl == nil {
		t.Fatal("manifest must declare capabilities.workflow_engine")
	}
	workflowconformance.CheckCapabilities(t, decl)
	for _, k := range workflowengine.NodeKinds {
		if !workflowengine.HasNodeKind(decl, k) {
			t.Errorf("official engine supports node kind %s, manifest must declare it", k)
		}
	}
	for _, f := range workflowengine.Features {
		if !workflowengine.HasFeature(decl, f) {
			t.Errorf("official engine supports feature %s, manifest must declare it", f)
		}
	}
}

// conformanceDraft 发起 → 部门审批（王芳，办理节点）→ 结束「已通过」写 f-status；连线不带条件（graph_json 要过
// workflow/1 schema，条件表达式文档的完整形状不在本测试关心范围内）。
func conformanceDraft(t *testing.T) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "采购申请审批", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走",
				StartPermission: model.StartGrant{RoleIDs: []string{"role-staff"}}})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线",
				FieldPermissions: []model.FieldPermission{{TableID: "dt-main", FieldID: "f-status", Grade: model.FieldGradeReadonly}}})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "n2"}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// newConformanceServers 用生产 hostclient 适配器（账本 / 单据）接 SDK 宿主替身，其余端口用本包既有假体。
func newConformanceServers(t *testing.T) (*workflowconformance.FakeWorkflowHost, *DefinitionServer, *InstanceServer, *TaskServer, context.Context) {
	t.Helper()
	host := workflowconformance.NewFakeWorkflowHost(officialEnginePluginID)
	// 官方「发起即结束」口径：发起前读单据头时实例尚未落库（宿主对此按单据反查归属放行）。
	// 替身不接账本时只核对「每次都带了实例 ID」——这正是本用例要锁的：官方引擎经 Record 的每一次
	// 读写都带 workflow_instance_id。归属另由下方逐条比对。
	host.Record.Ledger = nil
	ledger := hostclient.NewLedger()
	record := hostclient.NewRecord()
	expr := testkit.NewFakeExpr()
	ids := testkit.NewSeqIDs()
	clock := testkit.FixedClock{T: time.Date(2026, 10, 19, 3, 0, 0, 0, time.UTC)}
	svc := &engineapp.Service{
		Ledger: ledger, Record: record, Clock: clock, IDs: ids, Launch: &testkit.FakeLaunch{},
		Compiler: compile.New(nil, fakeFreezer{}, testkit.AllTextMain("f-status"), nil),
		Engine:   &core.Engine{Expr: expr, Candidate: testkit.StaticCandidate{}, Record: record, Clock: clock, IDs: ids},
	}
	return host, NewDefinitionServer(svc), NewInstanceServer(svc), NewTaskServer(svc), host.Context(context.Background())
}

// TestHostConformance_LifecycleThroughSDKFakes：发布 → 发起 → 办理提交 → 结束写标识，全程经 SDK 宿主替身。
func TestHostConformance_LifecycleThroughSDKFakes(t *testing.T) {
	host, def, inst, task, ctx := newConformanceServers(t)

	created, err := def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	workflowconformance.CheckError(t, err)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defID := created.GetDefinition().GetDefinitionId()
	if got := host.Ledger.Commits(); len(got) == 0 {
		t.Fatal("create must commit through the host ledger")
	}
	saved, err := def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: conformanceDraft(t), ExpectedVersionNo: created.GetDefinition().GetVersionNo()})
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	pub, err := def.Publish(ctx, &workflowenginev1.PublishRequest{Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: saved.GetDefinition().GetVersionNo(), TemplatePublished: true, SerialFieldId: "f-no"})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(pub.GetDiagnostics()) != 0 {
		t.Fatalf("publish diagnostics: %+v", pub.GetDiagnostics())
	}

	started, err := inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-1"}, StartKind: "MANUAL"})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	instanceID := started.GetCommitted().GetWorkflowInstanceId()
	if instanceID == "" {
		t.Fatalf("start outcome = %+v", started)
	}
	var taskID string
	for _, tk := range host.Ledger.Tasks(instanceID) {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	if taskID == "" {
		t.Fatal("no pending handle task after start")
	}
	if _, err := task.Submit(ctx, &workflowenginev1.SubmitTaskRequest{Meta: meta(wangFangActor), TaskId: taskID}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	if got := host.Ledger.Instance(instanceID).GetStatus(); got != "ENDED" {
		t.Fatalf("instance status = %s, want ENDED", got)
	}

	// 每笔变更集、每条发件箱行都过 SDK 校验（替身 Commit 已对 error 级拒绝，这里再显式跑一遍并报 warn）。
	for _, c := range host.Ledger.Commits() {
		workflowconformance.CheckChangeset(t, c.GetChangeset())
	}
	kinds := map[string]bool{}
	for _, row := range host.Ledger.Outbox() {
		workflowconformance.CheckOutboxRow(t, row)
		kinds[row.GetKind()] = true
		if row.GetWorkflowInstanceId() != instanceID {
			t.Errorf("outbox %s belongs to %s, want %s", row.GetKind(), row.GetWorkflowInstanceId(), instanceID)
		}
	}
	for _, k := range []string{"INSTANCE_STARTED", "STEP_PASSED", "NOTIFY", "INSTANCE_PARKED", "INSTANCE_RESUMED", "INSTANCE_ENDED"} {
		if !kinds[k] {
			t.Errorf("outbox kinds %v missing %s", kinds, k)
		}
	}

	// 结束标识两段式写入经 Record，必须带上本实例 ID、写的是本实例单据。
	writes := host.Record.Writes()
	if len(writes) == 0 {
		t.Fatal("end label write must go through the host record service")
	}
	for _, w := range writes {
		if w.GetWorkflowInstanceId() != instanceID || w.GetRecord().GetRecordId() != "rec-1" {
			t.Errorf("record write instance=%q record=%q, want %q / rec-1", w.GetWorkflowInstanceId(), w.GetRecord().GetRecordId(), instanceID)
		}
	}
	if got := host.Record.Value("rec-1", "f-status"); got != "已通过" {
		t.Fatalf("end label = %q, want 已通过", got)
	}
}

// TestHostConformance_ErrorConvention：引擎业务拒绝合乎 "CODE: " 前缀约定，网关视角码正确。
func TestHostConformance_ErrorConvention(t *testing.T) {
	_, def, inst, _, ctx := newConformanceServers(t)
	created, err := def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defID := created.GetDefinition().GetDefinitionId()
	// 未发布就发起 → DEFINITION_NOT_PUBLISHED（409）。
	_, err = inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-1"}, StartKind: "MANUAL"})
	workflowconformance.CheckErrorCode(t, err, workflowhostv1.WorkflowErrorCode_DEFINITION_NOT_PUBLISHED)
	// 乐观锁过期保存草稿 → VERSION_CONFLICT（宿主账本 Aborted 透传，前缀保留）。
	_, err = def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: conformanceDraft(t), ExpectedVersionNo: 99})
	workflowconformance.CheckErrorCode(t, err, workflowhostv1.WorkflowErrorCode_VERSION_CONFLICT)
	// 不存在的定义 → NOT_FOUND（404）：越权与真不存在宿主对外同一口径。
	_, err = def.Get(ctx, &workflowenginev1.GetDefinitionRequest{Meta: meta(designerActor), DefinitionId: "def-missing"})
	workflowconformance.CheckErrorCode(t, err, workflowhostv1.WorkflowErrorCode_NOT_FOUND)
	if v := workflowengine.ViewAsGateway(err); v.HTTPStatus != 404 {
		t.Fatalf("gateway view of NOT_FOUND = %+v, want 404", v)
	}
}
