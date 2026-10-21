package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// node_end.go 是结束节点的到达行为（经运行期注册表登记）：新建步骤并直接 PASSED、
// 实例 ENDED；配了结束标识写入字段的先记 EndWrite，交 app 层在提交变更集之前两段式写入
// （见 end.go 的 PrepareEndWrite / ResumeIncident——那是事故恢复的另一半，不是到达本身）。

// arriveEnd 到达结束节点。
func arriveEnd(e *Engine, ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor, seq int32) (*arrival, error) {
	now := e.now()
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), SeqNo: seq, NodeId: target.NodeID, NodeKind: target.NodeKind, NodeName: target.NodeName,
		Status: string(model.StepStatusPassed), EnteredByUserId: submitter.UserID, EnteredAt: now, ClosedAt: now, Outcome: string(model.StepOutcomeEnded),
	}
	if from != nil {
		step.EnteredFromStepId = from.GetStepId()
	}
	inst.Status = string(model.InstanceStatusEnded)
	inst.EndLabel, inst.EndNodeId, inst.EndedAt = target.EndLabel, target.NodeID, now
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = "", "", ""
	inst.LastActionAt = now
	b.step(step)
	b.outbox(model.OutboxInstanceEnded, l.agg, inst, nil)
	// 流程结束：通知发起人。配了结束标识写入字段时本变更集会被 PrepareEndWrite 改写成停驻，
	// 届时这条通知一并剔除，改由第二段（ResumeIncident）追加。开关读到达的这个
	// 结束节点（target）的 on_ended。
	notify := target.Notify()
	if notify.Enabled(model.NotifyKeyEnded) {
		b.notify(model.NotifyInstanceEnded, inst, []int64{inst.GetStarterUserId()}, "", l.startSummary(), target.NodeName, notify.ChannelsOrDefault())
	}
	a := &arrival{step: step, ended: true}
	if target.EndLabelFieldID != "" {
		a.endWrite = &EndWrite{FieldID: target.EndLabelFieldID, Label: target.EndLabel, NodeID: target.NodeID, StepID: step.StepId}
	}
	return a, nil
}

// init 登记结束节点的运行期行为：结束是主线终点，没有回退这回事（backMethods 留空）。
func init() {
	registerRuntime(model.NodeKindEnd, kindRuntime{arrive: arriveEnd})
}
