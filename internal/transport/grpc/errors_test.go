package grpc

import (
	"testing"

	"google.golang.org/grpc/codes"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
)

// TestErrors_CodeMapping 覆盖 WorkflowErrorCode 全部 19 个非零枚举项（proto 注释逐条
// 声明的 gRPC code 映射），确保 errors.go 与 common.proto 的约定文本保持同步。
func TestErrors_CodeMapping(t *testing.T) {
	cases := []struct {
		name string
		code workflowhostv1.WorkflowErrorCode
		want codes.Code
	}{
		{"EXPRESSION_INVALID", workflowhostv1.WorkflowErrorCode_EXPRESSION_INVALID, codes.InvalidArgument},
		{"SYSTEM_ERROR", workflowhostv1.WorkflowErrorCode_SYSTEM_ERROR, codes.Internal},
		{"ROUTE_EVAL_FAILED", workflowhostv1.WorkflowErrorCode_ROUTE_EVAL_FAILED, codes.FailedPrecondition},
		{"CANDIDATE_FAILED", workflowhostv1.WorkflowErrorCode_CANDIDATE_FAILED, codes.FailedPrecondition},
		{"WITHDRAW_REJECTED_TOUCHED", workflowhostv1.WorkflowErrorCode_WITHDRAW_REJECTED_TOUCHED, codes.FailedPrecondition},
		{"WITHDRAW_REJECTED_END", workflowhostv1.WorkflowErrorCode_WITHDRAW_REJECTED_END, codes.FailedPrecondition},
		{"WITHDRAW_REJECTED_SUBFLOW", workflowhostv1.WorkflowErrorCode_WITHDRAW_REJECTED_SUBFLOW, codes.FailedPrecondition},
		{"WITHDRAW_REJECTED_NON_MANUAL_START", workflowhostv1.WorkflowErrorCode_WITHDRAW_REJECTED_NON_MANUAL_START, codes.FailedPrecondition},
		{"VERSION_CONFLICT", workflowhostv1.WorkflowErrorCode_VERSION_CONFLICT, codes.Aborted},
		{"TASK_NOT_OWNED", workflowhostv1.WorkflowErrorCode_TASK_NOT_OWNED, codes.PermissionDenied},
		{"TASK_NOT_ACTIONABLE", workflowhostv1.WorkflowErrorCode_TASK_NOT_ACTIONABLE, codes.FailedPrecondition},
		{"RECORD_ALREADY_HAS_INSTANCE", workflowhostv1.WorkflowErrorCode_RECORD_ALREADY_HAS_INSTANCE, codes.AlreadyExists},
		{"DEFINITION_DISABLED", workflowhostv1.WorkflowErrorCode_DEFINITION_DISABLED, codes.FailedPrecondition},
		{"DEFINITION_NOT_PUBLISHED", workflowhostv1.WorkflowErrorCode_DEFINITION_NOT_PUBLISHED, codes.FailedPrecondition},
		{"PUBLISH_REJECTED", workflowhostv1.WorkflowErrorCode_PUBLISH_REJECTED, codes.FailedPrecondition},
		{"INSTANCE_ENDED", workflowhostv1.WorkflowErrorCode_INSTANCE_ENDED, codes.FailedPrecondition},
		{"INSTANCE_PARKED", workflowhostv1.WorkflowErrorCode_INSTANCE_PARKED, codes.FailedPrecondition},
		{"INVALID_CHOICE", workflowhostv1.WorkflowErrorCode_INVALID_CHOICE, codes.InvalidArgument},
		{"DEFINITION_IN_USE", workflowhostv1.WorkflowErrorCode_DEFINITION_IN_USE, codes.FailedPrecondition},
	}
	if len(cases) != 19 {
		t.Fatalf("test table has %d cases, want 19 (one per non-zero WorkflowErrorCode enum value)", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := WorkflowErrorCodeToGRPC(tc.code); got != tc.want {
				t.Fatalf("WorkflowErrorCodeToGRPC(%s) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

func TestErrors_CodeMapping_UnspecifiedFallsBackToUnknown(t *testing.T) {
	if got := WorkflowErrorCodeToGRPC(workflowhostv1.WorkflowErrorCode_WORKFLOW_ERROR_CODE_UNSPECIFIED); got != codes.Unknown {
		t.Fatalf("WorkflowErrorCodeToGRPC(UNSPECIFIED) = %v, want Unknown", got)
	}
}

func TestErrors_CodeMapping_UnknownValueFallsBackToUnknown(t *testing.T) {
	if got := WorkflowErrorCodeToGRPC(workflowhostv1.WorkflowErrorCode(999)); got != codes.Unknown {
		t.Fatalf("WorkflowErrorCodeToGRPC(999) = %v, want Unknown", got)
	}
}

// TestErrors_SeverityForCode 覆盖日志分级判据：空码（系统性错误）报 error，
// 发起/结束/发布被拒报 info，其余维持 warn（含 NOT_FOUND / INVALID_ARGUMENT 等伪码与
// WITHDRAW_REJECTED_* 等未单列的类别）。
func TestErrors_SeverityForCode(t *testing.T) {
	cases := []struct {
		code string
		want string
	}{
		{"", "error"},
		{"DEFINITION_NOT_PUBLISHED", "info"},
		{"DEFINITION_DISABLED", "info"},
		{"PUBLISH_REJECTED", "info"},
		{"RECORD_ALREADY_HAS_INSTANCE", "info"},
		{"INSTANCE_ENDED", "info"},
		{"INSTANCE_PARKED", "info"},
		{"NOT_FOUND", "warn"},
		{"INVALID_ARGUMENT", "warn"},
		{"TASK_NOT_OWNED", "warn"},
		{"WITHDRAW_REJECTED_TOUCHED", "warn"},
		{"VERSION_CONFLICT", "warn"},
	}
	for _, tc := range cases {
		t.Run("code="+tc.code, func(t *testing.T) {
			if got := severityForCode(tc.code); got != tc.want {
				t.Fatalf("severityForCode(%q) = %q, want %q", tc.code, got, tc.want)
			}
		})
	}
}
