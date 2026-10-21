// Package grpc 承载流程引擎四个 gRPC 服务（kimpo.workflow.engine.v1：DefinitionService /
// InstanceService / TaskService / AdminService）的传输层，方法都接到 engineapp.Service——本层
// 只做 pb ↔ 应用服务层入参 / 出参翻译（convert.go）与错误码翻译（本文件），不含任何状态机业务
// 逻辑（业务在 internal/engine/core 与 internal/engine/app）。仍是冻结壳、显式返回
// codes.Unimplemented 的只有：DefinitionService.Delete、AdminService 的记录 / 定义生命周期四个
// 方法（归宿主自处理），以及 ListIncidents 只给 definition_id 的跨实例枚举。
package grpc

import (
	"context"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin/workflowengine"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/observability"
)

// unimplementedError 是仍为冻结壳的方法的共用返回路径：经 observability.Logger 把「宿主调用了
// 尚未实现的方法」按 warn 级上报给宿主日志中心（插件要在关键位置把不同级别日志信息上报给宿主），
// 再返回 codes.Unimplemented + note。调用方按 "<Service>.<Method>" 传 method（如
// "DefinitionService.Delete"），note 说明谁负责实现 / 为什么这里不接。
func unimplementedError(ctx context.Context, method, note string) error {
	observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.unimplemented",
		method+" 尚未实现", map[string]any{"method": method, "note": note})
	return status.Error(codes.Unimplemented, method+": "+note)
}

// toStatus 把 engineapp / core 层错误转成 gRPC status，所有已接线 handler 的错误返回都经它
// （requireMeta 的校验失败已经是 status，不经它——见 fail 的调用约定）。
//   - core.CodeOf(err) 非空且是 WorkflowErrorCode 枚举名 → 按 WorkflowErrorCodeToGRPC 映射，
//     message 前缀该枚举名；
//   - "NOT_FOUND"（ledgerErr 产生，不是 WorkflowErrorCode 枚举项）→ codes.NotFound；
//   - "INVALID_ARGUMENT"（单据模板不匹配、请求键复用等入参类拒绝，同样不是
//     WorkflowErrorCode 枚举项）→ codes.InvalidArgument；
//   - 其余（含空码，即不是 *core.Error 的系统性错误）→ codes.Internal + "SYSTEM_ERROR: " 前缀。
func toStatus(err error) error {
	if err == nil {
		return nil
	}
	code := core.CodeOf(err)
	switch {
	case code == "NOT_FOUND":
		return status.Error(codes.NotFound, "NOT_FOUND: "+errorMessage(err))
	case code == "INVALID_ARGUMENT":
		return status.Error(codes.InvalidArgument, "INVALID_ARGUMENT: "+errorMessage(err))
	case code != "":
		if v, ok := workflowhostv1.WorkflowErrorCode_value[code]; ok {
			return status.Error(WorkflowErrorCodeToGRPC(workflowhostv1.WorkflowErrorCode(v)), code+": "+errorMessage(err))
		}
	}
	return status.Error(codes.Internal, "SYSTEM_ERROR: "+err.Error())
}

// errorMessage 取错误的纯文案（*core.Error 只取 Message，不重复带 Code 前缀；toStatus 自己拼前缀）。
func errorMessage(err error) string {
	if e, ok := err.(*core.Error); ok {
		return e.Message
	}
	return err.Error()
}

// fail 是每个已接线 handler 的统一失败出口：按错误码分级上报宿主日志（事件码
// "workflow.engine.<service>.<method>_failed"，字段带 code），再把错误转成 gRPC status。
// method 形如 "DefinitionService.Create"。
//
// 按 severityForCode 分级（不能一律 warn，否则插件永远不会上报 error/info）：系统性错误（空码）上报 error；发起/结束/发布被拒这类
// 调用方按正常业务流程会遇到的预检失败上报 info；其余（入参/状态类拒绝）维持 warn。
func fail(ctx context.Context, method string, err error) error {
	service, action := splitMethod(method)
	eventCode := "workflow.engine." + strings.ToLower(strings.TrimSuffix(service, "Service")) + "." + strings.ToLower(action) + "_failed"
	code := core.CodeOf(err)
	observability.Logger(ctx).Emit(ctx, severityForCode(code), "workflow", "engine", eventCode, method+" failed",
		map[string]any{"method": method, "code": code, "error": err.Error()})
	return toStatus(err)
}

// severityForCode 按 core.CodeOf(err) 的错误码归类日志级别：
//   - 空码：toStatus 最终归为 codes.Internal + "SYSTEM_ERROR: " 前缀的系统性错误，上报 error；
//   - 发起 / 结束 / 发布被拒：调用方按正常业务规则会遇到的预检失败，不是异常，上报 info；
//   - 其余（NOT_FOUND / INVALID_ARGUMENT 等入参与状态类拒绝、WITHDRAW_REJECTED_* 等）：
//     维持 warn。
func severityForCode(code string) string {
	switch code {
	case "":
		return "error"
	case "DEFINITION_NOT_PUBLISHED", "DEFINITION_DISABLED", "PUBLISH_REJECTED",
		"RECORD_ALREADY_HAS_INSTANCE", "INSTANCE_ENDED", "INSTANCE_PARKED":
		return "info"
	default:
		return "warn"
	}
}

// splitMethod "<Service>.<Method>" → ("Service", "Method")；没有点时整串当 service，action 为空。
func splitMethod(method string) (service, action string) {
	if i := strings.IndexByte(method, '.'); i >= 0 {
		return method[:i], method[i+1:]
	}
	return method, ""
}

// WorkflowErrorCodeToGRPC 把业务错误码 WorkflowErrorCode 映射到传输层 gRPC status code。
//
// 直接取 SDK 公开码表 workflowengine.GRPCCode（与 proto WorkflowErrorCode 各项注释、SDK 黄金
// 夹具 schema/workflow/golden/errors.json 同源），不在本文件手抄 switch——手抄表会在 SDK 枚举
// 补全后漏映射，回落 codes.Unknown，宿主就会把业务拒绝当成未知错误。消息前缀是 "CODE: "（toStatus 负责），网关按前缀映射 HTTP 状态。
//
// 未识别的枚举值（含 WORKFLOW_ERROR_CODE_UNSPECIFIED）一律回退 codes.Unknown，不 panic——
// 调用方在拿到新枚举值但 SDK 码表尚未登记时应能安全降级，而不是打挂进程。
func WorkflowErrorCodeToGRPC(code workflowhostv1.WorkflowErrorCode) codes.Code {
	if !workflowengine.IsKnownCode(code.String()) {
		return codes.Unknown
	}
	return workflowengine.GRPCCode(code)
}
