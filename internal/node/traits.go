package node

import (
	"sync"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// traits.go 是节点类型的**静态特征表**。
//
// 引擎运行期与发布期编译器不按节点类型写 switch（到达 / 提交 / 暂存 / 回退 / 撤销 / 上步处理人 /
// 主线判定六处）——那样每加一类节点都要回头改六处，漏一处就是一个只有运行时才看得见的缺陷。这些
// 「这类节点是什么样的」的判断全部收进本表，由各节点的 Handler.Traits() 声明，消费方只问特征、
// 不问类型；「这类节点到达时做什么」（有 I/O 的行为）则在 engine/core 的运行期注册表里按类型登记。
//
// 加一类节点：node/<kind>.go 声明校验与特征 + compile/kind_<kind>.go 声明发布期摊平 +
// engine/core/node_<kind>.go 声明到达行为，各一行注册；不改任何 switch。

// WithdrawRule 撤销（G）时，这类节点的步骤夹在「我那一站」与「下一站」之间该怎么算。
type WithdrawRule string

const (
	// WithdrawPassThrough 抄送：已经发出去的不撤回，也不影响可撤销。
	WithdrawPassThrough WithdrawRule = "pass"
	// WithdrawBlockIfHuman 办理 / 审批：真有人办过就不能撤；系统自动办理过的可以撤。
	WithdrawBlockIfHuman WithdrawRule = "block_if_human"
	// WithdrawBlockLaunched 子流程：已经发起出去了，撤不回来。
	WithdrawBlockLaunched WithdrawRule = "block_launched"
)

// Traits 一类节点的静态特征。全部是纯数据，不带行为。
type Traits struct {
	// Main 主线节点（发起 / 办理 / 审批 / 结束）；辅助节点（抄送 / 子流程）为 false。
	// L10 出线要求、末级辅助节点与支线的判定都看它。
	Main bool
	// Human 会把任务派给人（办理 / 审批）。上步处理人、回退目标、撤销中间步骤都看它。
	// 发起节点虽然也有人（发起人），但它是流程入口，A5 的「上一步」语义由兜底覆盖，这里为 false。
	Human bool
	// TaskKind 派发任务的种类（任务中心据此显示「办理 / 审批」）；不派任务的节点为空。
	TaskKind model.TaskKind
	// Submit / Save / Back 办理面的三个直接动作对这类节点的任务是否可用。审批三者皆否——
	// 动作只能来自按钮（Buttons），否则会绕过按钮校验、理由必填与结果 / 理由写字段。
	Submit bool
	Save   bool
	Back   bool
	// Buttons 动作来自审批按钮（PressButton）。
	Buttons bool
	// Withdraw 撤销时作为中间步骤的规则。
	Withdraw WithdrawRule
	// BranchTarget 可以作为支线的终点——只有辅助节点可以。
	BranchTarget bool
}

var (
	defaultOnce sync.Once
	defaultReg  *Registry
)

// Default 包级默认注册表（全部六类节点），首次访问时构造。引擎运行期与编译器共用同一份。
func Default() *Registry {
	defaultOnce.Do(func() { defaultReg = NewDefaultRegistry() })
	return defaultReg
}

// TraitsOf 按节点类型取静态特征；未注册的类型返回零值与 false（调用方按「不是主线、不派任务、
// 什么都不能做」处理，宁可保守）。
func TraitsOf(kind model.NodeKind) (Traits, bool) {
	h, ok := Default().Get(kind)
	if !ok {
		return Traits{}, false
	}
	return h.Traits(), true
}

// TraitsOfStep 按步骤行的 node_kind 列（大写）取特征。
func TraitsOfStep(stepKind string) (Traits, bool) {
	return TraitsOf(model.NodeKindOfStep(stepKind))
}
