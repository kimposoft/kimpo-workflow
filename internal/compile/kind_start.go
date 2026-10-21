package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// kind_start.go 登记发起节点在发布期怎么摊平：目标模板 / 允许人工发起 / 无路提示 /
// 发起权限 / 字段权限（B-可编辑型）原样搬进 NodeCompiled；字段引用两类——字段权限、发起权限
// 的主表字段来源（N1.8，与办理/审批节点「人员来源=主表字段」同一登记口径，都落 RefKindFieldPerm，
// 见 kind_handle.go 同款写法）；待冻结表达式两条——步骤摘要（H）、发起条件（N1.7，PurposeJudge，
// 槽位 field 记为 "start_cond"，照抄办理/审批节点自动办理条件 <node>:auto 的做法）。发起节点是
// 流程入口、恒可发布，publishable 恒真。
func init() {
	registerKind(model.NodeKindStart, kindSpec{
		defaultName: "发起",
		publishable: true,
		compile: func(n *model.Node, nc *NodeCompiled) error {
			cfg, err := model.StartConfigOf(n)
			if err != nil {
				return err
			}
			nc.TargetTemplateID, nc.AllowManualStart, nc.NoRouteHint = cfg.TargetTemplateID, cfg.AllowManualStart, cfg.NoRouteHint
			// 宿主依赖键经 SDK 类型化编码（见 hostkeys.go）。
			enc := &hostKeyEncoder{}
			enc.set(&nc.StartPermissionJSON, func() (string, error) { return encodeStartPermission(cfg.StartPermission) })
			enc.set(&nc.FieldPermissionsJSON, func() (string, error) { return encodeFieldPermissions(cfg.FieldPermissions) })
			if enc.err != nil {
				return enc.err
			}
			nc.SummaryDocumentJSON = string(cfg.SummaryExpr)
			// 发起条件文档原样带进编译产物；发布物 id 由冻结回填（compile.go switch 的
			// "start_cond" 分支），提示文本直接摊平（不是表达式，不必等冻结）。
			nc.StartConditionDocJSON = string(cfg.StartCondition)
			nc.StartConditionHint = cfg.StartConditionHint
			// 节点级通知配置：只认 OnReturned/OnWithdrawn/OnTerminated 三个键，运行期
			// 经 NodeCompiled.Notify() 反序列化读取。
			nc.NotifyJSON = marshalOrEmpty(cfg.Notify)
			return nil
		},
		fieldRefs: func(n *model.Node, sink *refSink) {
			cfg, err := model.StartConfigOf(n)
			if err != nil {
				return
			}
			permFieldRefs(sink, n.ID, cfg.FieldPermissions)
			// 发起权限的主表字段来源本身也算一条字段引用（按值匹配人要读这个字段），
			// 与办理/审批节点「人员来源=主表字段」同一登记口径（见 kind_handle.go）。
			if cfg.StartPermission.MainFieldID != "" {
				sink.add(FieldRef{FieldID: cfg.StartPermission.MainFieldID, RefKind: RefKindFieldPerm, NodeID: n.ID})
			}
		},
		expressions: func(n *model.Node, add exprAdder) {
			cfg, err := model.StartConfigOf(n)
			if err == nil {
				add(n.ID+":summary", PurposeCompute, cfg.SummaryExpr, exprSlot{nodeID: n.ID, field: "summary"})
				add(n.ID+":start_cond", PurposeJudge, cfg.StartCondition, exprSlot{nodeID: n.ID, field: "start_cond"})
			}
		},
	})
}
