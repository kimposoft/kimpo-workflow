package compile

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// ExpressionPurpose 三种用途，与宿主 ExpressionService 的 ExpressionPurpose 对齐。
type ExpressionPurpose string

const (
	PurposeJudge   ExpressionPurpose = "JUDGE"
	PurposeValue   ExpressionPurpose = "VALUE"
	PurposeCompute ExpressionPurpose = "COMPUTE"
)

// ExpressionSpec 一条待冻结表达式；ExpressionID 约定：引导线 = link_id，节点摘要 = "<node_id>:summary"，
// 自动办理 = "<node_id>:auto"，抄送标题 / 正文 = "<node_id>:title" / "<node_id>:body"。
type ExpressionSpec struct {
	ExpressionID string
	Purpose      ExpressionPurpose
	DocumentJSON string
}

// FrozenExpression 冻结结果。
type FrozenExpression struct {
	ExpressionID     string
	PublicationID    string
	ReferencedFields []FieldRef
}

// FreezeInput / FreezeOutput 冻结端口的入参与出参。Issues 非空时 Frozen 为空（整批不落库）。
type FreezeInput struct {
	AppID        string
	TemplateID   string
	DefinitionID string
	VersionNo    int64
	Specs        []ExpressionSpec
}

type FreezeOutput struct {
	Frozen []FrozenExpression
	Issues []model.Diagnostic
}

// Freezer 是宿主 ExpressionService.Freeze 的端口（transport 层用 gRPC 客户端实现）。
type Freezer interface {
	Freeze(ctx context.Context, in FreezeInput) (FreezeOutput, error)
}

// collectExpressions 从文档收集全部要冻结的表达式；返回 spec 清单与「expression_id → 回填位置」。
// 引导线的条件表达式与节点无关，直接在这里收；每类节点具体收哪些表达式槽由 specOf(n.Kind)
// 查到的 kindSpec.expressions 决定（compile/kind_<kind>.go），通过 add 闭包（类型 exprAdder）登记。
func collectExpressions(doc *model.Document) ([]ExpressionSpec, map[string]exprSlot, []model.Diagnostic) {
	var specs []ExpressionSpec
	slots := map[string]exprSlot{}
	var issues []model.Diagnostic
	add := func(id string, purpose ExpressionPurpose, raw json.RawMessage, slot exprSlot) {
		if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
			return
		}
		specs = append(specs, ExpressionSpec{ExpressionID: id, Purpose: purpose, DocumentJSON: string(raw)})
		slots[id] = slot
	}
	for i := range doc.Links {
		l := &doc.Links[i]
		add(l.ID, PurposeJudge, l.ConditionDoc, exprSlot{linkID: l.ID})
	}
	for i := range doc.Nodes {
		n := &doc.Nodes[i]
		if spec, ok := specOf(n.Kind); ok && spec.expressions != nil {
			spec.expressions(n, add)
		}
	}
	return specs, slots, issues
}

// exprSlot 记录冻结结果要回填到 CompiledDefinition 的哪个位置。
type exprSlot struct {
	linkID string
	nodeID string
	field  string // summary | auto | title | body
}
