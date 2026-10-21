package node

import "github.com/kimposoft/kimpo-workflow/internal/model"

// HandleHandler 是办理节点的行为实现。发布期校验：人员来源（经宿主 CandidateService
// 计算）+ 办理方式；运行期到达 / 提交语义在
// engine/core（arrive.go / submit.go / pass.go）。
type HandleHandler struct{}

// NewHandleHandler 构造 HandleHandler。
func NewHandleHandler() *HandleHandler { return &HandleHandler{} }

// Kind 见 Handler 接口。
func (h *HandleHandler) Kind() model.NodeKind { return model.NodeKindHandle }

// Traits 办理：主线、派人、三个直接动作都可用；夹在撤销链中间时有人办过即不可撤（G8 自动办理除外）。
func (h *HandleHandler) Traits() Traits {
	return Traits{Main: true, Human: true, TaskKind: model.TaskKindHandle, Submit: true, Save: true, Back: true, Withdraw: WithdrawBlockIfHuman}
}

// Validate 办理节点：A1 至少一种来源且每种来源的必填项不空；办理方式两档都支持（按比例的
// 百分比须在 1%~100%）；无路可走时的提示选填（不填由填报层落默认提示）；节点级通知配置（可选）若配了渠道要落在三档闭集内。
func (h *HandleHandler) Validate(_ *model.Document, n *model.Node) []model.Diagnostic {
	cfg, err := model.HandleConfigOf(n)
	if err != nil {
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}
	}
	var out []model.Diagnostic
	// 人员来源与办理方式两套通用件与审批节点共用同一份实现（assignee_rules.go）——业务规则里它们
	// 本就是同一件事（A 与 D），两处各写一份迟早漂移。
	out = append(out, validateAssigneeSources(n.ID, cfg.Assignees, cfg.RelationFilters)...)
	out = append(out, validateCompleteMode(n.ID, cfg.CompleteMode)...)
	out = append(out, validateNodeNotify(n.ID, cfg.Notify)...)
	return out
}
