package grpc

import (
	"context"
	"encoding/json"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"
	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// adminActor 管理员操作人（是否只许超管由宿主网关判定，AdminServer 本身不判角色）。
var adminActor = &workflowhostv1.ActorRef{UserId: 9, DisplayName: "管理员", IsSuperAdmin: true}

// startedInstance 走完 Create → SaveDraft → Publish → Start，返回定义 id 与新实例 id
// （AdminService 三个方法的用例共用这段前置）。
func startedInstance(t *testing.T, ts *testServers) (defID, instanceID string) {
	t.Helper()
	ctx := context.Background()
	createReply, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: "tpl-1", Name: "采购申请审批"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defID = createReply.GetDefinition().GetDefinitionId()
	saveReply, err := ts.def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: draftDoc(t), ExpectedVersionNo: createReply.GetDefinition().GetVersionNo()})
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	if _, err := ts.def.Publish(ctx, &workflowenginev1.PublishRequest{Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: saveReply.GetDefinition().GetVersionNo(), TemplatePublished: true, SerialFieldId: "f-no"}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	startReply, err := ts.inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: defID, Record: &workflowhostv1.RecordRef{RecordId: "rec-admin-1"}, StartKind: "MANUAL"})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	committed := startReply.GetCommitted()
	if committed == nil {
		t.Fatalf("start outcome = %+v, want Committed", startReply)
	}
	return defID, committed.GetWorkflowInstanceId()
}

// TestAdminServer_TerminateInstance：终止一个仍在跑的实例——outcome 落 Committed、
// status=ENDED、end_label=已终止（transport 层只做翻译，业务判据在 engineapp/core 单测里）。
func TestAdminServer_TerminateInstance(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()
	_, instanceID := startedInstance(t, ts)

	outcome, err := ts.admin.TerminateInstance(ctx, &workflowenginev1.TerminateInstanceRequest{
		Meta: meta(adminActor), WorkflowInstanceId: instanceID, Note: "违规单据",
	})
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	committed := outcome.GetCommitted()
	if committed == nil || committed.GetStatus() != "ENDED" || committed.GetEndLabel() != "已终止" {
		t.Fatalf("outcome = %+v", outcome)
	}

	// 已经结束的实例不能再终止一次——按状态码而不是幂等回放（不同 request_key）。
	if _, err := ts.admin.TerminateInstance(ctx, &workflowenginev1.TerminateInstanceRequest{
		Meta: meta(adminActor), WorkflowInstanceId: instanceID,
	}); status.Convert(err).Message() == "" || status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("terminate ended instance again: err=%v, want FailedPrecondition INSTANCE_ENDED", err)
	}
}

// TestAdminServer_ReassignTask：原任务撤销、新任务待办，宿主网关拿到的 outcome
// 与普通任务动作同一个翻译路径（outcomeToPB），改派特有的计数不变 / 租约释放已在
// engineapp 单测里断言过，这里只验证 transport 层把请求正确转发并翻译回包。
func TestAdminServer_ReassignTask(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()
	_, instanceID := startedInstance(t, ts)

	detail, err := ts.inst.GetDetail(ctx, &workflowenginev1.GetDetailRequest{Meta: meta(starterActor), WorkflowInstanceId: instanceID})
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	var taskID string
	for _, tk := range detail.GetAggregate().GetTasks() {
		if tk.GetAssigneeUserId() == 22 && tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	if taskID == "" {
		t.Fatalf("no pending task for user 22: %+v", detail.GetAggregate().GetTasks())
	}

	outcome, err := ts.admin.ReassignTask(ctx, &workflowenginev1.ReassignTaskRequest{
		Meta: meta(adminActor), TaskId: taskID, ToUserId: 33, Note: "王芳请假",
	})
	if err != nil {
		t.Fatalf("reassign: %v", err)
	}
	if outcome.GetCommitted() == nil {
		t.Fatalf("outcome = %+v, want Committed", outcome)
	}

	detail, err = ts.inst.GetDetail(ctx, &workflowenginev1.GetDetailRequest{Meta: meta(starterActor), WorkflowInstanceId: instanceID})
	if err != nil {
		t.Fatalf("get detail after reassign: %v", err)
	}
	var oldStatus, newStatus string
	for _, tk := range detail.GetAggregate().GetTasks() {
		switch tk.GetAssigneeUserId() {
		case 22:
			oldStatus = tk.GetStatus()
		case 33:
			newStatus = tk.GetStatus()
		}
	}
	if oldStatus != "WITHDRAWN" || newStatus != "PENDING" {
		t.Fatalf("reassign must withdraw the old task and create a pending one: old=%s new=%s", oldStatus, newStatus)
	}
}

// publishDocOn 走完 Create → SaveDraft → Publish，返回定义 id（ListIncidents 用例要搭两条独立
// 定义——父流程、子流程目标各绑自己的模板，不能复用 startedInstance 那条单一定义）。
func publishDocOn(t *testing.T, ts *testServers, templateID, name, doc string) string {
	t.Helper()
	ctx := context.Background()
	createReply, err := ts.def.Create(ctx, &workflowenginev1.CreateDefinitionRequest{Meta: meta(designerActor), TemplateId: templateID, Name: name})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defID := createReply.GetDefinition().GetDefinitionId()
	saveReply, err := ts.def.SaveDraft(ctx, &workflowenginev1.SaveDraftRequest{Meta: meta(designerActor), DefinitionId: defID, DraftJson: doc, ExpectedVersionNo: createReply.GetDefinition().GetVersionNo()})
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	if _, err := ts.def.Publish(ctx, &workflowenginev1.PublishRequest{Meta: meta(designerActor), DefinitionId: defID, ExpectedVersionNo: saveReply.GetDefinition().GetVersionNo(), TemplatePublished: true}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return defID
}

// subflowChildDoc 子流程目标流程：发起 → 结束，单步直达（与 engineapp 单测同构，独立复制一份，
// 两边是不同包不能互相引用测试内部类型）。
func subflowChildDoc(t *testing.T, templateID string) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "子流程目标", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "c0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: templateID, AllowManualStart: false, NoRouteHint: "无路可走"})},
			{ID: "c1", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "子流程已完成"})},
		},
		Links: []model.Link{{ID: "cl1", From: "c0", To: "c1"}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// subflowParentDoc 发起 → 部门审批（王芳 22）→ 子流程 → 结束「已通过」（Wait=true，发起失败时
// 稳稳停在子流程步骤本身，不与「同一提交里恰好也跑到了结束节点」相混，同 engineapp 单测）。
func subflowParentDoc(t *testing.T, childDefID string) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "父流程", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfgJSON(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindHandle, Name: "部门审批", Config: cfgJSON(t, model.HandleConfig{Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: []int64{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny}, NoRouteHint: "没有可走的路线"})},
			{ID: "sf", Kind: model.NodeKindSubflow, Name: "子流程", Config: cfgJSON(t, model.SubflowConfig{TargetWorkflowID: childDefID, Wait: true, Disposition: model.SubflowDispositionIgnore})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: cfgJSON(t, model.EndConfig{EndFlag: "已通过"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "sf"}, {ID: "l3", From: "sf", To: "n2"}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestAdminServer_ListIncidents_ByInstance：带 workflow_instance_id 时按单实例查，
// 只回 M5 三类事故；再传 status 时按状态筛一遍（本例只造了一条 OPEN，筛 RESOLVED 应得空）。
func TestAdminServer_ListIncidents_ByInstance(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()
	ts.launch.Err = context.DeadlineExceeded // 让子流程发起失败，造一条 SUBFLOW_START_FAILED 事故
	childID := publishDocOn(t, ts, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	parentID := publishDocOn(t, ts, "tpl-1", "父流程admin", subflowParentDoc(t, childID))

	startReply, err := ts.inst.Start(ctx, &workflowenginev1.StartRequest{Meta: meta(starterActor), DefinitionId: parentID, Record: &workflowhostv1.RecordRef{RecordId: "rec-admin-incidents"}, StartKind: "MANUAL"})
	if err != nil || startReply.GetCommitted() == nil {
		t.Fatalf("start parent: %+v err %v", startReply, err)
	}
	instanceID := startReply.GetCommitted().GetWorkflowInstanceId()
	detail, err := ts.inst.GetDetail(ctx, &workflowenginev1.GetDetailRequest{Meta: meta(starterActor), WorkflowInstanceId: instanceID})
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	var taskID string
	for _, tk := range detail.GetAggregate().GetTasks() {
		if tk.GetAssigneeUserId() == 22 && tk.GetStatus() == "PENDING" {
			taskID = tk.GetTaskId()
		}
	}
	if taskID == "" {
		t.Fatalf("no pending task for user 22: %+v", detail.GetAggregate().GetTasks())
	}
	if _, err := ts.task.Submit(ctx, &workflowenginev1.SubmitTaskRequest{Meta: meta(wangFangActor), TaskId: taskID}); err != nil {
		t.Fatalf("submit (subflow launch should fail and park, not error out): %v", err)
	}

	reply, err := ts.admin.ListIncidents(ctx, &workflowenginev1.ListIncidentsRequest{Meta: meta(adminActor), WorkflowInstanceId: instanceID})
	if err != nil {
		t.Fatalf("list incidents: %v", err)
	}
	if len(reply.GetIncidents()) != 1 || reply.GetIncidents()[0].GetKind() != "SUBFLOW_START_FAILED" {
		t.Fatalf("want exactly one SUBFLOW_START_FAILED incident, got %+v", reply.GetIncidents())
	}

	// status 筛选：造的这条是 OPEN，筛 RESOLVED 应得空。
	filtered, err := ts.admin.ListIncidents(ctx, &workflowenginev1.ListIncidentsRequest{Meta: meta(adminActor), WorkflowInstanceId: instanceID, Status: "RESOLVED"})
	if err != nil {
		t.Fatalf("list incidents filtered: %v", err)
	}
	if len(filtered.GetIncidents()) != 0 {
		t.Fatalf("status=RESOLVED filter should return none, got %+v", filtered.GetIncidents())
	}
}

// TestAdminServer_ListIncidents_DefinitionOnlyStillUnimplemented：只给 definition_id、
// 不给 workflow_instance_id 是跨实例枚举，账本没有这个能力，保持冻结壳——这条判据钉死「仍然
// Unimplemented」，缺口一旦被悄悄用错误的方式接上（例如把 definition_id 误当
// workflow_instance_id 用）这里就会变红。
func TestAdminServer_ListIncidents_DefinitionOnlyStillUnimplemented(t *testing.T) {
	ts := newTestServers(t)
	ctx := context.Background()
	_, err := ts.admin.ListIncidents(ctx, &workflowenginev1.ListIncidentsRequest{Meta: meta(adminActor), Status: "OPEN", DefinitionId: "def-x"})
	if status.Code(err) != codes.Unimplemented {
		t.Fatalf("ListIncidents(definition_id only) should remain Unimplemented until cross-instance enumeration exists, got %v", err)
	}
}
