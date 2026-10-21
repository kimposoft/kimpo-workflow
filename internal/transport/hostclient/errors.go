// Package hostclient 是流程引擎四个出站端口（ports.Ledger / ports.Expression / ports.Record /
// compile.Freezer）的宿主 gRPC 适配层：插件进程内经 SDK plugin.WorkflowHostFrom(ctx) 拿宿主
// 七个出站客户端里的 LedgerService / ExpressionService / RecordService 三个，把宿主 gRPC 回复
// 翻译成引擎内部类型。与宿主交互一律经 SDK 客户端，不走别的通道（保持低耦合）。
package hostclient

import (
	"fmt"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin/workflowengine"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// fromStatus 把宿主返回的 gRPC 错误还原成 ports 哨兵错误。宿主 status message 以
// WorkflowErrorCode 枚举名（或裸 "NOT_FOUND"）为前缀，形如 "VERSION_CONFLICT: xxx"
// （proto/workflow/host/v1/common.proto 的错误约定）；同时看 status code 兜底
// （宿主用裸 gRPC codes.NotFound 而不带前缀时也算 NotFound）。原文一律保留在 %w 之后，
// 便于日志排障。
func fromStatus(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	code := codes.Unknown
	subCode := ""
	if st, ok := status.FromError(err); ok {
		msg = st.Message()
		code = st.Code()
		subCode = diagnosticCodeOf(st)
	}
	prefix := msg
	if idx := strings.Index(msg, ": "); idx >= 0 {
		prefix = msg[:idx]
	}
	switch prefix {
	case "NOT_FOUND":
		return fmt.Errorf("%w: %s", ports.ErrNotFound, msg)
	case "VERSION_CONFLICT":
		return fmt.Errorf("%w: %s", ports.ErrVersionConflict, msg)
	case "RECORD_ALREADY_HAS_INSTANCE":
		return fmt.Errorf("%w: %s", ports.ErrRecordHasInstance, msg)
	case "EXPRESSION_INVALID":
		return fmt.Errorf("%w: %s", ports.ErrExpressionInvalid, msg)
	case "RECORD_WRITE_REJECTED":
		// 宿主建单 / 写字段的业务校验类拒绝（workflowLaunchError / mapWorkflowRecordError 同一前缀）。
		// 宿主在状态详情里附的子码（必填缺失 / 「唯一」重复 / 模板禁用……）一并带回，停驻事故据此
		// 记细化原因码，供流程管理页显示业务话原因；没有子码时 SubCode 为空，行为与此前一致。
		return &ports.RecordWriteRejection{SubCode: subCode, Message: msg}
	case "REQUEST_KEY_REUSED":
		// 宿主 Commit 事务规约第⓪项：同请求键命中请求日志但摘要 / 操作人不同。
		return fmt.Errorf("%w: %s", ports.ErrRequestKeyReused, msg)
	}
	if code == codes.NotFound {
		return fmt.Errorf("%w: %s", ports.ErrNotFound, msg)
	}
	// 宿主具名拒绝（前缀在 SDK WorkflowErrorCode 枚举内，如 WORKFLOW_SUBFLOW_CROSS_ENGINE /
	// COMPILED_HOST_KEYS_INVALID / OUTBOX_PAYLOAD_INVALID）保留业务码，app 层原样回给网关；SYSTEM_ERROR 本身不算。
	if prefix != msg && prefix != "SYSTEM_ERROR" && workflowengine.IsKnownCode(prefix) {
		return &ports.HostRejection{Code: prefix, Message: msg}
	}
	return fmt.Errorf("%w: %s", ports.ErrSystem, msg)
}

// errUnavailable 统一构造「宿主出站面不可用」错误（ctx 里没有宿主句柄，例如未注入 /
// 测试假体），按 ports.ErrSystem 处理。
func errUnavailable(what string) error {
	return fmt.Errorf("%w: %s unavailable", ports.ErrSystem, what)
}

// diagnosticCodeOf 取宿主 gRPC 状态详情里第一条 Diagnostic 的子码；没有详情或详情解不出来
// 一律返回空串（子码只用于界面选文案，取不到不影响任何判定）。
func diagnosticCodeOf(st *status.Status) string {
	for _, d := range st.Details() {
		if diag, ok := d.(*pb.Diagnostic); ok && diag.GetCode() != "" {
			return diag.GetCode()
		}
	}
	return ""
}
