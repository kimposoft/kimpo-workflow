package model

import (
	"encoding/json"
	"testing"
)

// config_test.go 覆盖 HandleConfigOf / ApproveConfigOf / CCConfigOf 解码后的归一化
// （normalizeRelationSources）：旧文档里按来源配置的『与上步
// 处理人的关系』就地改记为过滤器，去重、保序、与已有过滤器合并、幂等，三类节点各验一条。

func nodeCfg(t *testing.T, kind NodeKind, v any) *Node {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return &Node{ID: "n1", Kind: kind, Config: raw}
}

// TestHandleConfigOf_NormalizeRelationSources：旧形状（Assignees 里混了两条 relation 来源）
// 解码后应当改记为 RelationFilters（去重、保持首次出现顺序），来源清单里的 relation 条目被摘掉，
// 其余来源原样保留。
func TestHandleConfigOf_NormalizeRelationSources(t *testing.T) {
	n := nodeCfg(t, NodeKindHandle, HandleConfig{
		Assignees: []AssigneeSource{
			{Kind: AssigneeSourceUser, UserIDs: IDList{22}},
			{Kind: AssigneeSourceRelation, Relation: AssigneeRelationSameDept},
			{Kind: AssigneeSourceRelation, Relation: AssigneeRelationDeptManager},
			{Kind: AssigneeSourceRelation, Relation: AssigneeRelationSameDept}, // 重复，去重
		},
	})
	cfg, err := HandleConfigOf(n)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Assignees) != 1 || cfg.Assignees[0].Kind != AssigneeSourceUser {
		t.Fatalf("relation 条目应被摘出来源清单，只留下用户来源：%+v", cfg.Assignees)
	}
	want := []AssigneeRelation{AssigneeRelationSameDept, AssigneeRelationDeptManager}
	if !relationsEqual(cfg.RelationFilters, want) {
		t.Fatalf("过滤器应为 %v（去重保序），实得 %v", want, cfg.RelationFilters)
	}
}

// TestApproveConfigOf_NormalizeRelationSources_MergeWithExisting：已有过滤器时，来源清单里的
// relation 条目并入而不是覆盖，已在过滤器里的不重复加。
func TestApproveConfigOf_NormalizeRelationSources_MergeWithExisting(t *testing.T) {
	n := nodeCfg(t, NodeKindApprove, ApproveConfig{
		Approvers: []AssigneeSource{
			{Kind: AssigneeSourceRole, RoleIDs: []string{"role-1"}},
			{Kind: AssigneeSourceRelation, Relation: AssigneeRelationChildDept},
			{Kind: AssigneeSourceRelation, Relation: AssigneeRelationSameDept}, // 已在 RelationFilters 里，不重复加
		},
		RelationFilters: []AssigneeRelation{AssigneeRelationSameDept},
	})
	cfg, err := ApproveConfigOf(n)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Approvers) != 1 || cfg.Approvers[0].Kind != AssigneeSourceRole {
		t.Fatalf("relation 条目应被摘出，只留下角色来源：%+v", cfg.Approvers)
	}
	want := []AssigneeRelation{AssigneeRelationSameDept, AssigneeRelationChildDept}
	if !relationsEqual(cfg.RelationFilters, want) {
		t.Fatalf("已有过滤器应保留在前，新摘出的追加在后且不重复：%v", cfg.RelationFilters)
	}
}

// TestCCConfigOf_NormalizeRelationSources：抄送节点收件人清单同样归一化。
func TestCCConfigOf_NormalizeRelationSources(t *testing.T) {
	n := nodeCfg(t, NodeKindCC, CCConfig{
		Recipients: []AssigneeSource{
			{Kind: AssigneeSourceRelation, Relation: AssigneeRelationParentDeptMgr},
		},
	})
	cfg, err := CCConfigOf(n)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Recipients) != 0 {
		t.Fatalf("relation 条目应被摘空：%+v", cfg.Recipients)
	}
	want := []AssigneeRelation{AssigneeRelationParentDeptMgr}
	if !relationsEqual(cfg.RelationFilters, want) {
		t.Fatalf("过滤器应为 %v，实得 %v", want, cfg.RelationFilters)
	}
}

// TestNormalizeRelationSources_Idempotent：对已经归一化过的形状（来源里没有 relation 条目）
// 重复解码，结果必须与第一次一致，不因为反复解码而漂移或报错。
func TestNormalizeRelationSources_Idempotent(t *testing.T) {
	n := nodeCfg(t, NodeKindHandle, HandleConfig{
		Assignees:       []AssigneeSource{{Kind: AssigneeSourceUser, UserIDs: IDList{22}}},
		RelationFilters: []AssigneeRelation{AssigneeRelationSameDept},
	})
	first, err := HandleConfigOf(n)
	if err != nil {
		t.Fatal(err)
	}
	// 用第一次解码的结果重新编码，模拟「保存一次后再打开」。
	raw, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HandleConfigOf(&Node{ID: "n1", Kind: NodeKindHandle, Config: raw})
	if err != nil {
		t.Fatal(err)
	}
	if !relationsEqual(first.RelationFilters, second.RelationFilters) {
		t.Fatalf("幂等：两次解码的过滤器应一致，第一次 %v 第二次 %v", first.RelationFilters, second.RelationFilters)
	}
	if len(second.Assignees) != 1 || second.Assignees[0].Kind != AssigneeSourceUser {
		t.Fatalf("幂等：来源清单不该被二次解码改变：%+v", second.Assignees)
	}
}

func relationsEqual(a, b []AssigneeRelation) bool {
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
