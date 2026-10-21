package hostclient

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// fakeLedgerServiceClient 是仅测试用的假 LedgerServiceClient：只记录 / 回放 Commit 与 FindCommit，
// 其余方法本测试不用，直接返回 Unimplemented（NewLedgerForTest 的存在意义就是绕开
// plugin.WorkflowHostFrom(ctx) 需要的真实宿主连接——见 ledger.go 的 testClient 字段注释）。
//
// 内嵌生成的 Client 接口（零值）：SDK 以后给账本加 RPC（如 tp.12 的 ListIncidents）时替身照样能编译，
// 本测试没用到的新 RPC 被调用即 panic（提醒补桩），不必每加一个 RPC 回来手写一个 Unimplemented。
type fakeLedgerServiceClient struct {
	pb.LedgerServiceClient

	commitReq   *pb.CommitRequest
	commitReply *pb.CommitReply
	commitErr   error

	findReq   *pb.FindCommitRequest
	findReply *pb.FindCommitReply
	findErr   error
}

func (f *fakeLedgerServiceClient) GetDefinition(context.Context, *pb.GetDefinitionRequest, ...grpc.CallOption) (*pb.GetDefinitionReply, error) {
	return nil, status.Error(codes.Unimplemented, "not used in this test")
}
func (f *fakeLedgerServiceClient) ListDefinitions(context.Context, *pb.ListDefinitionsRequest, ...grpc.CallOption) (*pb.ListDefinitionsReply, error) {
	return nil, status.Error(codes.Unimplemented, "not used in this test")
}
func (f *fakeLedgerServiceClient) GetVersion(context.Context, *pb.GetVersionRequest, ...grpc.CallOption) (*pb.GetVersionReply, error) {
	return nil, status.Error(codes.Unimplemented, "not used in this test")
}
func (f *fakeLedgerServiceClient) LoadInstance(context.Context, *pb.LoadInstanceRequest, ...grpc.CallOption) (*pb.InstanceAggregate, error) {
	return nil, status.Error(codes.Unimplemented, "not used in this test")
}

func (f *fakeLedgerServiceClient) Commit(_ context.Context, in *pb.CommitRequest, _ ...grpc.CallOption) (*pb.CommitReply, error) {
	f.commitReq = in
	if f.commitErr != nil {
		return nil, f.commitErr
	}
	return f.commitReply, nil
}

func (f *fakeLedgerServiceClient) FindCommit(_ context.Context, in *pb.FindCommitRequest, _ ...grpc.CallOption) (*pb.FindCommitReply, error) {
	f.findReq = in
	if f.findErr != nil {
		return nil, f.findErr
	}
	return f.findReply, nil
}

var _ pb.LedgerServiceClient = (*fakeLedgerServiceClient)(nil)

// TestLedgerClient_RoundTrip：hostclient.Ledger 的 Commit / FindCommit 请求字段要完整映射到
// pb 请求、回包字段要完整还原成 ports 类型，错误要经 fromStatus 还原成哨兵错误。
func TestLedgerClient_RoundTrip(t *testing.T) {
	t.Run("Commit maps request fields and reply", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{commitReply: &pb.CommitReply{Applied: true, InstanceVersion: 5, OutcomeJson: `{"kind":"COMMITTED"}`}}
		l := NewLedgerForTest(fake)
		cs := &pb.Changeset{Instance: &pb.InstanceWrite{ExpectedVersion: 4}}
		result, err := l.Commit(context.Background(), "app-1", ports.CommitInput{RequestKey: "req-1", RequestDigest: "digest-1", ActorUserID: 42, OutcomeJSON: `{"kind":"COMMITTED"}`, Changeset: cs})
		if err != nil {
			t.Fatalf("commit: %v", err)
		}
		if fake.commitReq.GetAppId() != "app-1" || fake.commitReq.GetRequestKey() != "req-1" || fake.commitReq.GetRequestDigest() != "digest-1" ||
			fake.commitReq.GetActorUserId() != 42 || fake.commitReq.GetOutcomeJson() != `{"kind":"COMMITTED"}` || fake.commitReq.GetChangeset() != cs {
			t.Fatalf("commit request = %+v", fake.commitReq)
		}
		if !result.Applied || result.InstanceVersion != 5 || result.OutcomeJSON != `{"kind":"COMMITTED"}` {
			t.Fatalf("commit result = %+v", result)
		}
	})

	t.Run("Commit replay reply (applied=false)", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{commitReply: &pb.CommitReply{Applied: false, InstanceVersion: 2, OutcomeJson: `{"kind":"TASK_SAVED"}`}}
		l := NewLedgerForTest(fake)
		result, err := l.Commit(context.Background(), "app-1", ports.CommitInput{RequestKey: "req-1", Changeset: &pb.Changeset{}})
		if err != nil {
			t.Fatalf("commit: %v", err)
		}
		if result.Applied || result.InstanceVersion != 2 || result.OutcomeJSON != `{"kind":"TASK_SAVED"}` {
			t.Fatalf("replay result = %+v", result)
		}
	})

	t.Run("Commit error restored to ErrRequestKeyReused", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{commitErr: status.Error(codes.InvalidArgument, "REQUEST_KEY_REUSED: request_key req-1 reused with different content")}
		l := NewLedgerForTest(fake)
		_, err := l.Commit(context.Background(), "app-1", ports.CommitInput{RequestKey: "req-1", Changeset: &pb.Changeset{}})
		if !errors.Is(err, ports.ErrRequestKeyReused) {
			t.Fatalf("want ErrRequestKeyReused, got %v", err)
		}
	})

	t.Run("Commit error restored to ErrVersionConflict", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{commitErr: status.Error(codes.Aborted, "VERSION_CONFLICT: stale")}
		l := NewLedgerForTest(fake)
		_, err := l.Commit(context.Background(), "app-1", ports.CommitInput{RequestKey: "req-1", Changeset: &pb.Changeset{}})
		if !errors.Is(err, ports.ErrVersionConflict) {
			t.Fatalf("want ErrVersionConflict, got %v", err)
		}
	})

	t.Run("FindCommit maps request and a found reply", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{findReply: &pb.FindCommitReply{
			Found: true, RequestDigest: "digest-1", ActorUserId: 42, WorkflowInstanceId: "inst-1", DefinitionId: "", InstanceVersion: 5, OutcomeJson: `{"kind":"COMMITTED"}`,
		}}
		l := NewLedgerForTest(fake)
		found, err := l.FindCommit(context.Background(), "app-1", "req-1")
		if err != nil {
			t.Fatalf("find commit: %v", err)
		}
		if fake.findReq.GetAppId() != "app-1" || fake.findReq.GetRequestKey() != "req-1" {
			t.Fatalf("find commit request = %+v", fake.findReq)
		}
		if found == nil || found.RequestDigest != "digest-1" || found.ActorUserID != 42 || found.WorkflowInstanceID != "inst-1" ||
			found.InstanceVersion != 5 || found.OutcomeJSON != `{"kind":"COMMITTED"}` {
			t.Fatalf("found = %+v", found)
		}
	})

	t.Run("FindCommit not found returns (nil, nil)", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{findReply: &pb.FindCommitReply{Found: false}}
		l := NewLedgerForTest(fake)
		found, err := l.FindCommit(context.Background(), "app-1", "req-missing")
		if err != nil || found != nil {
			t.Fatalf("want (nil, nil), got (%+v, %v)", found, err)
		}
	})

	t.Run("FindCommit error propagated via fromStatus", func(t *testing.T) {
		fake := &fakeLedgerServiceClient{findErr: status.Error(codes.Internal, "SYSTEM_ERROR: db down")}
		l := NewLedgerForTest(fake)
		_, err := l.FindCommit(context.Background(), "app-1", "req-1")
		if !errors.Is(err, ports.ErrSystem) {
			t.Fatalf("want ErrSystem, got %v", err)
		}
	})
}
