package model

// 本文件是流程实例 / 步骤 / 任务 / 发件箱 / 事故等全部状态字符串常量的**唯一清单**
// （状态码是 VARCHAR 字符串不是数据库枚举，新增取值只改这里 + 四语 + 投影映射，不动表）。宿主账本行（workflow_* 表）与 SDK 行消息（kimpo.workflow.host.v1）
// 落库时逐字引用这些取值，禁止在别处另开字面量。
//
// 取值全部大写，与宿主账本的测试夹具一致。

// InstanceStatus 流程实例状态。PARKED 是内部第三态（停驻事故 M3），对外投影时映射为 RUNNING。
type InstanceStatus string

const (
	InstanceStatusRunning InstanceStatus = "RUNNING"
	InstanceStatusParked  InstanceStatus = "PARKED"
	InstanceStatusEnded   InstanceStatus = "ENDED"
)

// StartKind 实例发起方式（G9：非人工发起不能撤销发起）。
type StartKind string

const (
	StartKindManual  StartKind = "MANUAL"
	StartKindAction  StartKind = "ACTION"
	StartKindSubflow StartKind = "SUBFLOW"
)

// StepStatus 步骤状态：到达一次一行。
type StepStatus string

const (
	StepStatusActive    StepStatus = "ACTIVE"    // 当前站（单令牌：非结束实例恰一条）
	StepStatusPassed    StepStatus = "PASSED"    // 已过关向后走
	StepStatusWithdrawn StepStatus = "WITHDRAWN" // 被上一站撤销（G）
	StepStatusReturned  StepStatus = "RETURNED"  // 被回退
	StepStatusCancelled StepStatus = "CANCELLED" // 被终止
)

// StepOutcome 步骤关闭时的结果。
type StepOutcome string

const (
	StepOutcomeSubmitted StepOutcome = "SUBMITTED"
	StepOutcomeWithdrawn StepOutcome = "WITHDRAWN"
	StepOutcomeReturned  StepOutcome = "RETURNED"
	StepOutcomeAuto      StepOutcome = "AUTO"
	StepOutcomeEnded     StepOutcome = "ENDED"
	// StepOutcomeNotified 抄送步骤到达即完成：没有人要处理，步骤一到达就关闭。
	StepOutcomeNotified StepOutcome = "NOTIFIED"
	// StepOutcomeLaunched 子流程步骤已把子流程发出去（「不等待」档到达即完成）。
	StepOutcomeLaunched StepOutcome = "LAUNCHED"
	// StepOutcomeCancelled 步骤随实例被终止。
	StepOutcomeCancelled StepOutcome = "CANCELLED"
)

// StepNodeKind 步骤行 node_kind 列取值（与 NodeKind 一一对应，大写）。
func StepNodeKind(k NodeKind) string {
	switch k {
	case NodeKindStart:
		return "START"
	case NodeKindHandle:
		return "HANDLE"
	case NodeKindApprove:
		return "APPROVE"
	case NodeKindCC:
		return "CC"
	case NodeKindSubflow:
		return "SUBFLOW"
	case NodeKindEnd:
		return "END"
	default:
		return string(k)
	}
}

// NodeKindOfStep 步骤行 node_kind 列（大写）→ 节点类型常量，StepNodeKind 的反函数。
// 认不出的原样转成 NodeKind（调用方按「未注册类型」处理）。
func NodeKindOfStep(stepKind string) NodeKind {
	switch stepKind {
	case "START":
		return NodeKindStart
	case "HANDLE":
		return NodeKindHandle
	case "APPROVE":
		return NodeKindApprove
	case "CC":
		return NodeKindCC
	case "SUBFLOW":
		return NodeKindSubflow
	case "END":
		return NodeKindEnd
	default:
		return NodeKind(stepKind)
	}
}

// PassRule 办理方式（D）落库取值。
type PassRule string

const (
	PassRuleAny   PassRule = "ANY"
	PassRuleRatio PassRule = "RATIO"
)

// TaskStatus 任务状态。
type TaskStatus string

const (
	TaskStatusPending   TaskStatus = "PENDING"   // 待办
	TaskStatusSaved     TaskStatus = "SAVED"     // 暂存
	TaskStatusDone      TaskStatus = "DONE"      // 已完成
	TaskStatusWithdrawn TaskStatus = "WITHDRAWN" // 已撤销
)

// TaskKind 任务种类。
type TaskKind string

const (
	TaskKindStart   TaskKind = "START"
	TaskKindHandle  TaskKind = "HANDLE"
	TaskKindApprove TaskKind = "APPROVE"
)

// TaskActionCode 任务完成时的动作码。
type TaskActionCode string

const (
	TaskActionSubmit    TaskActionCode = "SUBMIT"
	TaskActionBackPrev  TaskActionCode = "BACK_PREV"
	TaskActionBackStart TaskActionCode = "BACK_START"
	TaskActionBackStep  TaskActionCode = "BACK_STEP"
)

// TaskActionButton 审批按钮的动作码：BTN:<按钮 id>（账本形状已冻结在 TaskRow.action_code 注释里）。
// 审批的动作不是「提交」而是「点了哪个按钮」，流转明细要能还原到具体按钮，所以不复用 SUBMIT。
func TaskActionButton(buttonID string) string { return "BTN:" + buttonID }

// BackMethodOfButton 审批按钮动作 → 回退方式（E1 三档）。动作是「提交通过」时返回空串。
// 动作是「不通过并结束流程」（end_flow）时同样返回空串：它是直达结束节点，不是回退，
// 调用方不得据此空串把它当成「提交通过」（引擎按动作本身分流）。
// 审批节点的「允许哪些回退方式」不另配清单，就由按钮清单本身表达：配了这个按钮即允许这一档。
func BackMethodOfButton(a ButtonAction) WithdrawMethod {
	switch a {
	case ButtonActionWithdrawPrev:
		return WithdrawMethodPreviousStep
	case ButtonActionWithdrawInit:
		return WithdrawMethodInitiator
	case ButtonActionWithdrawSpecify:
		return WithdrawMethodSpecified
	default:
		return ""
	}
}

// TaskActionOfBackMethod 回退方式 → 任务动作码（办理节点的回退用；审批走 BTN:<id>）。
func TaskActionOfBackMethod(m WithdrawMethod) TaskActionCode {
	switch m {
	case WithdrawMethodInitiator:
		return TaskActionBackStart
	case WithdrawMethodSpecified:
		return TaskActionBackStep
	default:
		return TaskActionBackPrev
	}
}

// TaskWithdrawReason 任务被撤销的原因。
type TaskWithdrawReason string

const (
	TaskWithdrawPriorWithdrawn TaskWithdrawReason = "PRIOR_WITHDRAWN" // 上一站撤销
	TaskWithdrawStepPassed     TaskWithdrawReason = "STEP_PASSED"     // 本步已过关
	TaskWithdrawStepReturned   TaskWithdrawReason = "STEP_RETURNED"   // 整步回退
	TaskWithdrawReassigned     TaskWithdrawReason = "REASSIGNED"      // 改派
	TaskWithdrawTerminated     TaskWithdrawReason = "TERMINATED"      // 终止
	TaskWithdrawStepEnded      TaskWithdrawReason = "STEP_ENDED"      // 本步已被他人点「不通过并结束流程」而结束
)

// CCReceiptStatus 抄送回执状态。
type CCReceiptStatus string

const (
	CCReceiptStatusUnread CCReceiptStatus = "UNREAD"
	CCReceiptStatusRead   CCReceiptStatus = "READ"
)

// OutboxKind 发件箱事件种类。宿主投影工作者据此更新记录状态投影 / 任务索引 / 发通知。
type OutboxKind string

const (
	OutboxInstanceStarted OutboxKind = "INSTANCE_STARTED"
	OutboxStepArrived     OutboxKind = "STEP_ARRIVED"
	OutboxTaskSaved       OutboxKind = "TASK_SAVED"
	OutboxTaskDone        OutboxKind = "TASK_DONE"
	OutboxStepPassed      OutboxKind = "STEP_PASSED"
	OutboxStepWithdrawn   OutboxKind = "STEP_WITHDRAWN"
	// OutboxStepReturned 整步回退。宿主投影与其它状态行同路（载荷是同一份快照），
	// 不需要宿主认识这个新种类。
	OutboxStepReturned    OutboxKind = "STEP_RETURNED"
	OutboxInstanceEnded   OutboxKind = "INSTANCE_ENDED"
	OutboxInstanceParked  OutboxKind = "INSTANCE_PARKED"
	OutboxInstanceResumed OutboxKind = "INSTANCE_RESUMED"
	// OutboxCcSent 抄送已发出：载荷带收件人、渠道、标题、正文，宿主投影按渠道
	// 各投一次。与 NOTIFY 一样走独立轨道——投递失败不该拖住同实例的状态行。
	OutboxCcSent OutboxKind = "CC_SENT"
	// OutboxSubflowStarted 子流程已发起：载荷带父子实例与等待档，供投影与审计。
	OutboxSubflowStarted OutboxKind = "SUBFLOW_STARTED"
	// OutboxNotify 通知事件：载荷 {event, recipient_user_ids, task_id, …}，宿主投影工作者
	// 单独消费、投递失败不阻塞同实例的状态投影；不参与记录状态 / 任务索引。
	OutboxNotify OutboxKind = "NOTIFY"
	// OutboxTaskReassigned 管理员改派任务：原任务 WITHDRAWN（REASSIGNED）+ 新任务
	// PENDING，走通用状态行轨道（宿主投影不按 Kind 分支，只有 NOTIFY / CC_SENT 两条独立轨道，
	// 其余一律按状态快照处理），不需要宿主接一行新代码。
	OutboxTaskReassigned OutboxKind = "TASK_REASSIGNED"
)

// NotifyEvent 是 OutboxNotify 载荷里的 event 取值。
type NotifyEvent string

const (
	NotifyTaskAssigned  NotifyEvent = "TASK_ASSIGNED"  // 收到任务
	NotifyTaskWithdrawn NotifyEvent = "TASK_WITHDRAWN" // 待办被上一步撤销
	NotifyInstanceEnded NotifyEvent = "INSTANCE_ENDED" // 流程结束（发起人）
	NotifyTaskReturned  NotifyEvent = "TASK_RETURNED"  // 单据被回退（收件人是回退目标步骤的办理人）
	// NotifyInstanceTerminated 实例被管理员终止（T1/T3/T5：新增第五类事件）。
	// 只在管理员主动终止（core.Engine.Terminate）这条路径上发，子流程处置复用的 ForceEnd
	// 不发；收件人是终止那一刻当前站还未完成的办理人/审批人，开关与渠道读发起
	// 节点的 NodeNotify.OnTerminated/Channels。
	NotifyInstanceTerminated NotifyEvent = "INSTANCE_TERMINATED"
)

// IncidentKind 事故种类。
type IncidentKind string

const (
	IncidentWriteFieldFailed IncidentKind = "WRITE_FIELD_FAILED"
	// IncidentEndWritePending 结束标识两段式提交的第一段：实例已停驻在结束节点、
	// 结束标识尚未写入。正常情况下同一请求内紧接着写字段并解决；写失败则 ParkAgain 改判为
	// WRITE_FIELD_FAILED 交管理员处理。
	IncidentEndWritePending    IncidentKind = "END_WRITE_PENDING"
	IncidentSubflowStartFailed IncidentKind = "SUBFLOW_START_FAILED"
	IncidentAutoChainLimit     IncidentKind = "AUTO_CHAIN_LIMIT"
)

// IncidentStatus 事故状态。
type IncidentStatus string

const (
	IncidentStatusOpen     IncidentStatus = "OPEN"
	IncidentStatusResolved IncidentStatus = "RESOLVED"
)

// LinkWaitMode 父子链接『是否等待』落库取值。
type LinkWaitMode string

const (
	LinkWaitModeWait   LinkWaitMode = "WAIT"
	LinkWaitModeNoWait LinkWaitMode = "NO_WAIT"
)

// LinkWaitModeOf 由子流程节点『是否等待』的布尔配置取链接行的 wait_mode 落库取值。
func LinkWaitModeOf(wait bool) LinkWaitMode {
	if wait {
		return LinkWaitModeWait
	}
	return LinkWaitModeNoWait
}

// LinkOrphanPolicy 父流程先结束时子流程的处置（仅「不等待」时有意义）落库取值。
type LinkOrphanPolicy string

const (
	LinkOrphanPolicyIgnore   LinkOrphanPolicy = "IGNORE"
	LinkOrphanPolicyForceEnd LinkOrphanPolicy = "FORCE_END"
)

// LinkOrphanPolicyOf 由节点配置的『处置』（SubflowDisposition，小写 ignore/force_end）取链接行
// 的 orphan_policy 落库取值；未识别的一律按「不管」处理（保守，不多做强制结束）。
func LinkOrphanPolicyOf(d SubflowDisposition) LinkOrphanPolicy {
	if d == SubflowDispositionForceEnd {
		return LinkOrphanPolicyForceEnd
	}
	return LinkOrphanPolicyIgnore
}

// LinkChildStatus 链接行里子实例的状态快照，沿用 InstanceStatus 的两档取值。
type LinkChildStatus string

const (
	LinkChildStatusRunning LinkChildStatus = LinkChildStatus(InstanceStatusRunning)
	LinkChildStatusEnded   LinkChildStatus = LinkChildStatus(InstanceStatusEnded)
)

// DefinitionStatus 定义状态（DV4 停用只拦新发起）。
type DefinitionStatus string

const (
	DefinitionStatusEnabled  DefinitionStatus = "enabled"
	DefinitionStatusDisabled DefinitionStatus = "disabled"
)
