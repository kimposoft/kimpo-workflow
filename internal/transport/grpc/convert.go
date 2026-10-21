package grpc

import (
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"
	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// convert.go 只做 pb ↔ 应用服务层入参 / 出参的翻译，不含任何业务判断（业务在 engineapp.Service /
// internal/engine/core）。所有转换函数对 nil 输入安全（proto 生成的 Getxxx 对 nil 接收者返回零值）。

// metaOf 把请求公共头 RequestMeta 翻成应用服务层 Meta；调用前必须先过 requireMeta 校验。
func metaOf(meta *workflowhostv1.RequestMeta) engineapp.Meta {
	actor := meta.GetActor()
	return engineapp.Meta{
		AppID:      meta.GetAppId(),
		RequestKey: meta.GetRequestKey(),
		Actor:      ports.Actor{UserID: actor.GetUserId(), DisplayName: actor.GetDisplayName(), SuperAdmin: actor.GetIsSuperAdmin()},
		Locale:     meta.GetLocale(),
	}
}

// requireMeta 校验 RequestMeta 必填项（app_id / request_key）；不满足直接返回 InvalidArgument
// status，不经 toStatus（"INVALID_ARGUMENT" 不是 WorkflowErrorCode 枚举名，属传输层自产错误）。
func requireMeta(meta *workflowhostv1.RequestMeta) error {
	if meta.GetAppId() == "" || meta.GetRequestKey() == "" {
		return status.Error(codes.InvalidArgument, "INVALID_ARGUMENT: app_id and request_key are required")
	}
	return nil
}

// choicesOf 弹框后的选路 / 选人回填。
func choicesOf(c *workflowenginev1.Choices) core.Choices {
	return core.Choices{RouteLinkID: c.GetRouteChoiceLinkId(), SelectedAssignees: c.GetSelectedAssigneeUserIds()}
}

// startKindOf StartRequest.start_kind 空按 MANUAL（主要通道）；非法值也回退 MANUAL，不 panic。
func startKindOf(raw string) model.StartKind {
	switch model.StartKind(raw) {
	case model.StartKindAction, model.StartKindSubflow:
		return model.StartKind(raw)
	default:
		return model.StartKindManual
	}
}

// recordRefOf StartRequest.record（宿主已保存的单据定位）。
func recordRefOf(r *workflowhostv1.RecordRef) ports.RecordRef {
	return ports.RecordRef{AppID: r.GetAppId(), TemplateID: r.GetTemplateId(), RecordID: r.GetRecordId()}
}

// outcomeToPB 六态 ActionOutcome：把 engineapp.Result 翻成引擎面回包 oneof。
func outcomeToPB(res *engineapp.Result) *workflowenginev1.ActionOutcome {
	if res == nil {
		return &workflowenginev1.ActionOutcome{}
	}
	o := res.Outcome
	out := &workflowenginev1.ActionOutcome{}
	switch o.Kind {
	case core.OutcomeCommitted:
		out.Outcome = &workflowenginev1.ActionOutcome_Committed{Committed: &workflowenginev1.Committed{
			WorkflowInstanceId: o.WorkflowInstanceID,
			StepId:             o.StepID,
			Status:             o.Status,
			EndLabel:           o.EndLabel,
			InstanceVersion:    res.InstanceVersion,
			Replayed:           res.Replayed,
		}}
	case core.OutcomeRouteChoiceRequired:
		out.Outcome = &workflowenginev1.ActionOutcome_RouteChoiceRequired{RouteChoiceRequired: &workflowenginev1.RouteChoiceRequired{
			Options:    routeOptionsToPB(o.Routes),
			FromNodeId: o.FromNodeID,
		}}
	case core.OutcomeAssigneeChoiceRequired:
		out.Outcome = &workflowenginev1.ActionOutcome_AssigneeChoiceRequired{AssigneeChoiceRequired: &workflowenginev1.AssigneeChoiceRequired{
			NodeId:     o.NodeID,
			NodeName:   o.NodeName,
			Candidates: candidatesToPB(o.Candidates),
			ViaLinkId:  o.ViaLinkID,
		}}
	case core.OutcomeNoRoute:
		out.Outcome = &workflowenginev1.ActionOutcome_NoRoute{NoRoute: &workflowenginev1.NoRoute{Hint: o.Hint, Saved: o.Saved}}
	case core.OutcomeNoCandidate:
		out.Outcome = &workflowenginev1.ActionOutcome_NoCandidate{NoCandidate: &workflowenginev1.NoCandidate{Saved: o.Saved}}
	case core.OutcomeParked:
		out.Outcome = &workflowenginev1.ActionOutcome_Parked{Parked: &workflowenginev1.Parked{IncidentId: o.IncidentID}}
	}
	return out
}

func routeOptionsToPB(routes []core.RouteOption) []*workflowenginev1.RouteOption {
	if len(routes) == 0 {
		return nil
	}
	out := make([]*workflowenginev1.RouteOption, 0, len(routes))
	for _, r := range routes {
		out = append(out, &workflowenginev1.RouteOption{LinkId: r.LinkID, ToNodeId: r.ToNodeID, ToNodeName: r.ToNodeName})
	}
	return out
}

func candidatesToPB(people []ports.Person) []*workflowenginev1.CandidateInfo {
	if len(people) == 0 {
		return nil
	}
	out := make([]*workflowenginev1.CandidateInfo, 0, len(people))
	for _, p := range people {
		out = append(out, &workflowenginev1.CandidateInfo{UserId: p.UserID, DisplayName: p.DisplayName, SourceNotes: p.Notes})
	}
	return out
}

// diagnosticsToPB model.Diagnostic → 宿主面 Diagnostic（两个流程 proto 包共用形状，见 common.proto）。
func diagnosticsToPB(diags []model.Diagnostic) []*workflowhostv1.Diagnostic {
	if len(diags) == 0 {
		return nil
	}
	out := make([]*workflowhostv1.Diagnostic, 0, len(diags))
	for _, d := range diags {
		out = append(out, &workflowhostv1.Diagnostic{Code: d.Code, MessageKey: d.MessageKey, NodeId: d.NodeID, LinkId: d.LinkID, Arguments: d.Arguments})
	}
	return out
}

// definitionReplyPB 定义 + 版本清单（Create / SaveDraft / SetEnabled / Get 共用回包形状）。
func definitionReplyPB(v *engineapp.DefinitionView) *workflowenginev1.DefinitionReply {
	if v == nil {
		return &workflowenginev1.DefinitionReply{}
	}
	return &workflowenginev1.DefinitionReply{Definition: v.Definition, Versions: v.Versions}
}
