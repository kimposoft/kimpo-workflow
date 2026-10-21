package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// resume_incident.go 承接 ResumeIncident 除 END_ARRIVE 外的另外两种停驻点恢复：
// AUTO_CHAIN_LIMIT（连续自动办理超限）与 SUBFLOW_START（子流程发起反复失败）。少了这两种，
// 事故清单能看到却永远恢复不了，违背「查看事故原因，处理后让实例从停驻点继续」的约定。

// resumeAutoChainLimit AUTO_CHAIN_LIMIT 停驻点的恢复：停在 rp.StepID 那条 ACTIVE 步骤（parkAutoChain
// 建的，节点是 rp.NodeID，没有派发任何任务）不再尝试自动求值——都已经连续超限了，条件八成还是
// 真——改按人工走『选人与派发』重新算候选：
//   - 多人：没有人在现场弹框，AutoSelectAll 全选（与 F3 自动办理之后到达下一站同一口径）；
//   - 零人：这次恢复没有产生任何变化，步骤原地留 ACTIVE，旧事故 RESOLVED 的同时立即再开一条
//     同类事故重新停驻，交管理员下次再试（例如先调整候选来源，M3「处理后继续」允许多次尝试）。
//
// 「上步处理人」按 A5 口径：从这一步的来处步骤（EnteredFromStepId）往前找最近的人工步骤，
// 找不到就落回当初触发自动办理链的那个人（parkAutoChain 建步骤时记的 EnteredByUserId）。
func (e *Engine) resumeAutoChainLimit(ctx context.Context, l *loaded, inst *pb.InstanceRow, incident *pb.IncidentRow, rp resumePoint, actor ports.Actor, note string) (*Decision, error) {
	step := l.step(rp.StepID)
	if step == nil || step.GetStatus() != string(model.StepStatusActive) {
		return nil, errf("SYSTEM_ERROR", "resume step %s not found or not active", rp.StepID)
	}
	target := l.compiled.Node(rp.NodeID)
	if target == nil {
		return nil, errf("SYSTEM_ERROR", "resume node %s not found", rp.NodeID)
	}
	now := e.now()
	instRow := cloneInstance(inst)
	inc := cloneIncident(incident)
	inc.Status, inc.ResolvedAt, inc.ResolvedByUserId, inc.ResolutionNote = string(model.IncidentStatusResolved), now, actor.UserID, note

	prev := previousHumanActors(l, nil, step.GetEnteredFromStepId(), []int64{step.GetEnteredByUserId()})
	// 事故恢复重算候选要走与正常到达（node_human.go）同一套
	// 「先算候选、配了过滤器再筛一道」编排（relation_filter.go），不能绕过——新编译产物的关系
	// 只存在 target.RelationFilters 里，若这里继续直接调 Candidate.Resolve 只喂 SourcesJSON，
	// 配了过滤器的节点恢复时会连关系带来的收窄都丢掉。
	people, err := resolveCandidatesFiltered(ctx, e.Candidate, l.rec, target, target.StaticUserIDs, prev, "candidates")
	if err != nil {
		return nil, err
	}
	b := newCS()
	if len(people) == 0 {
		// 零候选：步骤原地不动，旧事故 RESOLVED，立即再开一条同类事故重新停驻。
		again := &pb.IncidentRow{
			IncidentId: e.IDs.New("inc"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: step.GetStepId(),
			Kind: string(model.IncidentAutoChainLimit), Status: string(model.IncidentStatusOpen), OpenedAt: now,
			// 原因码与「连续自动办理超限」分开：这里是恢复时仍算不出办理人，管理员要去查办理人设置，
			// 不是去查自动办理环路（事故 kind 不变，只是界面原因文案不同）。
			ErrorCode: "RESUME_NO_CANDIDATE", ErrorMessage: "no candidate resolved on resume, parked again",
			ResumePointJson: rp.json(),
		}
		instRow.ParkedIncidentId = again.IncidentId
		instRow.LastActionAt = now
		b.instance(instRow, inst.GetVersion())
		b.incident(inc)
		b.incident(again)
		b.outbox(model.OutboxInstanceParked, l.agg, instRow, nil)
		if err := checkInvariant(b, l.agg); err != nil {
			return nil, err
		}
		return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
			Outcome: Outcome{Kind: OutcomeParked, IncidentID: again.IncidentId, WorkflowInstanceID: instRow.GetWorkflowInstanceId()}}, nil
	}

	// 有候选：按人工走 C，无人在场弹框，多候选一律全选（同 F3 口径）；步骤原地复用（不新开一行，
	// P5「同一节点走两次就两步」说的是**再次到达**，这一步压根没走完，不算再到达一次）。
	summary, err := e.summaryFor(ctx, l, target, actor)
	if err != nil {
		return nil, err
	}
	s := cloneStep(step)
	s.PassRule, s.PassRatio, s.AssigneeCount, s.SummaryText = target.PassRule, target.PassRatio, int32(len(people)), summary
	taskKind := string(traitsOf(target.KindOf()).TaskKind)
	var tasks []*pb.TaskRow
	for _, p := range people {
		tasks = append(tasks, &pb.TaskRow{
			TaskId: e.IDs.New("task"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: s.StepId, DefinitionId: inst.GetDefinitionId(), RecordId: inst.GetRecordId(),
			TaskKind: taskKind, AssigneeUserId: p.UserID, Status: string(model.TaskStatusPending), Title: summary, PendingSince: now,
		})
	}
	instRow.Status = string(model.InstanceStatusRunning)
	instRow.ParkedIncidentId = ""
	instRow.LastActionAt = now
	b.step(s)
	for _, t := range tasks {
		b.task(t)
	}
	b.instance(instRow, inst.GetVersion())
	b.incident(inc)
	b.outbox(model.OutboxInstanceResumed, l.agg, instRow, nil)
	b.outbox(model.OutboxStepArrived, l.agg, instRow, tasks)
	// 事故恢复重派与正常到达同一个 on_assigned 语义，读 target（这一步本来就在
	// 的那个节点）的通知配置。
	notify := target.Notify()
	if notify.Enabled(model.NotifyKeyAssigned) {
		channels := notify.ChannelsOrDefault()
		for _, t := range tasks {
			b.notify(model.NotifyTaskAssigned, instRow, []int64{t.GetAssigneeUserId()}, t.GetTaskId(), summary, target.NodeName, channels)
		}
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow, tasks: tasks,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: instRow.GetWorkflowInstanceId(), StepID: s.GetStepId(), Status: instRow.GetStatus()}}, nil
}

// resumeSubflowStart SUBFLOW_START 停驻点的恢复：子流程发起反复失败时，rp.NodeID/rp.StepID 那一步
// 本身该走的路早已经走完（等待档留 ACTIVE、不等待档已经继续往下走，都在失败之前的那次提交里
// 落定了）——恢复不需要再碰任何步骤，只需要把实例判回 RUNNING、事故 RESOLVED，再按当时的传递
// 字段重算一遍参数交给 app 层重新发起。已经发起成功过的（部分失败）靠 subflowAlreadyLaunched
// 判重跳过，不会重复发。
func (e *Engine) resumeSubflowStart(ctx context.Context, l *loaded, inst *pb.InstanceRow, incident *pb.IncidentRow, rp resumePoint, actor ports.Actor, note string) (*Decision, error) {
	target := l.compiled.Node(rp.NodeID)
	if target == nil {
		return nil, errf("SYSTEM_ERROR", "resume node %s not found", rp.NodeID)
	}
	now := e.now()
	instRow := cloneInstance(inst)
	instRow.Status = string(model.InstanceStatusRunning)
	instRow.ParkedIncidentId = ""
	instRow.LastActionAt = now
	inc := cloneIncident(incident)
	inc.Status, inc.ResolvedAt, inc.ResolvedByUserId, inc.ResolutionNote = string(model.IncidentStatusResolved), now, actor.UserID, note

	b := newCS()
	b.instance(instRow, inst.GetVersion())
	b.incident(inc)
	b.outbox(model.OutboxInstanceResumed, l.agg, instRow, nil)
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	d := &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: instRow.GetWorkflowInstanceId(), StepID: rp.StepID, Status: instRow.GetStatus()}}

	mappings := subflowMappingsOf(target)
	params, err := e.subflowParams(ctx, l, target, mappings)
	if err != nil {
		return nil, err
	}
	if subflowAlreadyLaunched(l, target.NodeID) {
		params = nil // 判重：上一轮已经有链接行挂在这个节点下，不重复发起
	}
	if len(params) > 0 {
		d.PendingSubflowStarts = []SubflowStart{{
			NodeID: target.NodeID, StepID: rp.StepID, TargetDefinitionID: target.SubflowTargetDefinitionID,
			Wait: target.SubflowWait, Disposition: target.SubflowDisposition, Params: params,
			Submitter: e.resumeSubflowSubmitter(ctx, l, rp),
		}}
	}
	return d, nil
}

// resumeSubflowSubmitter 事故恢复重新发起子流程时的发起人：**不是**处理事故的
// 管理员，而是当初把父流程送到这个子流程节点的那位办理人。
//   - 停驻时记进恢复点的那一份优先（带姓名）；
//   - 存量事故的恢复点没有这项记录：从该子流程步骤起回溯最近一位把流程往前送的真人
//     （lastHumanSubmitter；通常就是这一步的进入人，姓名尽力解析）；
//   - 都取不到：返回零值，app 层退回本次操作人。
func (e *Engine) resumeSubflowSubmitter(ctx context.Context, l *loaded, rp resumePoint) ports.Actor {
	if rp.SubmitterUserID != 0 {
		return ports.Actor{UserID: rp.SubmitterUserID, DisplayName: rp.SubmitterName, SuperAdmin: rp.SubmitterSuperAdmin}
	}
	return e.lastHumanSubmitter(ctx, l, nil, l.step(rp.StepID))
}
