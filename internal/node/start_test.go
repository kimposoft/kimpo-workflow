package node

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// startNode 夹具复用 notify_rules_test.go 已有的同名 helper（同包，不重复定义）。

// 发起节点配全时不报任何诊断（目标模板 + 无路提示，没配发起条件）。
func TestStartValidate_HappyPath(t *testing.T) {
	h := NewStartHandler()
	got := h.Validate(nil, startNode(t, model.StartConfig{
		TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走",
	}))
	if len(got) != 0 {
		t.Fatalf("配全的发起节点不该有诊断，实得 %+v", got)
	}
}

// 配了发起条件但没填「不满足发起条件时的提示」→ N1_START_CONDITION_HINT_REQUIRED；
// 提示全是空白字符等同没填；配了条件又填了提示 → 放行；没配条件不要求提示。
func TestStartValidate_StartConditionHintRequired(t *testing.T) {
	h := NewStartHandler()
	base := model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走"}

	noCondition := base
	if codes(h.Validate(nil, startNode(t, noCondition)))["N1_START_CONDITION_HINT_REQUIRED"] {
		t.Fatal("没配发起条件不该要求提示")
	}

	missingHint := base
	missingHint.StartCondition = json.RawMessage(`{"mode":"condition"}`)
	if !codes(h.Validate(nil, startNode(t, missingHint)))["N1_START_CONDITION_HINT_REQUIRED"] {
		t.Fatal("配了发起条件却没填提示，应报 N1_START_CONDITION_HINT_REQUIRED")
	}

	blankHint := base
	blankHint.StartCondition = json.RawMessage(`{"mode":"condition"}`)
	blankHint.StartConditionHint = "   "
	if !codes(h.Validate(nil, startNode(t, blankHint)))["N1_START_CONDITION_HINT_REQUIRED"] {
		t.Fatal("提示全是空白字符，等同没填，应报 N1_START_CONDITION_HINT_REQUIRED")
	}

	nullCondition := base
	nullCondition.StartCondition = json.RawMessage(`null`)
	if !json.Valid(nullCondition.StartCondition) {
		t.Fatal("测试数据本身非法 JSON")
	}
	if codes(h.Validate(nil, startNode(t, nullCondition)))["N1_START_CONDITION_HINT_REQUIRED"] {
		t.Fatal("字面量 null 等同没配条件，不该要求提示（与 compile.collectExpressions 的 add 同一口径）")
	}

	filled := base
	filled.StartCondition = json.RawMessage(`{"mode":"condition"}`)
	filled.StartConditionHint = "金额超限，不能发起"
	if codes(h.Validate(nil, startNode(t, filled)))["N1_START_CONDITION_HINT_REQUIRED"] {
		t.Fatal("配了条件又填了提示，不该报诊断")
	}
}
