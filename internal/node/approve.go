package node

import "github.com/kimposoft/kimpo-workflow/internal/model"

// ApproveHandler 是审批节点的发布期校验实现。
//
// 审批与办理共用『人员来源』『办理方式』『回退』三套通用件，差异只有三处：审批不改表单
// 内容、动作来自按钮、过关前要把结果标识与理由写进绑定字段。本文件只做发布期校验，运行期语义
// 在 engine/core（approve.go：按钮校验 → 求路 → 写字段 → 提交）。
type ApproveHandler struct{}

// NewApproveHandler 构造 ApproveHandler。
func NewApproveHandler() *ApproveHandler { return &ApproveHandler{} }

// Kind 见 Handler 接口。
func (h *ApproveHandler) Kind() model.NodeKind { return model.NodeKindApprove }

// Traits 审批：主线、派人，但提交 / 暂存 / 回退三个直接动作都不可用——动作只能来自按钮
// （审查 A3 / A9：接口是公开的，只靠前端不画按钮挡不住）。
func (h *ApproveHandler) Traits() Traits {
	return Traits{Main: true, Human: true, TaskKind: model.TaskKindApprove, Buttons: true, Withdraw: WithdrawBlockIfHuman}
}

// Validate 审批节点的发布期校验：
//   - 审批人来源同办理节点（至少一种、每种来源必填项不空、来源档位合法）；
//   - 按钮至少一个，每个按钮名称不空、动作在五档之内（含「不通过并结束流程」）；
//   - 动作为「不通过并结束流程」（end_flow）的按钮必须指定目标（N3_BUTTON_END_TARGET_REQUIRED），
//     目标必须是本流程里存在的结束节点（N3_BUTTON_END_TARGET_INVALID）；
//   - 结果标识：动作为「提交通过」的按钮若配了结果绑定字段却没填结果标识，落库会写空值，
//     直接拒；
//   - 无路可走时的提示选填：不填不拦发布，填报层在零命中时
//     落系统默认提示「没有满足条件的后续步骤」（文案在宿主前端本地化，引擎只透出空串）。
//
// 绑定字段的类型检查（必须是主表文本字段）属于 K4，已在 compile/fieldtype.go 实现——发布期
// 编译器经字段目录端口（ports.FieldCatalog）查真实类型，不在这里假装检查（本层没有字段目录，
// 猜错比不查更糟）。
func (h *ApproveHandler) Validate(doc *model.Document, n *model.Node) []model.Diagnostic {
	cfg, err := model.ApproveConfigOf(n)
	if err != nil {
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}
	}
	var out []model.Diagnostic
	out = append(out, validateAssigneeSources(n.ID, cfg.Approvers, cfg.RelationFilters)...)
	out = append(out, validateCompleteMode(n.ID, cfg.CompleteMode)...)

	if len(cfg.Buttons) == 0 {
		out = append(out, model.NewDiagnostic("N3_BUTTON_REQUIRED", n.ID, "", nil))
	}
	for _, btn := range cfg.Buttons {
		if btn.Name == "" {
			out = append(out, model.NewDiagnostic("N3_BUTTON_NAME_REQUIRED", n.ID, "", nil))
		}
		switch btn.Action {
		case model.ButtonActionSubmitApprove, model.ButtonActionWithdrawPrev,
			model.ButtonActionWithdrawInit, model.ButtonActionWithdrawSpecify:
		case model.ButtonActionEndFlow:
			out = append(out, validateEndFlowTarget(doc, n.ID, btn)...)
		default:
			out = append(out, model.NewDiagnostic("N3_BUTTON_ACTION_UNSUPPORTED", n.ID, "", map[string]string{"button": btn.Name, "action": string(btn.Action)}))
		}
		// 配了结果绑定字段却没给这个按钮填结果标识：确认时会把空串写进单据，等于把字段清掉，
		// 属于配置没配完，发布期直接拒（N3.3 写入顺序的前提）。
		if cfg.ResultFieldID != "" && btn.ResultTag == "" {
			out = append(out, model.NewDiagnostic("N3_BUTTON_RESULT_TAG_REQUIRED", n.ID, "", map[string]string{"button": btn.Name}))
		}
	}
	// 节点级通知配置（可选）：若配了渠道要落在三档闭集内，与其余三类主线节点共用同一份校验。
	out = append(out, validateNodeNotify(n.ID, cfg.Notify)...)
	return out
}

// validateEndFlowTarget 校验「不通过并结束流程」按钮的目标结束节点：
//   - end_node_id 为空 → N3_BUTTON_END_TARGET_REQUIRED；
//   - 指向的节点在文档里不存在（含目标被删除）或类型不是结束节点 → N3_BUTTON_END_TARGET_INVALID。
//
// doc 为 nil 时（单节点校验的调用方没有文档）无法核对目标，只做「必填」检查、跳过 INVALID 检查。
// 诊断带节点 id 与按钮名称 / 按钮 id，前端据此指出是哪个环节的哪个按钮。
func validateEndFlowTarget(doc *model.Document, nodeID string, btn model.ApprovalButton) []model.Diagnostic {
	args := map[string]string{"button": btn.Name, "button_id": btn.ID}
	if btn.EndNodeID == "" {
		return []model.Diagnostic{model.NewDiagnostic("N3_BUTTON_END_TARGET_REQUIRED", nodeID, "", args)}
	}
	if doc == nil {
		return nil
	}
	args["end_node_id"] = btn.EndNodeID
	for i := range doc.Nodes {
		if doc.Nodes[i].ID == btn.EndNodeID {
			if doc.Nodes[i].Kind == model.NodeKindEnd {
				return nil
			}
			break
		}
	}
	return []model.Diagnostic{model.NewDiagnostic("N3_BUTTON_END_TARGET_INVALID", nodeID, "", args)}
}
