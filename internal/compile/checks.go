package compile

import (
	"strconv"
	"unicode/utf8"

	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// linkNameMaxRunes 连线名称的字符数上限：按 rune 计，不按字节，
// 以免多字节字符（中文）被字节长度误判超限。
const linkNameMaxRunes = 20

// structuralChecks 发布期结构检查：
//   - 引导线端点必须存在且不自环；
//   - L10：除结束外每个主线节点至少一条主线出线（只挂支线的拒绝）；
//   - L11：至少一个结束节点，且每个结束节点都有入线（不做可达性检查，允许循环）；
//   - 结束节点不得有出线；
//   - 支持面：kindSpec.publishable 为 false 的类型（目前只有子流程）一律 NODE_KIND_UNSUPPORTED。
//
// 加上每类节点的 Handler.Validate（各节点的必填项与取值范围）与
// 每类节点自己的专属结构检查（kindSpec.checks，目前只有结束节点用，见 kind_end.go）。
func structuralChecks(doc *model.Document, g *graph, registry *node.Registry) []model.Diagnostic {
	var out []model.Diagnostic
	seenLinks := map[string]bool{}
	for i := range doc.Links {
		l := &doc.Links[i]
		if l.ID == "" || seenLinks[l.ID] {
			out = append(out, model.NewDiagnostic("LINK_ID_INVALID", "", l.ID, nil))
			continue
		}
		seenLinks[l.ID] = true
		if g.nodes[l.From] == nil || g.nodes[l.To] == nil {
			out = append(out, model.NewDiagnostic("LINK_ENDPOINT_UNKNOWN", "", l.ID, map[string]string{"from": l.From, "to": l.To}))
			continue
		}
		if l.From == l.To {
			out = append(out, model.NewDiagnostic("LINK_SELF_LOOP", l.From, l.ID, nil))
		}
		// 连线名称留空不检查（可空），超过 20 个字符发布拒绝；不做重名检查——同一节点的
		// 出线允许重名，名称也不出现在提交人的选路界面。
		if n := utf8.RuneCountInString(l.Name); n > linkNameMaxRunes {
			out = append(out, model.NewDiagnostic("LINK_NAME_TOO_LONG", "", l.ID, map[string]string{"length": strconv.Itoa(n), "max_length": strconv.Itoa(linkNameMaxRunes)}))
		}
	}

	endCount := 0
	for _, id := range g.order {
		n := g.nodes[id]
		// 支持面：未注册规格、或注册了但 publishable=false（目前只有子流程，见 kind_subflow.go
		// 那段长注释：设计器画得出来、引擎跑不了的节点必须在发布期就说清楚）。
		spec, known := specOf(n.Kind)
		if !known || !spec.publishable {
			out = append(out, model.NewDiagnostic("NODE_KIND_UNSUPPORTED", n.ID, "", map[string]string{"kind": string(n.Kind)}))
		}
		if h, ok := registry.Get(n.Kind); ok {
			out = append(out, h.Validate(doc, n)...)
		}
		if n.Kind == model.NodeKindEnd {
			endCount++
		}
		if known && spec.checks != nil {
			out = append(out, spec.checks(n, g)...)
		}
		if n.Kind == model.NodeKindEnd {
			continue
		}
		if traits, ok := node.TraitsOf(n.Kind); ok && traits.Main {
			mainOut := 0
			for _, l := range g.out[n.ID] {
				if g.isMainLink(l) {
					mainOut++
				}
			}
			if mainOut == 0 {
				out = append(out, model.NewDiagnostic("L10", n.ID, "", nil))
			}
		}
	}
	if endCount == 0 {
		out = append(out, model.NewDiagnostic("L11", "", "", map[string]string{"reason": "no_end_node"}))
	}
	return out
}
