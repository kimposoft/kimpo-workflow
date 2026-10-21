package model

// Diagnostic 是本地（发布期检查、节点自校验）产生的诊断条目，字段形状与 SDK 契约面
// kimpo.workflow.host.v1.Diagnostic（proto/workflow/host/v1/common.proto）对齐，
// 便于后续卡直接转换成 workflowhostv1.Diagnostic / workflowenginev1 回包，不需要另起一套。
type Diagnostic struct {
	// Code 是 WorkflowErrorCode 枚举名字符串，或发布期检查子码（如 "L10"、"K4"）。
	Code string `json:"code"`
	// MessageKey 是 i18n 键（err.workflow.*），前端按此取四语文案。
	MessageKey string `json:"message_key"`
	// NodeID 关联节点 id，可空。
	NodeID string `json:"node_id,omitempty"`
	// LinkID 关联引导线 id，可空。
	LinkID string `json:"link_id,omitempty"`
	// Arguments 文案参数。
	Arguments map[string]string `json:"arguments,omitempty"`
}
