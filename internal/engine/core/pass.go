package core

import (
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// pass.go 是『办理方式』的过关判定唯一实现。办理节点与审批节点共用同一份判定，
// 两类节点只是叫法不同（任一人办完即过 / 一人同意即过；按比例办完 / 按比例同意）。
//
// 四条规则：
//   - D1 分母是**本步选中办理人的人数**（step.assignee_count），不是候选人数。选人对话框选了几
//     个人，分母就是几。
//   - D2 「通过」在办理节点指提交、在审批节点指点了动作为「提交通过」的按钮；回退类操作不计入
//     通过数（回退走的是整步回退，根本走不到计数）。
//   - D3 本步过关后，其余人尚未完成的任务撤销。
//   - D4 本步任何一人回退，整步立即回退，其余未完成任务撤销；多数通过压不过先到的一票回退。
//     「先到」按同一实例版本上的先后决定：回退与提交都要带实例版本做 CAS，后到的那个会因为
//     版本冲突被拒并重新读取，读到的就是已经回退掉的步骤，于是自然失效。

// passedEnough 判定本步是否已经过关。passedCount 是本步累计的通过人数（含本次），
// assigneeCount 是本步选中的办理人数（D1 的分母），rule/ratio 来自编译产物。
//
// 按比例用整数比较（passed * 100 >= assignee * ratio），不引入浮点：ratio 是百分比整数，
// 3 人 60% 即 passed*100 >= 180，两人通过（200）过关、一人（100）不过关。
func passedEnough(rule string, ratio, passedCount, assigneeCount int32) bool {
	if assigneeCount <= 0 {
		// 没有选中任何人的步骤不该存在（C4 会把它转成暂存），真出现了就按「不过关」处理，
		// 宁可停住等人来看，也不要凭空放行。
		return false
	}
	if rule != string(model.PassRuleRatio) {
		return true // 任一人：第一个通过即过
	}
	if ratio <= 0 {
		ratio = 100 // 百分比缺省按 100%（全部）
	}
	return passedCount*100 >= assigneeCount*ratio
}

// closeOtherOpenTasks 把同一步骤里除 keep 之外仍未完成（待办 / 暂存）的任务全部收掉，标上给出
// 的原因，返回被改动的任务行。D3（过关撤余，原因 STEP_PASSED）与 D4（一票回退撤余，原因
// STEP_RETURNED）共用这一段——两处各写一遍迟早漏掉暂存态那一支。
func closeOtherOpenTasks(l *loaded, stepID, keepTaskID string, reason model.TaskWithdrawReason, now *timestamppb.Timestamp) []*pb.TaskRow {
	var changed []*pb.TaskRow
	for _, other := range l.tasksOfStep(stepID) {
		if other.GetTaskId() == keepTaskID {
			continue
		}
		if other.GetStatus() != string(model.TaskStatusPending) && other.GetStatus() != string(model.TaskStatusSaved) {
			continue
		}
		o := cloneTask(other)
		o.Status, o.WithdrawnAt, o.WithdrawReason = string(model.TaskStatusWithdrawn), now, string(reason)
		changed = append(changed, o)
	}
	return changed
}
