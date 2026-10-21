package core

import (
	"sort"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// previous_actors.go 是『上步处理人』的唯一实现。
//
// 「与上步处理人的关系」这一类人员来源（同部门 / 上级部门 / 下级部门 / 部门主管 / 上级部门主管）
// 要以上一步的处理人为基准算人。规则：**上步处理人取最近的人工步骤；自动办理的步骤没有
// 人，跳过**。只取「本次提交人」一个人在两种情况下不对：
//   - 多人办理：本步是三个人一起办，过关的那一刻「上步处理人」应当是这一步实际办过的所有人，
//     不只是踩下过关那一脚的人（要以每一个人为基准分别算再取并集）；
//   - 上一步是自动办理：自动步骤没有人，要继续往前找最近的人工步骤。
//
// 这里只负责「算出是谁」，关系档位怎么展开成人由宿主的候选计算负责（插件不自己查组织）。

// previousHumanActors 返回当前实例里「最近一个人工步骤」的处理人清单。
//
// fromStepID 是即将到达的新步骤的来源步骤（也就是刚刚过关的那一步）：从它开始往前找，
// 命中第一个「人工步骤且确实有人办过」的步骤就返回该步骤全部办过的人（去重，保持步骤内任务的
// 顺序）。一个都找不到（例如发起之后的第一站，上一步就是发起）时返回 fallback——发起节点的
// 提交人就是发起人，他本人就是「上一步处理人」。
//
// 🔴 b 是本次动作正在攒的变更集，**必须叠加在决策前快照之上**：本次提交人的任务在
// 快照 l.agg 里仍是 PENDING，只有变更集里才是 DONE。只看快照会认为刚过关的这一步「没有人办过」，
// 于是继续往前找到上上一站——三站以上的链上「与上步处理人同部门」就算错了人（两站流程恰好靠
// 发起人兜底，看不出来）。b 为 nil 时只看快照。
func previousHumanActors(l *loaded, b *csBuilder, fromStepID string, fallback []int64) []int64 {
	if l == nil {
		return fallback
	}
	steps := overlaySteps(l, b)
	tasks := overlayTasks(l, b)
	// 步骤按 seq_no 升序排列（账本写入顺序），从 fromStep 往前逐个回溯。
	idx := -1
	for i, s := range steps {
		if s.GetStepId() == fromStepID {
			idx = i
			break
		}
	}
	if idx < 0 {
		idx = len(steps) - 1
	}
	for i := idx; i >= 0; i-- {
		s := steps[i]
		// 自动办理的步骤（auto_handled）虽然节点类型也是办理 / 审批，但没有人；辅助节点与被撤销
		// 的步骤同样跳过——A5 与 E6「上一步取最近人工步骤」是同一口径。
		if s.GetAutoHandled() || s.GetStatus() == string(model.StepStatusWithdrawn) {
			continue
		}
		if !isHumanStepKind(s.GetNodeKind()) {
			continue
		}
		actors := actorsOfStep(tasks, s.GetStepId())
		if len(actors) > 0 {
			return actors
		}
	}
	return fallback
}

// overlaySteps 快照里的步骤 + 变更集里新增 / 改过的步骤，按 seq_no 升序。变更集同 id 的行覆盖快照行。
func overlaySteps(l *loaded, b *csBuilder) []*pb.StepRow {
	out := append([]*pb.StepRow(nil), l.agg.GetSteps()...)
	if b == nil || b.cs == nil {
		return out
	}
	index := make(map[string]int, len(out))
	for i, s := range out {
		index[s.GetStepId()] = i
	}
	for _, s := range b.cs.GetStepUpserts() {
		if i, ok := index[s.GetStepId()]; ok {
			out[i] = s
			continue
		}
		index[s.GetStepId()] = len(out)
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].GetSeqNo() < out[j].GetSeqNo() })
	return out
}

// overlayTasks 快照里的任务 + 变更集里新增 / 改过的任务（同 id 覆盖），保持快照顺序、新增追加在后。
func overlayTasks(l *loaded, b *csBuilder) []*pb.TaskRow {
	out := append([]*pb.TaskRow(nil), l.agg.GetTasks()...)
	if b == nil || b.cs == nil {
		return out
	}
	index := make(map[string]int, len(out))
	for i, t := range out {
		index[t.GetTaskId()] = i
	}
	for _, t := range b.cs.GetTaskUpserts() {
		if i, ok := index[t.GetTaskId()]; ok {
			out[i] = t
			continue
		}
		index[t.GetTaskId()] = len(out)
		out = append(out, t)
	}
	return out
}

// isHumanStepKind 判断一个步骤是不是「人工步骤」：只有办理与审批两类会派任务给人。发起步骤虽然
// 也有人（发起人），但它是流程入口，A5 的「上一步」语义里由 fallback 覆盖，不在这里命中——
// 静态特征表里 Start 的 Human 就是 false，与此同一口径。判据走 traitsOfStep，不写死具体类型，
// 加一类会派任务给人的节点只需要把它的 Handler.Traits().Human 置为 true。
func isHumanStepKind(nodeKind string) bool {
	return traitsOfStep(nodeKind).Human
}

// actorsOfStep 取某个步骤里「实际办过的人」：任务状态为已完成的办理人，去重保序。
// 暂存、待办、被撤销的都不算——他们没有把流程往前推，不构成「上一步处理人」。
// tasks 是已叠加变更集的任务清单（见 overlayTasks）。
func actorsOfStep(tasks []*pb.TaskRow, stepID string) []int64 {
	var out []int64
	seen := make(map[int64]bool)
	for _, t := range tasks {
		if t.GetStepId() != stepID || t.GetStatus() != string(model.TaskStatusDone) {
			continue
		}
		uid := t.GetAssigneeUserId()
		if uid == 0 || seen[uid] {
			continue
		}
		seen[uid] = true
		out = append(out, uid)
	}
	return out
}
