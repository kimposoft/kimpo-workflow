package core_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// ═══ 发起═══

// TestN1_5_StartTaskCreatedAndDone：发起任务即建即完成，发起步骤 PASSED 并记走的引导线，令牌落在下一站。
func TestN1_5_StartTaskCreatedAndDone(t *testing.T) {
	// 本测试只关心状态类发件箱行的顺序，不关心通知——节点级通知默认全开会话本会多插一条
	// NOTIFY 把断言打乱，用 notifyOff 关掉（通知行为本身见 notify_test.go）。
	h := newHarness(t, notifyOff(f1()))
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	st := h.task(agg, 1, "DONE")
	wantEqual(t, "start task kind", st.GetTaskKind(), "START")
	wantEqual(t, "start task action", st.GetActionCode(), "SUBMIT")
	s0 := h.step(agg, "n0", "PASSED")
	wantEqual(t, "start step route", s0.GetRouteLinkId(), "l1")
	wantEqual(t, "start step outcome", s0.GetOutcome(), "SUBMITTED")
	cur := h.current(agg)
	wantEqual(t, "current node", cur.GetNodeId(), "n1")
	wantEqual(t, "current status", cur.GetStatus(), "ACTIVE")
	wantEqual(t, "instance status", agg.GetInstance().GetStatus(), "RUNNING")
	wantEqual(t, "start kind", agg.GetInstance().GetStartKind(), "MANUAL")
	wantEqual(t, "outbox", strings.Join(h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId()), ","), "1/INSTANCE_STARTED,1/STEP_ARRIVED")
}

// TestDV1_StartBindsLatestPublishedVersion：实例绑定发起时的最新版本号与版本 id。
func TestDV1_StartBindsLatestPublishedVersion(t *testing.T) {
	h := newHarness(t, f1())
	v2 := &pb.DefinitionVersionRow{VersionId: "ver-2", DefinitionId: "def-1", VersionNo: 2, Name: "采购申请审批 v2", CompiledJson: h.ver.GetCompiledJson()}
	h.ledger.Versions["def-1"] = append(h.ledger.Versions["def-1"], v2)
	latest, err := h.ledger.GetVersion(h.ctx(), appID, "def-1", 0)
	if err != nil || latest.GetVersionNo() != 2 {
		t.Fatalf("latest = %v err %v", latest, err)
	}
	h.ver = latest
	h.mustStart(starter, core.Choices{})
	inst := h.agg().GetInstance()
	wantEqual(t, "version_no", inst.GetVersionNo(), int64(2))
	wantEqual(t, "version_id", inst.GetVersionId(), "ver-2")
}

// TestDV4_DisabledDefinitionRejectsStart：停用定义不能发起，且不建实例。
func TestDV4_DisabledDefinitionRejectsStart(t *testing.T) {
	h := newHarness(t, f1())
	h.def.StatusCode = "disabled"
	_, err := h.start(starter, core.Choices{})
	wantCode(t, err, "DEFINITION_DISABLED")
	if h.existing() != nil {
		t.Fatalf("instance must not be created")
	}
}

// TestN1_3_ManualStartDisabledRejected：发起节点关闭「允许人工发起」后，人工发起（StartKind
// 为空即按 MANUAL 处理）被拒；非人工发起（子流程 / 动作，StartKindSubflow）不受此限，照常放行——
// 这条开关管的是「谁能从人工入口发起」，不是这条流程本身能不能跑。
func TestN1_3_ManualStartDisabledRejected(t *testing.T) {
	c := f1()
	c.Nodes[0].AllowManualStart = false
	h := newHarness(t, c)

	_, err := h.start(starter, core.Choices{}) // h.start 不传 StartKind，Start() 按空串归 MANUAL
	wantCode(t, err, "DEFINITION_MANUAL_START_DISABLED")
	if h.existing() != nil {
		t.Fatalf("instance must not be created when manual start is disabled")
	}

	d, err := h.eng.Start(h.ctx(), core.StartInput{
		AppID: appID, Definition: h.def, Version: h.ver, Existing: h.existing(),
		Record: record, Actor: starter, StartKind: model.StartKindSubflow,
	})
	if err != nil {
		t.Fatalf("subflow start must be allowed when manual start is disabled: %v", err)
	}
	h.commit(d)
	if h.existing() == nil {
		t.Fatalf("subflow start must create an instance")
	}
}

// TestDV1_NoPublishedVersionRejectsStart：没有已发布版本 → DEFINITION_NOT_PUBLISHED（这条测的是
// 「实例绑定发起时的最新已发布版本」——没有版本可绑就拒绝发起，不是「目标模板未发布」）。
func TestDV1_NoPublishedVersionRejectsStart(t *testing.T) {
	h := newHarness(t, f1())
	h.ver = nil
	_, err := h.start(starter, core.Choices{})
	wantCode(t, err, "DEFINITION_NOT_PUBLISHED")
}

// TestP1_SecondStartOnSameRecordRejected：同一单据只能有一个实例——状态机层拒绝，账本层也兜底。
func TestP1_SecondStartOnSameRecordRejected(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	_, err := h.start(starter, core.Choices{})
	wantCode(t, err, "RECORD_ALREADY_HAS_INSTANCE")
	// 账本兜底：绕过 Existing 直接再建一个实例行。
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.ledger.Commit(h.ctx(), appID, ports.CommitInput{RequestKey: "dup", RequestDigest: "dup-digest", ActorUserID: 1, Changeset: d.Changeset})
	if !errors.Is(err, ports.ErrRecordHasInstance) {
		t.Fatalf("ledger must reject duplicate instance, got %v", err)
	}
}

// TestNoRoute_StartDoesNotCreateInstance：发起零命中 → 不发起、不落库、带节点提示。
func TestNoRoute_StartDoesNotCreateInstance(t *testing.T) {
	h := newHarness(t, f1())
	h.expr.Conditions["p-l1"] = false
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeNoRoute)
	wantEqual(t, "saved", d.Outcome.Saved, false)
	wantEqual(t, "hint", d.Outcome.Hint, "无路可走")
	if d.Changeset != nil || h.existing() != nil || h.ledger.Commits != 0 {
		t.Fatalf("nothing may be written")
	}
}

// TestL12_RouteEvalFailureIsNotSaved：条件求值系统性失败与表达式失效同归 ROUTE_EVAL_FAILED（B9 统一口径）。
func TestL12_RouteEvalFailureIsNotSaved(t *testing.T) {
	h := newHarness(t, f1())
	h.expr.CondErr["p-l1"] = ports.ErrSystem
	_, err := h.start(starter, core.Choices{})
	wantCode(t, err, "ROUTE_EVAL_FAILED")
	h.expr.CondErr["p-l1"] = ports.ErrExpressionInvalid
	_, err = h.start(starter, core.Choices{})
	wantCode(t, err, "ROUTE_EVAL_FAILED")
	if h.existing() != nil {
		t.Fatalf("instance must not be created")
	}
}

// f1WithStartCondition 克隆 f1，给发起节点配一条发起条件（冻结发布物 id 为 p-start-cond）与
// 「不满足发起条件时的提示」，供发起条件一组用例使用；f1 原有的出线 l1（条件 p-l1）不动，用例
// 按需自己摆 p-l1 的真假，不与发起条件这道闸门混在一起判断。
func f1WithStartCondition(hint string) *compile.CompiledDefinition {
	c := f1()
	c.Nodes[0].StartConditionPubID = "p-start-cond"
	c.Nodes[0].StartConditionDocJSON = `{"mode":"condition"}`
	c.Nodes[0].StartConditionHint = hint
	return c
}

// TestN1_7_ConditionTrueAllowsStart：发起条件为真，人工 / 动作 / 子流程三种发起都放行（子流程
// 发起本就不求值发起条件）、正常建实例（出线 p-l1 也摆真，只验条件闸门本身，不与无路可走
// 混在一起判断）。
func TestN1_7_ConditionTrueAllowsStart(t *testing.T) {
	for _, kind := range []model.StartKind{model.StartKindManual, model.StartKindAction, model.StartKindSubflow} {
		h := newHarness(t, f1WithStartCondition("金额超限，不能发起"))
		h.expr.Conditions["p-start-cond"] = true
		h.expr.Conditions["p-l1"] = true
		d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Existing: h.existing(), Record: record, Actor: starter, StartKind: kind})
		if err != nil {
			t.Fatalf("%s: start: %v", kind, err)
		}
		h.commit(d)
		if h.existing() == nil {
			t.Fatalf("%s: 条件为真必须建实例", kind)
		}
	}
}

// TestN1_7_ConditionFalseBlocksStart：发起条件为假 → 与无路可走同一口径回传（Outcome.Kind=NO_ROUTE，
// Hint 是设计者写的「不满足发起条件时的提示」，不含表达式原文），不建实例、不落库；人工 / 动作
// 两种发起一视同仁（子流程发起不受发起条件限制，见下一条用例）；条件闸门先于出线
// 求路（p-l1 从未被求值，断言 h.expr.Calls 佐证）。
func TestN1_7_ConditionFalseBlocksStart(t *testing.T) {
	for _, kind := range []model.StartKind{model.StartKindManual, model.StartKindAction} {
		h := newHarness(t, f1WithStartCondition("金额超限，不能发起"))
		h.expr.Conditions["p-start-cond"] = false
		d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Existing: h.existing(), Record: record, Actor: starter, StartKind: kind})
		if err != nil {
			t.Fatalf("%s: start: %v", kind, err)
		}
		wantKind(t, d, core.OutcomeNoRoute)
		wantEqual(t, string(kind)+" saved", d.Outcome.Saved, false)
		wantEqual(t, string(kind)+" hint", d.Outcome.Hint, "金额超限，不能发起")
		if strings.Contains(d.Outcome.Hint, "mode") || strings.Contains(d.Outcome.Hint, "condition") {
			t.Fatalf("%s: hint 不得包含表达式原文，实得 %q", kind, d.Outcome.Hint)
		}
		h.commit(d)
		if d.Changeset != nil || h.existing() != nil {
			t.Fatalf("%s: 条件为假不得建实例/落库", kind)
		}
		for _, c := range h.expr.Calls {
			if c == "p-l1" {
				t.Fatalf("%s: 发起条件不满足时不该再对出线求值", kind)
			}
		}
	}
}

// TestN1_7_SubflowStartSkipsCondition：子流程发起不受目标流程发起条件限制——条件为假照常建实例；条件求值报错也不影响（发起条件根本不被求值，h.expr.Calls 佐证）。
func TestN1_7_SubflowStartSkipsCondition(t *testing.T) {
	h := newHarness(t, f1WithStartCondition("金额超限，不能发起"))
	h.expr.Conditions["p-start-cond"] = false
	h.expr.CondErr["p-start-cond"] = ports.ErrSystem
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Existing: h.existing(), Record: record, Actor: starter, StartKind: model.StartKindSubflow})
	if err != nil {
		t.Fatalf("subflow start: %v", err)
	}
	wantKind(t, d, core.OutcomeCommitted)
	h.commit(d)
	if h.existing() == nil || h.existing().GetInstance().GetStartKind() != string(model.StartKindSubflow) {
		t.Fatalf("subflow start must create the instance regardless of the start condition")
	}
	for _, c := range h.expr.Calls {
		if c == "p-start-cond" {
			t.Fatalf("start condition must not even be evaluated for a subflow start")
		}
	}
}

// TestN1_7_EvalErrorIsNotTreatedAsUnmet：发起条件求值本身报错（系统性失败 / 表达式失效）不按
// 「不满足」处理（同 L12 引导线条件求值报错口径）：提交失败并复用 ROUTE_EVAL_FAILED，不建实例。
func TestN1_7_EvalErrorIsNotTreatedAsUnmet(t *testing.T) {
	h := newHarness(t, f1WithStartCondition("金额超限，不能发起"))
	h.expr.CondErr["p-start-cond"] = ports.ErrSystem
	_, err := h.start(starter, core.Choices{})
	wantCode(t, err, "ROUTE_EVAL_FAILED")
	h.expr.CondErr["p-start-cond"] = ports.ErrExpressionInvalid
	_, err = h.start(starter, core.Choices{})
	wantCode(t, err, "ROUTE_EVAL_FAILED")
	if h.existing() != nil {
		t.Fatalf("instance must not be created")
	}
}

// TestN1_7_NoConditionAllowsStart：没配发起条件（PubID 与 DocJSON 都空）直接放行，不求值任何
// 发起条件相关的发布物——与既有 f1 夹具（没配 StartCondition）跑通即是最直接的证据，本用例只
// 再显式断言一次 h.expr.Calls 里不含 p-start-cond，避免以后误把「没配」也当一条要求值的槽位。
func TestN1_7_NoConditionAllowsStart(t *testing.T) {
	h := newHarness(t, f1())
	h.expr.Conditions["p-l1"] = true
	h.mustStart(starter, core.Choices{})
	if h.existing() == nil {
		t.Fatalf("没配发起条件应正常建实例")
	}
	for _, c := range h.expr.Calls {
		if c == "p-start-cond" {
			t.Fatalf("没配发起条件不该求值任何发起条件槽位")
		}
	}
}

// ═══ 候选（C）═══

// TestC1_ArrivalResolvesCandidatesBeforeDispatch：每次到达都算一次候选，并把前手交给解析器。
func TestC1_ArrivalResolvesCandidatesBeforeDispatch(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	wantEqual(t, "candidate calls after start", h.cand.Calls, 1)
	wantEqual(t, "prev handler", len(h.cand.LastPrev) == 1 && h.cand.LastPrev[0] == 1, true)
	h.mustSubmit(wangFang, core.Choices{})
	wantEqual(t, "candidate calls after submit", h.cand.Calls, 2)
	wantEqual(t, "prev handler", h.cand.LastPrev[0], int64(22))
}

// TestC2_SingleCandidateDispatchedWithoutChoice：唯一候选直接派发，不弹选人。
func TestC2_SingleCandidateDispatchedWithoutChoice(t *testing.T) {
	h := newHarness(t, f1())
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	task := h.task(agg, 22, "PENDING")
	wantEqual(t, "task kind", task.GetTaskKind(), "HANDLE")
	wantEqual(t, "assignee_count", h.current(agg).GetAssigneeCount(), int32(1))
}

// TestC3_MultipleCandidatesRequireSelection：多候选无选择 → AssigneeChoiceRequired 且不落库；选择后按选择派发。
func TestC3_MultipleCandidatesRequireSelection(t *testing.T) {
	c := f1()
	c.Nodes[1].StaticUserIDs = []int64{22, 33, 44}
	h := newHarness(t, c)
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeAssigneeChoiceRequired)
	wantEqual(t, "node", d.Outcome.NodeID, "n1")
	wantEqual(t, "via link", d.Outcome.ViaLinkID, "l1")
	wantEqual(t, "candidates", len(d.Outcome.Candidates), 3)
	if d.Changeset != nil || h.existing() != nil {
		t.Fatalf("choice required must not write")
	}
	d = h.mustStart(starter, core.Choices{SelectedAssignees: []int64{33, 44}})
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	h.task(agg, 33, "PENDING")
	h.task(agg, 44, "PENDING")
	wantEqual(t, "assignee_count", h.current(agg).GetAssigneeCount(), int32(2))
	for _, tk := range agg.GetTasks() {
		if tk.GetAssigneeUserId() == 22 {
			t.Fatalf("unselected candidate must not get a task")
		}
	}
}

// TestC3_SelectionOutsideCandidatesRejected：选人不在候选集内 → INVALID_CHOICE。
func TestC3_SelectionOutsideCandidatesRejected(t *testing.T) {
	c := f1()
	c.Nodes[1].StaticUserIDs = []int64{22, 33}
	h := newHarness(t, c)
	_, err := h.start(starter, core.Choices{SelectedAssignees: []int64{99}})
	wantCode(t, err, "INVALID_CHOICE")
}

// TestC4_StartWithNoCandidateKeepsInstanceAndSavesStartTask：发起到达零候选 → 实例仍建、发起步骤留在原站、发起任务转暂存；
// 候选补齐后可再提交。
func TestC4_StartWithNoCandidateKeepsInstanceAndSavesStartTask(t *testing.T) {
	c := f1()
	c.Nodes[1].StaticUserIDs = nil
	h := newHarness(t, c)
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeNoCandidate)
	wantEqual(t, "saved", d.Outcome.Saved, true)
	agg := h.agg()
	wantEqual(t, "instance status", agg.GetInstance().GetStatus(), "RUNNING")
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n0")
	st := h.task(agg, 1, "SAVED")
	wantEqual(t, "start task kind", st.GetTaskKind(), "START")
	wantEqual(t, "outbox", strings.Join(h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId()), ","), "1/INSTANCE_STARTED,1/TASK_SAVED")
	// 候选补齐（模拟人员来源变化）后再提交发起任务。
	h.cand.Force, h.cand.Forced = true, []ports.Person{{UserID: 22}}
	d = h.mustSubmit(starter, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	agg = h.agg()
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n1")
	h.task(agg, 22, "PENDING")
	h.task(agg, 1, "DONE")
}

// TestC4_SubmitWithNoCandidateSavesSubmitterTask：中途到达零候选 → 提交人任务转暂存，令牌不动。
func TestC4_SubmitWithNoCandidateSavesSubmitterTask(t *testing.T) {
	c := f2()
	c.Nodes[3].StaticUserIDs = nil // 财务复核无人
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeNoCandidate)
	wantEqual(t, "saved", d.Outcome.Saved, true)
	wantEqual(t, "node", d.Outcome.NodeID, "n3")
	agg := h.agg()
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n1")
	wantEqual(t, "step still active", h.current(agg).GetStatus(), "ACTIVE")
	h.task(agg, 22, "SAVED")
	wantEqual(t, "passed_count untouched", h.current(agg).GetPassedCount(), int32(0))
}

// ═══ 选路（L）═══

// TestL2_ExactlyOneHitTakenDirectly：多条主线出线里恰好一条条件成立，直接走它，不弹选路对话框
// （L2：恰一条成立就直接走，不是「零一或全部都要过对话框」）。
func TestL2_ExactlyOneHitTakenDirectly(t *testing.T) {
	h := newTwoWay(t)
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = false, true
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "route taken directly", h.step(h.agg(), "n1", "PASSED").GetRouteLinkId(), "l3")
	wantEqual(t, "no dialog fields on a direct commit", d.Outcome.FromNodeID == "" && len(d.Outcome.Routes) == 0, true)
}

// TestRouteChoice_MultipleHitsThenChoiceCommits：多条出线同时命中先弹选路对话框（不落库、不改任何
// 行），带上选择重新提交后正常落库、走所选的那条线（L3 + L5 串联）。
func TestRouteChoice_MultipleHitsThenChoiceCommits(t *testing.T) {
	h := newTwoWay(t)
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = true, true
	h.mustStart(starter, core.Choices{})
	before := h.agg().GetInstance().GetVersion()
	d, err := h.submit(wangFang, core.Choices{})
	if err != nil {
		t.Fatal(err)
	}
	wantKind(t, d, core.OutcomeRouteChoiceRequired)
	if d.Changeset != nil || h.agg().GetInstance().GetVersion() != before {
		t.Fatalf("choice required must not write")
	}
	d = h.mustSubmit(wangFang, core.Choices{RouteLinkID: "l2"})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "route taken", h.step(h.agg(), "n1", "PASSED").GetRouteLinkId(), "l2")
	wantEqual(t, "end label", d.Outcome.EndLabel, "已通过")
}

// TestL2_UnconditionalLinkAlwaysHits：无条件引导线恒成立，无需求值。
func TestL2_UnconditionalLinkAlwaysHits(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	calls := len(h.expr.Calls)
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "no extra evaluation", len(h.expr.Calls), calls)
	wantEqual(t, "ended", h.agg().GetInstance().GetStatus(), "ENDED")
}

// twoWayCompiled 部门审批后两条出线：l2 → 结束「已通过」（p-l2），l3 → 结束「已否决」（p-l3）。
func twoWayCompiled(t *testing.T) *compile.CompiledDefinition {
	t.Helper()
	c := f1()
	c.Nodes = append(c.Nodes, compile.NodeCompiled{NodeID: "n3", NodeKind: "END", NodeName: "结束", EndLabel: "已否决"})
	c.Links[1].ConditionPublicationID, c.Links[1].ConditionDocumentJSON = "p-l2", `{"mode":"condition"}`
	c.Links = append(c.Links, compile.LinkCompiled{LinkID: "l3", FromNodeID: "n1", ToNodeID: "n3", IsMain: true, ConditionPublicationID: "p-l3", ConditionDocumentJSON: `{"mode":"condition"}`})
	return c
}

// newTwoWay 部门审批后两条出线：l2 → 结束「已通过」（p-l2），l3 → 结束「已否决」（p-l3）。
func newTwoWay(t *testing.T) *harness {
	t.Helper()
	return newHarness(t, twoWayCompiled(t))
}

// TestL1_MultipleOutLinksEvaluatedIndependently：每条出线独立求值，只有一条成立就直接走。
func TestL1_MultipleOutLinksEvaluatedIndependently(t *testing.T) {
	h := newTwoWay(t)
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = false, true
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "end label", d.Outcome.EndLabel, "已否决")
	wantEqual(t, "route", h.step(h.agg(), "n1", "PASSED").GetRouteLinkId(), "l3")
	wantEqual(t, "both evaluated", strings.Join(h.expr.Calls[1:], ","), "p-l2,p-l3")
}

// TestL3_RouteChoiceRequiredCommitsNothing：多条成立无选择 → 选路对话框，账本不动。
func TestL3_RouteChoiceRequiredCommitsNothing(t *testing.T) {
	h := newTwoWay(t)
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = true, true
	h.mustStart(starter, core.Choices{})
	before := h.agg().GetInstance().GetVersion()
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeRouteChoiceRequired)
	wantEqual(t, "from node", d.Outcome.FromNodeID, "n1")
	wantEqual(t, "routes", len(d.Outcome.Routes), 2)
	wantEqual(t, "route names", d.Outcome.Routes[0].ToNodeName+"/"+d.Outcome.Routes[1].ToNodeName, "结束/结束")
	if d.Changeset != nil {
		t.Fatalf("choice required must not write")
	}
	agg := h.agg()
	wantEqual(t, "version unchanged", agg.GetInstance().GetVersion(), before)
	h.task(agg, 22, "PENDING")
}

// TestL5_RouteChooserIsPassTrigger：带 route_choice 再提交，走所选线并过关。
func TestL5_RouteChooserIsPassTrigger(t *testing.T) {
	h := newTwoWay(t)
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = true, true
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{RouteLinkID: "l3"})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "end label", d.Outcome.EndLabel, "已否决")
	wantEqual(t, "route", h.step(h.agg(), "n1", "PASSED").GetRouteLinkId(), "l3")
}

// TestL3_RouteChoiceOutsideHitsRejected：所选线不在命中集内 → INVALID_CHOICE。
func TestL3_RouteChoiceOutsideHitsRejected(t *testing.T) {
	h := newTwoWay(t)
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = true, true
	h.mustStart(starter, core.Choices{})
	_, err := h.submit(wangFang, core.Choices{RouteLinkID: "l9"})
	wantCode(t, err, "INVALID_CHOICE")
}

// TestL4_NoRouteOnSubmitSavesTask：中途零命中 → 提交人任务转暂存，带节点提示。
func TestL4_NoRouteOnSubmitSavesTask(t *testing.T) {
	// 只关心暂存那一行的下标，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(twoWayCompiled(t)))
	h.expr.Conditions["p-l2"], h.expr.Conditions["p-l3"] = false, false
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeNoRoute)
	wantEqual(t, "saved", d.Outcome.Saved, true)
	wantEqual(t, "hint", d.Outcome.Hint, "审批后没有可走的路线")
	agg := h.agg()
	h.task(agg, 22, "SAVED")
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n1")
	wantEqual(t, "outbox tail", h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId())[2], "2/TASK_SAVED")
}

// ═══ 办理（N2 / D）═══

// TestN2_1_ArrivalDispatchesTaskPerAssignee：到达时每个办理人一条待办；任一人提交即过关，其余待办撤销。
func TestN2_1_ArrivalDispatchesTaskPerAssignee(t *testing.T) {
	c := f2()
	c.Nodes[1].StaticUserIDs = []int64{22, 33}
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 33}})
	agg := h.agg()
	h.task(agg, 22, "PENDING")
	h.task(agg, 33, "PENDING")
	d := h.mustSubmit(liSi, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	agg = h.agg()
	wantEqual(t, "n1 passed", h.step(agg, "n1", "").GetStatus(), "PASSED")
	wantEqual(t, "passed_count", h.step(agg, "n1", "").GetPassedCount(), int32(1))
	other := h.task(agg, 22, "WITHDRAWN")
	wantEqual(t, "withdraw reason", other.GetWithdrawReason(), "STEP_PASSED")
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n3")
	wantEqual(t, "entered_by", h.current(agg).GetEnteredByUserId(), int64(33))
}

// TestN2_2_SubmitPassesStepAndRoutes：提交 = 任务完成 + 步骤过关 + 选路到达；发件箱顺序 STEP_PASSED → STEP_ARRIVED。
func TestN2_2_SubmitPassesStepAndRoutes(t *testing.T) {
	// 只关心状态类发件箱行顺序，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f2()))
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	done := h.task(agg, 22, "DONE")
	wantEqual(t, "action", done.GetActionCode(), "SUBMIT")
	wantEqual(t, "entered_from", h.current(agg).GetEnteredFromStepId(), h.step(agg, "n1", "PASSED").GetStepId())
	wantEqual(t, "outbox", strings.Join(h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId()), ","), "1/INSTANCE_STARTED,1/STEP_ARRIVED,2/STEP_PASSED,2/STEP_ARRIVED")
}

// TestN2_4_SaveKeepsTokenInPlace：暂存只改任务状态，令牌与步骤不动；暂存后仍可提交。
func TestN2_4_SaveKeepsTokenInPlace(t *testing.T) {
	// 只关心暂存那一行的下标，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f1()))
	h.mustStart(starter, core.Choices{})
	d, err := h.save(wangFang)
	if err != nil {
		t.Fatal(err)
	}
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	h.task(agg, 22, "SAVED")
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n1")
	wantEqual(t, "version", agg.GetInstance().GetVersion(), int64(2))
	wantEqual(t, "outbox tail", h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId())[2], "2/TASK_SAVED")
	h.mustSubmit(wangFang, core.Choices{})
	wantEqual(t, "ended", h.agg().GetInstance().GetStatus(), "ENDED")
}

// TestTaskPermission_NotOwnedNotActionable：非本人 / 非待办 / 已结束 三类拒绝。
func TestTaskPermission_NotOwnedNotActionable(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	task := h.task(agg, 22, "PENDING")
	_, err := h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: liSi})
	wantCode(t, err, "TASK_NOT_OWNED")
	startTask := h.task(agg, 1, "DONE")
	_, err = h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: startTask.GetTaskId(), Actor: starter})
	wantCode(t, err, "TASK_NOT_ACTIONABLE")
	_, err = h.eng.Save(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: "nope", Actor: starter})
	wantCode(t, err, "NOT_FOUND")
	h.mustSubmit(wangFang, core.Choices{})
	agg = h.agg()
	_, err = h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: wangFang})
	wantCode(t, err, "INSTANCE_ENDED")
}

// ═══ 结束═══

// TestN5_1_EndWritesLabelBeforeEnding：到达结束节点先写结束标识再结束；写成功则实例 ENDED、带标识。
func TestN5_1_EndWritesLabelBeforeEnding(t *testing.T) {
	// 只关心两段式提交的状态行顺序，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f1()))
	h.mustStart(starter, core.Choices{})
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "outcome end label", d.Outcome.EndLabel, "已通过")
	wantEqual(t, "writes", len(h.rec.Writes), 1)
	wantEqual(t, "write field", h.rec.Writes[0].FieldID+"="+h.rec.Writes[0].TextValue, "f-status=已通过")
	agg := h.agg()
	inst := agg.GetInstance()
	wantEqual(t, "status", inst.GetStatus(), "ENDED")
	wantEqual(t, "end label", inst.GetEndLabel(), "已通过")
	wantEqual(t, "end node", inst.GetEndNodeId(), "n2")
	wantEqual(t, "current cleared", inst.GetCurrentStepId(), "")
	if inst.GetEndedAt() == nil {
		t.Fatalf("ended_at must be set")
	}
	end := h.step(agg, "n2", "PASSED")
	wantEqual(t, "end step outcome", end.GetOutcome(), "ENDED")
	// 两段式：第一段停驻（版本 2）→ 写字段 → 第二段恢复 + 结束（版本 3）。
	wantEqual(t, "outbox", strings.Join(h.ledger.OutboxKinds(inst.GetWorkflowInstanceId()), ","), "1/INSTANCE_STARTED,1/STEP_ARRIVED,2/STEP_PASSED,2/INSTANCE_PARKED,3/INSTANCE_RESUMED,3/INSTANCE_ENDED")
	inc := agg.GetIncidents()[0]
	wantEqual(t, "pending incident resolved", inc.GetStatus(), "RESOLVED")
	wantEqual(t, "pending incident kind", inc.GetKind(), "END_WRITE_PENDING")
}

// TestN5_1_EndWithoutTargetFieldSkipsWrite：结束节点没配写入字段 → 不写表单直接结束。
func TestN5_1_EndWithoutTargetFieldSkipsWrite(t *testing.T) {
	c := f1()
	c.Nodes[2].EndLabelFieldID = ""
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	d, err := h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: h.agg(), TaskID: h.task(h.agg(), 22, "PENDING").GetTaskId(), Actor: wangFang})
	if err != nil {
		t.Fatal(err)
	}
	if d.PendingEndWrite != nil {
		t.Fatalf("no end write expected")
	}
	h.commit(d)
	wantEqual(t, "writes", len(h.rec.Writes), 0)
	wantEqual(t, "ended", h.agg().GetInstance().GetStatus(), "ENDED")
}

// TestN5_2_EndedOutboxCarriesEndLabel：INSTANCE_ENDED 载荷带结束标识与 flow_status=ENDED（P2 投影快照）。
func TestN5_2_EndedOutboxCarriesEndLabel(t *testing.T) {
	// 断言的是「最后一条发件箱行」，通知开关全关避免 NOTIFY 排在 INSTANCE_ENDED 后面把它顶掉
	// （理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f1()))
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	last := h.ledger.Outbox[len(h.ledger.Outbox)-1]
	wantEqual(t, "kind", last.GetKind(), "INSTANCE_ENDED")
	var payload map[string]any
	if err := json.Unmarshal([]byte(last.GetPayloadJson()), &payload); err != nil {
		t.Fatal(err)
	}
	wantEqual(t, "end_label", payload["end_label"], "已通过")
	wantEqual(t, "flow_status", payload["flow_status"], "ENDED")
	wantEqual(t, "current_node_id", payload["current_node_id"], "")
}

// TestM3_EndLabelWriteFailureParksInstance：写结束标识失败 → 实例停驻、事故 OPEN、结束步骤回 ACTIVE 持有令牌，
// 对外 flow_status 仍是 RUNNING；停驻期间任务动作与撤销都被拒绝。
func TestM3_EndLabelWriteFailureParksInstance(t *testing.T) {
	// 只关心两段式提交的状态行顺序，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f1()))
	h.mustStart(starter, core.Choices{})
	h.rec.WriteErr = errors.New("aria unavailable")
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeParked)
	agg := h.agg()
	inst := agg.GetInstance()
	wantEqual(t, "status", inst.GetStatus(), "PARKED")
	wantEqual(t, "end label not set", inst.GetEndLabel(), "")
	wantEqual(t, "parked incident", inst.GetParkedIncidentId(), d.Outcome.IncidentID)
	wantEqual(t, "current = end step", h.current(agg).GetNodeId(), "n2")
	wantEqual(t, "end step active", h.current(agg).GetStatus(), "ACTIVE")
	wantEqual(t, "incidents", len(agg.GetIncidents()), 1)
	inc := agg.GetIncidents()[0]
	wantEqual(t, "incident kind", inc.GetKind(), "WRITE_FIELD_FAILED")
	wantEqual(t, "incident status", inc.GetStatus(), "OPEN")
	wantEqual(t, "attempts", inc.GetAttempts(), int32(1))
	// 两段式：版本 2 停驻占位（END_WRITE_PENDING），写失败后版本 3 改判 WRITE_FIELD_FAILED 仍停驻。
	wantEqual(t, "outbox", strings.Join(h.ledger.OutboxKinds(inst.GetWorkflowInstanceId()), ","), "1/INSTANCE_STARTED,1/STEP_ARRIVED,2/STEP_PASSED,2/INSTANCE_PARKED,3/INSTANCE_PARKED")
	var payload map[string]any
	_ = json.Unmarshal([]byte(h.ledger.Outbox[len(h.ledger.Outbox)-1].GetPayloadJson()), &payload)
	wantEqual(t, "external flow_status", payload["flow_status"], "RUNNING")
	wantEqual(t, "parked flag", payload["parked"], true)
	// 停驻期间：撤销与任务动作都拒绝。
	_, err := h.eng.Withdraw(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "DONE").GetTaskId(), Actor: wangFang})
	wantCode(t, err, "INSTANCE_PARKED")
	_, err = h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "DONE").GetTaskId(), Actor: wangFang})
	wantCode(t, err, "INSTANCE_PARKED")
}

// TestM3_ResumeIncidentContinuesFromParkPoint：恢复时再写一次；仍失败 attempts+1 保持停驻，成功则事故 RESOLVED、实例 ENDED。
func TestM3_ResumeIncidentContinuesFromParkPoint(t *testing.T) {
	// 只关心事故恢复两段的状态行顺序，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f1()))
	h.mustStart(starter, core.Choices{})
	h.rec.WriteErr = errors.New("aria unavailable")
	d := h.mustSubmit(wangFang, core.Choices{})
	incID := d.Outcome.IncidentID
	admin := ports.Actor{UserID: 9, DisplayName: "管理员", SuperAdmin: true}

	// 第一次恢复：写仍失败 → ParkAgain。
	agg := h.agg()
	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: agg, IncidentID: incID, Actor: admin, Note: "重试"})
	if err != nil {
		t.Fatal(err)
	}
	if rd.PendingEndWrite == nil || rd.PendingEndWrite.FieldID != "f-status" {
		t.Fatalf("resume must carry the end write: %+v", rd.PendingEndWrite)
	}
	if werr := h.rec.WriteFields(h.ctx(), record, nil, "", admin, "k"); werr != nil {
		rd = h.eng.ParkAgain(agg, incID, werr)
	}
	key := h.nextKey()
	if _, err := h.ledger.Commit(h.ctx(), appID, ports.CommitInput{RequestKey: key, RequestDigest: "digest:" + key, ActorUserID: 1, Changeset: rd.Changeset}); err != nil {
		t.Fatal(err)
	}
	agg = h.agg()
	wantEqual(t, "still parked", agg.GetInstance().GetStatus(), "PARKED")
	wantEqual(t, "attempts", agg.GetIncidents()[0].GetAttempts(), int32(2))

	// 第二次恢复：写成功 → ENDED。
	h.rec.WriteErr = nil
	rd, err = h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: agg, IncidentID: incID, Actor: admin, Note: "已修"})
	if err != nil {
		t.Fatal(err)
	}
	rd = h.commit(rd)
	wantKind(t, rd, core.OutcomeCommitted)
	wantEqual(t, "resume writes", len(h.rec.Writes), 1)
	agg = h.agg()
	inst := agg.GetInstance()
	wantEqual(t, "ended", inst.GetStatus(), "ENDED")
	wantEqual(t, "end label", inst.GetEndLabel(), "已通过")
	wantEqual(t, "parked cleared", inst.GetParkedIncidentId(), "")
	inc := agg.GetIncidents()[0]
	wantEqual(t, "resolved", inc.GetStatus(), "RESOLVED")
	wantEqual(t, "resolved by", inc.GetResolvedByUserId(), int64(9))
	wantEqual(t, "note", inc.GetResolutionNote(), "已修")
	wantEqual(t, "end step passed", h.step(agg, "n2", "").GetStatus(), "PASSED")
	kinds := h.ledger.OutboxKinds(inst.GetWorkflowInstanceId())
	// 版本 5 而不是 6：原先夹具多算了一版，是因为 harness 对「恢复」这一段决策又跑了一遍两段式
	// （再停驻一次再恢复一次），凭空多出一次提交，也在账本里多留了一条事故——正是那条多出来的
	// 事故让 GetIncidents()[0] 变成抛硬币。harness 已按生产路径改为不重入。
	wantEqual(t, "outbox tail", strings.Join(kinds[len(kinds)-2:], ","), "5/INSTANCE_RESUMED,5/INSTANCE_ENDED")
	// 已结束后不能再恢复（B1 附带项：按实例语义报 INSTANCE_ENDED）。
	_, err = h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: agg, IncidentID: incID, Actor: admin})
	wantCode(t, err, "INSTANCE_ENDED")
}

// TestB1_EndWriteTwoPhaseBlocksConcurrentActions：第一段提交后（结束标识尚未写），并发的办理动作被
// INSTANCE_PARKED 挡住——这正是两段式要堵的口子（写完字段再冲突不可能发生）。
func TestB1_EndWriteTwoPhaseBlocksConcurrentActions(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	d, err := h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "PENDING").GetTaskId(), Actor: wangFang})
	if err != nil || d.PendingEndWrite == nil {
		t.Fatalf("submit: %+v err %v", d, err)
	}
	pre := h.eng.PrepareEndWrite(d)
	wantKind(t, pre, core.OutcomeParked)
	if pre.PendingEndWrite == nil {
		t.Fatalf("PrepareEndWrite must keep PendingEndWrite for the caller")
	}
	h.rawCommit(pre.Changeset)
	wantEqual(t, "no write yet", len(h.rec.Writes), 0)
	agg = h.agg()
	wantEqual(t, "parked", agg.GetInstance().GetStatus(), "PARKED")
	wantEqual(t, "pending kind", agg.GetIncidents()[0].GetKind(), "END_WRITE_PENDING")
	wantEqual(t, "attempts", agg.GetIncidents()[0].GetAttempts(), int32(0))
	// 并发者拿着旧聚合重试提交 → 旧版本 CAS 必冲突；拿新聚合 → INSTANCE_PARKED。
	_, err = h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "DONE").GetTaskId(), Actor: wangFang})
	wantCode(t, err, "INSTANCE_PARKED")
	// 错误的事故 id 不能恢复。
	_, err = h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: agg, IncidentID: "inc-nope", Actor: starter})
	wantCode(t, err, "NOT_FOUND")
}

// TestT1_NotifyOutboxRows：默认（节点没配 notify）时到达 / 撤销 / 结束各追加 NOTIFY；节点级
// 显式关闭某个开关时不追加（开关配在节点级，f2()/f1() 夹具的节点本就
// 没配 notify，天然落在「默认全开 + 仅 system」这条路径，不需要再显式赋 Document.Notify——
// 那份流程级设置已经不被 engine/core 读取，赋值也不影响这里任何一条断言）。
func TestT1_NotifyOutboxRows(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	inst := h.agg().GetInstance()
	kinds := h.ledger.OutboxKinds(inst.GetWorkflowInstanceId())
	wantEqual(t, "arrive notify", strings.Join(kinds, ","), "1/INSTANCE_STARTED,1/STEP_ARRIVED,1/NOTIFY")
	var p map[string]any
	_ = json.Unmarshal([]byte(h.ledger.Outbox[len(h.ledger.Outbox)-1].GetPayloadJson()), &p)
	wantEqual(t, "event", p["event"], "TASK_ASSIGNED")
	wantEqual(t, "recipients", fmt.Sprint(p["recipient_user_ids"]), "[22]")
	if p["task_id"] == "" || p["workflow_instance_id"] != inst.GetWorkflowInstanceId() {
		t.Fatalf("payload = %v", p)
	}
	h.mustSubmit(wangFang, core.Choices{})          // 王芳 → 李四到达：NOTIFY(TASK_ASSIGNED 33)
	if _, err := h.withdraw(wangFang); err != nil { // 王芳撤销：李四待办被撤 → NOTIFY(TASK_WITHDRAWN 33)
		t.Fatal(err)
	}
	kinds = h.ledger.OutboxKinds(inst.GetWorkflowInstanceId())
	wantEqual(t, "withdraw notify", strings.Join(kinds[len(kinds)-2:], ","), "3/STEP_WITHDRAWN,3/NOTIFY")
	_ = json.Unmarshal([]byte(h.ledger.Outbox[len(h.ledger.Outbox)-1].GetPayloadJson()), &p)
	wantEqual(t, "withdraw event", p["event"], "TASK_WITHDRAWN")
	wantEqual(t, "withdraw recipients", fmt.Sprint(p["recipient_user_ids"]), "[33]")
	h.mustSubmit(wangFang, core.Choices{})
	h.mustSubmit(liSi, core.Choices{}) // 李四 → 结束（配了写入字段 → 两段式，结束通知在第二段）
	kinds = h.ledger.OutboxKinds(inst.GetWorkflowInstanceId())
	wantEqual(t, "end notify", strings.Join(kinds[len(kinds)-3:], ","), "6/INSTANCE_RESUMED,6/INSTANCE_ENDED,6/NOTIFY")
	_ = json.Unmarshal([]byte(h.ledger.Outbox[len(h.ledger.Outbox)-1].GetPayloadJson()), &p)
	wantEqual(t, "end event", p["event"], "INSTANCE_ENDED")
	wantEqual(t, "end recipients", fmt.Sprint(p["recipient_user_ids"]), "[1]")
	for _, o := range h.ledger.Outbox {
		if o.GetKind() == "NOTIFY" {
			continue
		}
		if strings.Contains(o.GetPayloadJson(), "TASK_ASSIGNED") {
			t.Fatalf("state rows must not carry notify payload: %s", o.GetPayloadJson())
		}
	}
	// 停驻第一段不得带「流程结束」通知。
	h2 := newHarness(t, f1())
	h2.mustStart(starter, core.Choices{})
	agg := h2.agg()
	d, _ := h2.eng.Submit(h2.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h2.task(agg, 22, "PENDING").GetTaskId(), Actor: wangFang})
	pre := h2.eng.PrepareEndWrite(d)
	for _, o := range pre.Changeset.GetOutboxAppends() {
		if strings.Contains(o.GetPayloadJson(), "INSTANCE_ENDED") && o.GetKind() == "NOTIFY" {
			t.Fatalf("parked changeset must not notify ended")
		}
	}
	// 节点级开关全关：一条 NOTIFY 都没有（「关闭」配在节点上，不是流程级 Document.Notify 清零，
	// 用 notifyOff 夹具覆盖发起/办理/结束三类节点）。
	h3 := newHarness(t, notifyOff(f2()))
	h3.mustStart(starter, core.Choices{})
	h3.mustSubmit(wangFang, core.Choices{})
	for _, k := range h3.ledger.OutboxKinds(h3.agg().GetInstance().GetWorkflowInstanceId()) {
		if strings.HasSuffix(k, "/NOTIFY") {
			t.Fatalf("notify off but got %s", k)
		}
	}
}

// TestG2_TaskFlags：GetDetail 派生标志与 Withdraw 同口径——可撤 / 下一站被动过 / 下一站是结束 / 已结束 / 未办。
func TestG2_TaskFlags(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	flags := core.TaskFlags(agg)
	byID := map[string]core.TaskFlag{}
	for _, f := range flags {
		byID[f.TaskID] = f
	}
	startTask := h.task(agg, 1, "DONE")
	wantEqual(t, "start withdrawable", byID[startTask.GetTaskId()].Withdrawable, true)
	pending := h.task(agg, 22, "PENDING")
	wantEqual(t, "pending reason", byID[pending.GetTaskId()].ReasonCode, "TASK_NOT_DONE")
	// 王芳暂存 → 发起任务不可撤（NEXT_TOUCHED）。
	if _, err := h.save(wangFang); err != nil {
		t.Fatal(err)
	}
	agg = h.agg()
	flags = core.TaskFlags(agg)
	for _, f := range flags {
		if f.TaskID == startTask.GetTaskId() {
			wantEqual(t, "touched", f.ReasonCode, "NEXT_TOUCHED")
			wantEqual(t, "touched not withdrawable", f.Withdrawable, false)
		}
	}
	// 王芳提交 → 李四站；王芳可撤，发起人不可撤（NOT_NEXT）。
	h.mustSubmit(wangFang, core.Choices{})
	agg = h.agg()
	for _, f := range core.TaskFlags(agg) {
		switch f.TaskID {
		case startTask.GetTaskId():
			wantEqual(t, "starter not next", f.ReasonCode, "NOT_NEXT")
		case h.task(agg, 22, "DONE").GetTaskId():
			wantEqual(t, "wangfang withdrawable", f.Withdrawable, true)
		}
	}
	// 李四提交 → 结束：全部 INSTANCE_ENDED。
	h.mustSubmit(liSi, core.Choices{})
	for _, f := range core.TaskFlags(h.agg()) {
		wantEqual(t, "ended "+f.TaskID, f.ReasonCode, "INSTANCE_ENDED")
	}
}

// TestC3_SelectionDedupedAndSingleCandidateChecked：选人去重只生成一条待办；单候选时带了不是候选的选择 → INVALID_CHOICE。
func TestC3_SelectionDedupedAndSingleCandidateChecked(t *testing.T) {
	c := f1()
	c.Nodes[1].StaticUserIDs = []int64{22, 33}
	h := newHarness(t, c)
	d := h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 22, 33, 22}})
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	n := 0
	for _, t := range agg.GetTasks() {
		if t.GetStatus() == "PENDING" {
			n++
		}
	}
	wantEqual(t, "pending tasks", n, 2)
	wantEqual(t, "assignee_count", h.current(agg).GetAssigneeCount(), int32(2))

	h2 := newHarness(t, f1()) // 单候选 22
	_, err := h2.start(starter, core.Choices{SelectedAssignees: []int64{33}})
	wantCode(t, err, "INVALID_CHOICE")
	d = h2.mustStart(starter, core.Choices{SelectedAssignees: []int64{22}})
	wantKind(t, d, core.OutcomeCommitted)
}

// ═══ 撤销（G）═══

// TestG1_OnlyNextStepSubmitterCanWithdraw：只有把流程送到下一站的人能撤；下一站办理人对自己的待办无「撤销」可言。
func TestG1_OnlyNextStepSubmitterCanWithdraw(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	agg := h.agg()
	_, err := h.eng.Withdraw(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 33, "PENDING").GetTaskId(), Actor: liSi})
	wantCode(t, err, "TASK_NOT_ACTIONABLE")
	_, err = h.eng.Withdraw(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "DONE").GetTaskId(), Actor: liSi})
	wantCode(t, err, "TASK_NOT_OWNED")
	// 发起人此时也不能撤：下一站已被王芳送走。
	_, err = h.withdrawStart(starter)
	wantCode(t, err, "WITHDRAW_REJECTED_TOUCHED")
	d, err := h.withdraw(wangFang)
	if err != nil {
		t.Fatal(err)
	}
	wantKind(t, d, core.OutcomeCommitted)
}

// TestG2_WithdrawRejectedWhenNextTouched：下一站任一人暂存过 → 不能撤。
func TestG2_WithdrawRejectedWhenNextTouched(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if _, err := h.save(liSi); err != nil {
		t.Fatal(err)
	}
	_, err := h.withdraw(wangFang)
	wantCode(t, err, "WITHDRAW_REJECTED_TOUCHED")
}

// TestG2_WithdrawRejectedWhenNextIsEnd：下一站是结束 → 不能撤（实例已结束）。
func TestG2_WithdrawRejectedWhenNextIsEnd(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	_, err := h.withdraw(wangFang)
	wantCode(t, err, "WITHDRAW_REJECTED_END")
}

// TestG4_WithdrawCancelsNextTasksAndReopensOwn：撤销后下一站任务全撤销（PRIOR_WITHDRAWN）、下一站步骤 WITHDRAWN，
// 本站回 ACTIVE、撤销人任务回待办（reopen_count+1）、因过关被撤销的同站待办恢复。
func TestG4_WithdrawCancelsNextTasksAndReopensOwn(t *testing.T) {
	c := f2()
	c.Nodes[1].StaticUserIDs = []int64{22, 44}
	// 只关心撤销那一行的状态类发件箱尾巴，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(c))
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 44}})
	h.mustSubmit(wangFang, core.Choices{})
	agg := h.agg()
	h.task(agg, 44, "WITHDRAWN")
	d, err := h.withdraw(wangFang)
	if err != nil {
		t.Fatal(err)
	}
	wantKind(t, d, core.OutcomeCommitted)
	agg = h.agg()
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n1")
	wantEqual(t, "n1 active", h.current(agg).GetStatus(), "ACTIVE")
	wantEqual(t, "n1 route cleared", h.current(agg).GetRouteLinkId(), "")
	wantEqual(t, "n1 passed_count", h.current(agg).GetPassedCount(), int32(0))
	n3 := h.step(agg, "n3", "")
	wantEqual(t, "n3 withdrawn", n3.GetStatus(), "WITHDRAWN")
	wantEqual(t, "n3 outcome", n3.GetOutcome(), "WITHDRAWN")
	lisi := h.task(agg, 33, "WITHDRAWN")
	wantEqual(t, "lisi reason", lisi.GetWithdrawReason(), "PRIOR_WITHDRAWN")
	mine := h.task(agg, 22, "PENDING")
	wantEqual(t, "reopen_count", mine.GetReopenCount(), int32(1))
	wantEqual(t, "done_at cleared", mine.GetDoneAt() == nil, true)
	peer := h.task(agg, 44, "PENDING")
	wantEqual(t, "peer restored", peer.GetWithdrawReason(), "")
	wantEqual(t, "instance running", agg.GetInstance().GetStatus(), "RUNNING")
	kinds := h.ledger.OutboxKinds(agg.GetInstance().GetWorkflowInstanceId())
	wantEqual(t, "outbox tail", kinds[len(kinds)-1], "3/STEP_WITHDRAWN")
	wantEqual(t, "form untouched", len(h.rec.Writes), 0)
}

// TestG6_ResubmitAfterWithdrawReroutesAndRecandidates：撤销后再提交重新选路、重新算候选，新建下一站步骤（C5：提交人成为进入人）。
func TestG6_ResubmitAfterWithdrawReroutesAndRecandidates(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatal(err)
	}
	calls := h.cand.Calls
	h.cand.Force, h.cand.Forced = true, []ports.Person{{UserID: 44}} // 财务复核换人
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "candidates recomputed", h.cand.Calls, calls+1)
	agg := h.agg()
	cur := h.current(agg)
	wantEqual(t, "new n3 step", cur.GetNodeId(), "n3")
	wantEqual(t, "seq", cur.GetSeqNo(), int32(4))
	wantEqual(t, "entered_by resubmitter", cur.GetEnteredByUserId(), int64(22))
	h.task(agg, 44, "PENDING")
	wantEqual(t, "old lisi task stays withdrawn", h.task(agg, 33, "").GetStatus(), "WITHDRAWN")
	wantEqual(t, "steps", len(agg.GetSteps()), 4)
}

// TestC5_ArrivalReusesSameRoutineWithSubmitterAsChooser：撤销后再提交，到达目标节点重新走一遍
// C1～C4 整套候选 routine（再算一次候选），且「前手」是这次的提交人 / 回退人，不是原来那次的
// 提交人（C5：回退到某一步时该步重新执行，提交人是回退人）。
func TestC5_ArrivalReusesSameRoutineWithSubmitterAsChooser(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{}) // -> n3，第一次到达，前手是王芳(22)
	wantEqual(t, "first arrival chooser", h.cand.LastPrev[0], int64(22))
	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatal(err)
	}
	callsBefore := h.cand.Calls
	// 王芳（同一人）重新提交：回退人=这次的提交人=22，到达 n3 时必须重新走 C1～C4。
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "routine re-run (candidates recomputed)", h.cand.Calls, callsBefore+1)
	wantEqual(t, "chooser is the resubmitter", len(h.cand.LastPrev) == 1 && h.cand.LastPrev[0] == wangFang.UserID, true)
	h.task(h.agg(), 33, "PENDING")
}

// TestG7_WithdrawStartKeepsInstanceAndReopensStartTask：撤销发起 = 撤发起任务：实例仍在、发起任务回待办、下一站撤销；再提交即再次发起。
func TestG7_WithdrawStartKeepsInstanceAndReopensStartTask(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	d, err := h.withdrawStart(starter)
	if err != nil {
		t.Fatal(err)
	}
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	wantEqual(t, "instance running", agg.GetInstance().GetStatus(), "RUNNING")
	wantEqual(t, "current = start", h.current(agg).GetNodeId(), "n0")
	st := h.task(agg, 1, "PENDING")
	wantEqual(t, "start task reopen", st.GetReopenCount(), int32(1))
	wantEqual(t, "n1 withdrawn", h.step(agg, "n1", "").GetStatus(), "WITHDRAWN")
	h.task(agg, 22, "WITHDRAWN")
	// 再提交发起任务：重新求路、重新到达。
	evals := len(h.expr.Calls)
	d = h.mustSubmit(starter, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	wantEqual(t, "route re-evaluated", len(h.expr.Calls), evals+1)
	agg = h.agg()
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n1")
	h.task(agg, 22, "PENDING")
	h.task(agg, 1, "DONE")
}

// TestN1_5_StartTaskReopenedAndResubmitRecordsAgain：撤销发起后发起任务回到待办（同一条任务，不是
// 新建一条）；再次提交即再次发起，同一条任务记录第二次「谁、何时、发起了哪条流程」——action_code
// 再次是 SUBMIT、done_at 再次落笔、reopen_count 已经在撤销时加过一次。
func TestN1_5_StartTaskReopenedAndResubmitRecordsAgain(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	firstTaskID := h.task(h.agg(), 1, "DONE").GetTaskId()
	if _, err := h.withdrawStart(starter); err != nil {
		t.Fatal(err)
	}
	reopened := h.task(h.agg(), 1, "PENDING")
	wantEqual(t, "same task reopened, not a new one", reopened.GetTaskId(), firstTaskID)
	wantEqual(t, "reopen_count", reopened.GetReopenCount(), int32(1))
	if reopened.GetDoneAt() != nil {
		t.Fatalf("done_at must be cleared while pending: %v", reopened.GetDoneAt())
	}
	d := h.mustSubmit(starter, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	again := h.task(h.agg(), 1, "DONE")
	wantEqual(t, "same task id reused on resubmit", again.GetTaskId(), firstTaskID)
	wantEqual(t, "action code recorded again", again.GetActionCode(), "SUBMIT")
	if again.GetDoneAt() == nil {
		t.Fatalf("second submission must record done_at again")
	}
	kinds := h.ledger.OutboxKinds(h.agg().GetInstance().GetWorkflowInstanceId())
	if !strings.Contains(strings.Join(kinds, ","), "STEP_ARRIVED") {
		t.Fatalf("resubmission must be recorded on the outbox trail: %v", kinds)
	}
}

// TestG9_NonManualStartCannotBeWithdrawn：非人工发起的实例不能撤销发起。
func TestG9_NonManualStartCannotBeWithdrawn(t *testing.T) {
	h := newHarness(t, f1())
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter, StartKind: model.StartKindAction})
	if err != nil {
		t.Fatal(err)
	}
	h.commit(d)
	_, err = h.withdrawStart(starter)
	wantCode(t, err, "WITHDRAW_REJECTED_NON_MANUAL_START")
}

// TestG10_WithdrawRecordsWhoWhenWhichStep：被撤销的步骤记下撤销人与时刻。
func TestG10_WithdrawRecordsWhoWhenWhichStep(t *testing.T) {
	h := newHarness(t, f2())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatal(err)
	}
	n3 := h.step(h.agg(), "n3", "WITHDRAWN")
	wantEqual(t, "withdrawn_by", n3.GetWithdrawnByUserId(), int64(22))
	wantEqual(t, "withdrawn_at", n3.GetWithdrawnAt().AsTime().Equal(fixedNow), true)
	wantEqual(t, "closed_at", n3.GetClosedAt() != nil, true)
}

// ═══ 摘要（H）═══

// TestH1_SummaryFromComputedExpression：节点配了计算表达式 → 到达时求一次，存进步骤与任务标题。
func TestH1_SummaryFromComputedExpression(t *testing.T) {
	c := f1()
	c.Nodes[1].SummaryPublicationID, c.Nodes[1].SummaryDocumentJSON = "p-sum", `{"mode":"value"}`
	h := newHarness(t, c)
	h.expr.Computed["p-sum"] = "采购申请 PO0001 · 王芳"
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	wantEqual(t, "step summary", h.current(agg).GetSummaryText(), "采购申请 PO0001 · 王芳")
	wantEqual(t, "task title", h.task(agg, 22, "PENDING").GetTitle(), "采购申请 PO0001 · 王芳")
}

// TestH2_DefaultSummaryStarterFlowSerial：没配摘要 → 「某某发起的某某流程 + 首个自动编号值」。
func TestH2_DefaultSummaryStarterFlowSerial(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	wantEqual(t, "start step summary", h.step(agg, "n0", "").GetSummaryText(), "张三发起的采购申请审批 PO0001")
	wantEqual(t, "handle step reuses", h.current(agg).GetSummaryText(), "张三发起的采购申请审批 PO0001")
	wantEqual(t, "task title", h.task(agg, 22, "PENDING").GetTitle(), "张三发起的采购申请审批 PO0001")
}

// TestH2_DefaultSummaryWithoutSerialField：主表没有自动编号字段 / 值为空 → 不附编号。
func TestH2_DefaultSummaryWithoutSerialField(t *testing.T) {
	c := f1()
	c.SerialFieldID = ""
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	wantEqual(t, "summary", h.step(h.agg(), "n0", "").GetSummaryText(), "张三发起的采购申请审批")

	h2 := newHarness(t, f1())
	h2.rec.Serial = "  "
	h2.mustStart(starter, core.Choices{})
	wantEqual(t, "summary", h2.step(h2.agg(), "n0", "").GetSummaryText(), "张三发起的采购申请审批")
}

// TestH3_SummaryFrozenAtArrival：到达后单据变了（编号 / 表达式结果变了）也不更新已存摘要；新到达的站才用新值。
func TestH3_SummaryFrozenAtArrival(t *testing.T) {
	c := f2()
	c.Nodes[3].SummaryPublicationID, c.Nodes[3].SummaryDocumentJSON = "p-sum", `{"mode":"value"}`
	h := newHarness(t, c)
	h.expr.Computed["p-sum"] = "第一版"
	h.mustStart(starter, core.Choices{})
	h.rec.Serial = "PO0999"
	h.expr.Computed["p-sum"] = "第二版"
	h.mustSubmit(wangFang, core.Choices{})
	agg := h.agg()
	wantEqual(t, "n1 summary frozen", h.step(agg, "n1", "").GetSummaryText(), "张三发起的采购申请审批 PO0001")
	wantEqual(t, "n3 summary at its arrival", h.current(agg).GetSummaryText(), "第二版")
}

// ═══ 时间 / 投影 / 幂等═══

// TestDV6_AllTimestampsAreUTC：时钟给的是 +08:00 时刻，落账与载荷一律 UTC 瞬时。
func TestDV6_AllTimestampsAreUTC(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	inst := h.agg().GetInstance()
	wantEqual(t, "last_action_at instant", inst.GetLastActionAt().AsTime().Equal(fixedNow), true)
	var payload map[string]any
	_ = json.Unmarshal([]byte(h.ledger.Outbox[0].GetPayloadJson()), &payload)
	wantEqual(t, "payload last_action_at", payload["last_action_at"], any(fixedNow.UTC().Format(time.RFC3339)))
}

// TestP2_OutboxPayloadIsProjectionSnapshot：发件箱载荷带投影所需六项 + 本次改动任务。
func TestP2_OutboxPayloadIsProjectionSnapshot(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	var payload map[string]any
	_ = json.Unmarshal([]byte(h.ledger.Outbox[1].GetPayloadJson()), &payload)
	wantEqual(t, "record_id", payload["record_id"], "rec-1")
	wantEqual(t, "template_id", payload["template_id"], "tpl-1")
	wantEqual(t, "definition_id", payload["definition_id"], "def-1")
	wantEqual(t, "flow_status", payload["flow_status"], "RUNNING")
	wantEqual(t, "current_node_name", payload["current_node_name"], "部门审批")
	ids := payload["current_assignee_user_ids"].([]any)
	wantEqual(t, "assignees", len(ids) == 1 && ids[0].(float64) == 22, true)
	tasks := payload["changed_tasks"].([]any)
	wantEqual(t, "changed_tasks", len(tasks), 1)
	wantEqual(t, "task title", tasks[0].(map[string]any)["title"], "张三发起的采购申请审批 PO0001")
}

// lastPayloadAssignees 取最后一条发件箱行载荷的 current_assignee_user_ids（currentStepAssignees
// 已按升序排列，这里原样取出，供测试按顺序比较）。
func lastPayloadAssignees(t *testing.T, h *harness) []int64 {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(h.ledger.Outbox[len(h.ledger.Outbox)-1].GetPayloadJson()), &payload); err != nil {
		t.Fatal(err)
	}
	raw, _ := payload["current_assignee_user_ids"].([]any)
	out := make([]int64, 0, len(raw))
	for _, v := range raw {
		out = append(out, int64(v.(float64)))
	}
	return out
}

func wantInt64Slice(t *testing.T, label string, got, want []int64) {
	t.Helper()
	ok := len(got) == len(want)
	if ok {
		for i := range got {
			if got[i] != want[i] {
				ok = false
				break
			}
		}
	}
	if !ok {
		t.Fatalf("%s: got %v, want %v", label, got, want)
	}
}

// TestP2_CurrentAssigneesIsWholeStep：当前办理人快照 = 当前步骤下全部
// PENDING / SAVED 任务的办理人，不是只看本次改动的任务：两人待办、一人暂存 → 快照仍含两人；
// 会签（RATIO 两人都要过）未过关的提交 → 提交人任务变 DONE，快照只剩还没提交的另一人；
// 两人都提交、实例结束 → 快照为空。
func TestP2_CurrentAssigneesIsWholeStep(t *testing.T) {
	c := f1()
	c.Nodes[1].StaticUserIDs = []int64{22, 33}
	c.Nodes[1].PassRule, c.Nodes[1].PassRatio = "RATIO", 100 // passed_count*100 >= assignee_count*100，两人都要提交
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{22, 33}})

	// 一人暂存：快照仍含两人（旧实现只看本次改动的任务，这里会漏掉没动过的 33）。
	if _, err := h.save(wangFang); err != nil {
		t.Fatal(err)
	}
	wantInt64Slice(t, "both pending/saved", lastPayloadAssignees(t, h), []int64{22, 33})

	// 王芳提交但未过关（李四还没提交）：步骤仍 ACTIVE，快照只剩李四（旧实现会把快照写空）。
	d, err := h.submit(wangFang, core.Choices{})
	if err != nil {
		t.Fatal(err)
	}
	wantKind(t, d, core.OutcomeCommitted)
	agg := h.agg()
	wantEqual(t, "step still active", h.current(agg).GetStatus(), "ACTIVE")
	wantEqual(t, "wangFang done", h.task(agg, 22, "DONE").GetStatus(), "DONE")
	wantInt64Slice(t, "only the other assignee", lastPayloadAssignees(t, h), []int64{33})

	// 李四提交，两人都过关，路由到结束节点：实例 ENDED，快照为空。
	h.mustSubmit(liSi, core.Choices{})
	wantEqual(t, "ended", h.agg().GetInstance().GetStatus(), "ENDED")
	wantInt64Slice(t, "ended snapshot empty", lastPayloadAssignees(t, h), nil)
}

// TestP3_OutboxSeqReservedZeroForHostToFill：引擎产出的发件箱行 seq=0，由账本在提交事务里填成新版本号。
func TestP3_OutboxSeqReservedZeroForHostToFill(t *testing.T) {
	h := newHarness(t, f1())
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Record: record, Actor: starter})
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range d.Changeset.GetOutboxAppends() {
		wantEqual(t, "seq before commit", o.GetSeq(), int64(0))
	}
	wantEqual(t, "expected version new", d.ExpectedVersion, int64(0))
	h.commit(d)
	for _, o := range h.ledger.Outbox {
		wantEqual(t, "seq after commit", o.GetSeq(), int64(1))
	}
}

// TestIdempotency_SameRequestKeyAppliesOnce：同一 request_key 重放 → applied=false 且状态不变；过期版本 → VERSION_CONFLICT。
func TestIdempotency_SameRequestKeyAppliesOnce(t *testing.T) {
	// 只关心发件箱条数，通知开关全关（理由见 notifyOff 注释）。
	h := newHarness(t, notifyOff(f1()))
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	d, err := h.eng.Save(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "PENDING").GetTaskId(), Actor: wangFang})
	if err != nil {
		t.Fatal(err)
	}
	result, err := h.ledger.Commit(h.ctx(), appID, ports.CommitInput{RequestKey: "same", RequestDigest: "same-digest", ActorUserID: 1, Changeset: d.Changeset})
	wantEqual(t, "first applied", result.Applied && result.InstanceVersion == 2 && err == nil, true)
	result, err = h.ledger.Commit(h.ctx(), appID, ports.CommitInput{RequestKey: "same", RequestDigest: "same-digest", ActorUserID: 1, Changeset: d.Changeset})
	wantEqual(t, "replay not applied", !result.Applied && result.InstanceVersion == 2 && err == nil, true)
	wantEqual(t, "outbox count", len(h.ledger.Outbox), 3)
	// 用旧聚合再做一次决策 → CAS 冲突。
	d2, err := h.eng.Save(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h.task(agg, 22, "PENDING").GetTaskId(), Actor: wangFang})
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.ledger.Commit(h.ctx(), appID, ports.CommitInput{RequestKey: "other", RequestDigest: "other-digest", ActorUserID: 1, Changeset: d2.Changeset})
	if !errors.Is(err, ports.ErrVersionConflict) {
		t.Fatalf("want version conflict, got %v", err)
	}
}

// ═══ 不变量 ═══

// TestSingleToken_Invariant：每次决策后恰一条 ACTIVE 步骤且 current_step_id 指向它；聚合被破坏（两条 ACTIVE）时任何动作都拒绝提交。
func TestSingleToken_Invariant(t *testing.T) {
	h := newHarness(t, f2())
	check := func(label string) {
		t.Helper()
		agg := h.agg()
		var active []string
		for _, s := range agg.GetSteps() {
			if s.GetStatus() == "ACTIVE" {
				active = append(active, s.GetStepId())
			}
		}
		if agg.GetInstance().GetStatus() == "ENDED" {
			wantEqual(t, label+": ended has no active", len(active), 0)
			return
		}
		wantEqual(t, label+": exactly one active", len(active), 1)
		wantEqual(t, label+": current points to it", agg.GetInstance().GetCurrentStepId(), active[0])
	}
	h.mustStart(starter, core.Choices{})
	check("start")
	h.mustSubmit(wangFang, core.Choices{})
	check("submit")
	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatal(err)
	}
	check("withdraw")
	h.mustSubmit(wangFang, core.Choices{})
	check("resubmit")
	if _, err := h.save(liSi); err != nil {
		t.Fatal(err)
	}
	check("save")
	h.mustSubmit(liSi, core.Choices{})
	check("end")

	// 破坏聚合：塞进第二条 ACTIVE 步骤 → 暂存必须被拒绝。
	h2 := newHarness(t, f1())
	h2.mustStart(starter, core.Choices{})
	agg := h2.agg()
	agg.Steps = append(agg.Steps, &pb.StepRow{StepId: "ghost", WorkflowInstanceId: agg.GetInstance().GetWorkflowInstanceId(), SeqNo: 99, NodeId: "n1", NodeKind: "HANDLE", Status: "ACTIVE"})
	_, err := h2.eng.Save(h2.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: h2.task(agg, 22, "PENDING").GetTaskId(), Actor: wangFang})
	wantCode(t, err, "SYSTEM_ERROR")
}
