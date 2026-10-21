package hostclient

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// Ledger 实现 ports.Ledger：六本账读写全部转发宿主 LedgerServiceClient。无状态——每次调用
// 现从 ctx 取客户端，保证拿到当次请求真正绑定的宿主连接（ctx 由 gRPC 拦截器逐请求注入）。
type Ledger struct {
	// testClient 仅测试注入：正常生产路径永远从 ctx 经 plugin.WorkflowHostFrom 取客户端；
	// plugin.WorkflowHostFrom 依赖宿主进程真实注入的连接，单测里没有这个连接，所以留一个只有
	// 测试代码会用到的后门，绕开 ctx 直接指定假的 LedgerServiceClient（见 ledger_test.go）。
	testClient pb.LedgerServiceClient
}

// NewLedger 构造账本适配器。
func NewLedger() *Ledger { return &Ledger{} }

// NewLedgerForTest 仅测试用：注入假的 LedgerServiceClient，跳过 plugin.WorkflowHostFrom(ctx)。
func NewLedgerForTest(c pb.LedgerServiceClient) *Ledger { return &Ledger{testClient: c} }

func (l *Ledger) client(ctx context.Context) (pb.LedgerServiceClient, error) {
	if l.testClient != nil {
		return l.testClient, nil
	}
	host := plugin.WorkflowHostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("workflow host services")
	}
	c := host.WorkflowLedger()
	if c == nil {
		return nil, errUnavailable("ledger client")
	}
	return c, nil
}

// GetDefinition 定义头 + 版本清单（不含 graph_json / compiled_json）。
func (l *Ledger) GetDefinition(ctx context.Context, appID, definitionID string) (*pb.DefinitionRow, []*pb.DefinitionVersionRow, error) {
	c, err := l.client(ctx)
	if err != nil {
		return nil, nil, err
	}
	reply, err := c.GetDefinition(ctx, &pb.GetDefinitionRequest{AppId: appID, DefinitionId: definitionID})
	if err != nil {
		return nil, nil, fromStatus(err)
	}
	return reply.GetDefinition(), reply.GetVersions(), nil
}

// ListDefinitions 定义清单。
func (l *Ledger) ListDefinitions(ctx context.Context, appID, templateID string, includeDisabled bool) ([]*pb.DefinitionRow, error) {
	c, err := l.client(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := c.ListDefinitions(ctx, &pb.ListDefinitionsRequest{AppId: appID, TemplateId: templateID, IncludeDisabled: includeDisabled})
	if err != nil {
		return nil, fromStatus(err)
	}
	return reply.GetDefinitions(), nil
}

// GetVersion versionNo = 0 取最新已发布。
func (l *Ledger) GetVersion(ctx context.Context, appID, definitionID string, versionNo int64) (*pb.DefinitionVersionRow, error) {
	c, err := l.client(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := c.GetVersion(ctx, &pb.GetVersionRequest{AppId: appID, DefinitionId: definitionID, VersionNo: versionNo})
	if err != nil {
		return nil, fromStatus(err)
	}
	return reply.GetVersion(), nil
}

// LoadInstanceByID 按实例 id 定位（LoadInstanceRequest.by 的 workflow_instance_id 分支）。
func (l *Ledger) LoadInstanceByID(ctx context.Context, appID, workflowInstanceID string) (*pb.InstanceAggregate, error) {
	return l.loadInstance(ctx, &pb.LoadInstanceRequest{AppId: appID, By: &pb.LoadInstanceRequest_WorkflowInstanceId{WorkflowInstanceId: workflowInstanceID}})
}

// LoadInstanceByRecord 按单据 id 定位（P1：一单一实例）。
func (l *Ledger) LoadInstanceByRecord(ctx context.Context, appID, recordID string) (*pb.InstanceAggregate, error) {
	return l.loadInstance(ctx, &pb.LoadInstanceRequest{AppId: appID, By: &pb.LoadInstanceRequest_RecordId{RecordId: recordID}})
}

// LoadInstanceByTask 按任务 id 定位。
func (l *Ledger) LoadInstanceByTask(ctx context.Context, appID, taskID string) (*pb.InstanceAggregate, error) {
	return l.loadInstance(ctx, &pb.LoadInstanceRequest{AppId: appID, By: &pb.LoadInstanceRequest_TaskId{TaskId: taskID}})
}

// LoadInstanceByIncident 按事故 id 定位（ResumeIncident 只带 incident_id）。
func (l *Ledger) LoadInstanceByIncident(ctx context.Context, appID, incidentID string) (*pb.InstanceAggregate, error) {
	return l.loadInstance(ctx, &pb.LoadInstanceRequest{AppId: appID, By: &pb.LoadInstanceRequest_IncidentId{IncidentId: incidentID}})
}

// LoadParentOfChild 按子实例反查它的父实例聚合（N6.4 等待档）。
func (l *Ledger) LoadParentOfChild(ctx context.Context, appID, childInstanceID string) (*pb.InstanceAggregate, error) {
	return l.loadInstance(ctx, &pb.LoadInstanceRequest{AppId: appID, By: &pb.LoadInstanceRequest_ParentOfChildInstanceId{ParentOfChildInstanceId: childInstanceID}})
}

func (l *Ledger) loadInstance(ctx context.Context, req *pb.LoadInstanceRequest) (*pb.InstanceAggregate, error) {
	c, err := l.client(ctx)
	if err != nil {
		return nil, err
	}
	agg, err := c.LoadInstance(ctx, req)
	if err != nil {
		return nil, fromStatus(err)
	}
	return agg, nil
}

// Commit 提交变更集（宿主 CAS + request_key 幂等，事务规约见 ledger.proto 顶部注释；
// 带上意图摘要 / 操作人 / 结果快照，供宿主按请求日志判定重放 vs 请求键复用）。
func (l *Ledger) Commit(ctx context.Context, appID string, in ports.CommitInput) (ports.CommitResult, error) {
	c, err := l.client(ctx)
	if err != nil {
		return ports.CommitResult{}, err
	}
	reply, err := c.Commit(ctx, &pb.CommitRequest{AppId: appID, RequestKey: in.RequestKey, Changeset: in.Changeset, RequestDigest: in.RequestDigest, ActorUserId: in.ActorUserID, OutcomeJson: in.OutcomeJSON})
	if err != nil {
		return ports.CommitResult{}, fromStatus(err)
	}
	return ports.CommitResult{Applied: reply.GetApplied(), InstanceVersion: reply.GetInstanceVersion(), OutcomeJSON: reply.GetOutcomeJson()}, nil
}

// FindCommit 按请求键查已提交的动作（A5：引擎在决策前调用）；未找到时宿主回 found=false，本方法
// 还原成 (nil, nil)。
func (l *Ledger) FindCommit(ctx context.Context, appID, requestKey string) (*ports.CommittedRequest, error) {
	c, err := l.client(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := c.FindCommit(ctx, &pb.FindCommitRequest{AppId: appID, RequestKey: requestKey})
	if err != nil {
		return nil, fromStatus(err)
	}
	if !reply.GetFound() {
		return nil, nil
	}
	return &ports.CommittedRequest{RequestDigest: reply.GetRequestDigest(), ActorUserID: reply.GetActorUserId(), WorkflowInstanceID: reply.GetWorkflowInstanceId(),
		DefinitionID: reply.GetDefinitionId(), InstanceVersion: reply.GetInstanceVersion(), OutcomeJSON: reply.GetOutcomeJson()}, nil
}

var _ ports.Ledger = (*Ledger)(nil)
