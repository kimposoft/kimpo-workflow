package compile

import (
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// graph 是文档的结构视图：节点索引、出入线；用于 L2 主线判定与 K1 结构检查。
type graph struct {
	nodes map[string]*model.Node
	out   map[string][]*model.Link
	in    map[string][]*model.Link
	order []string // 节点按文档顺序
	// endRefs 被审批按钮（动作 end_flow）引用为目标的结束节点 id 集合（L11 放宽）：
	// 这类结束节点允许没有入线。只按按钮配置收集，不核对目标是否真为结束节点（那是节点校验的事）。
	endRefs map[string]bool
}

func buildGraph(doc *model.Document) *graph {
	g := &graph{nodes: map[string]*model.Node{}, out: map[string][]*model.Link{}, in: map[string][]*model.Link{}, endRefs: map[string]bool{}}
	for i := range doc.Nodes {
		n := &doc.Nodes[i]
		g.nodes[n.ID] = n
		g.order = append(g.order, n.ID)
		// 审批节点：收集 end_flow 按钮指向的结束节点；配置解码失败就跳过（由节点校验报错）。
		if n.Kind == model.NodeKindApprove {
			if cfg, err := model.ApproveConfigOf(n); err == nil {
				for _, btn := range cfg.Buttons {
					if btn.Action == model.ButtonActionEndFlow && btn.EndNodeID != "" {
						g.endRefs[btn.EndNodeID] = true
					}
				}
			}
		}
	}
	for i := range doc.Links {
		l := &doc.Links[i]
		g.out[l.From] = append(g.out[l.From], l)
		g.in[l.To] = append(g.in[l.To], l)
	}
	return g
}

// isTerminalAuxiliary 末级辅助节点：辅助节点且没有出线（L9 支线终点）。
func (g *graph) isTerminalAuxiliary(nodeID string) bool {
	n := g.nodes[nodeID]
	if n == nil {
		return false
	}
	if traits, ok := node.TraitsOf(n.Kind); ok && traits.Main {
		return false
	}
	return len(g.out[nodeID]) == 0
}

// isMainLink 主线出线：指向主线节点、或指向本身有出线的辅助节点；指向末级辅助节点的是支线。
func (g *graph) isMainLink(l *model.Link) bool {
	to := g.nodes[l.To]
	if to == nil {
		return false
	}
	if traits, ok := node.TraitsOf(to.Kind); ok && traits.Main {
		return true
	}
	return len(g.out[l.To]) > 0
}
