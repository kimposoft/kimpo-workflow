package grpc

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"
	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// —— 夹具：直接调 server 方法（不起 gRPC 网络），验证 convert.go 的翻译 + errors.go 的错误
// 码翻译接线是否正确；状态机本身的行为已经在 internal/engine/app 的单测里覆盖过，这里不重复。

// fakeFreezer 与 internal/engine/app 单测同构：每条表达式冻结为 "pub:<expression_id>"。
type fakeFreezer struct{}

func (fakeFreezer) Freeze(_ context.Context, in compile.FreezeInput) (compile.FreezeOutput, error) {
	var out compile.FreezeOutput
	for _, sp := range in.Specs {
		out.Frozen = append(out.Frozen, compile.FrozenExpression{
			ExpressionID: sp.ExpressionID, PublicationID: "pub:" + sp.ExpressionID,
			ReferencedFields: []compile.FieldRef{{DataTableID: "dt-main", FieldID: "f-amount"}},
		})
	}
	return out, nil
}

// testServers 组一个跑在内存假体上的 engineapp.Service + 对应的四个 gRPC server。
type testServers struct {
	def    *DefinitionServer
	inst   *InstanceServer
	task   *TaskServer
	admin  *AdminServer
	ledger *testkit.MemLedger
	expr   *testkit.FakeExpr
	// launch 子流程非人工发起通道的假体；newTestServers 默认接好，用到子流程停驻场景的用例
	// （如 ListIncidents 按实例查）自己把 Err 设成非 nil 造一条 SUBFLOW_START_FAILED 事故。
	launch *testkit.FakeLaunch
}

func newTestServers(t *testing.T) *testServers {
	t.Helper()
	ledger := testkit.NewMemLedger()
	expr := testkit.NewFakeExpr()
	rec := &testkit.FakeRecord{Serial: "PO0001", Exists: true}
	ids := testkit.NewSeqIDs()
	clock := testkit.FixedClock{T: time.Date(2026, 9, 17, 3, 0, 0, 0, time.UTC)}
	launch := &testkit.FakeLaunch{}
	expr.Conditions["pub:l1"] = true
	svc := &engineapp.Service{
		Ledger: ledger, Record: rec, Clock: clock, IDs: ids, Launch: launch, Compiler: compile.New(nil, fakeFreezer{}, testkit.AllTextMain("f-status"), nil),
		Engine: &core.Engine{Expr: expr, Candidate: testkit.StaticCandidate{}, Record: rec, Clock: clock, IDs: ids},
	}
	return &testServers{
		def: NewDefinitionServer(svc), inst: NewInstanceServer(svc), task: NewTaskServer(svc), admin: NewAdminServer(svc),
		ledger: ledger, expr: expr, launch: launch,
	}
}

var (
	designerActor = &workflowhostv1.ActorRef{UserId: 7, DisplayName: "设计者"}
	starterActor  = &workflowhostv1.ActorRef{UserId: 1, DisplayName: "张三"}
	wangFangActor = &workflowhostv1.ActorRef{UserId: 22, DisplayName: "王芳"}
)

var reqSeq int

// meta 造一个 RequestMeta；每次调用换新的 request_key（同一动作不该复用别的动作的幂等键）。
func meta(actor *workflowhostv1.ActorRef) *workflowhostv1.RequestMeta {
	reqSeq++
	return &workflowhostv1.RequestMeta{AppId: "app", RequestKey: "req-" + strconv.Itoa(reqSeq), Actor: actor}
}

func cfgJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// draftDoc 发起 → 部门审批（王芳）→ 结束「已通过」写 f-status；l1 带条件（与 engineapp 单测
// 的 draftDoc 同构，独立复制一份——两边是不同包，不能互相引用测试内部类型）。
func draftDoc(t *testing.T) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "采购申请审批", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1", ConditionDoc: json.RawMessage(`{"mode":"condition"}`)}, {ID: "l2", From: "n1", To: "n2"}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestServers_LifecycleCreateSaveDraftPublishStart：Create → SaveDraft → Publish → Start，
// 覆盖 convert.go 的定义面 / 实例面翻译（definitionReplyPB / outcomeToPB 的 Committed 分支）。
func TestServers_LifecycleCreateSaveDraftPublishStart(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()

	createReply, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defID := createReply.GetDefinition().GetDefinitionId()
	if defID == "" {
		t.Fatalf("create reply missing definition_id: %+v", createReply)
	}

	saveReply, err := ts.def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{
		Meta: meta(designerActor), DefinitionId: defID, DraftJson: draftDoc(t), ExpectedVersionNo: createReply.GetDefinition().GetVersionNo(),
	})
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	if saveReply.GetDefinition().GetDraftJson() == "" {
		t.Fatalf("save draft reply missing draft_json: %+v", saveReply)
	}

	pubReply, err := ts.def.Publish(ctx, &workflowenginev1.PublishRequest{
		Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: saveReply.GetDefinition().GetVersionNo(), TemplatePublished: true, SerialFieldId: "f-no",
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(pubReply.GetDiagnostics()) != 0 || pubReply.GetVersionNo() != 1 || pubReply.GetVersionId() == "" {
		t.Fatalf("publish reply = %+v", pubReply)
	}

	startReply, err := ts.inst.Start(ctx, &workflowenginev1.StartRequest{
		Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-1"}, StartKind: "MANUAL",
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	committed := startReply.GetCommitted()
	if committed == nil {
		t.Fatalf("start outcome = %+v, want Committed", startReply)
	}
	if committed.GetWorkflowInstanceId() == "" || committed.GetInstanceVersion() != 1 || committed.GetReplayed() {
		t.Fatalf("committed = %+v", committed)
	}
}

// TestServers_SubmitNotOwner_PermissionDenied：非任务归属人提交 → codes.PermissionDenied，
// message 前缀 "TASK_NOT_OWNED:"（errors.go toStatus 按 WorkflowErrorCode 枚举名映射）。
func TestServers_SubmitNotOwner_PermissionDenied(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()

	createReply, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defID := createReply.GetDefinition().GetDefinitionId()
	if _, err := ts.def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: draftDoc(t), ExpectedVersionNo: 1}); err != nil {
		t.Fatalf("save draft: %v", err)
	}
	if _, err := ts.def.Publish(ctx, &workflowenginev1.PublishRequest{Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: 2, TemplatePublished: true, SerialFieldId: "f-no"}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if _, err := ts.inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-1"}}); err != nil {
		t.Fatalf("start: %v", err)
	}

	agg, err := ts.ledger.LoadInstanceByRecord(ctx, "app", "rec-1")
	if err != nil {
		t.Fatalf("load instance: %v", err)
	}
	var taskID string
	for _, tk := range agg.GetTasks() {
		if tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	if taskID == "" {
		t.Fatalf("no pending task in aggregate: %+v", agg)
	}

	// 归属人是王芳（user 22）；用张三（user 1）提交应被拒。
	_, err = ts.task.Submit(ctx, &workflowenginev1.SubmitTaskRequest{Meta: meta(starterActor), TaskId: taskID})
	if err == nil {
		t.Fatalf("submit by non-owner must fail")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("error is not a grpc status: %v", err)
	}
	if st.Code() != codes.PermissionDenied {
		t.Fatalf("code = %v, want PermissionDenied", st.Code())
	}
	if !strings.HasPrefix(st.Message(), "TASK_NOT_OWNED:") {
		t.Fatalf("message = %q, want prefix TASK_NOT_OWNED:", st.Message())
	}

	// 归属人本人提交应成功（顺带验证 outcomeToPB 的 Committed.end_label）。
	submitReply, err := ts.task.Submit(ctx, &workflowenginev1.SubmitTaskRequest{Meta: meta(wangFangActor), TaskId: taskID})
	if err != nil {
		t.Fatalf("submit by owner: %v", err)
	}
	if got := submitReply.GetCommitted().GetEndLabel(); got != "已通过" {
		t.Fatalf("end_label = %q, want 已通过", got)
	}
}

// TestServers_MissingRequestKey_InvalidArgument：RequestMeta 缺 request_key → InvalidArgument，
// message 前缀 "INVALID_ARGUMENT:"（requireMeta，绕过 toStatus 的传输层自产错误）。
func TestServers_MissingRequestKey_InvalidArgument(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()

	_, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{
		Meta:       &workflowhostv1.RequestMeta{AppId: "app", Actor: designerActor}, // RequestKey 空
		TemplateId: "tpl-1", Name: "采购申请审批",
	})
	if err == nil {
		t.Fatalf("missing request_key must fail")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("error is not a grpc status: %v", err)
	}
	if st.Code() != codes.InvalidArgument {
		t.Fatalf("code = %v, want InvalidArgument", st.Code())
	}
	if !strings.HasPrefix(st.Message(), "INVALID_ARGUMENT:") {
		t.Fatalf("message = %q, want prefix INVALID_ARGUMENT:", st.Message())
	}

	// 缺 app_id 同样要拒。
	_, err = ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{
		Meta:       &workflowhostv1.RequestMeta{RequestKey: "req-x", Actor: designerActor}, // AppId 空
		TemplateId: "tpl-1", Name: "采购申请审批",
	})
	if err == nil {
		t.Fatalf("missing app_id must fail")
	}
	if st, ok := status.FromError(err); !ok || st.Code() != codes.InvalidArgument {
		t.Fatalf("missing app_id: err = %v", err)
	}
}

// TestServers_DeleteStillUnimplemented：Delete 是刻意留给宿主网关的冻结壳，恒
// Unimplemented（不接线；DEFINITION_IN_USE 由宿主网关自查）。
func TestServers_DeleteStillUnimplemented(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()

	_, err := ts.def.Delete(ctx, &workflowenginev1.DeleteDefinitionRequest{Meta: meta(designerActor), DefinitionId: "def-x"})
	if err == nil {
		t.Fatalf("Delete must still be unimplemented")
	}
	st, ok := status.FromError(err)
	if !ok || st.Code() != codes.Unimplemented {
		t.Fatalf("Delete err = %v, want Unimplemented", err)
	}
	if !strings.Contains(st.Message(), "DEFINITION_IN_USE") {
		t.Fatalf("message = %q, want it to explain DEFINITION_IN_USE is checked by host gateway", st.Message())
	}

	// AdminService：TerminateInstance / ReassignTask 已接线（各自的用例见
	// TestAdminServer_TerminateInstance / TestAdminServer_ReassignTask）；ListIncidents 因
	// 接口面缺口仍是冻结壳，见 TestAdminServer_ListIncidents_StillFrozen。记录 / 定义生命周期
	// 四个方法归宿主自处理，恒 Unimplemented。
	if _, err := ts.admin.OnRecordDeleted(ctx, &workflowenginev1.RecordLifecycleRequest{Meta: meta(designerActor)}); status.Code(err) != codes.Unimplemented {
		t.Fatalf("AdminService.OnRecordDeleted must still be unimplemented, got %v", err)
	}
}

// TestServers_GetDetailCarriesTaskFlags：GetDetail 只加 task_flags，每条任务一条。
func TestServers_GetDetailCarriesTaskFlags(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()
	createReply, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	if err != nil {
		t.Fatal(err)
	}
	defID := createReply.GetDefinition().GetDefinitionId()
	saveReply, err := ts.def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: draftDoc(t), ExpectedVersionNo: createReply.GetDefinition().GetVersionNo()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ts.def.Publish(ctx, &workflowenginev1.PublishRequest{Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: saveReply.GetDefinition().GetVersionNo(), TemplatePublished: true, SerialFieldId: "f-no"}); err != nil {
		t.Fatal(err)
	}
	startReply, err := ts.inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-1"}, StartKind: "MANUAL"})
	if err != nil {
		t.Fatal(err)
	}
	instID := startReply.GetCommitted().GetWorkflowInstanceId()
	reply, err := ts.inst.GetDetail(ctx, &workflowenginev1.GetDetailRequest{Meta: meta(starterActor), WorkflowInstanceId: instID})
	if err != nil {
		t.Fatal(err)
	}
	if len(reply.GetTaskFlags()) != len(reply.GetAggregate().GetTasks()) || len(reply.GetTaskFlags()) == 0 {
		t.Fatalf("task_flags = %+v", reply.GetTaskFlags())
	}
	for _, f := range reply.GetTaskFlags() {
		if f.GetTaskId() == "" || (!f.GetWithdrawable() && f.GetReasonCode() == "") {
			t.Fatalf("flag = %+v", f)
		}
	}
}

// approveDraftDoc 夹具：发起 → 部门审批（王芳，审批节点，两个按钮，允许回退到发起人）→ 结束。
func approveDraftDoc(t *testing.T) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "采购申请审批", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindApprove, Name: "部门审批", Config: cfgJSON(t, model.ApproveConfig{
				Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}},
				CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
				Buttons: []model.ApprovalButton{
					{ID: "b-ok", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "已通过"},
					{ID: "b-back", Name: "退回发起人", Action: model.ButtonActionWithdrawInit, ResultTag: "已退回", RequireReason: true},
				},
				NoRouteHint: "审批后没有可走的路线",
			})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "n2"}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestButtonActionToPB_EndFlow：五档按钮动作到线上字面量的翻译；未知动作仍兜底为 SUBMIT。
func TestButtonActionToPB_EndFlow(t *testing.T) {
	cases := map[model.ButtonAction]string{
		model.ButtonActionSubmitApprove:   "SUBMIT",
		model.ButtonActionWithdrawPrev:    "BACK_PREV",
		model.ButtonActionWithdrawInit:    "BACK_START",
		model.ButtonActionWithdrawSpecify: "BACK_STEP",
		model.ButtonActionEndFlow:         "END_FLOW",
		model.ButtonAction("unknown"):     "SUBMIT",
	}
	for in, want := range cases {
		if got := buttonActionToPB(in); got != want {
			t.Fatalf("buttonActionToPB(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestTaskService_Batch6Actions：Back / PressButton / Preview 三个方法已接线。
// Preview 报的按钮与允许的回退方式必须与真正执行时的判定一致——界面不该画出点下去被拒的按钮。
func TestTaskService_Batch6Actions(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()

	createReply, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	if err != nil {
		t.Fatal(err)
	}
	defID := createReply.GetDefinition().GetDefinitionId()
	saveReply, err := ts.def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: approveDraftDoc(t), ExpectedVersionNo: createReply.GetDefinition().GetVersionNo()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ts.def.Publish(ctx, &workflowenginev1.PublishRequest{Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: saveReply.GetDefinition().GetVersionNo(), TemplatePublished: true, SerialFieldId: "f-no"}); err != nil {
		t.Fatal(err)
	}
	startReply, err := ts.inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-1"}, StartKind: "MANUAL"})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := ts.inst.GetDetail(ctx, &workflowenginev1.GetDetailRequest{Meta: meta(starterActor), WorkflowInstanceId: startReply.GetCommitted().GetWorkflowInstanceId()})
	if err != nil {
		t.Fatal(err)
	}
	var taskID string
	for _, tk := range detail.GetAggregate().GetTasks() {
		if tk.GetAssigneeUserId() == 22 && tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	if taskID == "" {
		t.Fatalf("no pending task for the approver: %+v", detail.GetAggregate().GetTasks())
	}

	preview, err := ts.task.Preview(ctx, &workflowenginev1.PreviewTaskRequest{Meta: meta(wangFangActor), TaskId: taskID})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if len(preview.GetButtons()) != 2 || preview.GetButtons()[0].GetAction() != "SUBMIT" || preview.GetButtons()[1].GetAction() != "BACK_START" {
		t.Fatalf("buttons = %+v", preview.GetButtons())
	}
	if !preview.GetButtons()[1].GetCommentRequired() {
		t.Fatalf("「退回发起人」配了需填理由，预告里必须带上：%+v", preview.GetButtons()[1])
	}
	if len(preview.GetAllowedBackKinds()) != 1 || preview.GetAllowedBackKinds()[0] != "START" {
		t.Fatalf("allowed_back_kinds = %v，本节点只配了「退回发起人」那一档按钮", preview.GetAllowedBackKinds())
	}
	if preview.GetNoRouteHint() != "审批后没有可走的路线" {
		t.Fatalf("no_route_hint = %q", preview.GetNoRouteHint())
	}

	// back_mode 不在三档之内：直接回绝，不落库。
	if _, err := ts.task.Back(ctx, &workflowenginev1.BackTaskRequest{Meta: meta(wangFangActor), TaskId: taskID, BackMode: "SIDEWAYS"}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("unknown back_mode err = %v, want InvalidArgument", err)
	}

	// 需填理由的按钮不填理由：被拒。
	if _, err := ts.task.PressButton(ctx, &workflowenginev1.PressButtonRequest{Meta: meta(wangFangActor), TaskId: taskID, ButtonId: "b-back"}); err == nil {
		t.Fatal("需填理由的按钮不填理由应当被拒")
	}

	// 点「同意」：流程走到结束。
	outcome, err := ts.task.PressButton(ctx, &workflowenginev1.PressButtonRequest{Meta: meta(wangFangActor), TaskId: taskID, ButtonId: "b-ok", Comment: "金额无误"})
	if err != nil {
		t.Fatalf("press b-ok: %v", err)
	}
	if outcome.GetCommitted() == nil || outcome.GetCommitted().GetStatus() != "ENDED" {
		t.Fatalf("outcome = %+v", outcome)
	}
}
