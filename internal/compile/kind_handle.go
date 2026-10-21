package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// kind_handle.go 登记办理节点在发布期怎么摊平：人员来源（A）摊成静态用户 id +
// 原始清单 JSON（staticUserIDsAndSources，与审批共用）、办理方式（D）摊成 PassRule/PassRatio、
// 字段权限（B-可编辑型）、回退相关（E：可用回退方式 / 回退清空字段）、无路提示（N2 必填）、
// 自动办理条件（F）与步骤摘要（H）两条待冻结表达式。字段引用三类：字段权限、回退清空、
// 「人员来源=主表字段」时该字段本身也算一条引用（按值匹配人要读这个字段）。
func init() {
	registerKind(model.NodeKindHandle, kindSpec{
		defaultName: "办理",
		publishable: true,
		compile: func(n *model.Node, nc *NodeCompiled) error {
			cfg, err := model.HandleConfigOf(n)
			if err != nil {
				return err
			}
			nc.NoRouteHint = cfg.NoRouteHint
			nc.PassRule, nc.PassRatio = passRuleOf(cfg.CompleteMode)
			if nc.StaticUserIDs, nc.SourcesJSON, err = staticUserIDsAndSources(cfg.Assignees); err != nil {
				return err
			}
			// 过滤器：cfg 已经过 model.HandleConfigOf 的归一化，Assignees 里
			// 不会再混着 relation 条目，这里只是把归一化后的过滤器清单原样带出。
			nc.RelationFilters = cfg.RelationFilters
			// 宿主依赖键经 SDK 类型化编码（见 hostkeys.go）。
			enc := &hostKeyEncoder{}
			enc.set(&nc.FieldPermissionsJSON, func() (string, error) { return encodeFieldPermissions(cfg.FieldPermissions) })
			enc.set(&nc.ClearOnWithdrawJSON, func() (string, error) { return encodeClearOnWithdraw(cfg.ClearOnWithdraw) })
			if enc.err != nil {
				return enc.err
			}
			nc.AllowedWithdrawsJSON = marshalOrEmpty(cfg.AllowedWithdrawMethods)
			nc.SummaryDocumentJSON = string(cfg.SummaryExpr)
			nc.AutoConditionDocJSON = string(cfg.AutoCompleteCondition)
			// 节点级通知配置：只认 OnAssigned/OnReturned 两个键。
			nc.NotifyJSON = marshalOrEmpty(cfg.Notify)
			return nil
		},
		fieldRefs: func(n *model.Node, sink *refSink) {
			cfg, err := model.HandleConfigOf(n)
			if err != nil {
				return
			}
			permFieldRefs(sink, n.ID, cfg.FieldPermissions)
			clearFieldRefs(sink, n.ID, cfg.ClearOnWithdraw)
			for _, src := range cfg.Assignees {
				if src.Kind == model.AssigneeSourceMainField && src.MainFieldID != "" {
					sink.add(FieldRef{FieldID: src.MainFieldID, RefKind: RefKindFieldPerm, NodeID: n.ID})
				}
			}
		},
		expressions: func(n *model.Node, add exprAdder) {
			cfg, err := model.HandleConfigOf(n)
			if err == nil {
				add(n.ID+":summary", PurposeCompute, cfg.SummaryExpr, exprSlot{nodeID: n.ID, field: "summary"})
				add(n.ID+":auto", PurposeJudge, cfg.AutoCompleteCondition, exprSlot{nodeID: n.ID, field: "auto"})
			}
		},
	})
}
