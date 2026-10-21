package core_test

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/testkit"
)

// relation_filter_test.go 覆盖『过滤器：与上步处理人的关系』在引擎侧算候选的新语义
// 与旧编译产物兼容（engine/core/relation_filter.go）。
//
// 默认 harness 用的 testkit.StaticCandidate 只认 staticUserIDs、完全忽略 sourcesJSON
// （测试替身设计如此），没法回答「按 sourcesJSON 里的 relation 条目查出哪些人」这类
// 问题——本文件的用例改用 testkit.SourceCandidate 作 h.cand.Inner，它能解析 sourcesJSON
// 里的 user / relation 条目，按预置的 RelationMembers 表回放「这一档筛出谁」。它不模拟真实
// 组织语义（判定在宿主），只用来验证引擎侧「先算候选、按过滤器筛
// 一道再取交集」这套编排逻辑本身有没有接对。

// frFilter 一站办理夹具：发起 → n1（人员来源直接指定 staticIDs，过滤器 filters，全部完成才过关）
// → 结束。RATIO/100 而不是默认的 ANY，方便多人到齐再过关的用例复用同一个夹具。
func frFilter(staticIDs []int64, filters []model.AssigneeRelation) *compile.CompiledDefinition {
	c := f1()
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == "n1" {
			c.Nodes[i].StaticUserIDs = staticIDs
			c.Nodes[i].RelationFilters = filters
			c.Nodes[i].PassRule, c.Nodes[i].PassRatio = "RATIO", 100
		}
	}
	return c
}

// frCC f5 的变体：末级抄送 cc1 的收件人与过滤器可配。
func frCC(staticIDs []int64, filters []model.AssigneeRelation) *compile.CompiledDefinition {
	c := f5()
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == "cc1" {
			c.Nodes[i].StaticUserIDs = staticIDs
			c.Nodes[i].RelationFilters = filters
		}
	}
	return c
}

// withSourceCandidate 把 h 的内层候选解析器换成能读 sourcesJSON 的 SourceCandidate。
func withSourceCandidate(h *harness, relationMembers map[string][]int64) {
	h.cand.Inner = testkit.SourceCandidate{RelationMembers: relationMembers}
}

func int64SliceEqual(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestA3_RelationFilter_IntersectsCandidates：来源算出候选 {王芳,李四,赵五}，过滤器只允许
// {李四,丁(99，不在候选里)} → 交集只剩李四，直接派给他（交集恰一人，不弹选人框）。
func TestA3_RelationFilter_IntersectsCandidates(t *testing.T) {
	h := newHarness(t, frFilter([]int64{wangFang.UserID, liSi.UserID, zhaoWu.UserID}, []model.AssigneeRelation{model.AssigneeRelationSameDept}))
	withSourceCandidate(h, map[string][]int64{"same_department": {liSi.UserID, 99}})
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted)
	task := h.task(h.agg(), liSi.UserID, "PENDING")
	wantEqual(t, "任务办理人", task.GetAssigneeUserId(), liSi.UserID)
	if len(h.agg().GetTasks()) != 2 { // 发起 + 李四；王芳、赵五被过滤器筛掉，不该有任务
		t.Fatalf("过滤后只该有李四一条办理任务，实得 %v", taskLines(h.agg()))
	}
}

// TestA3_RelationFilter_MultipleRelationsUnionThenIntersect：勾了两种关系，先各自算出「允许
// 的人」取并集，再与候选取交集——候选 {王芳,李四,赵五}，same_department→{李四}，
// department_manager→{赵五}，并集 {李四,赵五}，交集后仍是这两人（王芳被筛掉）。
func TestA3_RelationFilter_MultipleRelationsUnionThenIntersect(t *testing.T) {
	h := newHarness(t, frFilter([]int64{wangFang.UserID, liSi.UserID, zhaoWu.UserID},
		[]model.AssigneeRelation{model.AssigneeRelationSameDept, model.AssigneeRelationDeptManager}))
	withSourceCandidate(h, map[string][]int64{
		"same_department":    {liSi.UserID},
		"department_manager": {zhaoWu.UserID},
	})
	d, err := h.start(starter, core.Choices{})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	wantKind(t, d, core.OutcomeAssigneeChoiceRequired)
	if len(d.Outcome.Candidates) != 2 {
		t.Fatalf("过滤后应剩李四与赵五两人，实得 %+v", d.Outcome.Candidates)
	}
	seen := map[int64]bool{}
	for _, p := range d.Outcome.Candidates {
		seen[p.UserID] = true
	}
	if !seen[liSi.UserID] || !seen[zhaoWu.UserID] || seen[wangFang.UserID] {
		t.Fatalf("候选应恰为 {李四,赵五}，不含王芳，实得 %+v", d.Outcome.Candidates)
	}
}

// TestA10_RelationFilter_EmptyIntersectionIsNoCandidate：过滤后一个候选都不剩，等同无人可办，
// 走现有 C4 无候选处置（实例仍建、发起任务转暂存），不新写分支——与「来源本身为空」表现一致。
func TestA10_RelationFilter_EmptyIntersectionIsNoCandidate(t *testing.T) {
	h := newHarness(t, frFilter([]int64{wangFang.UserID}, []model.AssigneeRelation{model.AssigneeRelationSameDept}))
	withSourceCandidate(h, map[string][]int64{"same_department": {liSi.UserID}}) // 与候选无交集
	d := h.mustStart(starter, core.Choices{})
	wantKind(t, d, core.OutcomeNoCandidate)
	wantEqual(t, "saved", d.Outcome.Saved, true)
	agg := h.agg()
	wantEqual(t, "instance status", agg.GetInstance().GetStatus(), "RUNNING")
	wantEqual(t, "current node", h.current(agg).GetNodeId(), "n0")
	h.task(agg, starter.UserID, "SAVED")
}

// TestN4_RelationFilter_Intersects：抄送节点收件人 {李四,赵五}，过滤器只允许 {赵五} → 只有
// 赵五收到通知（2 渠道各一行）。
func TestN4_RelationFilter_Intersects(t *testing.T) {
	h := newHarness(t, frCC([]int64{liSi.UserID, zhaoWu.UserID}, []model.AssigneeRelation{model.AssigneeRelationSameDept}))
	withSourceCandidate(h, map[string][]int64{"same_department": {zhaoWu.UserID}})
	presetCCText(h, "cc1")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	rows := ccRowsOf(h.agg())
	if len(rows) != 2 { // 一个收件人 × 两个渠道
		t.Fatalf("过滤后应只有赵五收到通知（2 行），实得 %d：%+v", len(rows), rows)
	}
	for _, r := range rows {
		if r.GetRecipientUserId() != zhaoWu.UserID {
			t.Fatalf("过滤后只该通知赵五，实得 %+v", rows)
		}
	}
}

// TestN4_RelationFilter_EmptyIntersectionStillFlows：抄送节点过滤后交集为空——按 A10/N4.3
// 不写抄送行、不发通知，流程照常向后走（与「收件人本来算不出人」C4.3 同一处置，不是无候选）。
func TestN4_RelationFilter_EmptyIntersectionStillFlows(t *testing.T) {
	h := newHarness(t, frCC([]int64{liSi.UserID}, []model.AssigneeRelation{model.AssigneeRelationSameDept}))
	withSourceCandidate(h, map[string][]int64{"same_department": {zhaoWu.UserID}}) // 与候选无交集
	presetCCText(h, "cc1")
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	agg := h.agg()
	if len(ccRowsOf(agg)) != 0 {
		t.Fatalf("过滤后交集为空不该写抄送行，实得 %+v", ccRowsOf(agg))
	}
	wantEqual(t, "流程照常走完", agg.GetInstance().GetStatus(), "ENDED")
}

// TestA12_LegacyCompiledProduct_UsesOldUnionSemantics：旧编译产物——关系仍以来源形态躺在
// SourcesJSON 里（`{"kind":"relation",...}`），RelationFilters 为空（旧编译器压根不产这个
// 字段）。运行期必须继续按旧语义把它当成一条来源并集加人，且只调一次 Resolve——不能因为
// SourcesJSON 里出现了 relation 字样就误当新形状触发第二次过滤调用。
func TestA12_LegacyCompiledProduct_UsesOldUnionSemantics(t *testing.T) {
	c := f1()
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == "n1" {
			c.Nodes[i].StaticUserIDs = nil
			c.Nodes[i].SourcesJSON = `[{"kind":"user","user_ids":["22"]},{"kind":"relation","relation":"same_department"}]`
			c.Nodes[i].RelationFilters = nil // 旧编译产物没有这个字段（新编译器才会写）
		}
	}
	h := newHarness(t, c)
	withSourceCandidate(h, map[string][]int64{"same_department": {liSi.UserID}})
	d, err := h.start(starter, core.Choices{})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	wantKind(t, d, core.OutcomeAssigneeChoiceRequired) // 并集两人：王芳（user 来源）+ 李四（relation 来源）
	if len(d.Outcome.Candidates) != 2 {
		t.Fatalf("旧语义应是并集两人，实得 %+v", d.Outcome.Candidates)
	}
	seen := map[int64]bool{}
	for _, p := range d.Outcome.Candidates {
		seen[p.UserID] = true
	}
	if !seen[wangFang.UserID] || !seen[liSi.UserID] {
		t.Fatalf("并集应同时包含王芳与李四，实得 %+v", d.Outcome.Candidates)
	}
	if h.cand.Calls != 1 {
		t.Fatalf("旧编译产物（RelationFilters 为空）应只调一次 Resolve，实得 %d 次", h.cand.Calls)
	}
}

// TestA3_RelationFilter_SecondResolveCallArgs：显式钉住第二次 Resolve 调用的入参形状——
// staticUserIDs 传空、来源清单只含过滤器合成的 relation 条目（不含 user/role/department，
// 不会被 hostclient.SourcesToPB 的「来源为空兜底成 USER」或「发起人补位」两个收尾分支污染）、
// prev 与第一次调用完全一致（两次共用同一个 prev 变量，不是分别算的）。
func TestA3_RelationFilter_SecondResolveCallArgs(t *testing.T) {
	h := newHarness(t, frFilter([]int64{wangFang.UserID, liSi.UserID},
		[]model.AssigneeRelation{model.AssigneeRelationSameDept, model.AssigneeRelationDeptManager}))
	withSourceCandidate(h, map[string][]int64{"same_department": {liSi.UserID}})
	// 过滤后交集只剩李四一人，直接派给他，不需要选人（选择只针对过滤后的候选集）。
	h.mustStart(starter, core.Choices{})

	if len(h.cand.CallLog) != 2 {
		t.Fatalf("配了过滤器的到达应触发两次 Resolve，实得 %d 次：%+v", len(h.cand.CallLog), h.cand.CallLog)
	}
	first, second := h.cand.CallLog[0], h.cand.CallLog[1]
	if len(second.StaticUserIDs) != 0 {
		t.Fatalf("第二次调用 staticUserIDs 应传空，实得 %v", second.StaticUserIDs)
	}
	var srcs []model.AssigneeSource
	if err := json.Unmarshal([]byte(second.SourcesJSON), &srcs); err != nil {
		t.Fatalf("第二次调用的来源清单应是合法 JSON：%v", err)
	}
	if len(srcs) != 2 {
		t.Fatalf("第二次调用应只含两条来源（对应两种关系），实得 %+v", srcs)
	}
	for _, s := range srcs {
		if s.Kind != model.AssigneeSourceRelation {
			t.Fatalf("第二次调用的来源应全部是 relation，不该混进 user/role/department，实得 %+v", srcs)
		}
	}
	if !int64SliceEqual(first.Prev, second.Prev) {
		t.Fatalf("两次调用的 prev 应完全一致：第一次 %v，第二次 %v", first.Prev, second.Prev)
	}
}

// TestA3_RelationFilter_MultiplePrevActors：上一步是多人协同完成（全部完成才过关），过滤器
// 以“上步处理人里每一个人”为基准算，交给两次 Resolve 调用的 prev 必须是这两人（顺序也一致，
// 因为两次调用共用同一个 prev 变量，不是分别现算的）。
func TestA3_RelationFilter_MultiplePrevActors(t *testing.T) {
	c := f2() // 发起 → n1（部门审批）→ n3（财务复核）→ 结束
	for i := range c.Nodes {
		switch c.Nodes[i].NodeID {
		case "n1":
			// 王芳 + 赵五两人一起办，全部完成才过关。
			c.Nodes[i].StaticUserIDs = []int64{wangFang.UserID, zhaoWu.UserID}
			c.Nodes[i].PassRule, c.Nodes[i].PassRatio = "RATIO", 100
		case "n3":
			c.Nodes[i].StaticUserIDs = []int64{wangFang.UserID, liSi.UserID, zhaoWu.UserID}
			c.Nodes[i].RelationFilters = []model.AssigneeRelation{model.AssigneeRelationSameDept}
		}
	}
	h := newHarness(t, c)
	withSourceCandidate(h, map[string][]int64{"same_department": {liSi.UserID}})
	h.mustStart(starter, core.Choices{SelectedAssignees: []int64{wangFang.UserID, zhaoWu.UserID}})
	h.mustSubmit(zhaoWu, core.Choices{})
	h.cand.CallLog = nil // 只关心过关那一刻到达财务复核触发的调用
	d := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, d, core.OutcomeCommitted) // 交集只剩李四，直接派给他
	h.task(h.agg(), liSi.UserID, "PENDING")

	if len(h.cand.CallLog) != 2 {
		t.Fatalf("到达财务复核应触发两次 Resolve，实得 %d 次：%+v", len(h.cand.CallLog), h.cand.CallLog)
	}
	first, second := h.cand.CallLog[0], h.cand.CallLog[1]
	if len(first.Prev) != 2 {
		t.Fatalf("上步处理人应是王芳与赵五两人，实得 %v", first.Prev)
	}
	seenPrev := map[int64]bool{}
	for _, id := range first.Prev {
		seenPrev[id] = true
	}
	if !seenPrev[wangFang.UserID] || !seenPrev[zhaoWu.UserID] {
		t.Fatalf("前手应同时包含王芳与赵五，实得 %v", first.Prev)
	}
	if !int64SliceEqual(first.Prev, second.Prev) {
		t.Fatalf("两次调用的 prev 应完全一致：第一次 %v，第二次 %v", first.Prev, second.Prev)
	}
}

// TestResumeAutoChainLimit_RelationFilter：AUTO_CHAIN_LIMIT 事故恢复时重算候选
// （resume_incident.go resumeAutoChainLimit）同样要走过滤器这道闸——这是 node_human.go/cc.go
// 之外的第三处「算候选」调用点，同样经 resolveCandidatesFiltered，
// 否则配了过滤器的节点从事故恢复时会绕开过滤（新编译产物的关系只在 RelationFilters 里，
// 旧调用只读 SourcesJSON 会连旧语义并集都没有，直接把关系漏了）。夹具与
// TestResumeAutoChainLimit_MultiCandidate 同款（n5/n6 互指形成自动办理死循环，20 步撞限，
// 固定停在 n5），只是把「候选改两人」换成「候选三人 + 过滤器只留一人」。
func TestResumeAutoChainLimit_RelationFilter(t *testing.T) {
	c := f4()
	c.Nodes[3].AutoConditionPubID, c.Nodes[3].AutoConditionDocJSON = "p-auto", `{"mode":"condition"}`
	c.Links[3] = compile.LinkCompiled{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n5", IsMain: true}
	c.Nodes[2].StaticUserIDs = []int64{wangFang.UserID, liSi.UserID, zhaoWu.UserID} // n5 候选三人
	c.Nodes[2].RelationFilters = []model.AssigneeRelation{model.AssigneeRelationSameDept}
	h := newHarness(t, c)
	withSourceCandidate(h, map[string][]int64{"same_department": {liSi.UserID}})
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	parked := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, parked, core.OutcomeParked)
	incidentID := parked.Outcome.IncidentID

	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: h.agg(), IncidentID: incidentID, Actor: ports.Actor{UserID: 9, DisplayName: "管理员"}, Note: "已排查"})
	if err != nil {
		t.Fatalf("resume auto chain limit: %v", err)
	}
	h.rawCommit(rd.Changeset)
	wantKind(t, rd, core.OutcomeCommitted)

	agg := h.agg()
	cur := h.current(agg)
	wantEqual(t, "当前站仍是 n5", cur.GetNodeId(), "n5")
	wantEqual(t, "过滤后只剩李四一人", cur.GetAssigneeCount(), int32(1))
	h.task(agg, liSi.UserID, "PENDING")
}
