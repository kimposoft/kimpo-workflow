package core

import (
	"errors"
	"fmt"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// 事故原因码：停驻事故行 error_code 的取值口径。
//
// 原因码**只供界面选业务话文案**（宿主流程管理页按它显示「原因 + 处理建议」），不参与任何流转
// 判定——恢复、重试、终止都只看事故 kind 与停驻点。错误原文照旧原样写进 error_message 供排障。
// 新增原因码时，宿主前端流程管理页的原因文案（四语）要同步补；漏补不会出错，界面回落通用说明。

// SubflowNoInstanceError 子流程的目标流程发起之后没有形成实例：目标流程的发起节点选路 / 选人
// 零命中、或需要弹框让人选——子流程由系统发起、没有人在场处理这些对话框，一律按发起失败处理
// 。带上 Outcome 是为了让停驻事故记下「究竟是哪一种没形成实例」，管理员才知道该去改
// 目标流程的办理人设置还是分支条件。NO_ROUTE 在子流程路径上只剩「发起后没有分支命中」
// 一种——目标流程的发起条件对子流程发起不生效，不会再因它而没形成实例。
// ASSIGNEE_CHOICE_REQUIRED 也不再产生（子流程发起的第一跳多候选默认全选），归类里
// 保留这一档只作防御。
//
// Error() 文本在没有 NodeName / Hint 时与此前的 fmt.Errorf 逐字一致；有则追加在后面，它原样落进
// 事故行 error_message，管理员在「技术详情」里能直接看到卡在目标流程的哪个节点、设计者提示了什么。
type SubflowNoInstanceError struct {
	Outcome OutcomeKind
	// NodeName 要手选办理人时，目标流程里等着选人的那个节点的名称；其余结果为空。
	NodeName string
	// Hint 无路可走 / 找不到办理人时设计者写的提示语；没写为空。
	Hint string
}

func (e *SubflowNoInstanceError) Error() string {
	msg := fmt.Sprintf("subflow start produced no instance, outcome=%s", e.Outcome)
	if e.NodeName != "" {
		msg += fmt.Sprintf(", node=%q", e.NodeName)
	}
	if e.Hint != "" {
		msg += fmt.Sprintf(", hint=%q", e.Hint)
	}
	return msg
}

// passthroughReasonCodes 引擎发起动作自身拒绝时，允许原样当作原因码记进事故行的引擎错误码白名单。
// 白名单之外的码（含 SYSTEM_ERROR / NOT_FOUND / INVALID_ARGUMENT）不透传，落到后面的通用判定。
var passthroughReasonCodes = map[string]bool{
	"DEFINITION_DISABLED":         true,
	"DEFINITION_NOT_PUBLISHED":    true,
	"RECORD_ALREADY_HAS_INSTANCE": true,
	"ROUTE_EVAL_FAILED":           true,
	"CANDIDATE_FAILED":            true,
	"EXPRESSION_INVALID":          true,
}

// incidentReasonCode 把一次停驻的失败原因归成稳定原因码。子流程发起失败与结束节点写字段失败
// 共用同一套归类；都认不出来时记 SYSTEM_ERROR。err 可能被 fmt.Errorf("…: %w") 包过多层，
// 一律用 errors.As / errors.Is 沿错误链判定（CodeOf 只认最外层，这里不能用）。
//
// subflowLaunch 为 true 表示这是子流程发起失败：只有这个场景下「找不到」才意味着「子流程节点
// 指向的流程 / 表单不存在」；写字段场景的「找不到」宿主会走业务拒绝子码 RECORD_NOT_FOUND，
// 走不到那条的裸 NOT_FOUND 不猜，落 SYSTEM_ERROR。
func incidentReasonCode(err error, subflowLaunch bool) string {
	if err == nil {
		return ""
	}
	// 宿主业务校验类拒绝：带子码就记到子码一级。
	var rejection *ports.RecordWriteRejection
	if errors.As(err, &rejection) && rejection.SubCode != "" {
		return "RECORD_WRITE_REJECTED:" + rejection.SubCode
	}
	if errors.Is(err, ports.ErrRecordWriteRejected) {
		return "RECORD_WRITE_REJECTED"
	}
	// 子流程目标流程发起后没有形成实例。
	var noInstance *SubflowNoInstanceError
	if errors.As(err, &noInstance) {
		switch noInstance.Outcome {
		case OutcomeAssigneeChoiceRequired, OutcomeRouteChoiceRequired, OutcomeNoRoute, OutcomeNoCandidate:
			return "SUBFLOW_" + string(noInstance.Outcome)
		}
		return "SYSTEM_ERROR"
	}
	// 引擎发起动作自身拒绝（目标流程已停用 / 未发布、分支条件或办理人计算出错……）。
	var engineErr *Error
	if errors.As(err, &engineErr) && passthroughReasonCodes[engineErr.Code] {
		return engineErr.Code
	}
	// 目标流程 / 目标表单找不到（账本或宿主回 NOT_FOUND；引擎 Start 自己也用 NOT_FOUND 码）。
	if subflowLaunch && (errors.Is(err, ports.ErrNotFound) || (engineErr != nil && engineErr.Code == "NOT_FOUND")) {
		return "SUBFLOW_TARGET_NOT_FOUND"
	}
	if errors.Is(err, ports.ErrRecordHasInstance) {
		return "RECORD_ALREADY_HAS_INSTANCE"
	}
	if errors.Is(err, ports.ErrExpressionInvalid) {
		return "EXPRESSION_INVALID"
	}
	return "SYSTEM_ERROR"
}
