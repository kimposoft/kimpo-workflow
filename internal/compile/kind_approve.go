package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// kind_approve.go 登记审批节点在发布期怎么摊平：人员来源（A，字段名叫 Approvers）与
// 办理方式（D）的摊平逻辑与办理节点共用 staticUserIDsAndSources / passRuleOf；审批特有
// 审批按钮清单（原样落 JSON，运行期按钮校验与回退方式都由它反查）、结果 / 理由绑定字段
// （K4 只允许主表文本字段，校验见 compile/fieldtype.go）。字段引用四类：字段权限、回退清空、
// 结果绑定字段、理由绑定字段。
func init() {
	registerKind(model.NodeKindApprove, kindSpec{
		defaultName: "审批",
		publishable: true,
		compile: func(n *model.Node, nc *NodeCompiled) error {
			cfg, err := model.ApproveConfigOf(n)
			if err != nil {
				return err
			}
			nc.NoRouteHint = cfg.NoRouteHint
			nc.PassRule, nc.PassRatio = passRuleOf(cfg.CompleteMode)
			if nc.StaticUserIDs, nc.SourcesJSON, err = staticUserIDsAndSources(cfg.Approvers); err != nil {
				return err
			}
			// 过滤器，归一化同办理节点。
			nc.RelationFilters = cfg.RelationFilters
			// 宿主依赖键经 SDK 类型化编码（见 hostkeys.go）。
			enc := &hostKeyEncoder{}
			enc.set(&nc.FieldPermissionsJSON, func() (string, error) { return encodeFieldPermissions(cfg.FieldPermissions) })
			enc.set(&nc.ClearOnWithdrawJSON, func() (string, error) { return encodeClearOnWithdraw(cfg.ClearOnWithdraw) })
			enc.set(&nc.ApproveButtonsJSON, func() (string, error) { return encodeApproveButtons(cfg.Buttons) })
			if enc.err != nil {
				return enc.err
			}
			nc.ResultFieldID, nc.ReasonFieldID = cfg.ResultFieldID, cfg.ReasonFieldID
			nc.SummaryDocumentJSON = string(cfg.SummaryExpr)
			nc.AutoConditionDocJSON = string(cfg.AutoCompleteCondition)
			// 节点级通知配置：只认 OnAssigned/OnReturned 两个键，与办理节点同一套语义。
			nc.NotifyJSON = marshalOrEmpty(cfg.Notify)
			return nil
		},
		fieldRefs: func(n *model.Node, sink *refSink) {
			cfg, err := model.ApproveConfigOf(n)
			if err != nil {
				return
			}
			permFieldRefs(sink, n.ID, cfg.FieldPermissions)
			clearFieldRefs(sink, n.ID, cfg.ClearOnWithdraw)
			if cfg.ResultFieldID != "" {
				sink.add(FieldRef{FieldID: cfg.ResultFieldID, RefKind: RefKindApproveBind, NodeID: n.ID})
			}
			if cfg.ReasonFieldID != "" {
				sink.add(FieldRef{FieldID: cfg.ReasonFieldID, RefKind: RefKindApproveBind, NodeID: n.ID})
			}
		},
		expressions: func(n *model.Node, add exprAdder) {
			cfg, err := model.ApproveConfigOf(n)
			if err == nil {
				add(n.ID+":summary", PurposeCompute, cfg.SummaryExpr, exprSlot{nodeID: n.ID, field: "summary"})
				add(n.ID+":auto", PurposeJudge, cfg.AutoCompleteCondition, exprSlot{nodeID: n.ID, field: "auto"})
			}
		},
	})
}
