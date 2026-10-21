package core_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// —— 夹具：编译产物直接手写（编译器本身由 compile 包单测覆盖），状态机只读 CompiledDefinition ——

const appID = "app"

var (
	starter  = ports.Actor{UserID: 1, DisplayName: "张三"}
	wangFang = ports.Actor{UserID: 22, DisplayName: "王芳"}
	liSi     = ports.Actor{UserID: 33, DisplayName: "李四"}
	zhaoWu   = ports.Actor{UserID: 44, DisplayName: "赵五"}
	record   = ports.RecordRef{AppID: appID, TemplateID: "tpl-1", RecordID: "rec-1"}
	fixedNow = time.Date(2026, 1, 15, 10, 30, 0, 0, time.FixedZone("CST", 8*3600)) // 非 UTC 时钟：验证发件箱时间统一按 UTC 输出
)

// f1 发起 → 部门审批（王芳）→ 结束「已通过」写 f-status；l1 有条件 p-l1，l2 无条件。
func f1() *compile.CompiledDefinition {
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no",
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门审批", NoRouteHint: "审批后没有可走的路线", PassRule: "ANY", PassRatio: 100, StaticUserIDs: []int64{22}},
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过", EndLabelFieldID: "f-status"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true, ConditionPublicationID: "p-l1", ConditionDocumentJSON: `{"mode":"condition"}`},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n2", IsMain: true},
		},
	}
}

// f2 三站链：发起 → 部门审批（王芳）→ 财务复核（李四）→ 结束；全部无条件。
func f2() *compile.CompiledDefinition {
	c := f1()
	c.Links[0].ConditionPublicationID, c.Links[0].ConditionDocumentJSON = "", ""
	c.Nodes = append(c.Nodes, compile.NodeCompiled{NodeID: "n3", NodeKind: "HANDLE", NodeName: "财务复核", PassRule: "ANY", PassRatio: 100, StaticUserIDs: []int64{33}})
	c.Links = []compile.LinkCompiled{
		{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
		{LinkID: "l2", FromNodeID: "n1", ToNodeID: "n3", IsMain: true},
		{LinkID: "l3", FromNodeID: "n3", ToNodeID: "n2", IsMain: true},
	}
	return c
}

// notifyOffJSON 是四类主线节点（发起/办理/审批/结束）notify.channels 全关的 NotifyJSON 字面量
// （节点级通知事件开关键缺席才是「默认开」，显式写 false 就是关掉）。
const notifyOffJSON = `{"on_assigned":false,"on_returned":false,"on_withdrawn":false,"on_terminated":false,"on_ended":false}`

// notifyOff 返回 c 的一份浅拷贝，把发起/办理/审批/结束四类节点的通知开关全部显式关掉——给不
// 关心通知行为、只断言状态类发件箱行顺序/条数的夹具用。节点级通知默认全开，同一份夹具会多出
// NOTIFY 行把顺序/条数的断言打乱——这里用节点级关闭排除干扰，不代表通知功能本身要测
// 「全关」（通知行为测试见 notify_test.go）。CC/子流程节点没有 notify 字段，跳过。
func notifyOff(c *compile.CompiledDefinition) *compile.CompiledDefinition {
	clone := *c
	clone.Nodes = append([]compile.NodeCompiled(nil), c.Nodes...)
	for i := range clone.Nodes {
		switch clone.Nodes[i].NodeKind {
		case "START", "HANDLE", "APPROVE", "END":
			clone.Nodes[i].NotifyJSON = notifyOffJSON
		}
	}
	return &clone
}

type harness struct {
	t      *testing.T
	eng    *core.Engine
	ledger *testkit.MemLedger
	expr   *testkit.FakeExpr
	rec    *testkit.FakeRecord
	cand   *testkit.RecordingCandidate
	def    *pb.DefinitionRow
	ver    *pb.DefinitionVersionRow
	reqSeq int
}

func newHarness(t *testing.T, c *compile.CompiledDefinition) *harness {
	t.Helper()
	raw, err := c.Encode()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, ledger: testkit.NewMemLedger(), expr: testkit.NewFakeExpr(), rec: &testkit.FakeRecord{Serial: "PO0001", Exists: true},
		cand: &testkit.RecordingCandidate{Inner: testkit.StaticCandidate{}}}
	h.expr.Conditions["p-l1"] = true
	h.eng = &core.Engine{Expr: h.expr, Candidate: h.cand, Record: h.rec, Clock: testkit.FixedClock{T: fixedNow}, IDs: testkit.NewSeqIDs()}
	h.def = &pb.DefinitionRow{DefinitionId: "def-1", TemplateId: "tpl-1", Name: "采购申请审批", StatusCode: "enabled"}
	h.ver = &pb.DefinitionVersionRow{VersionId: "ver-1", DefinitionId: "def-1", VersionNo: 1, Name: "采购申请审批", CompiledJson: string(raw)}
	h.ledger.Definitions["def-1"] = h.def
	h.ledger.Versions["def-1"] = []*pb.DefinitionVersionRow{h.ver}
	return h
}

func (h *harness) ctx() context.Context { return context.Background() }

func (h *harness) nextKey() string {
	h.reqSeq++
	return fmt.Sprintf("req-%d", h.reqSeq)
}

// commit 模拟 app 层（engineapp.commitLoop 的两段式）：带结束标识时先提交
// PrepareEndWrite 的停驻变更集，再写字段；成功 ResumeIncident 提交第二段，失败 ParkAgain 提交改判。
func (h *harness) commit(d *core.Decision) *core.Decision {
	h.t.Helper()
	if d == nil || d.Changeset == nil {
		return d
	}
	if d.PendingEndWrite == nil {
		h.rawCommit(d.Changeset)
		return d
	}
	if resolvesIncident(d) {
		// 已经是两段式**第二段**的产物（ResumeIncident 的变更集里带着一条 RESOLVED 事故）：
		// 照生产路径（engineapp.finishEndWrite）办——写字段，然后直接提交这一段，**不重入**
		// 两段式。重入会再开一条新事故、再停驻一次，账本里躺着两条事故，判据按下标取 [0]
		// 就成了抛硬币（表现为单跑必过、全包跑偶发不过）。
		w := d.PendingEndWrite
		if err := h.rec.WriteFields(h.ctx(), record, []ports.FieldWrite{{FieldID: w.FieldID, TextValue: w.Label}}, "workflow-end", starter, "k"); err != nil {
			h.t.Fatalf("second-phase end write: %v", err)
		}
		h.rawCommit(d.Changeset)
		return d
	}
	w := d.PendingEndWrite
	d = h.eng.PrepareEndWrite(d)
	h.rawCommit(d.Changeset)
	incidentID := d.Outcome.IncidentID
	if err := h.rec.WriteFields(h.ctx(), record, []ports.FieldWrite{{FieldID: w.FieldID, TextValue: w.Label}}, "workflow-end", starter, "k"); err != nil {
		pd := h.eng.ParkAgain(h.agg(), incidentID, err)
		h.rawCommit(pd.Changeset)
		return pd
	}
	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: h.agg(), IncidentID: incidentID, Actor: ports.Actor{UserID: 1}})
	if err != nil {
		h.t.Fatalf("resume after end write: %v", err)
	}
	h.rawCommit(rd.Changeset)
	return rd
}

// resolvesIncident 变更集里是否已经把某条事故标成 RESOLVED（即它本身就是两段式的第二段）。
func resolvesIncident(d *core.Decision) bool {
	for _, inc := range d.Changeset.GetIncidentUpserts() {
		if inc.GetStatus() == "RESOLVED" {
			return true
		}
	}
	return false
}

// rawCommit 直接提交一包变更集（顺序请求键）。
func (h *harness) rawCommit(cs *pb.Changeset) {
	h.t.Helper()
	key := h.nextKey()
	result, err := h.ledger.Commit(h.ctx(), appID, ports.CommitInput{RequestKey: key, RequestDigest: "digest:" + key, ActorUserID: 1, Changeset: cs})
	if err != nil {
		h.t.Fatalf("commit: %v", err)
	}
	if !result.Applied {
		h.t.Fatalf("commit not applied")
	}
}

// existing 账本里该单据的实例（无则 nil）。
func (h *harness) existing() *pb.InstanceAggregate {
	agg, err := h.ledger.LoadInstanceByRecord(h.ctx(), appID, record.RecordID)
	if errors.Is(err, ports.ErrNotFound) {
		return nil
	}
	if err != nil {
		h.t.Fatal(err)
	}
	return agg
}

func (h *harness) agg() *pb.InstanceAggregate {
	h.t.Helper()
	agg := h.existing()
	if agg == nil {
		h.t.Fatalf("no instance for record")
	}
	return agg
}

// start 发起并提交（有变更集时）。
func (h *harness) start(actor ports.Actor, choices core.Choices) (*core.Decision, error) {
	h.t.Helper()
	d, err := h.eng.Start(h.ctx(), core.StartInput{AppID: appID, Definition: h.def, Version: h.ver, Existing: h.existing(), Record: record, Actor: actor, Choices: choices})
	if err != nil {
		return nil, err
	}
	return h.commit(d), nil
}

func (h *harness) mustStart(actor ports.Actor, choices core.Choices) *core.Decision {
	h.t.Helper()
	d, err := h.start(actor, choices)
	if err != nil {
		h.t.Fatalf("start: %v", err)
	}
	return d
}

// task 某人在当前聚合里状态为 status 的任务（空 status = 任意）。
func (h *harness) task(agg *pb.InstanceAggregate, user int64, status string) *pb.TaskRow {
	h.t.Helper()
	for _, t := range agg.GetTasks() {
		if t.GetAssigneeUserId() == user && (status == "" || t.GetStatus() == status) {
			return t
		}
	}
	h.t.Fatalf("no task of user %d with status %q: %v", user, status, taskLines(agg))
	return nil
}

func (h *harness) submit(actor ports.Actor, choices core.Choices) (*core.Decision, error) {
	h.t.Helper()
	agg := h.agg()
	var task *pb.TaskRow
	for _, t := range agg.GetTasks() {
		if t.GetAssigneeUserId() == actor.UserID && (t.GetStatus() == "PENDING" || t.GetStatus() == "SAVED") {
			task = t
		}
	}
	if task == nil {
		h.t.Fatalf("user %d has no actionable task: %v", actor.UserID, taskLines(agg))
	}
	d, err := h.eng.Submit(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: actor, Choices: choices})
	if err != nil {
		return nil, err
	}
	return h.commit(d), nil
}

func (h *harness) mustSubmit(actor ports.Actor, choices core.Choices) *core.Decision {
	h.t.Helper()
	d, err := h.submit(actor, choices)
	if err != nil {
		h.t.Fatalf("submit by %d: %v", actor.UserID, err)
	}
	return d
}

func (h *harness) save(actor ports.Actor) (*core.Decision, error) {
	h.t.Helper()
	agg := h.agg()
	task := h.task(agg, actor.UserID, "PENDING")
	d, err := h.eng.Save(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: actor})
	if err != nil {
		return nil, err
	}
	return h.commit(d), nil
}

// withdraw 撤销 actor 已完成（DONE）的那条任务。
func (h *harness) withdraw(actor ports.Actor) (*core.Decision, error) {
	h.t.Helper()
	agg := h.agg()
	task := h.task(agg, actor.UserID, "DONE")
	d, err := h.eng.Withdraw(h.ctx(), core.TaskInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), Actor: actor})
	if err != nil {
		return nil, err
	}
	return h.commit(d), nil
}

func (h *harness) withdrawStart(actor ports.Actor) (*core.Decision, error) {
	h.t.Helper()
	d, err := h.eng.WithdrawStart(h.ctx(), appID, h.agg(), actor)
	if err != nil {
		return nil, err
	}
	return h.commit(d), nil
}

func (h *harness) step(agg *pb.InstanceAggregate, nodeID string, status string) *pb.StepRow {
	h.t.Helper()
	var found *pb.StepRow
	for _, s := range agg.GetSteps() {
		if s.GetNodeId() == nodeID && (status == "" || s.GetStatus() == status) {
			found = s // 取 seq 最大的
		}
	}
	if found == nil {
		h.t.Fatalf("no step on node %s status %q: %v", nodeID, status, stepLines(agg))
	}
	return found
}

func (h *harness) current(agg *pb.InstanceAggregate) *pb.StepRow {
	h.t.Helper()
	for _, s := range agg.GetSteps() {
		if s.GetStepId() == agg.GetInstance().GetCurrentStepId() {
			return s
		}
	}
	h.t.Fatalf("current step %q not found", agg.GetInstance().GetCurrentStepId())
	return nil
}

func taskLines(agg *pb.InstanceAggregate) []string {
	var out []string
	for _, t := range agg.GetTasks() {
		out = append(out, fmt.Sprintf("%s:%s/u%d/%s", t.GetTaskId(), t.GetTaskKind(), t.GetAssigneeUserId(), t.GetStatus()))
	}
	return out
}

func stepLines(agg *pb.InstanceAggregate) []string {
	var out []string
	for _, s := range agg.GetSteps() {
		out = append(out, fmt.Sprintf("%s#%d:%s/%s", s.GetStepId(), s.GetSeqNo(), s.GetNodeId(), s.GetStatus()))
	}
	return out
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want error %s, got nil", code)
	}
	if core.CodeOf(err) != code {
		t.Fatalf("want error code %s, got %q (%v)", code, core.CodeOf(err), err)
	}
}

func wantKind(t *testing.T, d *core.Decision, kind core.OutcomeKind) {
	t.Helper()
	if d == nil {
		t.Fatalf("nil decision")
	}
	if d.Outcome.Kind != kind {
		t.Fatalf("want outcome %s, got %s (%+v)", kind, d.Outcome.Kind, d.Outcome)
	}
}

func wantEqual[T comparable](t *testing.T, label string, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %v, want %v", label, got, want)
	}
}
