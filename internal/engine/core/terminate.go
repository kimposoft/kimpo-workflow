package core

import (
	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// terminate.go 是「强制结束一个实例」的通用实现。当前唯一的调用方是子流程 N6.5 / N6.8：
// 父流程结束（含被终止）那一刻，把它自己发起、配了「强制结束」且尚未结束的「不等待」子实例
// 逐一摁停；写成可复用的导出函数是为了 M1（管理员终止实例）将来直接复用，不必另起一份。
//
// ForceEnd 与正常流转到结束节点（node_end.go 的 arriveEnd）是两件不同的事：它不经过任何结束
// 节点、不写结束标识字段（没有「走到了哪个结束节点」这件事），只是把实例摁停在当前这一刻——
// 当前步骤标 CANCELLED、当前站待办任务全部 WITHDRAWN（原因 TERMINATED）、实例 ENDED，对外
// 固定显示业务文案「已终止」。

// forceEndLabel 强制结束对外显示的固定文案（中文硬编码，与 H2 默认摘要同一口径），不经过任何
// 结束节点配置，M1 与 N6.5/N6.8 共用同一句话。
const forceEndLabel = "已终止"

// ForceEnd 强制结束一个仍在跑的实例；agg 是调用方在提交前重新装载的最新聚合。reason 只供调用方
// 日志排障使用（M1 手动终止 / N6.5 父流程结束 / N6.8 父流程被终止，三个来处），本身不落库、
// 不影响行为——对外只有「已终止」一种展示，不按来处分支。已经结束的实例返回 (nil, nil)，
// 调用方按幂等处理（不是错误）。
func (e *Engine) ForceEnd(agg *pb.InstanceAggregate, reason string, actor ports.Actor) (*Decision, error) {
	// reason / actor 目前只供调用方日志排障，不落库、不分支行为——对外只有「已终止」一种展示；
	// 未来 M1 面板若要展示「谁因为什么终止」，落库位置就加在这里。
	_, _ = reason, actor
	inst := agg.GetInstance()
	if inst.GetStatus() == string(model.InstanceStatusEnded) {
		return nil, nil
	}
	now := e.now()
	instRow := cloneInstance(inst)
	currentStepID := inst.GetCurrentStepId()
	instRow.Status = string(model.InstanceStatusEnded)
	instRow.EndLabel = forceEndLabel
	instRow.EndedAt = now
	instRow.LastActionAt = now
	instRow.CurrentStepId, instRow.CurrentNodeId, instRow.CurrentNodeName = "", "", ""
	instRow.ParkedIncidentId = "" // 终止即了结，旧的停驻事故不再等人处理

	b := newCS()
	if currentStepID != "" {
		for _, s := range agg.GetSteps() {
			if s.GetStepId() != currentStepID {
				continue
			}
			cs := cloneStep(s)
			cs.Status, cs.ClosedAt, cs.Outcome = string(model.StepStatusCancelled), now, string(model.StepOutcomeCancelled)
			b.step(cs)
		}
	}
	var changed []*pb.TaskRow
	for _, t := range agg.GetTasks() {
		if t.GetStepId() != currentStepID {
			continue
		}
		if t.GetStatus() != string(model.TaskStatusPending) && t.GetStatus() != string(model.TaskStatusSaved) {
			continue
		}
		c := cloneTask(t)
		c.Status, c.WithdrawnAt, c.WithdrawReason = string(model.TaskStatusWithdrawn), now, string(model.TaskWithdrawTerminated)
		b.task(c)
		changed = append(changed, c)
	}
	b.instance(instRow, inst.GetVersion())
	b.outbox(model.OutboxInstanceEnded, agg, instRow, changed)
	d := &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: currentStepID, Status: instRow.Status, EndLabel: instRow.EndLabel}}
	if err := checkInvariant(b, agg); err != nil {
		return nil, err
	}
	return d, nil
}
