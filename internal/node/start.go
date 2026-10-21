package node

import (
	"strings"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// StartHandler 是发起节点的行为实现。这里做发布期校验（目标模板）；
// 到达 / 触发语义由 engine/core 的 start.go 实现（发起节点不经 OnArrive，发起即完成）。
type StartHandler struct{}

// NewStartHandler 构造 StartHandler。
func NewStartHandler() *StartHandler { return &StartHandler{} }

// Kind 见 Handler 接口。
func (h *StartHandler) Kind() model.NodeKind { return model.NodeKindStart }

// Traits 发起：主线；发起任务可再次提交、可暂存；回退动作可到达但发起节点没有允许清单，
// 运行期一律落 E1 的「该方式不被允许」（它已是第一站）；A5 的「上一步」不把发起算人工步骤（由兜底覆盖）。
func (h *StartHandler) Traits() Traits {
	return Traits{Main: true, TaskKind: model.TaskKindStart, Submit: true, Save: true, Back: true, Withdraw: WithdrawBlockIfHuman}
}

// Validate 发起节点必填：目标模板；「无路可走时的提示」选填（不填不拦发布，
// 填报层在选路零命中时落系统默认提示）；配了发起条件就必须再填
// 「不满足发起条件时的提示」（没配条件不要求提示）；节点级通知配置（可选）若配了
// 渠道要落在三档闭集内。
func (h *StartHandler) Validate(_ *model.Document, n *model.Node) []model.Diagnostic {
	cfg, err := model.StartConfigOf(n)
	if err != nil {
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}
	}
	var out []model.Diagnostic
	if cfg.TargetTemplateID == "" {
		out = append(out, model.NewDiagnostic("N1_TARGET_TEMPLATE_REQUIRED", n.ID, "", nil))
	}
	// 判「配了发起条件」用去空白后的原始表达式 JSON（与 compile.collectExpressions 的
	// add 闭包同一口径：空串或字面量 "null" 都算没配），配了就必须再填提示，去空白后仍是空即报。
	condRaw := strings.TrimSpace(string(cfg.StartCondition))
	if condRaw != "" && condRaw != "null" && strings.TrimSpace(cfg.StartConditionHint) == "" {
		out = append(out, model.NewDiagnostic("N1_START_CONDITION_HINT_REQUIRED", n.ID, "", nil))
	}
	out = append(out, validateNodeNotify(n.ID, cfg.Notify)...)
	return out
}
