// Package model 定义流程文档（Document）的内存模型：节点、引导线、状态常量，以及
// JSON 反序列化 + 结构校验（schema.go）。
//
// 本文件承载发起、办理、审批、抄送、结束、子流程六类节点的设计期配置结构体，供设计器
// 保存/加载文档、发布期检查读取。节点的运行期行为（到达时做什么、如何跟宿主换数据）
// 在 internal/node（各节点 Handler）与 internal/engine/core（引擎状态机）里实现。
package model

import "encoding/json"

// NodeKind 是节点类型的字符串常量集合，与画布前端（frontend/）的节点类型标识对齐。
type NodeKind string

const (
	// NodeKindStart 发起节点：主线，恰一个，新建流程时自动放好、不可删除。
	NodeKindStart NodeKind = "start"
	// NodeKindHandle 办理节点：主线，零到多个，由人补充表单数据。
	NodeKindHandle NodeKind = "handle"
	// NodeKindApprove 审批节点：主线，零到多个，只做审批判断不改表单内容。
	NodeKindApprove NodeKind = "approve"
	// NodeKindCC 抄送节点：辅助，零到多个，不停留。
	NodeKindCC NodeKind = "cc"
	// NodeKindSubflow 子流程节点：辅助，零到多个，发起另一条流程。
	NodeKindSubflow NodeKind = "subflow"
	// NodeKindEnd 结束节点：主线，至少一个，可多个，各配自己的结束标识。
	NodeKindEnd NodeKind = "end"
)

// KnownNodeKinds 是当前承认的全部节点类型闭集，供 schema.go 的未知类型校验使用。
// 新增节点类型须显式在此登记——不接受调用方隐式扩展。
var KnownNodeKinds = map[NodeKind]bool{
	NodeKindStart:   true,
	NodeKindHandle:  true,
	NodeKindApprove: true,
	NodeKindCC:      true,
	NodeKindSubflow: true,
	NodeKindEnd:     true,
}

// Node 是画布上的一个节点：通用信封 + 按 Kind 区分的专属配置（Config，序列化态用
// json.RawMessage 延迟解析，具体节点包在需要时按 Kind 解码进对应 XxxConfig）。
type Node struct {
	// ID 节点在本文档内唯一。
	ID string `json:"id"`
	// Kind 节点类型，取值见 NodeKind 常量。
	Kind NodeKind `json:"kind"`
	// Name 节点在画布上的展示名（设计者可改，默认按类型生成）。
	Name string `json:"name,omitempty"`
	// Config 节点专属配置的原始 JSON，按 Kind 解码为 StartConfig/HandleConfig/…
	Config json.RawMessage `json:"config,omitempty"`
	// PositionX/PositionY 画布坐标，引擎不关心，仅设计器读写、随文档整体保存。
	PositionX float64 `json:"position_x,omitempty"`
	PositionY float64 `json:"position_y,omitempty"`
}

// FieldGrade 是字段权限档位。B-可编辑型用全部四档；B-只看型只用 继承/只读/隐藏 三档
// （FieldGradeEdit 出现在 B-只看型字段清单里视为非法，由发布期检查或写入侧拒绝）。
type FieldGrade string

const (
	FieldGradeInherit  FieldGrade = "inherit" // 继承模板权限
	FieldGradeEdit     FieldGrade = "edit"    // 编辑（仅 B-可编辑型可用）
	FieldGradeReadonly FieldGrade = "readonly"
	FieldGradeHidden   FieldGrade = "hidden"
)

// FieldPermission 是字段权限清单的一条：目标数据表 + 字段 + 档位。
type FieldPermission struct {
	TableID string     `json:"table_id"`
	FieldID string     `json:"field_id"`
	Grade   FieldGrade `json:"grade"`
}

// AssigneeSourceKind 是『人员来源』五种取值之一。
type AssigneeSourceKind string

const (
	AssigneeSourceUser       AssigneeSourceKind = "user"       // 直接选人
	AssigneeSourceRole       AssigneeSourceKind = "role"       // 选角色
	AssigneeSourceDepartment AssigneeSourceKind = "department" // 选部门
	AssigneeSourceMainField  AssigneeSourceKind = "main_field" // 主表字段（按值匹配人）
	// AssigneeSourceRelation 与上步处理人的关系（五档）。「关系」现在是过滤器而不是来源（见下方
	// HandleConfig/ApproveConfig/CCConfig.RelationFilters）：设计层不再产生这个 kind 的来源条目，
	// AssigneeSource.Relation 字段与本常量只为读兼容保留——旧文档（设计器草稿，经
	// model.HandleConfigOf 等解码入口就地改记为过滤器）与旧编译产物（已发布版本的
	// compiled_json.NodeCompiled.SourcesJSON，已发布版本不重新编译，运行期继续按旧语义并集加人，
	// 见 engine/core/relation_filter.go）都还会遇到它。
	AssigneeSourceRelation AssigneeSourceKind = "relation"
	// AssigneeSourceInitiator 发起人：不用配任何参数，选中即表示运行时按实例的发起人取
	// 只用于办理、审批、抄送三类节点，
	// 发起节点自身的「谁能发起」没有这一档（发起的那一刻还没有发起人）。宿主候选计算协议里
	// 没有这一档，运行期由引擎自己就地取值（见 engine/core/initiator_source.go）。
	AssigneeSourceInitiator AssigneeSourceKind = "initiator"
)

// AssigneeRelation 是『与上步处理人的关系』的五档取值。
type AssigneeRelation string

const (
	AssigneeRelationSameDept      AssigneeRelation = "same_department"
	AssigneeRelationParentDept    AssigneeRelation = "parent_department"
	AssigneeRelationChildDept     AssigneeRelation = "child_department"
	AssigneeRelationDeptManager   AssigneeRelation = "department_manager"
	AssigneeRelationParentDeptMgr AssigneeRelation = "parent_department_manager"
)

// AssigneeMatchBy 是『主表字段』来源匹配依据二选一。
type AssigneeMatchBy string

const (
	AssigneeMatchByDisplayName AssigneeMatchBy = "display_name" // 用户名（可能撞名）
	AssigneeMatchByLoginName   AssigneeMatchBy = "login_name"
)

// AssigneeSource 是人员来源清单的一条；同一节点可配多条并按 A2 取并集。
type AssigneeSource struct {
	Kind AssigneeSourceKind `json:"kind"`
	// UserIDs Kind=user 时生效；编码为十进制字符串数组（见 ids.go IDList，防 19 位 id 丢精度）。
	UserIDs IDList `json:"user_ids,omitempty"`
	// RoleIDs Kind=role 时生效。
	RoleIDs []string `json:"role_ids,omitempty"`
	// DepartmentIDs Kind=department 时生效。
	DepartmentIDs []string `json:"department_ids,omitempty"`
	// MainFieldID / MatchBy Kind=main_field 时生效（A3：按用户名或登录名匹配）。
	MainFieldID string          `json:"main_field_id,omitempty"`
	MatchBy     AssigneeMatchBy `json:"match_by,omitempty"`
	// Relation Kind=relation 时生效（五档见 AssigneeRelation）。
	Relation AssigneeRelation `json:"relation,omitempty"`
}

// CompleteModeKind 是『办理方式』两档取值，过关判定相同、节点上的叫法不同
// （办理节点「任一人办完即过/按比例办完」，审批节点「一人同意即过/按比例同意」）。
type CompleteModeKind string

const (
	CompleteModeAny        CompleteModeKind = "any"        // 任一：第一个「通过」即过
	CompleteModePercentage CompleteModeKind = "percentage" // 按比例：通过人数 ≥ 选中人数 × 百分比
	// CompleteModeAll 全部（办理叫「全部完成」，审批叫「会签」）：语义上等同按比例 100%，
	// 单独存一档而不是让设计者去配「按比例 100%」，是为了以后改比例定义时不把这一档一起改坏
	// 过关判定上两者等价，编译期都落成
	// PassRuleRatio/100（见 compile.passRuleOf），不看 PercentageBP。
	CompleteModeAll CompleteModeKind = "all"
)

// CompleteMode 是『办理方式』的完整配置：档位 + 按比例时的百分比（默认 100）。
type CompleteMode struct {
	Kind CompleteModeKind `json:"kind"`
	// PercentageBP 万分比（basis points，10000=100%）；Kind=percentage 时生效，默认 10000。
	// 用整数而非 float 避免精度问题（比对「通过人数 * 10000 >= 总人数 * PercentageBP」）。
	PercentageBP int `json:"percentage_bp,omitempty"`
}

// WithdrawMethod 是『回退』三种目标取值之一，节点上逐个勾选允许哪些。
type WithdrawMethod string

const (
	WithdrawMethodPreviousStep WithdrawMethod = "previous_step"  // 回退到上一步
	WithdrawMethodInitiator    WithdrawMethod = "initiator"      // 回退到发起人
	WithdrawMethodSpecified    WithdrawMethod = "specified_step" // 回退到指定步骤（运行期选）
)

// ClearOnWithdrawField 是『回退时清空』清单的一条：目标数据表 + 字段。
type ClearOnWithdrawField struct {
	TableID string `json:"table_id"`
	FieldID string `json:"field_id"`
}

// NotifyChannel 是『通知渠道』三选多之一。
type NotifyChannel string

const (
	NotifyChannelSystem NotifyChannel = "system"
	NotifyChannelSMS    NotifyChannel = "sms"
	NotifyChannelEmail  NotifyChannel = "email"
)

// —— 节点级通知配置 ——
//
// 通知开关从流程定义级（Document.Notify，见 document.go 顶部注释）下放到节点级：每张
// 主线节点（发起 / 办理 / 审批 / 结束）各自挂一份 NodeNotify，事件开关默认全开、渠道默认
// 只有 system。抄送、子流程节点没有 notify——抄送本就是『发出即完成』，通知参数就是它自己
// 的正文/渠道配置（CCConfig）；子流程节点不产生任何面向人的通知事件。

// NotifyKeyAssigned 等五个字符串常量是 NodeNotify.Enabled 的键，同时也是 JSON 里对应
// 开关字段的键名（json 标签与这里的取值逐字一致，改一处要跟着改另一处）。
const (
	NotifyKeyAssigned   = "on_assigned"   // 收到任务（办理 / 审批）
	NotifyKeyReturned   = "on_returned"   // 被退回到这一步（办理 / 审批）/ 被退回到发起人（发起）
	NotifyKeyWithdrawn  = "on_withdrawn"  // 提交被撤销（发起）
	NotifyKeyTerminated = "on_terminated" // 实例被管理员终止（发起）
	NotifyKeyEnded      = "on_ended"      // 流程结束（结束）
)

// NodeNotify 是节点级通知配置：若干事件开关（键缺席 = 默认开）+ 渠道多选（缺席或空数组 =
// 默认仅 system）。哪个开关对哪类节点有意义，按节点类型分别只读取以下几个键，其余键对该类
// 节点没有意义，节点校验 / 编译 / 运行期一律忽略、不报错：
//   - 办理 HandleConfig / 审批 ApproveConfig：OnAssigned、OnReturned；
//   - 发起 StartConfig：OnReturned、OnWithdrawn、OnTerminated；
//   - 结束 EndConfig：OnEnded；
//   - 抄送 CCConfig、子流程 SubflowConfig：没有 notify 字段。
//
// 开关用 *bool 而不是 bool：JSON 反序列化后 bool 零值是 false，没法区分「设计者显式关掉」
// 与「压根没配这个键」，而约定「键缺席 = 默认开」——必须能分辨这两种情况。
type NodeNotify struct {
	OnAssigned   *bool `json:"on_assigned,omitempty"`
	OnReturned   *bool `json:"on_returned,omitempty"`
	OnWithdrawn  *bool `json:"on_withdrawn,omitempty"`
	OnTerminated *bool `json:"on_terminated,omitempty"`
	OnEnded      *bool `json:"on_ended,omitempty"`
	// Channels 通知渠道多选，取值同 NotifyChannel；缺席或空数组时 ChannelsOrDefault 兜底为
	// 仅 system。发布期渠道取值合法性校验见 node/notify_rules.go。
	Channels []NotifyChannel `json:"channels,omitempty"`
}

// Enabled 判断 key（取 NotifyKeyAssigned 等五个常量之一）对应的事件开关是否打开。
// n 为 nil（节点整个没配 notify）、开关本身是 nil（配了 notify 但没配这个键）、或 key 不认识
// （新事件类型出现时，老编译器/老运行时不该把它当成「关闭」），三种情况统一按「开」处理。
func (n *NodeNotify) Enabled(key string) bool {
	if n == nil {
		return true
	}
	var p *bool
	switch key {
	case NotifyKeyAssigned:
		p = n.OnAssigned
	case NotifyKeyReturned:
		p = n.OnReturned
	case NotifyKeyWithdrawn:
		p = n.OnWithdrawn
	case NotifyKeyTerminated:
		p = n.OnTerminated
	case NotifyKeyEnded:
		p = n.OnEnded
	default:
		return true
	}
	return p == nil || *p
}

// ChannelsOrDefault 渠道多选取值；n 为 nil 或渠道清单为空时默认只有 system（与 N4 抄送节点
// 「系统通知默认选中」同一口径）。
func (n *NodeNotify) ChannelsOrDefault() []NotifyChannel {
	if n == nil || len(n.Channels) == 0 {
		return []NotifyChannel{NotifyChannelSystem}
	}
	return n.Channels
}

// ButtonAction 是审批按钮点击动作的五档取值（含「不通过并结束流程」end_flow）。
type ButtonAction string

const (
	ButtonActionSubmitApprove   ButtonAction = "submit_approve" // 提交通过
	ButtonActionWithdrawPrev    ButtonAction = "withdraw_previous_step"
	ButtonActionWithdrawInit    ButtonAction = "withdraw_initiator"
	ButtonActionWithdrawSpecify ButtonAction = "withdraw_specified_step"
	// ButtonActionEndFlow 不通过并结束流程：不选路、不选人，直接走到按钮
	// EndNodeID 指定的结束节点；不是回退，不计入回退方式（见 BackMethodOfButton）。
	ButtonActionEndFlow ButtonAction = "end_flow"
)

// ApprovalButton 是审批节点『审批按钮』清单的一条。
type ApprovalButton struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	Color         string       `json:"color"`
	Action        ButtonAction `json:"action"`
	ResultTag     string       `json:"result_tag"`
	RequireReason bool         `json:"require_reason"`
	// EndNodeID 「不通过并结束流程」的目标结束节点 id。
	// 仅动作为 end_flow 时有意义，其余动作忽略。
	EndNodeID string `json:"end_node_id,omitempty"`
}

// SubflowFieldMapping 是子流程节点『传递字段』清单的一条：
// 来源字段（当前流程目标模板的主表或扩展表字段）→ 目标字段（目标流程目标模板主表字段）。
type SubflowFieldMapping struct {
	SourceTableID string `json:"source_table_id"`
	SourceFieldID string `json:"source_field_id"`
	TargetFieldID string `json:"target_field_id"`
}

// SubflowDisposition 是『父流程结束后子流程的处置』两档取值（仅「不等待」时可配）。
type SubflowDisposition string

const (
	SubflowDispositionIgnore   SubflowDisposition = "ignore"    // 不管
	SubflowDispositionForceEnd SubflowDisposition = "force_end" // 强制结束
)

// --- N1 发起：设计层配置 · 填报层触发 ---

// StartConfig 是发起节点的专属配置。
type StartConfig struct {
	// TargetTemplateID 目标模板（本应用内），经宿主通用模板选择弹窗设置。必填。
	TargetTemplateID string `json:"target_template_id"`
	// StartPermission 发起权限，三维（用户/角色/部门）取并集，与模板权限同一套选择方式；
	// 留空即除超级管理员外无人可发起。形状与旧形状兼容见 ids.go StartGrant。
	StartPermission StartGrant `json:"start_permission,omitempty"`
	// AllowManualStart 允许人工发起，默认开（关闭时只能由动作/子流程等发起）。
	AllowManualStart bool `json:"allow_manual_start"`
	// FieldPermissions 同『字段权限（可编辑型）』。
	FieldPermissions []FieldPermission `json:"field_permissions,omitempty"`
	// NoRouteHint 无路可走时的提示。
	NoRouteHint string `json:"no_route_hint"`
	// SummaryExpr 步骤摘要，宿主 V4 计算表达式发布物引用，可空。
	SummaryExpr json.RawMessage `json:"summary_expr,omitempty"`
	// StartCondition 发起条件：一条宿主 V4 判断表达式，结果为真才允许发起；不填即不限。
	// 发起前求值一次，人工发起与动作发起一视同仁；**子流程发起不受它限制**。它只是一道闸门，
	// **不参与**「用哪条流程」的选择——模板绑定的已发布流程仍由发起人显式选一个，不按发起条件
	// 自动选流程。表达式走既有的发布期冻结 → 运行期求值路径，与自动办理条件同一做法，
	// 引擎只拿求值结果，不自己解析表达式。
	StartCondition json.RawMessage `json:"start_condition,omitempty"`
	// StartConditionHint 不满足发起条件时的提示：配了 StartCondition 就必须填（发布期校验见
	// node/start.go Validate 的 N1_START_CONDITION_HINT_REQUIRED），求值为假时原样显示给发起人，
	// 绝不透出表达式原文。
	StartConditionHint string `json:"start_condition_hint,omitempty"`
	// Notify 节点级通知配置：只认 OnReturned（被退回到发起人）、
	// OnWithdrawn（提交被撤销）、OnTerminated（实例被管理员终止）三个键，OnAssigned/OnEnded
	// 对发起节点没有意义（发起本身不是"收到任务"）。
	Notify *NodeNotify `json:"notify,omitempty"`
}

// --- N2 办理：设计层配置 · 填报层执行 ---

// HandleConfig 是办理节点的专属配置。
type HandleConfig struct {
	// Assignees 办理人，同『人员来源』；见 A1（至少配一种来源）。
	Assignees []AssigneeSource `json:"assignees,omitempty"`
	// RelationFilters 『过滤器：与上步处理人的关系』：五档
	// 可多选，默认不限（空）。它不是来源，不参与 A2 的并集，而是在 Assignees 各来源算出候选
	// 之后再筛一道——以上步处理人里每一个人为基准、对所选的每一种关系分别计算出「允许的人」
	// 的并集，候选里只保留在这份并集里的人（多个上步处理人任一满足即保留，多种关系任一种
	// 满足即保留）。筛完一个人都不剩，等同无人可办，按现有『无候选处置』无候选处置走，不新写
	// 分支。A1：Assignees 与 RelationFilters 不能只配后者不配前者——只配过滤器没配来源的，
	// 发布时被 node/assignee_rules.go 拒绝（A1_FILTER_WITHOUT_SOURCE）。
	RelationFilters []AssigneeRelation `json:"relation_filters,omitempty"`
	// CompleteMode 办理方式。必填。
	CompleteMode CompleteMode `json:"complete_mode"`
	// FieldPermissions 同『字段权限（可编辑型）』。
	FieldPermissions []FieldPermission `json:"field_permissions,omitempty"`
	// AllowedWithdrawMethods 可用的回退方式（提交、暂存固定可用，不在此列）。
	AllowedWithdrawMethods []WithdrawMethod `json:"allowed_withdraw_methods,omitempty"`
	// ClearOnWithdraw 回退时清空的字段清单。
	ClearOnWithdraw []ClearOnWithdrawField `json:"clear_on_withdraw,omitempty"`
	// NoRouteHint 无路可走时的提示。必填。
	NoRouteHint string `json:"no_route_hint"`
	// AutoCompleteCondition 自动办理条件，宿主 V4 判断表达式发布物引用，可空。
	AutoCompleteCondition json.RawMessage `json:"auto_complete_condition,omitempty"`
	// SummaryExpr 步骤摘要，可空。
	SummaryExpr json.RawMessage `json:"summary_expr,omitempty"`
	// Notify 节点级通知配置：只认 OnAssigned（收到任务）、OnReturned
	// （被退回到这一步）两个键。
	Notify *NodeNotify `json:"notify,omitempty"`
}

// --- N3 审批：设计层配置 · 填报层执行 ---

// ApproveConfig 是审批节点的专属配置。
type ApproveConfig struct {
	// Approvers 审批人，同『人员来源』；见 A1。
	Approvers []AssigneeSource `json:"approvers,omitempty"`
	// RelationFilters 『过滤器：与上步处理人的关系』，语义与 A1/A3/A10 同 HandleConfig.RelationFilters
	// 一字不差（审批只是叫法不同，通用件本就是同一件事）。
	RelationFilters []AssigneeRelation `json:"relation_filters,omitempty"`
	// CompleteMode 办理方式。必填。
	CompleteMode CompleteMode `json:"complete_mode"`
	// FieldPermissions 同『字段权限（只看型）』。
	FieldPermissions []FieldPermission `json:"field_permissions,omitempty"`
	// Buttons 审批按钮，至少一个（默认两个：同意=提交通过、拒绝=回退到指定步骤，由设计器初始化）。
	Buttons []ApprovalButton `json:"buttons"`
	// ResultFieldID 结果绑定字段（本表主表），可空；发布期只允许文本字段。
	ResultFieldID string `json:"result_field_id,omitempty"`
	// ReasonFieldID 理由绑定字段（本表主表），可空；发布期只允许文本字段。
	ReasonFieldID string `json:"reason_field_id,omitempty"`
	// ClearOnWithdraw 回退时清空的字段清单。
	ClearOnWithdraw []ClearOnWithdrawField `json:"clear_on_withdraw,omitempty"`
	// NoRouteHint 无路可走时的提示。必填。
	NoRouteHint string `json:"no_route_hint"`
	// AutoCompleteCondition 自动办理条件，可空。
	AutoCompleteCondition json.RawMessage `json:"auto_complete_condition,omitempty"`
	// SummaryExpr 步骤摘要，可空。
	SummaryExpr json.RawMessage `json:"summary_expr,omitempty"`
	// Notify 节点级通知配置：只认 OnAssigned（收到任务）、OnReturned
	// （被退回到这一步）两个键，与办理节点同一套语义。
	Notify *NodeNotify `json:"notify,omitempty"`
}

// --- N4 抄送：设计层配置 · 填报层通知 ---

// CCConfig 是抄送节点的专属配置。
type CCConfig struct {
	// Recipients 收件人，同『人员来源』；见 A1。
	Recipients []AssigneeSource `json:"recipients,omitempty"`
	// RelationFilters 『过滤器：与上步处理人的关系』，语义与 A1/A3/A10 同 HandleConfig.RelationFilters
	// 一字不差；A10 抄送分支：筛完收件人为空按 N4.3 不发通知、流程照常向后走，不是无候选处置。
	RelationFilters []AssigneeRelation `json:"relation_filters,omitempty"`
	// Channels 通知渠道，多选，至少一种；系统通知默认选中。
	Channels []NotifyChannel `json:"channels"`
	// TitleExpr 通知标题（宿主 V4 取值表达式发布物引用）。必填。
	TitleExpr json.RawMessage `json:"title_expr"`
	// ContentExpr 通知正文（宿主 V4 取值表达式发布物引用）。必填。
	ContentExpr json.RawMessage `json:"content_expr"`
	// FieldPermissions 同『字段权限（只看型）』，在收件人查看单据时生效。
	FieldPermissions []FieldPermission `json:"field_permissions,omitempty"`
}

// --- N5 结束：设计层配置 · 填报层收尾 ---

// EndConfig 是结束节点的专属配置。
type EndConfig struct {
	// EndFlag 结束标识，一段文本（如「已通过」）。必填。
	EndFlag string `json:"end_flag"`
	// WriteFieldID 标识写入字段（本表主表），可空；发布期只允许文本字段。
	WriteFieldID string `json:"write_field_id,omitempty"`
	// Notify 节点级通知配置：只认 OnEnded（流程结束）一个键。
	Notify *NodeNotify `json:"notify,omitempty"`
}

// --- N6 子流程：设计层配置 · 填报层发起 ---

// SubflowConfig 是子流程节点的专属配置。
type SubflowConfig struct {
	// TargetWorkflowID 目标流程（一条已发布的流程）。必填。
	TargetWorkflowID string `json:"target_workflow_id"`
	// FieldMappings 传递字段清单（同一张扩展表，或全部来自主表）。
	FieldMappings []SubflowFieldMapping `json:"field_mappings,omitempty"`
	// Wait 是否等待：true=等待子流程全部结束再向后走；false=发起后立即向后走。必填。
	Wait bool `json:"wait"`
	// Disposition 父流程结束后子流程的处置，仅 Wait=false 时必填。
	Disposition SubflowDisposition `json:"disposition,omitempty"`
}
