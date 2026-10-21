package engineapp

import (
	"context"
	"errors"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// ═══ 管理员能力（M，app 层：幂等 / CAS 重试 / M4 租约释放接线）═══

// TestAdmin_TerminateEndsInstanceViaExecute：Terminate 经 execute/commitLoop 落地，
// 与其余动作同一条幂等骨架——重放同一 request_key 不再二次终止。
func TestAdmin_TerminateEndsInstanceViaExecute(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	defID := f.published(t)
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: defID, Record: ports.RecordRef{RecordID: "rec-t1"}})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	instanceID := r.Outcome.WorkflowInstanceID

	admin := ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}
	meta := f.meta(admin)
	res, err := f.svc.Terminate(ctx, meta, TerminateInput{InstanceID: instanceID, Reason: "违规单据"})
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if res.Outcome.Status != "ENDED" || res.Outcome.EndLabel != "已终止" {
		t.Fatalf("terminate outcome = %+v", res.Outcome)
	}
	agg, err := f.svc.GetDetail(ctx, meta, instanceID)
	if err != nil || agg.GetInstance().GetStatus() != "ENDED" {
		t.Fatalf("instance must be ended: %+v err %v", agg.GetInstance(), err)
	}

	// 重放同一 request_key：直接回放，不再重复终止（已经是 ENDED 也不会报 INSTANCE_ENDED）。
	res2, err := f.svc.Terminate(ctx, meta, TerminateInput{InstanceID: instanceID, Reason: "违规单据"})
	if err != nil || !res2.Replayed {
		t.Fatalf("replay: %+v err %v", res2, err)
	}
}

// TestAdmin_ReassignReleasesLeaseAndKeepsCounts：改派提交成功后，commitLoop 按
// Decision.PendingLeaseRelease 调用 Lease 端口释放原办理人的编辑租约；原任务
// REASSIGNED、新任务 PENDING、会签计数不变。
func TestAdmin_ReassignReleasesLeaseAndKeepsCounts(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	defID := f.published(t)
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: defID, Record: ports.RecordRef{RecordID: "rec-t2"}})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	instanceID := r.Outcome.WorkflowInstanceID
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	before := agg.GetInstance()
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")

	admin := ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}
	liSi := ports.Actor{UserID: 33, DisplayName: "李四"}
	res, err := f.svc.Reassign(ctx, f.meta(admin), ReassignInput{TaskID: taskID, ToUserID: liSi.UserID, Reason: "王芳请假"})
	if err != nil {
		t.Fatalf("reassign: %v", err)
	}
	if res.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("reassign outcome = %+v", res.Outcome)
	}
	if len(f.lease.Calls) != 1 || f.lease.Calls[0].HolderUserID != wangFang.UserID || f.lease.Calls[0].Reason != "REASSIGNED" {
		t.Fatalf("lease must be released for the original holder exactly once: %+v", f.lease.Calls)
	}
	if f.lease.Calls[0].Record.RecordID != before.GetRecordId() || f.lease.Calls[0].Record.WorkflowInstanceID != instanceID {
		t.Fatalf("lease release must target the instance's own record: %+v", f.lease.Calls[0])
	}

	agg, _ = f.svc.GetDetail(ctx, f.meta(starter), instanceID)
	cur := agg.GetInstance()
	if cur.GetCurrentStepId() != before.GetCurrentStepId() {
		t.Fatalf("current step must not change: before=%s after=%s", before.GetCurrentStepId(), cur.GetCurrentStepId())
	}
	newTask := taskOf(t, agg, liSi.UserID, "PENDING")
	if newTask == "" {
		t.Fatal("new assignee must have a pending task")
	}
}

// TestAdmin_ReassignLeaseFailureDoesNotRollback：释放租约失败只 warn，改派本身照样生效。
func TestAdmin_ReassignLeaseFailureDoesNotRollback(t *testing.T) {
	f := newFixture(t)
	f.lease.Err = errors.New("lease service down")
	ctx := context.Background()
	defID := f.published(t)
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: defID, Record: ports.RecordRef{RecordID: "rec-t3"}})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")

	admin := ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}
	res, err := f.svc.Reassign(ctx, f.meta(admin), ReassignInput{TaskID: taskID, ToUserID: 33, Reason: "租约释放会失败"})
	if err != nil {
		t.Fatalf("reassign must still succeed even if lease release fails: %v", err)
	}
	if res.Outcome.Kind != core.OutcomeCommitted {
		t.Fatalf("reassign outcome = %+v", res.Outcome)
	}
	if len(f.lease.Calls) != 1 {
		t.Fatalf("lease release must still be attempted once: %+v", f.lease.Calls)
	}
}

// TestAdmin_TerminateForceEndsWaitingSubflowRegardlessOfOrphanPolicy：
// 父流程终止那一刻正停在「等待」子流程节点，即使该链接配的是 IGNORE（orphan_policy 只在
// 「不等待」时有意义），等待中的子实例也要一律强制结束，不能留着没人管。
func TestAdmin_TerminateForceEndsWaitingSubflowRegardlessOfOrphanPolicy(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标(办理)", subflowChildHandleDoc(t, "tpl-2", 44))
	parentID := f.publishDoc(t, "tpl-1", "父流程terminate", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-term1"}})
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
	if res.Outcome.Status != "RUNNING" {
		t.Fatalf("parent should be waiting at sf: %+v", res.Outcome)
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentInstanceID)
	if len(parentAgg.GetLinks()) != 1 || parentAgg.GetLinks()[0].GetOrphanPolicy() != "IGNORE" || parentAgg.GetLinks()[0].GetWaitMode() != "WAIT" {
		t.Fatalf("want one WAIT/IGNORE link: %+v", parentAgg.GetLinks())
	}
	childInstanceID := parentAgg.GetLinks()[0].GetChildWorkflowInstanceId()

	admin := ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}
	if _, err := f.svc.Terminate(ctx, f.meta(admin), TerminateInput{InstanceID: parentInstanceID, Reason: "整单作废"}); err != nil {
		t.Fatalf("terminate parent: %v", err)
	}

	childAgg, err := f.svc.GetDetail(ctx, f.meta(starter), childInstanceID)
	if err != nil || childAgg.GetInstance().GetStatus() != "ENDED" || childAgg.GetInstance().GetEndLabel() != "已终止" {
		t.Fatalf("waiting child must be force-ended even though orphan_policy=IGNORE: %+v err %v", childAgg.GetInstance(), err)
	}
	childTaskID := taskOf(t, childAgg, 44, "WITHDRAWN")
	for _, tk := range childAgg.GetTasks() {
		if tk.GetTaskId() == childTaskID && tk.GetWithdrawReason() != "TERMINATED" {
			t.Fatalf("child's pending task must be withdrawn as TERMINATED: %+v", tk)
		}
	}
}

// TestAdmin_ListIncidentsOnlyThreeKinds：M3 事故清单只读，走 GetDetail 同一条账本，不消耗
// 请求键幂等。
func TestAdmin_ListIncidentsOnlyThreeKinds(t *testing.T) {
	f := newFixture(t)
	f.launch.Err = errors.New("host down")
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标", subflowChildDoc(t, "tpl-2"))
	parentID := f.publishDoc(t, "tpl-1", "父流程admin", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))
	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-t4"}})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), r.Outcome.WorkflowInstanceID)
	taskID := taskOf(t, agg, wangFang.UserID, "PENDING")
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), taskID, core.Choices{}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	admin := ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}
	incidents, err := f.svc.ListIncidents(ctx, f.meta(admin), r.Outcome.WorkflowInstanceID)
	if err != nil {
		t.Fatalf("list incidents: %v", err)
	}
	if len(incidents) != 1 || incidents[0].GetKind() != "SUBFLOW_START_FAILED" {
		t.Fatalf("want exactly one SUBFLOW_START_FAILED incident, got %+v", incidents)
	}
}
