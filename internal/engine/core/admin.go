package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// admin.go 是管理员三个能力（M1 终止 / M2 改派 / M3 事故清单）的状态机实现。
// 只许超管这条闸放在宿主网关（与事故恢复端点同一套闸），引擎自己不判角色——传进来的
// Actor 只用于落审计字段（谁点的、写进哪些行），不做权限判定。

// TerminateInput 终止入参。
type TerminateInput struct {
	AppID  string
	Agg    *pb.InstanceAggregate
	Actor  ports.Actor
	Reason string
}

// Terminate 管理员终止一个仍在跑的实例。已经结束的实例是幂等边界之外的明确拒绝
// （管理面板上「终止」这个按钮本就不该出现在已结束的实例上；ForceEnd 对已结束实例返回
// (nil, nil) 是给子流程善后那类「顺带来一次、可能已经结束」的系统性调用用的静默幂等，
// 管理员主动点按钮走的是另一条口径，要报错让前端知道按钮不该点得出）。
//
// 终止本身（当前站任务撤销、当前步骤 CANCELLED、实例 ENDED、对外显示「已终止」）全部复用
// core.ForceEnd，不重写一份。等待中的子流程一律强制结束、不等待的按节点配置处置：这一半不在
// 这里做——ForceEnd 只管本实例自己，向下处置子流程与其余结束路径共用同一条 app 层善后
// （afterInstanceEnded），
// app 层按 Decision.Outcome.Status==ENDED 统一触发，不需要 Terminate 自己再管一遍。
func (e *Engine) Terminate(ctx context.Context, in TerminateInput) (*Decision, error) {
	_ = ctx // 当前实现是纯计算，不需要 I/O；保留 ctx 形参与其余管理动作、以及未来可能的扩展对齐。
	inst := in.Agg.GetInstance()
	if inst == nil {
		return nil, errf("NOT_FOUND", "instance not found")
	}
	if inst.GetStatus() == string(model.InstanceStatusEnded) {
		return nil, errf("INSTANCE_ENDED", "instance %s has ended", inst.GetWorkflowInstanceId())
	}
	// 『被终止』通知事件：收件人是终止这一刻当前站还没收尾的
	// 办理人/审批人——必须在 ForceEnd 把这些任务改写成 WITHDRAWN 之前，从原始聚合（in.Agg，
	// ForceEnd 只读它、克隆后再改，不会就地修改）上收集；节点名同样取自终止前的
	// CurrentNodeName（ForceEnd 返回的实例行会把当前站清空）。
	currentStepID, currentNodeName := inst.GetCurrentStepId(), inst.GetCurrentNodeName()
	var recipients []int64
	for _, t := range in.Agg.GetTasks() {
		if t.GetStepId() != currentStepID {
			continue
		}
		if t.GetStatus() == string(model.TaskStatusPending) || t.GetStatus() == string(model.TaskStatusSaved) {
			recipients = append(recipients, t.GetAssigneeUserId())
		}
	}

	d, err := e.ForceEnd(in.Agg, in.Reason, in.Actor)
	if err != nil {
		return nil, err
	}
	if d == nil {
		// 上面已经拦过 ENDED，理论上到不了这里；防御性地给一个有意义的错误而不是让调用方拿
		// 到 nil 决策去解引用。
		return nil, errf("INSTANCE_ENDED", "instance %s has ended", inst.GetWorkflowInstanceId())
	}
	// 只在管理员终止这条路径上发（ForceEnd 本身被子流程处置复用，那些路径不走
	// Terminate，不受这里影响）。开关与渠道读发起节点的 on_terminated；compiled_json 解不出来
	// （理论不会发生，防御性处理）时保守不发，不阻断终止本身。
	if l, lerr := loadCompiled(in.AppID, in.Agg); lerr == nil {
		notify := l.compiled.Node(l.compiled.StartNodeID).Notify()
		if notify.Enabled(model.NotifyKeyTerminated) {
			if row := buildNotifyOutbox(model.NotifyInstanceTerminated, d.instance, recipients, "", l.startSummary(), currentNodeName, notify.ChannelsOrDefault()); row != nil {
				d.Changeset.OutboxAppends = append(d.Changeset.OutboxAppends, row)
			}
		}
	}
	return d, nil
}

// LeaseRelease 改派 / 终止后要释放的原办理人编辑租约，app 层据此调宿主
// LeaseService.ReleaseEditLease。TemplateID 与 RecordID 合起来定位单据（与 AppID 一起构成
// ports.RecordRef，AppID 由 app 层从调用的 Meta 里取，不必在这里重复携带）。
type LeaseRelease struct {
	// WorkflowInstanceID 被改派任务所属实例（释放租约时带给宿主核对归属）。
	WorkflowInstanceID string
	TemplateID         string
	RecordID           string
	HolderUserID       int64
	Reason             string
}

// ReassignInput 改派入参。
type ReassignInput struct {
	AppID    string
	Agg      *pb.InstanceAggregate
	TaskID   string
	ToUserID int64
	Actor    ports.Actor
	Reason   string
}

// Reassign 把一条待办任务换给另一个人。判据与 checkActionable 同一套状态段（实例未结束 /
// 未停驻、任务待办或暂存、在当前站），但**不查归属**——checkActionable 的第一条「任务属于操作
// 人自己」在这里天然不成立，改派本来就是把任务从别人手里挪给另一个人，这是它与普通任务动作
// 唯一的差别，其余状态判据原样照抄，不能因为要跳过归属就把状态判据也一起绕过去。
//
// 效果：原任务 WITHDRAWN（原因 REASSIGNED）+ 新任务 PENDING（同站同种类，标题沿用）；
// **assignee_count 与 passed_count 都不变**（M2「计数不变」——这不是这一站多了或少了一个人，
// 只是换了张脸，会签比例的分母分子都不该被这次改派影响）；新人收到「收到任务」通知
// （任务所在步骤的节点，on_assigned 开关）；Decision 带 PendingLeaseRelease 交
// app 层释放原办理人的编辑租约。
func (e *Engine) Reassign(ctx context.Context, in ReassignInput) (*Decision, error) {
	_ = ctx
	l, err := loadCompiled(in.AppID, in.Agg)
	if err != nil {
		return nil, err
	}
	task := l.task(in.TaskID)
	if task == nil {
		return nil, errf("NOT_FOUND", "task %s not found", in.TaskID)
	}
	inst := l.agg.GetInstance()
	switch inst.GetStatus() {
	case string(model.InstanceStatusEnded):
		return nil, errf("INSTANCE_ENDED", "instance %s has ended", inst.GetWorkflowInstanceId())
	case string(model.InstanceStatusParked):
		return nil, errf("INSTANCE_PARKED", "instance %s is parked on incident %s", inst.GetWorkflowInstanceId(), inst.GetParkedIncidentId())
	}
	if task.GetStatus() != string(model.TaskStatusPending) && task.GetStatus() != string(model.TaskStatusSaved) {
		return nil, errf("TASK_NOT_ACTIONABLE", "task %s is %s", task.GetTaskId(), task.GetStatus())
	}
	if task.GetStepId() != inst.GetCurrentStepId() {
		return nil, errf("TASK_NOT_ACTIONABLE", "task %s is not on the current step", task.GetTaskId())
	}
	if in.ToUserID <= 0 {
		return nil, errf("INVALID_ARGUMENT", "to_user_id is required")
	}
	if in.ToUserID == task.GetAssigneeUserId() {
		return nil, errf("INVALID_CHOICE", "task %s is already assigned to user %d", task.GetTaskId(), in.ToUserID)
	}

	now := e.now()
	instRow := cloneInstance(inst)
	instRow.LastActionAt = now
	old := cloneTask(task)
	old.Status, old.WithdrawnAt, old.WithdrawReason = string(model.TaskStatusWithdrawn), now, string(model.TaskWithdrawReassigned)
	newTask := &pb.TaskRow{
		TaskId: e.IDs.New("task"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: task.GetStepId(),
		DefinitionId: inst.GetDefinitionId(), RecordId: inst.GetRecordId(), TaskKind: task.GetTaskKind(),
		AssigneeUserId: in.ToUserID, Status: string(model.TaskStatusPending), Title: task.GetTitle(), PendingSince: now,
	}
	changed := []*pb.TaskRow{old, newTask}
	b := newCS()
	b.instance(instRow, inst.GetVersion())
	b.task(old)
	b.task(newTask)
	b.outbox(model.OutboxTaskReassigned, l.agg, instRow, changed)
	// 新人收到「收到任务」通知：开关读任务所在步骤的节点（不是发起节点），
	// 与正常到达时同一个 on_assigned 语义——改派也是「这个人现在要办这一步了」。
	nodeName := ""
	var reassignNotify *model.NodeNotify
	if step := l.step(task.GetStepId()); step != nil {
		nodeName = step.GetNodeName()
		reassignNotify = l.compiled.Node(step.GetNodeId()).Notify()
	}
	if reassignNotify.Enabled(model.NotifyKeyAssigned) {
		b.notify(model.NotifyTaskAssigned, instRow, []int64{in.ToUserID}, newTask.GetTaskId(), newTask.GetTitle(), nodeName, reassignNotify.ChannelsOrDefault())
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	d := &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow, tasks: changed,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: instRow.GetStatus()}}
	// 原办理人若持有编辑租约，交 app 层释放；他这一刻已经不再是这条任务的办理人了。
	d.PendingLeaseRelease = &LeaseRelease{WorkflowInstanceID: inst.GetWorkflowInstanceId(), TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId(),
		HolderUserID: task.GetAssigneeUserId(), Reason: string(model.TaskWithdrawReassigned)}
	return d, nil
}

// ListIncidents 按实例列事故，只回三类真正的事故（M5：写字段失败 / 子流程发起反复失败 /
// 自动连环超限）——END_WRITE_PENDING 是两段式提交中间的过渡态，正常情况下同一请求内就会被
// 紧接着的写字段解决掉，不该出现在管理员看到的事故清单里；万一它真的停留下来（进程在两段之间
// 崩溃），那本身已经是比「事故」更底层的系统故障，M3 的「查看原因、继续」这套面板不是为它设计
// 的，混进来只会让管理员误以为按「继续」就能像别的事故一样简单恢复。
func ListIncidents(agg *pb.InstanceAggregate) []*pb.IncidentRow {
	var out []*pb.IncidentRow
	for _, inc := range agg.GetIncidents() {
		switch model.IncidentKind(inc.GetKind()) {
		case model.IncidentWriteFieldFailed, model.IncidentSubflowStartFailed, model.IncidentAutoChainLimit:
			out = append(out, inc)
		}
	}
	return out
}
