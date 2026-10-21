package grpc

import (
	"context"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"

	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
)

// InstanceServer 实现 kimpo.workflow.engine.v1.InstanceService（发起、撤销发起、事故恢复、
// 流转明细聚合），接到 engineapp.Service。
type InstanceServer struct {
	workflowenginev1.UnimplementedInstanceServiceServer
	svc *engineapp.Service
}

// NewInstanceServer 构造 InstanceServer。
func NewInstanceServer(svc *engineapp.Service) *InstanceServer { return &InstanceServer{svc: svc} }

func (s *InstanceServer) Start(ctx context.Context, req *workflowenginev1.StartRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	in := engineapp.StartInput{
		DefinitionID: req.GetDefinitionId(),
		Record:       recordRefOf(req.GetRecord()),
		StartKind:    startKindOf(req.GetStartKind()),
		Choices:      choicesOf(req.GetChoices()),
	}
	res, err := s.svc.Start(ctx, metaOf(req.GetMeta()), in)
	if err != nil {
		return nil, fail(ctx, "InstanceService.Start", err)
	}
	return outcomeToPB(res), nil
}

func (s *InstanceServer) WithdrawStart(ctx context.Context, req *workflowenginev1.WithdrawStartRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.WithdrawStart(ctx, metaOf(req.GetMeta()), req.GetWorkflowInstanceId())
	if err != nil {
		return nil, fail(ctx, "InstanceService.WithdrawStart", err)
	}
	return outcomeToPB(res), nil
}

func (s *InstanceServer) ResumeIncident(ctx context.Context, req *workflowenginev1.ResumeIncidentRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.ResumeIncident(ctx, metaOf(req.GetMeta()), req.GetIncidentId(), req.GetNote())
	if err != nil {
		return nil, fail(ctx, "InstanceService.ResumeIncident", err)
	}
	return outcomeToPB(res), nil
}

// GetDetail 流转明细聚合 + 任务派生标志（task_flags）。
func (s *InstanceServer) GetDetail(ctx context.Context, req *workflowenginev1.GetDetailRequest) (*workflowenginev1.GetDetailReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	agg, flags, err := s.svc.GetDetailWithFlags(ctx, metaOf(req.GetMeta()), req.GetWorkflowInstanceId())
	if err != nil {
		return nil, fail(ctx, "InstanceService.GetDetail", err)
	}
	reply := &workflowenginev1.GetDetailReply{Aggregate: agg}
	for _, f := range flags {
		reply.TaskFlags = append(reply.TaskFlags, &workflowenginev1.TaskFlag{TaskId: f.TaskID, Withdrawable: f.Withdrawable, ReasonCode: f.ReasonCode})
	}
	return reply, nil
}
