package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// cc.go 是『抄送』的运行期：把单据知会给一批人，没有人需要处理，流程不停留。
//
// 与办理 / 审批的根本差别只有一条，但它决定了整段代码的形状：**抄送不走 C**。算出来的收件人
// 全部收到、不弹对话框，所以这里没有「候选多于一人就问」的分支，也没有任务行——
// 抄送写的是抄送行（workflow_cc），一收件人一渠道一行。
//
// 收件人算不出来（空集）时不发通知、不写行，流程照常向后走。这一条与办理节点的 C4
// 刻意不同：办理算不出人要停下等（没人办事情就办不了），抄送算不出人只是没人要知会，
// 不构成流程走不下去的理由。

// arriveCC 到达抄送节点。返回的 arrival 里没有任务；步骤到达即关闭（outcome=NOTIFIED）。
func (e *Engine) arriveCC(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor, seq int32) (*arrival, error) {
	now := e.now()
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), SeqNo: seq,
		NodeId: target.NodeID, NodeKind: target.NodeKind, NodeName: target.NodeName,
		Status: string(model.StepStatusPassed), EnteredByUserId: submitter.UserID, EnteredAt: now,
		ClosedAt: now, Outcome: string(model.StepOutcomeNotified),
	}
	if from != nil {
		step.EnteredFromStepId = from.GetStepId()
	}
	summary, err := e.summaryFor(ctx, l, target, submitter)
	if err != nil {
		return nil, err
	}
	step.SummaryText = summary

	// N4.1 收件人：按 A 算，不走 C。前手口径与办理节点一致。
	prev := to.PrevActors
	if len(prev) == 0 {
		prev = previousHumanActors(l, b, from.GetStepId(), []int64{submitter.UserID})
	}
	// 来源里配了「发起人」档的话，把实例发起人并入静态用户 id 清单——宿主候选计算协议
	// 没有这一档，运行期在这里就地取值（initiator_source.go）。
	staticUserIDs := withInitiatorSource(target.StaticUserIDs, target.SourcesJSON, inst.GetStarterUserId())
	// 先按来源算候选，配了过滤器再筛一道；筛完为空与「来源本来就没算出人」同一条
	// 既有路径（下面 len(people)>0 判定），不发通知、流程照常向后走。
	people, err := resolveCandidatesFiltered(ctx, e.Candidate, l.rec, target, staticUserIDs, prev, "recipients")
	if err != nil {
		return nil, err
	}

	b.step(step)
	if len(people) > 0 {
		title, body, err := e.ccText(ctx, l, target, submitter)
		if err != nil {
			return nil, err
		}
		channels := ccChannelsOf(target)
		var rows []*pb.CcRow
		for _, p := range people {
			for _, ch := range channels {
				rows = append(rows, &pb.CcRow{
					CcId: e.IDs.New("cc"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: step.StepId,
					RecipientUserId: p.UserID, Channel: string(ch), Title: title, Body: body,
					Status: string(model.CCReceiptStatusUnread), SentAt: now,
				})
			}
		}
		for _, r := range rows {
			b.cc(r)
		}
		b.ccSent(inst, step, rows)
	}

	// 穿插在主线里（还有主线出线）就继续沿主线走；末级抄送发完即完成，主线不受影响。
	if target.IsTerminalAuxiliary {
		return &arrival{step: step, auxiliaryOnly: true}, nil
	}
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, target.NodeID, target.NodeName
	inst.LastActionAt = now
	return e.continueAfterAuxiliary(ctx, l, b, inst, step, target, to, submitter)
}

// ccText 求抄送的标题与正文（两条宿主 V4 取值表达式，均必填）。
// 求值失败不吞：抄送发出去的是给人看的一句话，标题正文求不出来就不该发一条空白通知。
func (e *Engine) ccText(ctx context.Context, l *loaded, target *compile.NodeCompiled, actor ports.Actor) (string, string, error) {
	eval := func(pubID, docJSON, what string) (string, error) {
		if pubID == "" && docJSON == "" {
			return "", nil
		}
		text, null, err := e.Expr.EvaluateComputed(ctx, l.rec, pubID, docJSON, actor)
		if err != nil {
			return "", errf("EXPRESSION_INVALID", "node %s %s: %v", target.NodeID, what, err)
		}
		if null {
			return "", nil
		}
		return text, nil
	}
	title, err := eval(target.TitlePublicationID, target.TitleDocumentJSON, "cc title")
	if err != nil {
		return "", "", err
	}
	body, err := eval(target.ContentPublicationID, target.ContentDocumentJSON, "cc content")
	if err != nil {
		return "", "", err
	}
	return title, body, nil
}

// ccChannelsOf 取节点配置的通知渠道。一个都没配时回落系统通知——发布期已经拦住「一个都不选」
// （N4_CHANNEL_REQUIRED），这里的回落只是防御：宁可发一条站内通知，也不要静默什么都不发。
func ccChannelsOf(target *compile.NodeCompiled) []model.NotifyChannel {
	var out []model.NotifyChannel
	if target.CCChannelsJSON != "" {
		_ = json.Unmarshal([]byte(target.CCChannelsJSON), &out)
	}
	if len(out) == 0 {
		out = []model.NotifyChannel{model.NotifyChannelSystem}
	}
	return out
}

// init 登记抄送节点的运行期行为：辅助节点，没有回退这回事（backMethods 留空）。
func init() {
	registerRuntime(model.NodeKindCC, kindRuntime{arrive: (*Engine).arriveCC})
}
