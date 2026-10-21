package engineapp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// approve_end_test.go：审批按钮「不通过并结束流程」在 app 层的判据——
// 字段写入次序、并发先到者赢、子流程内点击父流程照常向后走。

var (
	liSi   = ports.Actor{UserID: 33, DisplayName: "李四"}
	zhaoWu = ports.Actor{UserID: 44, DisplayName: "赵五"}
)

// endFlowApproveDoc 发起 → 审批 n1（approvers，mode）→ 结束 n2「已通过」；n3「已拒绝」无入线，
// 只被 b-end 按钮指向。审批节点绑结果字段 f-status；n3 的结束标识写入字段也是 f-status
// （验证「结果绑定字段与结束写入字段同一字段以结束标识为准」）。
func endFlowApproveDoc(t *testing.T, approvers []int64, mode model.CompleteModeKind) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "审批不通过即结束", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"})},
			{ID: "n1", Kind: model.NodeKindApprove, Name: "财务审批", Config: cfg(t, model.ApproveConfig{
				Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList(approvers)}},
				CompleteMode: model.CompleteMode{Kind: mode, PercentageBP: 10000},
				Buttons: []model.ApprovalButton{
					{ID: "b-ok", Name: "同意", Action: model.ButtonActionSubmitApprove, ResultTag: "已通过"},
					{ID: "b-end", Name: "不通过并结束", Action: model.ButtonActionEndFlow, ResultTag: "审批未通过", EndNodeID: "n3"},
				},
				ResultFieldID: "f-status",
			})},
			{ID: "n2", Kind: model.NodeKindEnd, Name: "已通过", Config: cfg(t, model.EndConfig{EndFlag: "已通过"})},
			{ID: "n3", Kind: model.NodeKindEnd, Name: "已拒绝", Config: cfg(t, model.EndConfig{EndFlag: "已拒绝", WriteFieldID: "f-status"})},
		},
		Links: []model.Link{{ID: "l1", From: "n0", To: "n1"}, {ID: "l2", From: "n1", To: "n2"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// startEndFlow 发布并发起，返回实例 id。
func startEndFlow(t *testing.T, f *fixture, approvers []int64, mode model.CompleteModeKind) string {
	t.Helper()
	defID := f.publishDoc(t, "tpl-1", "审批不通过即结束", endFlowApproveDoc(t, approvers, mode))
	r, err := f.svc.Start(context.Background(), f.meta(starter), StartInput{DefinitionID: defID, Record: ports.RecordRef{RecordID: "rec-end"},
		Choices: core.Choices{SelectedAssignees: approvers}})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return r.Outcome.WorkflowInstanceID
}

// pendingTaskOf 实例里某人的待办任务 id。
func (f *fixture) pendingTaskOf(t *testing.T, instanceID string, user ports.Actor) string {
	t.Helper()
	agg, err := f.svc.GetDetail(context.Background(), f.meta(starter), instanceID)
	if err != nil {
		t.Fatal(err)
	}
	return taskOf(t, agg, user.UserID, "PENDING")
}

// TestN3_9_EndFlow_WritesResultThenEndLabel：结果绑定字段与结束写入字段是同一个字段（f-status）时，
// 先写结果标识（审批阶段）、后写结束标识（两段式），最终以结束标识为准。
func TestN3_9_EndFlow_WritesResultThenEndLabel(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	inst := startEndFlow(t, f, []int64{22}, model.CompleteModeAny)
	res, err := f.svc.PressButton(ctx, f.meta(wangFang), f.pendingTaskOf(t, inst, wangFang), PressButtonInput{ButtonID: "b-end"})
	if err != nil {
		t.Fatalf("press: %v", err)
	}
	wantEqualStr(t, "outcome status", res.Outcome.Status, "ENDED")
	wantEqualStr(t, "end label", res.Outcome.EndLabel, "已拒绝")
	if len(f.rec.Writes) != 2 || f.rec.Writes[0].TextValue != "审批未通过" || f.rec.Writes[1].TextValue != "已拒绝" {
		t.Fatalf("应先写结果标识再写结束标识，实得 %+v", f.rec.Writes)
	}
	agg, _ := f.svc.GetDetail(ctx, f.meta(starter), inst)
	wantEqualStr(t, "instance status", agg.GetInstance().GetStatus(), "ENDED")
	wantEqualStr(t, "end node", agg.GetInstance().GetEndNodeId(), "n3")
}

// racingLedger 在第一次「带 CAS 期望版本」的提交之前先跑一个 before 钩子（模拟另一个人抢先提交了
// 自己的动作），再照常委托给内层账本——于是本次提交撞上版本冲突，走「重装载重试一次」的路径。
type racingLedger struct {
	*testkit.MemLedger
	before func()
	done   bool
}

func (r *racingLedger) Commit(ctx context.Context, appID string, in ports.CommitInput) (ports.CommitResult, error) {
	if !r.done && in.Changeset.GetInstance().GetExpectedVersion() > 0 {
		r.done = true
		r.before()
	}
	return r.MemLedger.Commit(ctx, appID, in)
}

// N3.8 并发（先到者赢）：两人同时点，一人「同意」、一人「不通过并结束」。
//   - 「不通过并结束」先到：后到的「同意」重试时实例已结束，被拒 INSTANCE_ENDED，流程以拒绝结束；
//   - 「同意」先到（或签，一票即过关到「已通过」）：后到的「不通过并结束」被拒，流程以通过结束。
func TestN3_8_EndFlow_ConcurrentFirstWins(t *testing.T) {
	cases := []struct {
		name        string
		firstButton string // 抢先提交的按钮
		firstUser   ports.Actor
		laterButton string // 后到（撞版本冲突）的按钮
		laterUser   ports.Actor
		wantEndNode string
		wantLabel   string
	}{
		{"结束先到", "b-end", liSi, "b-ok", wangFang, "n3", "已拒绝"},
		{"同意先到", "b-ok", wangFang, "b-end", liSi, "n2", "已通过"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			inst := startEndFlow(t, f, []int64{22, 33}, model.CompleteModeAny)
			firstTask, laterTask := f.pendingTaskOf(t, inst, c.firstUser), f.pendingTaskOf(t, inst, c.laterUser)
			var firstErr error
			f.svc.Ledger = &racingLedger{MemLedger: f.ledger, before: func() {
				_, firstErr = f.svc.PressButton(ctx, f.meta(c.firstUser), firstTask, PressButtonInput{ButtonID: c.firstButton})
			}}
			_, err := f.svc.PressButton(ctx, f.meta(c.laterUser), laterTask, PressButtonInput{ButtonID: c.laterButton})
			if firstErr != nil {
				t.Fatalf("先到者应成功：%v", firstErr)
			}
			wantCode(t, err, "INSTANCE_ENDED")

			agg, _ := f.svc.GetDetail(ctx, f.meta(starter), inst)
			wantEqualStr(t, "status", agg.GetInstance().GetStatus(), "ENDED")
			wantEqualStr(t, "end node", agg.GetInstance().GetEndNodeId(), c.wantEndNode)
			wantEqualStr(t, "label", agg.GetInstance().GetEndLabel(), c.wantLabel)
			// 后到者的任务被撤销（或签过关 STEP_PASSED / 结束 STEP_ENDED），不是 DONE。
			for _, tk := range agg.GetTasks() {
				if tk.GetTaskId() == laterTask && tk.GetStatus() != "WITHDRAWN" {
					t.Fatalf("后到者的任务应被撤销，实得 %s", tk.GetStatus())
				}
			}
		})
	}
}

// subflowChildApproveDoc 子流程目标流程：发起 → 审批 c1（assignee）→ 结束 c2「子流程已完成」；
// c3「子流程被拒」无入线，只被 b-end 按钮指向。
func subflowChildApproveDoc(t *testing.T, templateID string, assignee int64) string {
	t.Helper()
	doc := model.Document{Schema: model.SchemaVersion, Name: "子流程目标(审批)", Notify: model.DefaultNotifySettings(),
		Nodes: []model.Node{
			{ID: "c0", Kind: model.NodeKindStart, Name: "发起", Config: cfg(t, model.StartConfig{TargetTemplateID: templateID, AllowManualStart: false, NoRouteHint: "无路可走"})},
			{ID: "c1", Kind: model.NodeKindApprove, Name: "子流程审批", Config: cfg(t, model.ApproveConfig{
				Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{assignee}}},
				CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
				Buttons: []model.ApprovalButton{
					{ID: "b-ok", Name: "同意", Action: model.ButtonActionSubmitApprove},
					{ID: "b-end", Name: "不通过并结束", Action: model.ButtonActionEndFlow, EndNodeID: "c3"},
				},
			})},
			{ID: "c2", Kind: model.NodeKindEnd, Name: "结束", Config: cfg(t, model.EndConfig{EndFlag: "子流程已完成"})},
			{ID: "c3", Kind: model.NodeKindEnd, Name: "被拒", Config: cfg(t, model.EndConfig{EndFlag: "子流程被拒"})},
		},
		Links: []model.Link{{ID: "cl1", From: "c0", To: "c1"}, {ID: "cl2", From: "c1", To: "c2"}},
	}
	raw, _ := json.Marshal(doc)
	return string(raw)
}

// N3.10 子流程内点该按钮：子实例结束（子流程结束标识为「被拒」）；等待档的父流程视为该子流程已结束，
// 照常向后走到结束，父流程不感知子流程的结束标识。
func TestN3_10_EndFlow_InSubflowParentContinues(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	childID := f.publishDoc(t, "tpl-2", "子流程目标(审批)", subflowChildApproveDoc(t, "tpl-2", 44))
	parentID := f.publishDoc(t, "tpl-1", "父流程", subflowParentDoc(t, childID, true, model.SubflowDispositionIgnore, nil))

	r, err := f.svc.Start(ctx, f.meta(starter), StartInput{DefinitionID: parentID, Record: ports.RecordRef{RecordID: "rec-p"}})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	parentInst := r.Outcome.WorkflowInstanceID
	if _, err := f.svc.Submit(ctx, f.meta(wangFang), f.pendingTaskOf(t, parentInst, wangFang), core.Choices{}); err != nil {
		t.Fatalf("submit n1: %v", err)
	}
	parentAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), parentInst)
	if len(parentAgg.GetLinks()) != 1 || parentAgg.GetInstance().GetStatus() != "RUNNING" {
		t.Fatalf("父流程应等在子流程节点：%+v links=%+v", parentAgg.GetInstance(), parentAgg.GetLinks())
	}
	childInst := parentAgg.GetLinks()[0].GetChildWorkflowInstanceId()

	// 子流程审批人点「不通过并结束」。
	if _, err := f.svc.PressButton(ctx, f.meta(zhaoWu), f.pendingTaskOf(t, childInst, zhaoWu), PressButtonInput{ButtonID: "b-end"}); err != nil {
		t.Fatalf("press in subflow: %v", err)
	}
	childAgg, _ := f.svc.GetDetail(ctx, f.meta(starter), childInst)
	wantEqualStr(t, "child status", childAgg.GetInstance().GetStatus(), "ENDED")
	wantEqualStr(t, "child end label", childAgg.GetInstance().GetEndLabel(), "子流程被拒")

	parentAgg, _ = f.svc.GetDetail(ctx, f.meta(starter), parentInst)
	wantEqualStr(t, "parent status", parentAgg.GetInstance().GetStatus(), "ENDED")
	wantEqualStr(t, "parent end label", parentAgg.GetInstance().GetEndLabel(), "已通过")
	wantEqualStr(t, "link status", parentAgg.GetLinks()[0].GetChildStatus(), "ENDED")
}

func wantEqualStr(t *testing.T, label, got, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %q, want %q", label, got, want)
	}
}
