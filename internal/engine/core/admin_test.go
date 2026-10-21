package core_test

import (
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

var admin = ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}

// ═══ 管理员能力（M）═══

// TestM1_TerminateEndsInstanceAndWithdrawsTasks：终止把仍在跑的实例标为已结束（对外「已终止」），
// 当前站待办任务原因 TERMINATED、当前步骤 CANCELLED——全部复用 core.ForceEnd。
func TestM1_TerminateEndsInstanceAndWithdrawsTasks(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()

	d, err := h.eng.Terminate(h.ctx(), core.TerminateInput{AppID: appID, Agg: agg, Actor: admin, Reason: "违规单据"})
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	h.rawCommit(d.Changeset)

	agg = h.agg()
	inst := agg.GetInstance()
	wantEqual(t, "实例状态", inst.GetStatus(), string(model.InstanceStatusEnded))
	wantEqual(t, "对外文案", inst.GetEndLabel(), "已终止")
	if inst.GetCurrentStepId() != "" {
		t.Fatalf("已结束实例不该再有当前站：%q", inst.GetCurrentStepId())
	}
	n1 := h.step(agg, "n1", "")
	wantEqual(t, "步骤状态", n1.GetStatus(), string(model.StepStatusCancelled))
	wantEqual(t, "步骤结果", n1.GetOutcome(), string(model.StepOutcomeCancelled))
	task := h.task(agg, wangFang.UserID, "")
	wantEqual(t, "任务状态", task.GetStatus(), string(model.TaskStatusWithdrawn))
	wantEqual(t, "撤销原因", task.GetWithdrawReason(), string(model.TaskWithdrawTerminated))
}

// TestM1_TerminateAlreadyEndedRejected：已结束的实例不能再被终止一次——按钮本不该出现在
// 已结束的实例上，报错让前端知道，而不是静默幂等（幂等留给子流程善后等内部系统调用）。
func TestM1_TerminateAlreadyEndedRejected(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{}) // 一路走到结束（两段式已经在 submit/commit 里处理过）

	agg := h.agg()
	if agg.GetInstance().GetStatus() != string(model.InstanceStatusEnded) {
		t.Fatalf("夹具应当已经走到结束：%+v", agg.GetInstance())
	}
	_, err := h.eng.Terminate(h.ctx(), core.TerminateInput{AppID: appID, Agg: agg, Actor: admin})
	wantCode(t, err, "INSTANCE_ENDED")
}

// TestM2_ReassignSwapsAssigneeKeepsCounts：改派后原任务 REASSIGNED、新任务 PENDING，
// assignee_count / passed_count 都不变，且 Decision 带上原办理人的租约释放。
func TestM2_ReassignSwapsAssigneeKeepsCounts(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	before := h.current(agg)
	oldTask := h.task(agg, wangFang.UserID, "PENDING")

	d, err := h.eng.Reassign(h.ctx(), core.ReassignInput{AppID: appID, Agg: agg, TaskID: oldTask.GetTaskId(), ToUserID: liSi.UserID, Actor: admin, Reason: "王芳请假"})
	if err != nil {
		t.Fatalf("reassign: %v", err)
	}
	if d.PendingLeaseRelease == nil || d.PendingLeaseRelease.HolderUserID != wangFang.UserID || d.PendingLeaseRelease.Reason != "REASSIGNED" {
		t.Fatalf("必须带租约释放且指向原办理人：%+v", d.PendingLeaseRelease)
	}
	h.rawCommit(d.Changeset)

	agg = h.agg()
	cur := h.current(agg)
	wantEqual(t, "候选人数不变", cur.GetAssigneeCount(), before.GetAssigneeCount())
	wantEqual(t, "通过数不变", cur.GetPassedCount(), before.GetPassedCount())
	wantEqual(t, "当前站不变", cur.GetNodeId(), before.GetNodeId())
	oldAfter := h.task(agg, wangFang.UserID, "")
	wantEqual(t, "原任务状态", oldAfter.GetStatus(), string(model.TaskStatusWithdrawn))
	wantEqual(t, "原任务撤销原因", oldAfter.GetWithdrawReason(), string(model.TaskWithdrawReassigned))
	newTask := h.task(agg, liSi.UserID, "PENDING")
	wantEqual(t, "新任务状态", newTask.GetStatus(), string(model.TaskStatusPending))
	wantEqual(t, "新任务所在站", newTask.GetStepId(), oldTask.GetStepId())
}

// TestM2_ReassignSameUserRejected：改派给当前办理人本人没有意义，拒绝（复用既有码
// INVALID_CHOICE，不新增错误码）。
func TestM2_ReassignSameUserRejected(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	task := h.task(agg, wangFang.UserID, "PENDING")
	_, err := h.eng.Reassign(h.ctx(), core.ReassignInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), ToUserID: wangFang.UserID, Actor: admin})
	wantCode(t, err, "INVALID_CHOICE")
}

// TestM2_ReassignRejectsInstanceEnded：实例已结束时改派同样按状态拒绝。
func TestM2_ReassignRejectsInstanceEnded(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	oldAgg := h.agg()
	task := h.task(oldAgg, wangFang.UserID, "PENDING")
	h.mustSubmit(wangFang, core.Choices{})

	agg := h.agg()
	_, err := h.eng.Reassign(h.ctx(), core.ReassignInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), ToUserID: liSi.UserID, Actor: admin})
	wantCode(t, err, "INSTANCE_ENDED")
}

// TestM3_ListIncidentsOnlyThreeKinds：事故清单只回三类真正的事故，END_WRITE_PENDING（两段式
// 提交的过渡态）不算数。
func TestM3_ListIncidentsOnlyThreeKinds(t *testing.T) {
	agg := &pb.InstanceAggregate{
		Instance: &pb.InstanceRow{WorkflowInstanceId: "inst-1"},
		Incidents: []*pb.IncidentRow{
			{IncidentId: "i1", Kind: string(model.IncidentWriteFieldFailed), Status: "OPEN"},
			{IncidentId: "i2", Kind: string(model.IncidentSubflowStartFailed), Status: "OPEN"},
			{IncidentId: "i3", Kind: string(model.IncidentAutoChainLimit), Status: "RESOLVED"},
			{IncidentId: "i4", Kind: string(model.IncidentEndWritePending), Status: "OPEN"},
		},
	}
	got := core.ListIncidents(agg)
	if len(got) != 3 {
		t.Fatalf("want 3 incidents (END_WRITE_PENDING excluded), got %d: %+v", len(got), got)
	}
	seen := map[string]bool{}
	for _, i := range got {
		seen[i.GetIncidentId()] = true
	}
	if !seen["i1"] || !seen["i2"] || !seen["i3"] || seen["i4"] {
		t.Fatalf("wrong set returned: %+v", got)
	}
}
