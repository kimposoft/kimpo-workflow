package core

import (
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// preview.go 回答办理面一个只读的问题：「我现在这条任务能做什么」。不落库、不决策，
// 纯粹是把节点配置与实例现状翻译成界面要画的几样东西——允许的回退方式、可选的回退目标步骤、
// 审批按钮清单、无路提示。
//
// 为什么由引擎回答而不是让前端自己从流转明细里推：回退目标的口径（E6 跳过自动步骤与辅助节点、
// 子流程不作目标）与运行期真正执行时必须是同一份判定，两边各写一遍迟早会出现「界面能选、
// 点下去被拒」。这里与 back.go 共用 isBackTargetStep / backMethodsOf。

// PreviewInfo 一条任务当前可用的操作。
type PreviewInfo struct {
	// AllowedBackMethods 本节点允许的回退方式。
	AllowedBackMethods []model.WithdrawMethod
	// BackTargets 「回退到指定步骤」的可选步骤，按到达顺序。
	BackTargets []*pb.StepRow
	// Buttons 审批按钮；办理节点为空。
	Buttons []model.ApprovalButton
	// NoRouteHint 无路可走时的提示。
	NoRouteHint string
}

// Preview 只读地算出一条任务当前可用的操作。任务不存在、不属于操作人、或已经不可动作时报错，
// 与真正执行动作同一套前置判定（checkActionable），免得界面画出一套「其实点不动」的按钮。
func Preview(appID string, agg *pb.InstanceAggregate, taskID string, actorUserID int64) (*PreviewInfo, error) {
	l, err := loadCompiled(appID, agg)
	if err != nil {
		return nil, err
	}
	task := l.task(taskID)
	if err := checkActionable(l, task, ports.Actor{UserID: actorUserID}); err != nil {
		return nil, err
	}
	step := l.step(task.GetStepId())
	if step == nil {
		return nil, errf("SYSTEM_ERROR", "step %s not found", task.GetStepId())
	}
	node := l.compiled.Node(step.GetNodeId())
	if node == nil {
		return nil, errf("SYSTEM_ERROR", "node %s not in compiled definition", step.GetNodeId())
	}
	info := &PreviewInfo{NoRouteHint: node.NoRouteHint}
	if node.ApproveButtonsJSON != "" {
		_ = json.Unmarshal([]byte(node.ApproveButtonsJSON), &info.Buttons)
	}
	// 办理节点读允许清单、审批节点按按钮推导（backMethodsOf），界面据此决定要不要画目标步骤选择框。
	for _, m := range backMethodsOf(node) {
		// 允许「回退到上一步」但无处可退时不报给界面——报了也点不动。人工发起的实例最差也能
		// 退到发起步骤，所以这里实际只会拦下非人工发起、前面又没有人工步骤
		// 的那种实例。
		if m == model.WithdrawMethodPreviousStep {
			if _, _, err := backTarget(l, step, m, ""); err != nil {
				continue
			}
		}
		info.AllowedBackMethods = append(info.AllowedBackMethods, m)
	}
	info.BackTargets = BackTargets(agg)
	return info, nil
}
