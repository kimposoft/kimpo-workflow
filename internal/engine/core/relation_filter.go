package core

import (
	"context"
	"encoding/json"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// relation_filter.go 是『过滤器：与上步处理人的关系』在引擎侧算候选的共用实现。「关系」是筛人
// 而不是加人：先按其余来源算出候选，再只留下满足所选关系的人（旧编译产物里「关系」仍是来源之一、
// 按并集加人，见下方兼容说明）。
//
// 办理 / 审批到达（node_human.go）与抄送到达（cc.go）两处「算候选」都要走这里，不能各写一份
// （assignee_rules.go 同款纪律：同一件事两处各判一次，口径迟早漂）：
//  1. 先照旧调一次 Resolve（target.SourcesJSON 是唯一入口——旧编译产物的关系仍以来源形态躺在
//     这份清单里，这一步天然按旧语义把它们并进 people；此时 target.RelationFilters 必为空
//     （见 compile/kind_handle.go 等：新编译产物的过滤器摘自归一化后的 Assignees，两者不会
//     同时非空），下面第 2 步直接短路返回 people，行为与旧语义逐字节一致——这正是旧编译产物
//     的兼容路径，不需要另外分支）；
//  2. target.RelationFilters 非空（新编译产物）时，再调一次 Resolve，来源清单只由过滤器合成
//     （每种关系一条 relation 来源），staticUserIDs 传空——这一次算出的是「允许保留的人」
//     （A3：以每个上步处理人为基准、对每种关系分别算，取并集）；
//  3. 结果 = 第一次候选 ∩ 允许保留的人，保持第一次候选原有顺序不变（不因为筛选打乱候选顺序，
//     选人对话框、任务派发都按这个顺序）。
//
// 交集为空：直接把空切片原样返回，不用另开分支——调用方（node_human.go 的
// OutcomeNoCandidate、cc.go 的「收件人为空不发」）本来就是按 len(people)==0 判定，交集为空与
// 「本来候选就是空」两种情况走的是同一条既有代码路径。
//
// 第二次调用天然不会撞上 hostclient.SourcesToPB 的两个收尾分支：
//   - 「来源清单为空时用 staticUserIDs 兜底成一条 USER 来源」：这里传的来源清单非空（只由
//     relation 条目组成），不会触发；
//   - 「发起人来源补一条 USER 来源」（A11 收尾）：这里合成的来源清单里没有 initiator 条目，
//     不会触发。
//
// 两条都在 relation_filter_test.go 用 RecordingCandidate.CallLog 钉住第二次调用的确切入参。
func resolveCandidatesFiltered(ctx context.Context, cand ports.Candidate, rec ports.RecordRef, target *compile.NodeCompiled, staticUserIDs []int64, prev []int64, label string) ([]ports.Person, error) {
	people, err := cand.Resolve(ctx, rec, staticUserIDs, target.SourcesJSON, prev)
	if err != nil {
		return nil, errf("CANDIDATE_FAILED", "node %s %s: %v", target.NodeID, label, err)
	}
	if len(target.RelationFilters) == 0 {
		return people, nil
	}
	filterSourcesJSON, err := relationFilterSourcesJSON(target.RelationFilters)
	if err != nil {
		return nil, errf("CANDIDATE_FAILED", "node %s %s relation filter: %v", target.NodeID, label, err)
	}
	allowed, err := cand.Resolve(ctx, rec, nil, filterSourcesJSON, prev)
	if err != nil {
		return nil, errf("CANDIDATE_FAILED", "node %s %s relation filter: %v", target.NodeID, label, err)
	}
	allowedIDs := make(map[int64]bool, len(allowed))
	for _, p := range allowed {
		allowedIDs[p.UserID] = true
	}
	// 不复用 people 的底层数组：people 可能被调用方留作别的用途（目前没有，但共用切片底层
	// 数组是隐蔽的别名坑，宁可多分配一次）。
	out := make([]ports.Person, 0, len(people))
	for _, p := range people {
		if allowedIDs[p.UserID] {
			out = append(out, p)
		}
	}
	return out, nil
}

// relationFilterSourcesJSON 把过滤器的关系档清单合成一份只含 relation 来源的 JSON，喂给第二次
// Resolve——形状与设计器写进 SourcesJSON 里的旧 relation 来源条目完全一致（复用
// hostclient.SourcesToPB 里现成的 relation 翻译分支，不用另开一条路）。
func relationFilterSourcesJSON(filters []model.AssigneeRelation) (string, error) {
	sources := make([]model.AssigneeSource, 0, len(filters))
	for _, f := range filters {
		sources = append(sources, model.AssigneeSource{Kind: model.AssigneeSourceRelation, Relation: f})
	}
	raw, err := json.Marshal(sources)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
