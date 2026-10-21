package grpc

import (
	"context"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"

	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
)

// noteLifecycleOwnedByHost 记录 / 定义生命周期级联（OnRecord* / OnDefinitionDeleted）由宿主自己
// 处理账本行与投影表（这些表归宿主所有），本服务不实现，保持冻结壳。
const noteLifecycleOwnedByHost = "记录 / 定义生命周期由宿主自行处理"

// noteListIncidentsCrossInstanceGap definition_id 跨实例枚举仍是冻结壳的说明（接口面只加不改——
// workflow_instance_id 已作为新字段追加，见 admin.proto；definition_id 这一半留着）：
//
// 跨实例查询需要宿主账本能按 (app_id, definition_id, status?) 枚举 workflow_incident，这条能力
// 当前的 LedgerService 没有（只能按实例 / 记录 / 任务 / 事故四种方式定位单个聚合），引擎自己也
// 不持有跨实例索引。要接上要么新增一条宿主账本 RPC（需要宿主后端配合实现，不是插件 + SDK
// 能单独交付的），要么把 definition_id 参数当 workflow_instance_id 用（字段名对不上，会让调用方
// 看到的接口语义和实际行为不一致）——两条路都需要先定接口，暂时保持冻结壳。
const noteListIncidentsCrossInstanceGap = "跨实例（仅 definition_id）枚举缺宿主账本能力，需新增宿主接口，见 admin.go 注释"

// AdminServer 实现 kimpo.workflow.engine.v1.AdminService（管理员终止/改派/事故清单，
// 以及记录/定义生命周期级联通知）。TerminateInstance / ReassignTask 已接到
// engineapp.Service；ListIncidents 带 workflow_instance_id 时按单实例已接线，仅
// definition_id（跨实例枚举）因接口面缺口暂留冻结壳（见 noteListIncidentsCrossInstanceGap）；
// 记录 / 定义生命周期四个方法归宿主自处理，本服务不实现。
type AdminServer struct {
	workflowenginev1.UnimplementedAdminServiceServer
	svc *engineapp.Service
}

// NewAdminServer 构造 AdminServer。
func NewAdminServer(svc *engineapp.Service) *AdminServer { return &AdminServer{svc: svc} }

// TerminateInstance 终止一个仍在跑的实例（是否只许超管由宿主网关判定，引擎不判角色）。
func (s *AdminServer) TerminateInstance(ctx context.Context, req *workflowenginev1.TerminateInstanceRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.Terminate(ctx, metaOf(req.GetMeta()), engineapp.TerminateInput{InstanceID: req.GetWorkflowInstanceId(), Reason: req.GetNote()})
	if err != nil {
		return nil, fail(ctx, "AdminService.TerminateInstance", err)
	}
	return outcomeToPB(res), nil
}

// ReassignTask 把一条待办任务换给另一个人，原任务撤销、新任务待办、计数不变；
// 原办理人若持有单据编辑租约随之释放（app 层按 Decision.PendingLeaseRelease 处理）。
func (s *AdminServer) ReassignTask(ctx context.Context, req *workflowenginev1.ReassignTaskRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.Reassign(ctx, metaOf(req.GetMeta()), engineapp.ReassignInput{TaskID: req.GetTaskId(), ToUserID: req.GetToUserId(), Reason: req.GetNote()})
	if err != nil {
		return nil, fail(ctx, "AdminService.ReassignTask", err)
	}
	return outcomeToPB(res), nil
}

// ListIncidents workflow_instance_id 非空时按单实例查（与 InstanceService.GetDetail 同源
// 聚合，按三类事故过滤），再按 status（若传）筛一遍；workflow_instance_id 为空、只给了
// definition_id 时是跨实例枚举，账本没有这个能力，保持冻结壳（见 noteListIncidentsCrossInstanceGap）。
func (s *AdminServer) ListIncidents(ctx context.Context, req *workflowenginev1.ListIncidentsRequest) (*workflowenginev1.ListIncidentsReply, error) {
	if req.GetWorkflowInstanceId() == "" {
		return nil, unimplementedError(ctx, "AdminService.ListIncidents", noteListIncidentsCrossInstanceGap)
	}
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	incidents, err := s.svc.ListIncidents(ctx, metaOf(req.GetMeta()), req.GetWorkflowInstanceId())
	if err != nil {
		return nil, fail(ctx, "AdminService.ListIncidents", err)
	}
	if status := req.GetStatus(); status != "" {
		filtered := incidents[:0:0]
		for _, inc := range incidents {
			if inc.GetStatus() == status {
				filtered = append(filtered, inc)
			}
		}
		incidents = filtered
	}
	return &workflowenginev1.ListIncidentsReply{Incidents: incidents}, nil
}

// OnRecordDeleted 单据彻底删除：实例、步骤、任务、回执、链接一并删除。
func (s *AdminServer) OnRecordDeleted(ctx context.Context, _ *workflowenginev1.RecordLifecycleRequest) (*workflowenginev1.RecordLifecycleReply, error) {
	return nil, unimplementedError(ctx, "AdminService.OnRecordDeleted", noteLifecycleOwnedByHost)
}

// OnRecordSoftDeleted 单据软删 / 还原：实例一并软删 / 还原。
func (s *AdminServer) OnRecordSoftDeleted(ctx context.Context, _ *workflowenginev1.RecordLifecycleRequest) (*workflowenginev1.RecordLifecycleReply, error) {
	return nil, unimplementedError(ctx, "AdminService.OnRecordSoftDeleted", noteLifecycleOwnedByHost)
}

func (s *AdminServer) OnRecordRestored(ctx context.Context, _ *workflowenginev1.RecordLifecycleRequest) (*workflowenginev1.RecordLifecycleReply, error) {
	return nil, unimplementedError(ctx, "AdminService.OnRecordRestored", noteLifecycleOwnedByHost)
}

// OnDefinitionDeleted 定义删除：实例与单据连删，由宿主网关在删除定义时调用。
func (s *AdminServer) OnDefinitionDeleted(ctx context.Context, _ *workflowenginev1.DefinitionLifecycleRequest) (*workflowenginev1.DefinitionLifecycleReply, error) {
	return nil, unimplementedError(ctx, "AdminService.OnDefinitionDeleted", noteLifecycleOwnedByHost)
}
