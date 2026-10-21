package hostclient

import (
	"errors"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// TestFromStatus 覆盖：四个前缀命中哨兵 / 裸 gRPC NotFound 兜底 / 未识别前缀与非 status 错误
// 一律落 ErrSystem / nil 直通。
func TestFromStatus(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want error
	}{
		{"nil", nil, nil},
		{"not_found_prefix", status.Error(codes.FailedPrecondition, "NOT_FOUND: definition missing"), ports.ErrNotFound},
		{"version_conflict_prefix", status.Error(codes.Aborted, "VERSION_CONFLICT: stale"), ports.ErrVersionConflict},
		{"record_has_instance_prefix", status.Error(codes.AlreadyExists, "RECORD_ALREADY_HAS_INSTANCE: dup"), ports.ErrRecordHasInstance},
		{"expression_invalid_prefix", status.Error(codes.InvalidArgument, "EXPRESSION_INVALID: bad publication"), ports.ErrExpressionInvalid},
		{"request_key_reused_prefix", status.Error(codes.InvalidArgument, "REQUEST_KEY_REUSED: request_key req-1 reused"), ports.ErrRequestKeyReused},
		// 宿主建单 / 写字段的业务校验类拒绝单独成类，不再折进 ErrSystem。
		{"record_write_rejected_prefix", status.Error(codes.FailedPrecondition, "RECORD_WRITE_REJECTED: workflow launch: unique field conflict"), ports.ErrRecordWriteRejected},
		{"bare_grpc_not_found_code", status.Error(codes.NotFound, "missing"), ports.ErrNotFound},
		{"system_error_prefix", status.Error(codes.Internal, "SYSTEM_ERROR: boom"), ports.ErrSystem},
		{"unrecognized_prefix_falls_back_system", status.Error(codes.Unknown, "whatever happened"), ports.ErrSystem},
		{"non_status_error_falls_back_system", errors.New("plain error, not a grpc status"), ports.ErrSystem},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := fromStatus(c.err)
			if c.want == nil {
				if got != nil {
					t.Fatalf("want nil, got %v", got)
				}
				return
			}
			if !errors.Is(got, c.want) {
				t.Fatalf("want wraps %v, got %v", c.want, got)
			}
			if c.err != nil && got.Error() == "" {
				t.Fatalf("original message must be preserved, got empty")
			}
		})
	}
}

// TestFromStatus_RecordWriteRejectionSubCode 宿主业务拒绝在状态详情里附的 Diagnostic 子码要带回
// （停驻事故据此记细化原因码）；没有详情时 SubCode 为空，哨兵判定与原文保留都不受影响。
func TestFromStatus_RecordWriteRejectionSubCode(t *testing.T) {
	st := status.New(codes.FailedPrecondition, "RECORD_WRITE_REJECTED: workflow launch: required field missing")
	withDetails, err := st.WithDetails(&pb.Diagnostic{Code: "REQUIRED_FIELD_MISSING"})
	if err != nil {
		t.Fatalf("attach details: %v", err)
	}
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"with_subcode", withDetails.Err(), "REQUIRED_FIELD_MISSING"},
		{"without_details", st.Err(), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := fromStatus(c.err)
			if !errors.Is(got, ports.ErrRecordWriteRejected) {
				t.Fatalf("want wraps ErrRecordWriteRejected, got %v", got)
			}
			var rejection *ports.RecordWriteRejection
			if !errors.As(got, &rejection) {
				t.Fatalf("want *ports.RecordWriteRejection, got %T", got)
			}
			if rejection.SubCode != c.want {
				t.Fatalf("want sub code %q, got %q", c.want, rejection.SubCode)
			}
			if want := "workflow: record write rejected: RECORD_WRITE_REJECTED: workflow launch: required field missing"; got.Error() != want {
				t.Fatalf("message must stay identical to the pre-subcode format, want %q, got %q", want, got.Error())
			}
		})
	}
}

// TestFromStatus_HostRejectionKeepsCode 宿主 Commit 校验的具名拒绝（跨引擎子流程、
// 宿主依赖键 / 发件箱不合规等 SDK 枚举内的码）保留业务码交 app 层原样回给网关；errors.Is(ErrSystem) 照常成立，
// 既有停驻 / 重试判定不变。未知前缀与 SYSTEM_ERROR 仍落普通 ErrSystem。
func TestFromStatus_HostRejectionKeepsCode(t *testing.T) {
	for _, c := range []struct {
		err  error
		code string
	}{
		{status.Error(codes.FailedPrecondition, "WORKFLOW_SUBFLOW_CROSS_ENGINE: subflow target definition is not bound to the same engine"), "WORKFLOW_SUBFLOW_CROSS_ENGINE"},
		{status.Error(codes.InvalidArgument, "COMPILED_HOST_KEYS_INVALID: node n1 kind"), "COMPILED_HOST_KEYS_INVALID"},
		{status.Error(codes.InvalidArgument, "OUTBOX_PAYLOAD_INVALID: kind"), "OUTBOX_PAYLOAD_INVALID"},
	} {
		got := fromStatus(c.err)
		var hr *ports.HostRejection
		if !errors.As(got, &hr) || hr.Code != c.code || !errors.Is(got, ports.ErrSystem) {
			t.Fatalf("%v: want HostRejection %s wrapping ErrSystem, got %#v", c.err, c.code, got)
		}
	}
	for _, e := range []error{status.Error(codes.Internal, "SYSTEM_ERROR: boom"), status.Error(codes.Unknown, "WHATEVER_CODE: x")} {
		var hr *ports.HostRejection
		if errors.As(fromStatus(e), &hr) {
			t.Fatalf("%v should not be a HostRejection", e)
		}
	}
}
