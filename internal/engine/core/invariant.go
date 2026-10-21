package core

import (
	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// checkInvariant 单令牌自检：把账本里的步骤叠加本次变更后，非 ENDED 实例恰一条 ACTIVE 且 current_step_id
// 指向它；ENDED 为零条。违反即 SYSTEM_ERROR，变更集不提交。
func checkInvariant(b *csBuilder, agg *pb.InstanceAggregate) error {
	if b.cs.Instance == nil || b.cs.Instance.GetRow() == nil {
		return errf("SYSTEM_ERROR", "changeset without instance row")
	}
	inst := b.cs.Instance.GetRow()
	merged := map[string]*pb.StepRow{}
	for _, s := range agg.GetSteps() {
		merged[s.GetStepId()] = s
	}
	for id, s := range b.steps {
		merged[id] = s
	}
	var active []string
	for id, s := range merged {
		if s.GetStatus() == string(model.StepStatusActive) {
			active = append(active, id)
		}
	}
	if inst.GetStatus() == string(model.InstanceStatusEnded) {
		if len(active) != 0 || inst.GetCurrentStepId() != "" {
			return errf("SYSTEM_ERROR", "single-token invariant: ended instance still has active steps %v", active)
		}
		return checkIncidents(b)
	}
	if len(active) != 1 || active[0] != inst.GetCurrentStepId() {
		return errf("SYSTEM_ERROR", "single-token invariant: active steps %v, current_step_id %q", active, inst.GetCurrentStepId())
	}
	return checkIncidents(b)
}

// checkIncidents 事故行自检：resume_point_json 是账本里的 JSON 列且非空，留空会让整笔提交死在
// 数据库的「文档为空」上——而那时报出来的是一个系统错误，动作已经算完、状态一点看不出哪里错
// （例如自动办理连环超限的事故若没带停驻点，整个发起动作只会报「服务器内部错误」）。在这里拦住，
// 比让数据库拦住早一步，也说得清楚。
func checkIncidents(b *csBuilder) error {
	for _, inc := range b.cs.IncidentUpserts {
		if inc.GetResumePointJson() == "" {
			return errf("SYSTEM_ERROR", "incident %s (%s) has no resume point", inc.GetIncidentId(), inc.GetKind())
		}
	}
	return nil
}
