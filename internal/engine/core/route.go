package core

import (
	"context"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// route 对节点的主线出线求值：
//   - 恰一条成立 → 直接走；
//   - 多条成立 → 无 route_choice 返回 RouteChoiceRequired（不落库）；有则必须在命中集内（INVALID_CHOICE）；
//   - 零命中 → NoRoute（提示取自节点配置）；
//   - 求值系统性失败 → ROUTE_EVAL_FAILED（提交失败不暂存）；表达式失效同样归 ROUTE_EVAL_FAILED。
//
// 返回 (chosen, outcome, err)：chosen 非 nil 表示已选定；outcome 非 nil 表示需要人处理。
func (e *Engine) route(ctx context.Context, l *loaded, fromNodeID string, actor ports.Actor, choices Choices) (*compile.LinkCompiled, *Outcome, error) {
	node := l.compiled.Node(fromNodeID)
	if node == nil {
		return nil, nil, errf("SYSTEM_ERROR", "node %s not in compiled definition", fromNodeID)
	}
	var hits []compile.LinkCompiled
	for _, link := range l.compiled.MainOutLinks(fromNodeID) {
		if link.ConditionPublicationID == "" {
			hits = append(hits, link)
			continue
		}
		ok, err := e.Expr.EvaluateCondition(ctx, l.rec, link.ConditionPublicationID, link.ConditionDocumentJSON, actor)
		if err != nil {
			// 系统性失败与表达式失效同归 ROUTE_EVAL_FAILED（统一口径），
			// 原因保留在消息里供日志排障。
			return nil, nil, errf("ROUTE_EVAL_FAILED", "link %s condition: %v", link.LinkID, err)
		}
		if ok {
			hits = append(hits, link)
		}
	}
	switch len(hits) {
	case 0:
		// 抄送自己不配「无路可走时的提示」，由上溯到的最近可办理节点的设置处理；
		// 连续多个抄送一直往上找。有自己提示的节点就用自己的。
		return nil, &Outcome{Kind: OutcomeNoRoute, Hint: noRouteHintFor(l.compiled, fromNodeID)}, nil
	case 1:
		chosen := hits[0]
		return &chosen, nil, nil
	}
	if choices.RouteLinkID == "" {
		out := &Outcome{Kind: OutcomeRouteChoiceRequired, FromNodeID: fromNodeID}
		for _, h := range hits {
			to := l.compiled.Node(h.ToNodeID)
			name := ""
			if to != nil {
				name = to.NodeName
			}
			out.Routes = append(out.Routes, RouteOption{LinkID: h.LinkID, ToNodeID: h.ToNodeID, ToNodeName: name})
		}
		return nil, out, nil
	}
	for _, h := range hits {
		if h.LinkID == choices.RouteLinkID {
			chosen := h
			return &chosen, nil, nil
		}
	}
	return nil, nil, errf("INVALID_CHOICE", "route_choice %s is not among the %d matched links", choices.RouteLinkID, len(hits))
}
