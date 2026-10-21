package node

import "github.com/kimposoft/kimpo-workflow/internal/model"

// EndHandler 是结束节点的行为实现。这里做发布期校验（结束标识必填）；到达语义在
// engine/core/end.go（先写结束标识再标结束）。
type EndHandler struct{}

// NewEndHandler 构造 EndHandler。
func NewEndHandler() *EndHandler { return &EndHandler{} }

// Kind 见 Handler 接口。
func (h *EndHandler) Kind() model.NodeKind { return model.NodeKindEnd }

// Traits 结束：主线，不派任务，没有任何动作。
func (h *EndHandler) Traits() Traits {
	return Traits{Main: true, Withdraw: WithdrawBlockIfHuman}
}

// Validate 结束标识必填。写入字段的类型检查（K4 只许主表文本字段）已在
// compile/fieldtype.go 实现，本层不重复检查；节点级通知配置（可选）若配了渠道要落在
// 三档闭集内。
func (h *EndHandler) Validate(_ *model.Document, n *model.Node) []model.Diagnostic {
	cfg, err := model.EndConfigOf(n)
	if err != nil {
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}
	}
	var out []model.Diagnostic
	if cfg.EndFlag == "" {
		out = append(out, model.NewDiagnostic("N5_END_FLAG_REQUIRED", n.ID, "", nil))
	}
	out = append(out, validateNodeNotify(n.ID, cfg.Notify)...)
	return out
}
