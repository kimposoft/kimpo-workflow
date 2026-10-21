package core_test

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
)

// initiator_source_test.go 覆盖『人员来源』档位「发起人」在引擎侧落地的两个消费点：办理 / 审批到达（node_human.go）与抄送到达（cc.go）。
// 两处都要在调 Candidate.Resolve 之前把实例发起人 id 并入 staticUserIDs
// （initiator_source.go 的 withInitiatorSource），这里用 harness 的 StaticCandidate
// （只是测试替身，只认 staticUserIDs、忽略 sourcesJSON）验证「并入」这一步确实发生了。

// fInitiatorHandle f1 的变体：n1 办理节点的来源从「直接指定王芳」改成「发起人」（不给
// StaticUserIDs，只给 SourcesJSON）。
func fInitiatorHandle() *compile.CompiledDefinition {
	c := f1()
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == "n1" {
			c.Nodes[i].StaticUserIDs = nil
			c.Nodes[i].SourcesJSON = `[{"kind":"initiator"}]`
		}
	}
	return c
}

// fInitiatorHandleMixed f1 的变体：n1 同时配「发起人」与「直接指定王芳」两种来源——验证
// 两者取并集，都要进候选（>1 候选无选择即 ASSIGNEE_CHOICE_REQUIRED，这里只断言候选清单）。
func fInitiatorHandleMixed() *compile.CompiledDefinition {
	c := f1()
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == "n1" {
			c.Nodes[i].StaticUserIDs = []int64{wangFang.UserID}
			c.Nodes[i].SourcesJSON = `[{"kind":"initiator"},{"kind":"user","user_ids":["22"]}]`
		}
	}
	return c
}

// fInitiatorCC f5 的变体：末级抄送 cc1 的收件人从「指定李四 / 赵五」改成「发起人」。
func fInitiatorCC() *compile.CompiledDefinition {
	c := f5()
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == "cc1" {
			c.Nodes[i].StaticUserIDs = nil
			c.Nodes[i].SourcesJSON = `[{"kind":"initiator"}]`
		}
	}
	return c
}

// TestA11_InitiatorSourceHandleAssignsStarter：办理节点只配「发起人」来源，候选恰好一人
// （实例发起人），直接派任务给他，不经选择框。
func TestA11_InitiatorSourceHandleAssignsStarter(t *testing.T) {
	h := newHarness(t, fInitiatorHandle())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	task := h.task(agg, starter.UserID, "PENDING")
	wantEqual(t, "任务办理人", task.GetAssigneeUserId(), starter.UserID)
	wantEqual(t, "当前站", agg.GetInstance().GetCurrentNodeId(), "n1")
}

// TestA11_InitiatorSourceHandleUnionWithOtherSource：办理节点「发起人」与「直接指定王芳」
// 并配，候选是两者并集（>1 人无选择弹 ASSIGNEE_CHOICE_REQUIRED，候选清单含两人）。
func TestA11_InitiatorSourceHandleUnionWithOtherSource(t *testing.T) {
	h := newHarness(t, fInitiatorHandleMixed())
	d, err := h.start(starter, core.Choices{})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	wantEqual(t, "结果", string(d.Outcome.Kind), "ASSIGNEE_CHOICE_REQUIRED")
	if len(d.Outcome.Candidates) != 2 {
		t.Fatalf("候选应是「发起人」与「王芳」的并集（2 人），实得 %+v", d.Outcome.Candidates)
	}
	seen := map[int64]bool{}
	for _, p := range d.Outcome.Candidates {
		seen[p.UserID] = true
	}
	if !seen[starter.UserID] || !seen[wangFang.UserID] {
		t.Fatalf("候选应同时包含发起人 %d 与王芳 %d，实得 %+v", starter.UserID, wangFang.UserID, d.Outcome.Candidates)
	}
}

// TestA11_InitiatorSourceCCNotifiesStarter：抄送节点只配「发起人」来源，收件人 = 实例发起人。
func TestA11_InitiatorSourceCCNotifiesStarter(t *testing.T) {
	h := newHarness(t, fInitiatorCC())
	presetCCText(h, "cc1")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	agg := h.agg()
	rows := ccRowsOf(agg)
	found := false
	for _, r := range rows {
		if r.GetRecipientUserId() == starter.UserID {
			found = true
		}
	}
	if !found {
		t.Fatalf("抄送节点配「发起人」来源应知会实例发起人，实得 %+v", rows)
	}
}
