package node

import (
	"encoding/json"
	"strings"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// CCHandler 是抄送节点的发布期校验实现。
//
// 抄送把单据知会给一批人，没有人需要处理、流程不停留。它与办理 / 审批的根本差别在于
// **不走 C（选人派发）**：算出来的收件人全部收到，不弹对话框——所以这里只校验
// 「来源配了没有」，不校验办理方式。
type CCHandler struct{}

// NewCCHandler 构造 CCHandler。
func NewCCHandler() *CCHandler { return &CCHandler{} }

// Kind 见 Handler 接口。
func (h *CCHandler) Kind() model.NodeKind { return model.NodeKindCC }

// Traits 抄送：辅助节点，不派任务；撤销时可跨过（已发出的不撤回）；可作支线终点。
func (h *CCHandler) Traits() Traits {
	return Traits{Withdraw: WithdrawPassThrough, BranchTarget: true}
}

// Validate 抄送节点的发布期校验：
//   - 收件人来源同办理节点（A1：至少一种、每种来源必填项不空、档位合法）；
//   - 通知渠道至少一种，且取值在三档之内；
//   - 标题与正文都必填（两条宿主 V4 取值表达式）。
//
// 「短信 / 邮箱只在系统里配置了对应渠道时可选」属于设计器侧的可选性（面板置灰），不在这里
// 校验——发布期的插件不知道宿主装了哪些渠道，拿不到那个事实就不该假装校验它。
func (h *CCHandler) Validate(_ *model.Document, n *model.Node) []model.Diagnostic {
	cfg, err := model.CCConfigOf(n)
	if err != nil {
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}
	}
	var out []model.Diagnostic
	out = append(out, validateAssigneeSources(n.ID, cfg.Recipients, cfg.RelationFilters)...)

	if len(cfg.Channels) == 0 {
		out = append(out, model.NewDiagnostic("N4_CHANNEL_REQUIRED", n.ID, "", nil))
	}
	// 渠道闭集校验与节点级 notify.channels 共用一份实现（notify_rules.go），抄送这里只多一条
	// 「至少选一种」的必填判据。
	out = append(out, validateNotifyChannels(n.ID, cfg.Channels)...)
	if isBlankExpr(cfg.TitleExpr) {
		out = append(out, model.NewDiagnostic("N4_TITLE_REQUIRED", n.ID, "", nil))
	}
	if isBlankExpr(cfg.ContentExpr) {
		out = append(out, model.NewDiagnostic("N4_CONTENT_REQUIRED", n.ID, "", nil))
	}
	return out
}

// isBlankExpr 判一条表达式槽是不是「没配」。不能只看 len==0：这些槽是 json.RawMessage，
// 没配的字段经过一次「序列化 → 反序列化」会变成字面量 null（四个字节），照长度判就漏了。
// 判据与 compile/freeze.go 收集表达式槽时的口径一致。
func isBlankExpr(raw json.RawMessage) bool {
	t := strings.TrimSpace(string(raw))
	return t == "" || t == "null"
}
