package grpc

import (
	"context"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"

	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
)

// noteDeleteDelegatedToHost 说明 DefinitionService.Delete 为什么恒 Unimplemented：删除不在引擎，
// 由宿主网关自查该定义是否还有在跑实例（有则 DEFINITION_IN_USE）后直接删表行，引擎无需知情。
const noteDeleteDelegatedToHost = "删除由宿主网关自查运行中实例后直接删表行（DEFINITION_IN_USE），引擎不介入"

// DefinitionServer 实现 kimpo.workflow.engine.v1.DefinitionService（设计器保存/发布/查询
// 流程定义），接到 engineapp.Service。
type DefinitionServer struct {
	workflowenginev1.UnimplementedDefinitionServiceServer
	svc *engineapp.Service
}

// NewDefinitionServer 构造 DefinitionServer。
func NewDefinitionServer(svc *engineapp.Service) *DefinitionServer {
	return &DefinitionServer{svc: svc}
}

func (s *DefinitionServer) Create(ctx context.Context, req *workflowenginev1.CreateDefinitionRequest) (*workflowenginev1.DefinitionReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	view, err := s.svc.CreateDefinition(ctx, metaOf(req.GetMeta()), req.GetTemplateId(), req.GetName())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.Create", err)
	}
	return definitionReplyPB(view), nil
}

func (s *DefinitionServer) SaveDraft(ctx context.Context, req *workflowenginev1.SaveDraftRequest) (*workflowenginev1.DefinitionReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	view, err := s.svc.SaveDraft(ctx, metaOf(req.GetMeta()), req.GetDefinitionId(), req.GetDraftJson(), req.GetExpectedVersionNo())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.SaveDraft", err)
	}
	return definitionReplyPB(view), nil
}

func (s *DefinitionServer) Validate(ctx context.Context, req *workflowenginev1.ValidateRequest) (*workflowenginev1.ValidateReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	diags, err := s.svc.Validate(ctx, metaOf(req.GetMeta()), req.GetDefinitionId(), req.GetDraftJson(), req.GetTemplatePublished())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.Validate", err)
	}
	return &workflowenginev1.ValidateReply{Ok: len(diags) == 0, Diagnostics: diagnosticsToPB(diags)}, nil
}

func (s *DefinitionServer) Publish(ctx context.Context, req *workflowenginev1.PublishRequest) (*workflowenginev1.PublishReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.Publish(ctx, metaOf(req.GetMeta()), req.GetDefinitionId(), req.GetExpectedVersionNo(), req.GetTemplatePublished(), req.GetSerialFieldId())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.Publish", err)
	}
	return &workflowenginev1.PublishReply{VersionNo: res.VersionNo, VersionId: res.VersionID, Diagnostics: diagnosticsToPB(res.Diagnostics)}, nil
}

func (s *DefinitionServer) SetEnabled(ctx context.Context, req *workflowenginev1.SetEnabledRequest) (*workflowenginev1.DefinitionReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	view, err := s.svc.SetEnabled(ctx, metaOf(req.GetMeta()), req.GetDefinitionId(), req.GetEnabled())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.SetEnabled", err)
	}
	return definitionReplyPB(view), nil
}

// Delete 删除不在引擎：宿主网关自查运行中实例后直接删表行（DEFINITION_IN_USE），引擎不介入。
func (s *DefinitionServer) Delete(ctx context.Context, _ *workflowenginev1.DeleteDefinitionRequest) (*workflowenginev1.DeleteDefinitionReply, error) {
	return nil, unimplementedError(ctx, "DefinitionService.Delete", noteDeleteDelegatedToHost)
}

func (s *DefinitionServer) Get(ctx context.Context, req *workflowenginev1.GetDefinitionRequest) (*workflowenginev1.DefinitionReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	view, err := s.svc.GetDefinition(ctx, metaOf(req.GetMeta()), req.GetDefinitionId(), req.GetWithDraft())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.Get", err)
	}
	return definitionReplyPB(view), nil
}

func (s *DefinitionServer) List(ctx context.Context, req *workflowenginev1.ListDefinitionsRequest) (*workflowenginev1.ListDefinitionsReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	rows, err := s.svc.ListDefinitions(ctx, metaOf(req.GetMeta()), req.GetTemplateId(), req.GetIncludeDisabled())
	if err != nil {
		return nil, fail(ctx, "DefinitionService.List", err)
	}
	return &workflowenginev1.ListDefinitionsReply{Definitions: rows}, nil
}
