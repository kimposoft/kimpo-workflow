package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// kind_end.go 登记结束节点在发布期怎么摊平：结束标识文本 + 写入字段（K4 只允许主表
// 文本字段，校验见 compile/fieldtype.go；运行期两段式提交写这个字段）。字段引用只有写入字段一类。结束节点还带一份**唯一的
// 专属结构检查**（其余五类都没有）：L11 要求每个结束节点都有入线或被审批按钮指定为目标（两者皆无的结束节点是画布上
// 摆设，永远到达不了）、END_HAS_OUTLINE 要求结束节点不得有出线（结束就是终点）。
func init() {
	registerKind(model.NodeKindEnd, kindSpec{
		defaultName: "结束",
		publishable: true,
		compile: func(n *model.Node, nc *NodeCompiled) error {
			cfg, err := model.EndConfigOf(n)
			if err != nil {
				return err
			}
			nc.EndLabel, nc.EndLabelFieldID = cfg.EndFlag, cfg.WriteFieldID
			// 节点级通知配置：只认 OnEnded 一个键。
			nc.NotifyJSON = marshalOrEmpty(cfg.Notify)
			return nil
		},
		fieldRefs: func(n *model.Node, sink *refSink) {
			if cfg, err := model.EndConfigOf(n); err == nil && cfg.WriteFieldID != "" {
				sink.add(FieldRef{FieldID: cfg.WriteFieldID, RefKind: RefKindEndLabelTarget, NodeID: n.ID})
			}
		},
		checks: func(n *model.Node, g *graph) []model.Diagnostic {
			var out []model.Diagnostic
			// L11（审批按钮可直达结束节点，故放宽）：没有入线，且没有任何审批按钮把它指定为目标，才报。
			if len(g.in[n.ID]) == 0 && !g.endRefs[n.ID] {
				out = append(out, model.NewDiagnostic("L11", n.ID, "", map[string]string{"reason": "end_without_inline"}))
			}
			if len(g.out[n.ID]) > 0 {
				out = append(out, model.NewDiagnostic("END_HAS_OUTLINE", n.ID, "", nil))
			}
			return out
		},
	})
}
