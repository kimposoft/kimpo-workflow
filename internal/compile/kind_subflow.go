package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// kind_subflow.go 登记子流程节点在发布期怎么摊平：目标流程、传递字段清单、
// 等待档、父流程先结束时的处置。子流程没有人员来源，配置落在各自的专属字段
// （SubflowTargetDefinitionID / SubflowMappingsJSON / SubflowWait / SubflowDisposition），
// 不碰 SourcesJSON——那个字段的语义是「人员来源清单」，由宿主 CandidateService 消费，
// 塞别的东西进去运行期一读就串味。
//
// publishable 为 true：engine/core/subflow.go 算出「要发起
// 几个子实例、各带什么值」交给 Decision.PendingSubflowStarts，engine/app/service.go 的
// commitLoop 在父实例提交之后逐个建单 → Start → 回写父子链接（CommitLinks），发起反复失败
// 开 SUBFLOW_START_FAILED 事故（ParkSubflowStart）。等待回推、父先结束的强制结束、回退删
// 子实例属于「发起之后还会发生什么」，与「能不能发起」是两件事，不影响这里放行。
// 呼应 compile/compile_test.go 的 TestSubflowPublishable 与 compile/kinds_test.go
// 的 TestKindRegistry_SubflowPublishable。
//
// 「目标流程存在 / 同应用 / 已发布」与「传递字段来源目标类型须相同或目标为文本」两道闸在
// compile/subflowmap.go（与本文件并列，跑在 compile.go 的 Compile 里，不摊进 kindSpec.compile /
// fieldRefs 这两个字段——那两个只管「配置怎么摊平」「登记哪些字段引用」，这两道闸管「配置合不
// 合法」，与绑定字段类型闸（fieldtype.go）同一层级）。
func init() {
	registerKind(model.NodeKindSubflow, kindSpec{
		defaultName: "子流程",
		publishable: true,
		compile: func(n *model.Node, nc *NodeCompiled) error {
			cfg, err := model.SubflowConfigOf(n)
			if err != nil {
				return err
			}
			nc.SubflowTargetDefinitionID = cfg.TargetWorkflowID
			nc.SubflowMappingsJSON = marshalOrEmpty(cfg.FieldMappings)
			nc.SubflowWait = cfg.Wait
			nc.SubflowDisposition = string(cfg.Disposition)
			return nil
		},
		fieldRefs: func(n *model.Node, sink *refSink) {
			if cfg, err := model.SubflowConfigOf(n); err == nil {
				for _, m := range cfg.FieldMappings {
					if m.SourceFieldID != "" {
						sink.add(FieldRef{DataTableID: m.SourceTableID, FieldID: m.SourceFieldID, RefKind: RefKindSubflowMap, NodeID: n.ID})
					}
				}
			}
		},
	})
}
