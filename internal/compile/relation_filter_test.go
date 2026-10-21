package compile

import (
	"strings"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// relation_filter_test.go 覆盖『过滤器：与上步处理人的关系』在发布期编译的落地：
// 新编译产物的 RelationFilters 带出、SourcesJSON 里不再出现 relation
// 条目；只配过滤器不配来源发布拒绝。

// TestCompile_RelationFilters_FlattenedAndSourcesJSONClean：办理节点配「用户来源 + 关系过滤器」，
// 编译后 NodeCompiled.RelationFilters 带出，SourcesJSON 只剩用户来源（没有 relation 条目）。
func TestCompile_RelationFilters_FlattenedAndSourcesJSONClean(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
		Assignees:       []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		RelationFilters: []model.AssigneeRelation{model.AssigneeRelationSameDept, model.AssigneeRelationDeptManager},
		CompleteMode:    model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint:     "审批后没有可走的路线",
	})
	res := compileOK(t, doc, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if len(res.Diagnostics) != 0 {
		t.Fatalf("来源+过滤器应放行，实得 %+v", res.Diagnostics)
	}
	n1 := nodeCompiledOf(t, res, "n1")
	want := []model.AssigneeRelation{model.AssigneeRelationSameDept, model.AssigneeRelationDeptManager}
	if !relationFiltersEqual(n1.RelationFilters, want) {
		t.Fatalf("RelationFilters 应为 %v，实得 %v", want, n1.RelationFilters)
	}
	if strings.Contains(n1.SourcesJSON, `"relation"`) {
		t.Fatalf("新编译产物 SourcesJSON 不应再出现 relation 条目：%s", n1.SourcesJSON)
	}
}

// TestCompile_RelationFilters_OldShapeNormalizedAtCompile：旧形状（Assignees 里直接混了 relation
// 来源，没有 RelationFilters）经编译期解码入口（model.HandleConfigOf）归一化后，编译产物里
// RelationFilters 带出、SourcesJSON 同样不含 relation——设计器草稿一旦重新发布，产物就是新形状。
func TestCompile_RelationFilters_OldShapeNormalizedAtCompile(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
		Assignees: []model.AssigneeSource{
			{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}},
			{Kind: model.AssigneeSourceRelation, Relation: model.AssigneeRelationChildDept},
		},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint:  "审批后没有可走的路线",
	})
	res := compileOK(t, doc, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if len(res.Diagnostics) != 0 {
		t.Fatalf("旧形状归一化后应放行，实得 %+v", res.Diagnostics)
	}
	n1 := nodeCompiledOf(t, res, "n1")
	want := []model.AssigneeRelation{model.AssigneeRelationChildDept}
	if !relationFiltersEqual(n1.RelationFilters, want) {
		t.Fatalf("旧形状应归一化进 RelationFilters，实得 %v", n1.RelationFilters)
	}
	if strings.Contains(n1.SourcesJSON, `"relation"`) {
		t.Fatalf("归一化后 SourcesJSON 不应再出现 relation 条目：%s", n1.SourcesJSON)
	}
}

// TestCompile_RelationFilters_WithoutSourceRejected：只配过滤器不配来源，编译期拒绝
// （A1_FILTER_WITHOUT_SOURCE，且不与 A1_SOURCE_REQUIRED 同时报），办理、审批、抄送三类节点
// 各验一条（A1 对三类节点都生效）。
func TestCompile_RelationFilters_WithoutSourceRejected(t *testing.T) {
	t.Run("handle", func(t *testing.T) {
		doc := f1Lite(t)
		doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
			RelationFilters: []model.AssigneeRelation{model.AssigneeRelationSameDept},
			CompleteMode:    model.CompleteMode{Kind: model.CompleteModeAny},
			NoRouteHint:     "x",
		})
		res := compileOK(t, doc, &fakeFreezer{})
		if !hasCode(res.Diagnostics, "A1_FILTER_WITHOUT_SOURCE", "n1") || res.Compiled != nil {
			t.Fatalf("办理节点只配过滤器应拒绝：%+v", res.Diagnostics)
		}
		if hasCode(res.Diagnostics, "A1_SOURCE_REQUIRED", "n1") {
			t.Fatalf("不该同时报 A1_SOURCE_REQUIRED：%+v", res.Diagnostics)
		}
	})
	t.Run("approve", func(t *testing.T) {
		doc := f1Lite(t)
		doc.Nodes[1] = model.Node{ID: "n1", Kind: model.NodeKindApprove, Name: "审批", Config: cfgJSON(t, model.ApproveConfig{
			RelationFilters: []model.AssigneeRelation{model.AssigneeRelationSameDept},
			CompleteMode:    model.CompleteMode{Kind: model.CompleteModeAny},
			Buttons:         []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove}},
			NoRouteHint:     "x",
		})}
		res := compileOK(t, doc, &fakeFreezer{})
		if !hasCode(res.Diagnostics, "A1_FILTER_WITHOUT_SOURCE", "n1") || res.Compiled != nil {
			t.Fatalf("审批节点只配过滤器应拒绝：%+v", res.Diagnostics)
		}
	})
	t.Run("cc", func(t *testing.T) {
		doc := f1Lite(t)
		doc.Nodes = append(doc.Nodes, model.Node{ID: "n4", Kind: model.NodeKindCC, Name: "抄送", Config: cfgJSON(t, model.CCConfig{
			RelationFilters: []model.AssigneeRelation{model.AssigneeRelationSameDept},
			Channels:        []model.NotifyChannel{model.NotifyChannelSystem},
			TitleExpr:       cfgJSON(t, "t"),
			ContentExpr:     cfgJSON(t, "c"),
		})})
		doc.Links = append(doc.Links, model.Link{ID: "l3", From: "n1", To: "n4"})
		res := compileOK(t, doc, &fakeFreezer{})
		if !hasCode(res.Diagnostics, "A1_FILTER_WITHOUT_SOURCE", "n4") || res.Compiled != nil {
			t.Fatalf("抄送节点只配过滤器应拒绝：%+v", res.Diagnostics)
		}
	})
}

func relationFiltersEqual(a, b []model.AssigneeRelation) bool {
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
