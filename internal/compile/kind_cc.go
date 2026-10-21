package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// kind_cc.go 登记抄送节点在发布期怎么摊平：收件人清单（同『人员来源』，原样落
// SourcesJSON）、通知渠道、标题 / 正文两条宿主 V4 取值表达式（发布期冻结成发布物，运行期
// 到达时求一次）、字段权限（B-只看型）。字段引用只有字段权限一类；标题 / 正文里的字段引用
// 由宿主冻结后回填的 ReferencedFields 承担（见 compile.go Compile 里的 RefKindCCText 分支），
// 不在这里重复登记。
func init() {
	registerKind(model.NodeKindCC, kindSpec{
		defaultName: "抄送",
		publishable: true,
		compile: func(n *model.Node, nc *NodeCompiled) error {
			cfg, err := model.CCConfigOf(n)
			if err != nil {
				return err
			}
			// 宿主依赖键经 SDK 类型化编码（见 hostkeys.go）。
			enc := &hostKeyEncoder{}
			enc.set(&nc.SourcesJSON, func() (string, error) { return encodeSources(cfg.Recipients) })
			// 过滤器，归一化同办理节点；抄送节点没有 StaticUserIDs 摊平这一步，
			// 过滤器直接原样带出即可。
			nc.RelationFilters = cfg.RelationFilters
			enc.set(&nc.FieldPermissionsJSON, func() (string, error) { return encodeFieldPermissions(cfg.FieldPermissions) })
			if enc.err != nil {
				return enc.err
			}
			nc.CCChannelsJSON = marshalOrEmpty(cfg.Channels)
			nc.TitleDocumentJSON, nc.ContentDocumentJSON = string(cfg.TitleExpr), string(cfg.ContentExpr)
			return nil
		},
		fieldRefs: func(n *model.Node, sink *refSink) {
			if cfg, err := model.CCConfigOf(n); err == nil {
				permFieldRefs(sink, n.ID, cfg.FieldPermissions)
			}
		},
		expressions: func(n *model.Node, add exprAdder) {
			cfg, err := model.CCConfigOf(n)
			if err == nil {
				add(n.ID+":title", PurposeValue, cfg.TitleExpr, exprSlot{nodeID: n.ID, field: "title"})
				add(n.ID+":body", PurposeValue, cfg.ContentExpr, exprSlot{nodeID: n.ID, field: "body"})
			}
		},
	})
}
