package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin/workflowengine"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// PrepareEndWrite 结束标识两段式提交的第一段（结束标识不在 Commit 之前写入）：
// 把「已结束」变更集改写成「停驻在结束节点、结束标识待写」——结束步骤回 ACTIVE、实例 PARKED 并挂
// END_WRITE_PENDING 事故（OPEN，attempts=0，停驻点 END_ARRIVE）、发件箱换成 INSTANCE_PARKED、剔除
// 「流程结束」通知。app 层先提交这一段（占住实例版本，任何并发办理都会被 INSTANCE_PARKED 挡住），
// 再写字段，成功则 ResumeIncident 提交第二段（RESOLVED + ENDED），失败则 ParkAgain 改判为
// WRITE_FIELD_FAILED 交管理员。
func (e *Engine) PrepareEndWrite(d *Decision) *Decision {
	return e.parkEndWrite(d, model.IncidentEndWritePending, 0, nil)
}

// ParkForEndWrite 写结束标识失败时直接改写成停驻（WRITE_FIELD_FAILED，attempts=1）。生产路径
// 走 PrepareEndWrite → 写 → ParkAgain 两段式，本函数保留给「第一段提交前就已知写不了」的场合
// （例如单据服务未装配）。
func (e *Engine) ParkForEndWrite(d *Decision, writeErr error) *Decision {
	return e.parkEndWrite(d, model.IncidentWriteFieldFailed, 1, writeErr)
}

func (e *Engine) parkEndWrite(d *Decision, kind model.IncidentKind, attempts int32, writeErr error) *Decision {
	if d == nil || d.PendingEndWrite == nil || d.Changeset == nil {
		return d
	}
	now := e.now()
	inst := d.Changeset.GetInstance().GetRow()
	var endStep *pb.StepRow
	for _, s := range d.Changeset.GetStepUpserts() {
		if s.GetStepId() == d.PendingEndWrite.StepID {
			endStep = s
		}
	}
	if endStep == nil {
		return d
	}
	endStep.Status, endStep.ClosedAt, endStep.Outcome = string(model.StepStatusActive), nil, ""
	inst.Status = string(model.InstanceStatusParked)
	inst.EndLabel, inst.EndNodeId, inst.EndedAt = "", "", nil
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = endStep.GetStepId(), endStep.GetNodeId(), endStep.GetNodeName()
	incident := &pb.IncidentRow{
		IncidentId: e.IDs.New("inc"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: endStep.GetStepId(),
		Kind: string(kind), Status: string(model.IncidentStatusOpen), Attempts: attempts, OpenedAt: now,
		ResumePointJson: resumePoint{Action: "END_ARRIVE", NodeID: d.PendingEndWrite.NodeID, StepID: endStep.GetStepId(), FieldID: d.PendingEndWrite.FieldID, EndLabel: d.PendingEndWrite.Label}.json(),
	}
	if writeErr != nil {
		// 原因码按失败性质归类（业务拒绝带子码 / 其余 SYSTEM_ERROR），供流程管理页显示业务话原因。
		incident.ErrorCode, incident.ErrorMessage = incidentReasonCode(writeErr, false), writeErr.Error()
	}
	inst.ParkedIncidentId = incident.IncidentId
	d.Changeset.IncidentUpserts = append(d.Changeset.IncidentUpserts, incident)
	// 发件箱：去掉 INSTANCE_ENDED 与「流程结束」通知，改 INSTANCE_PARKED。
	var kept []*pb.OutboxRow
	for _, o := range d.Changeset.GetOutboxAppends() {
		if o.GetKind() == string(model.OutboxInstanceEnded) || notifyEventOf(o) == model.NotifyInstanceEnded {
			continue
		}
		kept = append(kept, o)
	}
	// 停驻态当前步骤是结束节点本身，没有人工任务，current_assignee_user_ids 天然为空。
	kept = append(kept, stateOutboxRow(model.OutboxInstanceParked, workflowengine.StateFromInstance(inst, d.tasks, nil)))
	d.Changeset.OutboxAppends = kept
	// PendingEndWrite 留给调用方（两段式第一段提交后仍要据此写字段）；Outcome 改停驻。
	d.Outcome = Outcome{Kind: OutcomeParked, IncidentID: incident.IncidentId, WorkflowInstanceID: inst.GetWorkflowInstanceId()}
	return d
}

// ResumeInput 事故恢复入参。
type ResumeInput struct {
	AppID      string
	Agg        *pb.InstanceAggregate
	IncidentID string
	Actor      ports.Actor
	Note       string
}

// ResumeIncident 从停驻点继续：按事故的停驻点分派到三种恢复路径之一：
//   - END_ARRIVE：结束标识写入失败，再次交 app 层写字段；成功变更集 = 事故 RESOLVED +
//     结束步骤 PASSED + 实例 ENDED，失败由 ParkAgain 记 attempts+1 仍停驻；
//   - AUTO_CHAIN_LIMIT：连续自动办理超限而停驻在那一步的 ACTIVE 步骤，
//     恢复时按人工走 C 重新派发（多候选 AutoSelectAll，零候选留步骤 ACTIVE 并再开一条同类事故）；
//   - SUBFLOW_START：子流程发起反复失败，恢复时把 Decision.PendingSubflowStarts
//     重新带回去，交 app 层的 runSubflowStarts 再试一次（已发起过的按链接判重跳过）。
func (e *Engine) ResumeIncident(ctx context.Context, in ResumeInput) (*Decision, error) {
	l, err := loadCompiled(in.AppID, in.Agg)
	if err != nil {
		return nil, err
	}
	inst := l.agg.GetInstance()
	// 实例状态按语义报错（先于事故查找），且事故必须就是实例当前停驻的那一条。
	switch inst.GetStatus() {
	case string(model.InstanceStatusEnded):
		return nil, errf("INSTANCE_ENDED", "instance %s has ended", inst.GetWorkflowInstanceId())
	case string(model.InstanceStatusParked):
	default:
		return nil, errf("TASK_NOT_ACTIONABLE", "instance %s is not parked", inst.GetWorkflowInstanceId())
	}
	var incident *pb.IncidentRow
	for _, i := range l.agg.GetIncidents() {
		if i.GetIncidentId() == in.IncidentID {
			incident = i
		}
	}
	if incident == nil || incident.GetStatus() != string(model.IncidentStatusOpen) {
		return nil, errf("NOT_FOUND", "open incident %s not found", in.IncidentID)
	}
	if inst.GetParkedIncidentId() != in.IncidentID {
		return nil, errf("NOT_FOUND", "incident %s is not the parked incident of instance %s", in.IncidentID, inst.GetWorkflowInstanceId())
	}
	var rp resumePoint
	if err := json.Unmarshal([]byte(incident.GetResumePointJson()), &rp); err != nil {
		return nil, errf("SYSTEM_ERROR", "unsupported resume point: %s", incident.GetResumePointJson())
	}
	switch rp.Action {
	case "END_ARRIVE":
		return e.resumeEndArrive(l, inst, incident, rp, in.Actor, in.Note)
	case "AUTO_CHAIN_LIMIT":
		return e.resumeAutoChainLimit(ctx, l, inst, incident, rp, in.Actor, in.Note)
	case "SUBFLOW_START":
		return e.resumeSubflowStart(ctx, l, inst, incident, rp, in.Actor, in.Note)
	default:
		return nil, errf("SYSTEM_ERROR", "unsupported resume point: %s", incident.GetResumePointJson())
	}
}

// resumeEndArrive END_ARRIVE 停驻点的恢复：见 ResumeIncident 顶部注释。
func (e *Engine) resumeEndArrive(l *loaded, inst *pb.InstanceRow, incident *pb.IncidentRow, rp resumePoint, actor ports.Actor, note string) (*Decision, error) {
	step := l.step(rp.StepID)
	if step == nil {
		return nil, errf("SYSTEM_ERROR", "resume step %s not found", rp.StepID)
	}
	now := e.now()
	instRow := cloneInstance(inst)
	instRow.Status, instRow.EndLabel, instRow.EndNodeId, instRow.EndedAt = string(model.InstanceStatusEnded), rp.EndLabel, rp.NodeID, now
	instRow.CurrentStepId, instRow.CurrentNodeId, instRow.CurrentNodeName, instRow.ParkedIncidentId = "", "", "", ""
	instRow.LastActionAt = now
	s := cloneStep(step)
	s.Status, s.ClosedAt, s.Outcome = string(model.StepStatusPassed), now, string(model.StepOutcomeEnded)
	inc := cloneIncident(incident)
	inc.Status, inc.ResolvedAt, inc.ResolvedByUserId, inc.ResolutionNote = string(model.IncidentStatusResolved), now, actor.UserID, note
	b := newCS()
	b.instance(instRow, inst.GetVersion())
	b.step(s)
	b.incident(inc)
	b.outbox(model.OutboxInstanceResumed, l.agg, instRow, nil)
	b.outbox(model.OutboxInstanceEnded, l.agg, instRow, nil)
	// 两段式第二段的「流程结束」通知，与 node_end.go 到达时那条是同一件事的两处发生时机
	// （配了结束标识写入字段时走这里，否则走 arriveEnd 那条）——开关同样读 rp.NodeID 对应的
	// 结束节点，不能读丢了变成从 l.compiled.Notify 判。
	endNotify := l.compiled.Node(rp.NodeID).Notify()
	if endNotify.Enabled(model.NotifyKeyEnded) {
		b.notify(model.NotifyInstanceEnded, instRow, []int64{instRow.GetStarterUserId()}, "", l.startSummary(), s.GetNodeName(), endNotify.ChannelsOrDefault())
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	d := &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: instRow.GetWorkflowInstanceId(), StepID: s.GetStepId(), Status: instRow.GetStatus(), EndLabel: instRow.GetEndLabel()}}
	if rp.FieldID != "" {
		d.PendingEndWrite = &EndWrite{FieldID: rp.FieldID, Label: rp.EndLabel, NodeID: rp.NodeID, StepID: rp.StepID}
	}
	return d, nil
}

// ParkAgain 写结束标识失败（两段式第一段之后，或恢复时再次失败）：事故 attempts+1、记错误，实例保持停驻
// （不改状态，只更新事故行；END_WRITE_PENDING 改判 WRITE_FIELD_FAILED）。
func (e *Engine) ParkAgain(agg *pb.InstanceAggregate, incidentID string, writeErr error) *Decision {
	inst := agg.GetInstance()
	var incident *pb.IncidentRow
	for _, i := range agg.GetIncidents() {
		if i.GetIncidentId() == incidentID {
			incident = i
		}
	}
	if incident == nil {
		return &Decision{Outcome: Outcome{Kind: OutcomeParked, IncidentID: incidentID, WorkflowInstanceID: inst.GetWorkflowInstanceId()}}
	}
	inc := cloneIncident(incident)
	inc.Attempts++
	// 原因码按失败性质归类，口径同 ParkForEndWrite。
	inc.ErrorCode, inc.ErrorMessage = incidentReasonCode(writeErr, false), writeErr.Error()
	if inc.GetKind() == string(model.IncidentEndWritePending) {
		// 两段式第一段之后首次写失败：从「待写」改判为真正的事故，交管理员处理。
		inc.Kind = string(model.IncidentWriteFieldFailed)
	}
	instRow := cloneInstance(inst)
	instRow.LastActionAt = e.now()
	b := newCS()
	b.instance(instRow, inst.GetVersion())
	b.incident(inc)
	b.outbox(model.OutboxInstanceParked, agg, instRow, nil)
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow, Outcome: Outcome{Kind: OutcomeParked, IncidentID: incidentID, WorkflowInstanceID: inst.GetWorkflowInstanceId()}}
}
