package grpc

import (
	"context"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"

	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// TaskServer 实现 kimpo.workflow.engine.v1.TaskService（暂存、提交、回退、审批按钮、
// 预告），全部方法都接到 engineapp.Service。
type TaskServer struct {
	workflowenginev1.UnimplementedTaskServiceServer
	svc *engineapp.Service
}

// NewTaskServer 构造 TaskServer。
func NewTaskServer(svc *engineapp.Service) *TaskServer { return &TaskServer{svc: svc} }

func (s *TaskServer) Save(ctx context.Context, req *workflowenginev1.SaveTaskRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.Save(ctx, metaOf(req.GetMeta()), req.GetTaskId())
	if err != nil {
		return nil, fail(ctx, "TaskService.Save", err)
	}
	return outcomeToPB(res), nil
}

func (s *TaskServer) Submit(ctx context.Context, req *workflowenginev1.SubmitTaskRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.Submit(ctx, metaOf(req.GetMeta()), req.GetTaskId(), choicesOf(req.GetChoices()))
	if err != nil {
		return nil, fail(ctx, "TaskService.Submit", err)
	}
	return outcomeToPB(res), nil
}

func (s *TaskServer) Withdraw(ctx context.Context, req *workflowenginev1.WithdrawTaskRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.Withdraw(ctx, metaOf(req.GetMeta()), req.GetTaskId())
	if err != nil {
		return nil, fail(ctx, "TaskService.Withdraw", err)
	}
	return outcomeToPB(res), nil
}

// Back 回退。
func (s *TaskServer) Back(ctx context.Context, req *workflowenginev1.BackTaskRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	method := backMethodOfPB(req.GetBackMode())
	if method == "" {
		return nil, fail(ctx, "TaskService.Back", &core.Error{Code: "INVALID_ARGUMENT", Message: "back_mode must be one of PREV / START / STEP"})
	}
	res, err := s.svc.Back(ctx, metaOf(req.GetMeta()), req.GetTaskId(), engineapp.BackInput{
		Method: method, TargetStepID: req.GetTargetStepId(), Comment: req.GetComment(), Choices: choicesOf(req.GetChoices()),
	})
	if err != nil {
		return nil, fail(ctx, "TaskService.Back", err)
	}
	return outcomeToPB(res), nil
}

// PressButton 审批按钮。
func (s *TaskServer) PressButton(ctx context.Context, req *workflowenginev1.PressButtonRequest) (*workflowenginev1.ActionOutcome, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	res, err := s.svc.PressButton(ctx, metaOf(req.GetMeta()), req.GetTaskId(), engineapp.PressButtonInput{
		ButtonID: req.GetButtonId(), Reason: req.GetComment(), TargetStepID: req.GetTargetStepId(), Choices: choicesOf(req.GetChoices()),
	})
	if err != nil {
		return nil, fail(ctx, "TaskService.PressButton", err)
	}
	return outcomeToPB(res), nil
}

// Preview 不提交，预告本任务允许的回退方式、回退目标、按钮与无路提示。
func (s *TaskServer) Preview(ctx context.Context, req *workflowenginev1.PreviewTaskRequest) (*workflowenginev1.PreviewTaskReply, error) {
	if err := requireMeta(req.GetMeta()); err != nil {
		return nil, err
	}
	info, err := s.svc.Preview(ctx, metaOf(req.GetMeta()), req.GetTaskId())
	if err != nil {
		return nil, fail(ctx, "TaskService.Preview", err)
	}
	reply := &workflowenginev1.PreviewTaskReply{NoRouteHint: info.NoRouteHint}
	for _, m := range info.AllowedBackMethods {
		reply.AllowedBackKinds = append(reply.AllowedBackKinds, backModeToPB(m))
	}
	for _, s := range info.BackTargets {
		reply.BackTargets = append(reply.BackTargets, &workflowenginev1.BackTarget{StepId: s.GetStepId(), SeqNo: s.GetSeqNo(), NodeName: s.GetNodeName()})
	}
	for _, b := range info.Buttons {
		reply.Buttons = append(reply.Buttons, &workflowenginev1.ButtonSpec{
			ButtonId: b.ID, Label: b.Name, Color: b.Color, Action: buttonActionToPB(b.Action),
			ResultLabel: b.ResultTag, CommentRequired: b.RequireReason,
		})
	}
	return reply, nil
}

// backMethodOfPB 线上的 back_mode（PREV | START | STEP）→ 回退方式；未知返回空串。
func backMethodOfPB(mode string) model.WithdrawMethod {
	switch mode {
	case "PREV":
		return model.WithdrawMethodPreviousStep
	case "START":
		return model.WithdrawMethodInitiator
	case "STEP":
		return model.WithdrawMethodSpecified
	default:
		return ""
	}
}

// backModeToPB 回退方式 → 线上的 back_mode。
func backModeToPB(m model.WithdrawMethod) string {
	switch m {
	case model.WithdrawMethodInitiator:
		return "START"
	case model.WithdrawMethodSpecified:
		return "STEP"
	default:
		return "PREV"
	}
}

// buttonActionToPB 按钮动作 → 线上的 action（SUBMIT | BACK_PREV | BACK_START | BACK_STEP | END_FLOW）。
// END_FLOW 是「不通过并结束流程」；宿主只需要这个动作字面量（前端二次确认框不展示目标
// 结束节点），目标 end_node_id 只在插件内部使用，不下发。
func buttonActionToPB(a model.ButtonAction) string {
	switch a {
	case model.ButtonActionWithdrawPrev:
		return "BACK_PREV"
	case model.ButtonActionWithdrawInit:
		return "BACK_START"
	case model.ButtonActionWithdrawSpecify:
		return "BACK_STEP"
	case model.ButtonActionEndFlow:
		return "END_FLOW"
	default:
		return "SUBMIT"
	}
}
