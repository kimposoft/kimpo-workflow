package core

import (
	"context"
	"errors"
	"strings"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// 步骤摘要（通用件 H）：
//   - H1 配了计算表达式：到达时求一次；
//   - H2 没配：「某某发起的某某流程」+ 第一个主表自动编号值（没有就不附）——发起时算一次存进发起步骤，
//     之后各步默认摘要直接复用发起步骤那一份（发起人姓名只在发起那一刻可得）；
//   - H3 存进步骤与任务，之后单据数据变了不更新。

// defaultSummary H2：发起时计算。
func (e *Engine) defaultSummary(ctx context.Context, rec ports.RecordRef, c *compile.CompiledDefinition, flowName string, starter ports.Actor) (string, error) {
	text := starter.DisplayName + "发起的" + flowName
	if c.SerialFieldID != "" && e.Record != nil {
		exists, serial, err := e.Record.Header(ctx, rec, c.SerialFieldID)
		if err != nil {
			return "", errf("SYSTEM_ERROR", "read record header for summary: %v", err)
		}
		if exists && strings.TrimSpace(serial) != "" {
			text += " " + strings.TrimSpace(serial)
		}
	}
	return text, nil
}

// summaryFor 到达节点时的摘要：H1 优先，否则沿用发起步骤的 H2 摘要。
func (e *Engine) summaryFor(ctx context.Context, l *loaded, node *compile.NodeCompiled, actor ports.Actor) (string, error) {
	if node.SummaryPublicationID != "" {
		text, null, err := e.Expr.EvaluateComputed(ctx, l.rec, node.SummaryPublicationID, node.SummaryDocumentJSON, actor)
		if err != nil {
			code := "SYSTEM_ERROR"
			if errors.Is(err, ports.ErrExpressionInvalid) {
				code = "EXPRESSION_INVALID"
			}
			return "", errf(code, "summary of node %s: %v", node.NodeID, err)
		}
		if null {
			return "", nil
		}
		return text, nil
	}
	for _, s := range l.agg.GetSteps() {
		if s.GetNodeKind() == model.StepNodeKind(model.NodeKindStart) && s.GetSummaryText() != "" {
			return s.GetSummaryText(), nil
		}
	}
	return "", nil
}

// startStepSummary 发起步骤摘要：发起节点配了 H1 用 H1，否则 H2。
func (e *Engine) startStepSummary(ctx context.Context, rec ports.RecordRef, c *compile.CompiledDefinition, version *pb.DefinitionVersionRow, starter ports.Actor) (string, error) {
	start := c.Node(c.StartNodeID)
	if start != nil && start.SummaryPublicationID != "" {
		text, null, err := e.Expr.EvaluateComputed(ctx, rec, start.SummaryPublicationID, start.SummaryDocumentJSON, starter)
		if err != nil {
			return "", errf("SYSTEM_ERROR", "summary of start node: %v", err)
		}
		if !null && text != "" {
			return text, nil
		}
	}
	return e.defaultSummary(ctx, rec, c, version.GetName(), starter)
}
