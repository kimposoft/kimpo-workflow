package node

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// TestValidateAssigneeSources_Initiator：「发起人」来源——单独配、或与其他
// 来源混配，都不产任何诊断（没有必填项，也不算「未配来源」）。
func TestValidateAssigneeSources_Initiator(t *testing.T) {
	got := validateAssigneeSources("n1", []model.AssigneeSource{{Kind: model.AssigneeSourceInitiator}}, nil)
	if len(got) != 0 {
		t.Fatalf("单独配「发起人」来源不该有诊断：%+v", got)
	}
	got = validateAssigneeSources("n1", []model.AssigneeSource{
		{Kind: model.AssigneeSourceInitiator},
		{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}},
	}, nil)
	if len(got) != 0 {
		t.Fatalf("「发起人」与其他来源混配不该有诊断：%+v", got)
	}
}

// TestValidateAssigneeSources_RelationFilter：「与上步处理人的关系」是过滤器而不是来源。
func TestValidateAssigneeSources_RelationFilter(t *testing.T) {
	// 只配过滤器、没配来源 → A1_FILTER_WITHOUT_SOURCE，且不再同时报 A1_SOURCE_REQUIRED。
	got := validateAssigneeSources("n1", nil, []model.AssigneeRelation{model.AssigneeRelationSameDept})
	if len(got) != 1 || got[0].Code != "A1_FILTER_WITHOUT_SOURCE" {
		t.Fatalf("只配过滤器应报 A1_FILTER_WITHOUT_SOURCE 且仅此一条：%+v", got)
	}

	// 来源与过滤器都空 → 仍是 A1_SOURCE_REQUIRED（没有「过滤器」这回事可提）。
	got = validateAssigneeSources("n1", nil, nil)
	if len(got) != 1 || got[0].Code != "A1_SOURCE_REQUIRED" {
		t.Fatalf("都空应报 A1_SOURCE_REQUIRED：%+v", got)
	}

	// 过滤器取值非法 → A_SOURCE_UNSUPPORTED（复用现有码，不新开）。
	got = validateAssigneeSources("n1", []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		[]model.AssigneeRelation{"not_a_relation"})
	if len(got) != 1 || got[0].Code != "A_SOURCE_UNSUPPORTED" {
		t.Fatalf("过滤器非法取值应报 A_SOURCE_UNSUPPORTED：%+v", got)
	}

	// 来源 + 合法过滤器 → 放行。
	got = validateAssigneeSources("n1", []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		[]model.AssigneeRelation{model.AssigneeRelationSameDept, model.AssigneeRelationDeptManager})
	if len(got) != 0 {
		t.Fatalf("来源+合法过滤器应放行：%+v", got)
	}
}

// TestValidateCompleteMode_All：「全部完成 / 会签」档——放行，且不看 PercentageBP
// （越界的百分比值不影响判定，因为这一档根本不读它）。
func TestValidateCompleteMode_All(t *testing.T) {
	if got := validateCompleteMode("n1", model.CompleteMode{Kind: model.CompleteModeAll}); len(got) != 0 {
		t.Fatalf("「全部/会签」档应放行：%+v", got)
	}
	if got := validateCompleteMode("n1", model.CompleteMode{Kind: model.CompleteModeAll, PercentageBP: 99999}); len(got) != 0 {
		t.Fatalf("「全部/会签」档不看 PercentageBP，越界值也不该报错：%+v", got)
	}
}
