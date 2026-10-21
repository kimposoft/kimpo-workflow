package node

import "github.com/kimposoft/kimpo-workflow/internal/model"

// SubflowHandler 是子流程节点的发布期校验实现（传递字段类型与目标流程状态在
// compile/subflowmap.go，本文件只留文档层能就地判断、不用查账本 / 字段目录的那几条）。
//
// 这里的四条校验：目标流程必填、传递字段的扩展表来源必须同一张、末级子流程只能不等待、
// 不等待时必须给出父流程结束后的处置。
//
// 两条**不在这里**校验，理由写清楚免得以后有人当疏漏补上：
//   - 「来源与目标类型须相同或目标为文本」与「目标流程是否存在 / 同应用 / 已发布」：
//     都要经 compile.Compiler 持有的 ports.DefinitionCatalog（查账本）与 ports.FieldCatalog
//     （查目标模板字段目录）两个端口，文档层（本文件）拿不到，已在 compile/subflowmap.go
//     的 subflowMappingChecks / subflowTargetDefinition 里实现，随 Compile 一起跑、DryRun
//     同闸。
type SubflowHandler struct{}

// NewSubflowHandler 构造 SubflowHandler。
func NewSubflowHandler() *SubflowHandler { return &SubflowHandler{} }

// Kind 见 Handler 接口。
func (h *SubflowHandler) Kind() model.NodeKind { return model.NodeKindSubflow }

// Traits 子流程：辅助节点，不派任务；撤销遇到它即拒（已经发起出去了）；可作支线终点。
func (h *SubflowHandler) Traits() Traits {
	return Traits{Withdraw: WithdrawBlockLaunched, BranchTarget: true}
}

// Validate 子流程节点的发布期校验。isTerminal 由文档图结构决定，这里通过 doc 反推：
// 节点没有任何出线即末级节点。
func (h *SubflowHandler) Validate(doc *model.Document, n *model.Node) []model.Diagnostic {
	cfg, err := model.SubflowConfigOf(n)
	if err != nil {
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}
	}
	var out []model.Diagnostic

	if cfg.TargetWorkflowID == "" {
		out = append(out, model.NewDiagnostic("N6_TARGET_REQUIRED", n.ID, "", nil))
	}

	// 传递字段里的扩展表字段只能来自同一张扩展表。来源表 id 为空的那些是主表字段，
	// 不参与这条判定。
	tables := map[string]bool{}
	for _, m := range cfg.FieldMappings {
		if m.SourceTableID != "" {
			tables[m.SourceTableID] = true
		}
		if m.TargetFieldID == "" {
			out = append(out, model.NewDiagnostic("N6_MAPPING_TARGET_REQUIRED", n.ID, "", map[string]string{"source_field_id": m.SourceFieldID}))
		}
	}
	if len(tables) > 1 {
		out = append(out, model.NewDiagnostic("N6_MAPPING_MULTI_TABLE", n.ID, "", map[string]string{"count": itoa(len(tables))}))
	}

	// 末级节点只能「不等待」——末级节点不影响主线，等待无从谈起。
	if isTerminalNode(doc, n.ID) && cfg.Wait {
		out = append(out, model.NewDiagnostic("N6_TERMINAL_MUST_NOT_WAIT", n.ID, "", nil))
	}
	// 不等待时必须给出父流程结束后的处置；等待时配了也不算错（面板会置灰，运行期不看）。
	if !cfg.Wait {
		switch cfg.Disposition {
		case model.SubflowDispositionIgnore, model.SubflowDispositionForceEnd:
		default:
			out = append(out, model.NewDiagnostic("N6_DISPOSITION_REQUIRED", n.ID, "", nil))
		}
	}
	return out
}

// isTerminalNode 节点有没有出线。doc 为 nil（单测直接调 Validate 的场合）时按「有出线」处理，
// 不去凭空断言它是末级节点。
func isTerminalNode(doc *model.Document, nodeID string) bool {
	if doc == nil {
		return false
	}
	for _, l := range doc.Links {
		if l.From == nodeID {
			return false
		}
	}
	return true
}
