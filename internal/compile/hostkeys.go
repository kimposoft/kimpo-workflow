package compile

// hostkeys.go —— 编译产物里宿主会读的键（宿主依赖键）的类型化编码。
//
// 链路：设计层，DefinitionService.Publish → 本包把设计期配置摊平进 NodeCompiled → compiled_json 写版本行 →
// 宿主 LedgerService.Commit 按 SDK 同口径校验（COMPILED_HOST_KEYS_INVALID），之后宿主在发起目录（谁能发起）、
// 表单会话（节点字段权限）、办理页（审批按钮与结果文案、回退清空）、步骤目录（处理人来源）里读这些键。
//
// 五个宿主依赖键（start_permission_json / field_permissions_json / clear_on_withdraw_json / approve_buttons_json /
// sources_json）一律经 SDK plugin/workflowengine 的类型与 Encode* 编码：键名、空值省略（nil / 空数组 / 空对象编成
// 空串 = 宿主默认）、用户 id 十进制字符串都在 SDK 一处定义，并与宿主校验同源。输出与改造前 marshalOrEmpty 逐字节
// 一致，由 golden_conformance_test.go 对 SDK 黄金 compiled 锁定。编码失败（值不在闭集内等）由调用方转成
// NODE_CONFIG_INVALID 发布诊断——这类产物宿主 Commit 本来也会整笔拒绝，提前在发布期报出来。
//
// 引擎私有键（notify_json、allowed_withdraws_json、cc_channels_json、subflow_mappings_json 等）宿主不读，仍按
// marshalOrEmpty 原样冻结。

import (
	"strconv"

	"github.com/kimposoft/kimpo-plugin-sdk/plugin/workflowengine"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// decimalIDs 把用户 id 列表转成 SDK 约定的十进制字符串（与 model.IDList 的 JSON 编码同口径）；nil 保持 nil
// （配合 omitempty 省略键）。
func decimalIDs(ids model.IDList) []string {
	if ids == nil {
		return nil
	}
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = strconv.FormatInt(id, 10)
	}
	return out
}

// encodeStartPermission 编码 START 节点的 start_permission_json（四组来源取并集，全空 = 空串 = 仅超管可发起）。
func encodeStartPermission(g model.StartGrant) (string, error) {
	return workflowengine.EncodeStartPermission(workflowengine.StartGrant{
		UserIDs: decimalIDs(g.UserIDs), RoleIDs: g.RoleIDs, DepartmentIDs: g.DepartmentIDs,
		MainFieldID: g.MainFieldID, MatchBy: string(g.MatchBy),
	})
}

// encodeFieldPermissions 编码 field_permissions_json（档位 inherit / edit / readonly / hidden）。
func encodeFieldPermissions(list []model.FieldPermission) (string, error) {
	if list == nil {
		return "", nil
	}
	out := make([]workflowengine.FieldPermission, len(list))
	for i, p := range list {
		out[i] = workflowengine.FieldPermission{TableID: p.TableID, FieldID: p.FieldID, Grade: string(p.Grade)}
	}
	return workflowengine.EncodeFieldPermissions(out)
}

// encodeClearOnWithdraw 编码 clear_on_withdraw_json（回退时清空的字段）。
func encodeClearOnWithdraw(list []model.ClearOnWithdrawField) (string, error) {
	if list == nil {
		return "", nil
	}
	out := make([]workflowengine.FieldRef, len(list))
	for i, f := range list {
		out[i] = workflowengine.FieldRef{TableID: f.TableID, FieldID: f.FieldID}
	}
	return workflowengine.EncodeClearOnWithdraw(out)
}

// encodeApproveButtons 编码 approve_buttons_json（按钮动作五档闭集，end_flow 必须带目标结束节点）。
func encodeApproveButtons(list []model.ApprovalButton) (string, error) {
	if list == nil {
		return "", nil
	}
	out := make([]workflowengine.ApproveButton, len(list))
	for i, b := range list {
		out[i] = workflowengine.ApproveButton{
			ID: b.ID, Name: b.Name, Color: b.Color, Action: string(b.Action),
			ResultTag: b.ResultTag, RequireReason: b.RequireReason, EndNodeID: b.EndNodeID,
		}
	}
	return workflowengine.EncodeApproveButtons(out)
}

// encodeSources 编码 sources_json（办理 / 审批的处理人来源、抄送的收件人来源）。relation 条目已在解码时由
// model.normalizeRelationSources 改记为过滤器，新产物不再出现。
func encodeSources(list []model.AssigneeSource) (string, error) {
	if list == nil {
		return "", nil
	}
	out := make([]workflowengine.AssigneeSource, len(list))
	for i, s := range list {
		out[i] = workflowengine.AssigneeSource{
			Kind: string(s.Kind), UserIDs: decimalIDs(s.UserIDs), RoleIDs: s.RoleIDs, DepartmentIDs: s.DepartmentIDs,
			MainFieldID: s.MainFieldID, MatchBy: string(s.MatchBy), Relation: string(s.Relation),
		}
	}
	return workflowengine.EncodeSources(out)
}

// hostKeyEncoder 依次执行若干宿主依赖键编码，遇到第一个错误即停（各 kind_*.go 的 compile 闭包共用，免得每个键
// 各写一遍 if err != nil）。
type hostKeyEncoder struct{ err error }

// set 编码一个键并写入 dst；之前已有错误时跳过。
func (e *hostKeyEncoder) set(dst *string, encode func() (string, error)) {
	if e.err != nil {
		return
	}
	s, err := encode()
	if err != nil {
		e.err = err
		return
	}
	*dst = s
}
