// Package core 是流程引擎的状态机：无 I/O、无 gRPC，
// 只吃已加载的实例聚合与编译后的定义，产出「一包变更集 + 动作结果」。
//
// 单令牌不变量：非结束实例恰一条 ACTIVE 步骤且 instance.current_step_id 指向它；结束后为零。
// 每次 Decide 结束前自检（invariant.go），违反即 SYSTEM_ERROR 不提交。
//
// 单测按规则编号（与诊断码前缀同一套）命名。
package core

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin/workflowengine"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// Engine 状态机；依赖五个端口里不做 I/O 提交的四个（账本提交在 app 层）。
type Engine struct {
	Expr      ports.Expression
	Candidate ports.Candidate
	Record    ports.Record // Header 与 ReadFields；WriteFields 由 app 层在 Commit 前调用
	Launch    ports.Launch // 非人工发起通道的建单那一半（子流程）
	Clock     ports.Clock
	IDs       ports.IDGen
}

// OutcomeKind 六态（与 engine.v1 ActionOutcome 对齐）。
type OutcomeKind string

const (
	OutcomeCommitted              OutcomeKind = "COMMITTED"
	OutcomeRouteChoiceRequired    OutcomeKind = "ROUTE_CHOICE_REQUIRED"
	OutcomeAssigneeChoiceRequired OutcomeKind = "ASSIGNEE_CHOICE_REQUIRED"
	OutcomeNoRoute                OutcomeKind = "NO_ROUTE"
	OutcomeNoCandidate            OutcomeKind = "NO_CANDIDATE"
	OutcomeParked                 OutcomeKind = "PARKED"
)

// RouteOption 供选路对话框。
type RouteOption struct {
	LinkID     string
	ToNodeID   string
	ToNodeName string
}

// Outcome 动作结果。
type Outcome struct {
	Kind OutcomeKind
	// Committed
	WorkflowInstanceID string
	StepID             string
	Status             string
	EndLabel           string
	// RouteChoiceRequired
	FromNodeID string
	Routes     []RouteOption
	// AssigneeChoiceRequired
	NodeID     string
	NodeName   string
	ViaLinkID  string
	Candidates []ports.Person
	// NoRoute / NoCandidate
	Hint  string
	Saved bool
	// Parked
	IncidentID string
}

// Choices 弹框后的回填。
type Choices struct {
	RouteLinkID       string
	SelectedAssignees []int64
}

// EndWrite 到达结束节点时要先写的结束标识（app 层在 Commit 前经 Record.WriteFields 执行）。
type EndWrite struct {
	FieldID string
	Label   string
	NodeID  string
	StepID  string
}

// Decision 一次动作的产物。Changeset 为 nil 表示「不落库」（选路 / 选人 / 发起零命中）。
type Decision struct {
	Changeset *pb.Changeset
	Outcome   Outcome
	// PendingEndWrite 非 nil 时 app 层先写字段：成功照 Changeset 提交；失败改用 ParkForEndWrite 的变更集。
	PendingEndWrite *EndWrite
	// PendingApproveWrite 非 nil 时 app 层在提交变更集**之前**把审批结果与理由写进单据并保存。
	// 写失败即整个动作失败、变更集不提交——不留「字段写了一半、流程没走」的中间态；与结束标识那条
	// 「先提交停驻、再写、再提交」的两段式不同，审批写的是本步自己的单据字段，没有跨步骤的停驻态。
	PendingApproveWrite *ApproveWrite
	// PendingClearWrite 非 nil 时 app 层在提交变更集之前把「回退时清空」的字段清空并保存单据。
	PendingClearWrite *ClearWrite
	// PendingSubflowStarts 本次动作要发起的子实例。app 层在**提交本实例之后**逐个发起
	// （建单 → Start → Commit），再回写父子链接——一个变更集只写一个实例，子实例得走自己那一遍。
	PendingSubflowStarts []SubflowStart
	// PendingSubflowCancels 本次回退把哪些已经发起过的子实例从时间线上抹掉了。链接行
	// 本身已经在 Changeset.LinkDeleteIds 里删除；子实例交给 app 层逐个 ForceEnd（删单据是缺口，
	// 宿主目前没有对应 RPC，暂不处理）。
	PendingSubflowCancels []SubflowCancel
	// PendingLeaseRelease 改派：原办理人若持有单据编辑租约，app 层在本次变更集
	// 提交成功之后调宿主 LeaseService.ReleaseEditLease 释放它，原办理人页面收到阻断提示。
	// 释放失败只 warn，不回滚改派——改派本身已经生效。
	PendingLeaseRelease *LeaseRelease
	// EndedByButton 非 nil 表示本次决策是审批人点了「不通过并结束流程」按钮。
	// 仅供 app 层在变更集提交成功后按级别上报宿主日志用，不参与落库。
	EndedByButton *EndedByButtonInfo
	// ExpectedVersion 实例 CAS 期望值（0 = 新建）。
	ExpectedVersion int64
	// outbox 载荷生成用
	instance *pb.InstanceRow
	tasks    []*pb.TaskRow
}

// Errors 状态机拒绝动作的错误（携带错误码枚举名，transport 映射 gRPC status）。
type Error struct {
	Code    string // WorkflowErrorCode 枚举名
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// SystemErrorf 构造 SYSTEM_ERROR（供 app 层复用同一错误类型）。
func SystemErrorf(format string, args ...any) error { return errf("SYSTEM_ERROR", format, args...) }

// CodeOf 取错误码；非 *Error 返回空串。
func CodeOf(err error) string {
	if e, ok := err.(*Error); ok {
		return e.Code
	}
	return ""
}

// —— 聚合辅助 ——

// loaded 把聚合与编译定义捆在一起，供各迁移函数共用。
type loaded struct {
	agg      *pb.InstanceAggregate
	compiled *compile.CompiledDefinition
	rec      ports.RecordRef
}

func loadCompiled(appID string, agg *pb.InstanceAggregate) (*loaded, error) {
	if agg == nil || agg.GetInstance() == nil || agg.GetVersion() == nil {
		return nil, errf("SYSTEM_ERROR", "aggregate is incomplete")
	}
	c, err := compile.Decode([]byte(agg.GetVersion().GetCompiledJson()))
	if err != nil {
		return nil, errf("SYSTEM_ERROR", "compiled_json of version %d is invalid: %v", agg.GetVersion().GetVersionNo(), err)
	}
	inst := agg.GetInstance()
	// 单据定位带上实例 ID，经 Record 读写时宿主据此核对归属。
	return &loaded{agg: agg, compiled: c, rec: ports.RecordRef{AppID: appID, TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId(), WorkflowInstanceID: inst.GetWorkflowInstanceId()}}, nil
}

func (l *loaded) step(stepID string) *pb.StepRow {
	for _, s := range l.agg.GetSteps() {
		if s.GetStepId() == stepID {
			return s
		}
	}
	return nil
}

func (l *loaded) task(taskID string) *pb.TaskRow {
	for _, t := range l.agg.GetTasks() {
		if t.GetTaskId() == taskID {
			return t
		}
	}
	return nil
}

func (l *loaded) tasksOfStep(stepID string) []*pb.TaskRow {
	var out []*pb.TaskRow
	for _, t := range l.agg.GetTasks() {
		if t.GetStepId() == stepID {
			out = append(out, t)
		}
	}
	return out
}

// startSummary 发起步骤（seq 1）的摘要（H2：流程结束通知里代表这张单据的一句话）。
func (l *loaded) startSummary() string {
	for _, s := range l.agg.GetSteps() {
		if s.GetSeqNo() == 1 {
			return s.GetSummaryText()
		}
	}
	return ""
}

func (l *loaded) activeStep() *pb.StepRow {
	return l.step(l.agg.GetInstance().GetCurrentStepId())
}

func (l *loaded) maxSeq() int32 {
	var m int32
	for _, s := range l.agg.GetSteps() {
		if s.GetSeqNo() > m {
			m = s.GetSeqNo()
		}
	}
	return m
}

// previousHumanStep 最近一个人工步骤（A5：跳过自动步骤）；从 seq 小于 before 往前找。
func (l *loaded) previousHumanStep(before int32) *pb.StepRow {
	var best *pb.StepRow
	for _, s := range l.agg.GetSteps() {
		if s.GetSeqNo() >= before || s.GetAutoHandled() || s.GetStatus() == string(model.StepStatusWithdrawn) {
			continue
		}
		if best == nil || s.GetSeqNo() > best.GetSeqNo() {
			best = s
		}
	}
	return best
}

// 行复制一律 proto.Clone（生成的消息内含互斥锁，不能按值复制）。
func cloneInstance(r *pb.InstanceRow) *pb.InstanceRow { return proto.Clone(r).(*pb.InstanceRow) }
func cloneStep(r *pb.StepRow) *pb.StepRow             { return proto.Clone(r).(*pb.StepRow) }
func cloneTask(r *pb.TaskRow) *pb.TaskRow             { return proto.Clone(r).(*pb.TaskRow) }
func cloneIncident(r *pb.IncidentRow) *pb.IncidentRow { return proto.Clone(r).(*pb.IncidentRow) }
func cloneLink(r *pb.LinkRow) *pb.LinkRow             { return proto.Clone(r).(*pb.LinkRow) }

// cs 变更集构造器（按行 id 去重 upsert）。
type csBuilder struct {
	cs    *pb.Changeset
	steps map[string]*pb.StepRow
	tasks map[string]*pb.TaskRow
	incs  map[string]*pb.IncidentRow
	links map[string]*pb.LinkRow
}

func newCS() *csBuilder {
	return &csBuilder{cs: &pb.Changeset{}, steps: map[string]*pb.StepRow{}, tasks: map[string]*pb.TaskRow{}, incs: map[string]*pb.IncidentRow{}, links: map[string]*pb.LinkRow{}}
}

func (b *csBuilder) instance(row *pb.InstanceRow, expected int64) {
	b.cs.Instance = &pb.InstanceWrite{Row: row, ExpectedVersion: expected}
}

func (b *csBuilder) step(row *pb.StepRow) {
	if _, ok := b.steps[row.GetStepId()]; !ok {
		b.cs.StepUpserts = append(b.cs.StepUpserts, row)
	}
	b.steps[row.GetStepId()] = row
}

func (b *csBuilder) task(row *pb.TaskRow) {
	if _, ok := b.tasks[row.GetTaskId()]; !ok {
		b.cs.TaskUpserts = append(b.cs.TaskUpserts, row)
	}
	b.tasks[row.GetTaskId()] = row
}

// cc 追加一条抄送行。抄送行只新增不改（已读回执由宿主在打开单据时自己更新）。
func (b *csBuilder) cc(row *pb.CcRow) {
	b.cs.CcUpserts = append(b.cs.CcUpserts, row)
}

// link 追加 / 更新一条父子链接行。
func (b *csBuilder) link(row *pb.LinkRow) {
	if _, ok := b.links[row.GetLinkId()]; !ok {
		b.cs.LinkUpserts = append(b.cs.LinkUpserts, row)
	}
	b.links[row.GetLinkId()] = row
}

// linkDelete 登记一条要删除的父子链接行（E7：回退目标在子流程节点之前时，把该节点已发起的
// 链接连同子实例一并处置；本方法只管账本这一半，子实例的强制结束由调用方另行提交）。
func (b *csBuilder) linkDelete(linkID string) {
	b.cs.LinkDeleteIds = append(b.cs.LinkDeleteIds, linkID)
}

// subflowStarted 追加一条 SUBFLOW_STARTED 发件箱行（app 层每发起完一批子实例后调用）：
// 载荷带父子实例、目标定义与等待档，供宿主投影与审计使用。
//
// SUBFLOW_STARTED 不是 NOTIFY / CC_SENT 那种独立轨道（宿主只把这两种 kind 摘出去单走一遍），
// 它落的是宿主投影的**通用轨道**（按状态行解码并更新单据流程状态），
// 因此载荷必须携带与其余状态类发件箱行同一份通用信封（六项快照：record_id / template_id /
// definition_id / flow_status / current_node_id / current_node_name / current_assignee_user_ids /
// last_action_at / changed_tasks，见 stateOutboxRow），仅在 items 之外——否则宿主解码时按
// 「缺 record_id / workflow_instance_id」失败、整行落 FAILED，还会挡住该实例之后的状态行投影。
// agg 是 CommitLinks 装载的最新父实例聚合，供推算当前站办理人用
// （子流程发起本身不产生任务，changed_tasks 恒空）。
func (b *csBuilder) subflowStarted(agg *pb.InstanceAggregate, inst *pb.InstanceRow, rows []*pb.LinkRow) {
	if len(rows) == 0 {
		return
	}
	// 载荷用 SDK 类型化构造（workflowengine.StatePayload + Items），通用信封与其余状态行
	// 同一份 StateFromInstance，字段列表不在两处各写一份。
	assignees := currentStepAssignees(agg, b.tasks, inst.GetCurrentStepId())
	p := workflowengine.StateFromInstance(inst, nil, assignees)
	for _, r := range rows {
		p.Items = append(p.Items, workflowengine.SubflowStartedItem{
			LinkID: r.GetLinkId(), ParentStepID: r.GetParentStepId(), ChildWorkflowInstanceID: r.GetChildWorkflowInstanceId(),
			ChildDefinitionID: r.GetChildDefinitionId(), WaitMode: r.GetWaitMode(),
		})
	}
	b.cs.OutboxAppends = append(b.cs.OutboxAppends, stateOutboxRow(model.OutboxSubflowStarted, p))
}

// ccSent 追加一条 CC_SENT 发件箱行：宿主投影按渠道各投一次。
// 载荷用 SDK 类型化构造（workflowengine.CcSentPayload，收件人按十进制字符串编码）。
func (b *csBuilder) ccSent(inst *pb.InstanceRow, step *pb.StepRow, rows []*pb.CcRow) {
	if len(rows) == 0 {
		return
	}
	p := workflowengine.CcSentPayload{
		WorkflowInstanceID: inst.GetWorkflowInstanceId(), DefinitionID: inst.GetDefinitionId(),
		StepID: step.GetStepId(), NodeName: step.GetNodeName(),
		Record: workflowengine.OutboxRecordRef{TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId()},
	}
	for _, r := range rows {
		p.Items = append(p.Items, workflowengine.CcSentItem{CcID: r.GetCcId(), RecipientUserID: r.GetRecipientUserId(), Channel: r.GetChannel(), Title: r.GetTitle(), Body: r.GetBody()})
	}
	row, err := workflowengine.NewCcSentOutbox(p)
	if err != nil {
		row = rawOutboxRow(model.OutboxCcSent, p.WorkflowInstanceID, p)
	}
	if row != nil {
		b.cs.OutboxAppends = append(b.cs.OutboxAppends, row)
	}
}

func (b *csBuilder) incident(row *pb.IncidentRow) {
	if _, ok := b.incs[row.GetIncidentId()]; !ok {
		b.cs.IncidentUpserts = append(b.cs.IncidentUpserts, row)
	}
	b.incs[row.GetIncidentId()] = row
}

// outbox 追加一条发件箱行；agg 是本次决策装载时的原始聚合（供 A3 current_assignee_user_ids 用，
// 合并原有任务与本次 upsert 后取「当前步骤」快照，nil 表示没有可参考的旧聚合——例如停驻 / 恢复期
// 系统性追加，届时当前步骤本就没有人工任务，assignees 天然为空）。
func (b *csBuilder) outbox(kind model.OutboxKind, agg *pb.InstanceAggregate, inst *pb.InstanceRow, changed []*pb.TaskRow) {
	assignees := currentStepAssignees(agg, b.tasks, inst.GetCurrentStepId())
	b.cs.OutboxAppends = append(b.cs.OutboxAppends, stateOutboxRow(kind, workflowengine.StateFromInstance(inst, changed, assignees)))
}

// currentStepAssignees inst.current_step_id 下全部 PENDING / SAVED 任务的办理人——
// 聚合账本里原有该站任务（agg，决策装载时的旧值）与本次决策对该站任务的 upsert（upserts，覆盖同 id 的旧值），
// 而不是只看本次改动的任务；这样一步多人时，只要有人还在待办 / 暂存，快照就不会漏掉他们（例如会签一人暂存、
// 或未过关的提交，都不该让快照只剩本次动作的那一个人）。实例已结束 / 当前步骤为空时返回空。
func currentStepAssignees(agg *pb.InstanceAggregate, upserts map[string]*pb.TaskRow, stepID string) []int64 {
	if stepID == "" {
		return nil
	}
	merged := map[string]*pb.TaskRow{}
	if agg != nil {
		for _, t := range agg.GetTasks() {
			if t.GetStepId() == stepID {
				merged[t.GetTaskId()] = t
			}
		}
	}
	for id, t := range upserts {
		if t.GetStepId() == stepID {
			merged[id] = t
		} else {
			delete(merged, id) // 理论上不会发生（任务不会中途换站），保险起见剔除
		}
	}
	var out []int64
	for _, t := range merged {
		if t.GetStatus() == string(model.TaskStatusPending) || t.GetStatus() == string(model.TaskStatusSaved) {
			out = append(out, t.GetAssigneeUserId())
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] }) // 稳定顺序，便于宿主与测试比对
	return out
}

// notify 追加一条 NOTIFY 发件箱行（带渠道）：收件人为空则不追加。开关由
// 调用方按节点级 NodeCompiled.Notify() 判定后再调本函数，channels 一律传该节点的
// NodeNotify.ChannelsOrDefault()（恒非空，至少 ["system"]）。
func (b *csBuilder) notify(event model.NotifyEvent, inst *pb.InstanceRow, recipients []int64, taskID, summary, nodeName string, channels []model.NotifyChannel) {
	if row := buildNotifyOutbox(event, inst, recipients, taskID, summary, nodeName, channels); row != nil {
		b.cs.OutboxAppends = append(b.cs.OutboxAppends, row)
	}
}

// buildNotifyOutbox 组装一条 NOTIFY 发件箱行（从 csBuilder.notify 里拆出来，供
// Terminate 在 ForceEnd 已经返回的变更集上追加「被终止」通知时复用——那时手上只有
// *pb.Changeset，没有正在构建它的 csBuilder）。收件人为空返回 nil（调用方不追加）。载荷字段与
// 宿主投影 worker 的 notify 分支约定一致：event / recipient_user_ids / task_id /
// workflow_instance_id / record / summary_text / node_name / definition_id / channels。
// channels 为空按 ["system"] 兜底，恒写出，供宿主投影按渠道分别处理。
func buildNotifyOutbox(event model.NotifyEvent, inst *pb.InstanceRow, recipients []int64, taskID, summary, nodeName string, channels []model.NotifyChannel) *pb.OutboxRow {
	recipients = uniqInt64(recipients)
	if len(recipients) == 0 {
		return nil
	}
	if len(channels) == 0 {
		channels = []model.NotifyChannel{model.NotifyChannelSystem}
	}
	// 载荷用 SDK 类型化构造（workflowengine.NotifyPayload），键名与宿主投影约定一致。
	p := workflowengine.NotifyPayload{
		Event: string(event), RecipientUserIDs: recipients, TaskID: taskID,
		WorkflowInstanceID: inst.GetWorkflowInstanceId(), DefinitionID: inst.GetDefinitionId(),
		Record:      workflowengine.OutboxRecordRef{TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId()},
		SummaryText: summary, NodeName: nodeName, EndLabel: inst.GetEndLabel(),
	}
	for _, c := range channels {
		p.Channels = append(p.Channels, string(c))
	}
	row, err := workflowengine.NewNotifyOutbox(p)
	if err != nil {
		return rawOutboxRow(model.OutboxNotify, p.WorkflowInstanceID, p)
	}
	return row
}

// notifyEventOf 从 NOTIFY 载荷取 event（停驻改写变更集时剔除「流程结束」通知用）。
func notifyEventOf(row *pb.OutboxRow) model.NotifyEvent {
	if row.GetKind() != string(model.OutboxNotify) {
		return ""
	}
	var p struct {
		Event string `json:"event"`
	}
	_ = json.Unmarshal([]byte(row.GetPayloadJson()), &p)
	return model.NotifyEvent(p.Event)
}

// uniqInt64 去重保序，剔除 0。
func uniqInt64(ids []int64) []int64 {
	seen := map[int64]bool{}
	var out []int64
	for _, id := range ids {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// stateOutboxRow 构造一条状态类发件箱行（六项快照 + 本次改动的任务，索引增量）。载荷
// 由 SDK 类型化构造（workflowengine.StateFromInstance / NewStateOutbox）：键名、PARKED 对外报 RUNNING 并置
// parked、时间 RFC3339 UTC 等口径都在 SDK 一处定义，与宿主 Commit 校验同源。currentAssignees 由调用方算好传入
// （csBuilder.outbox 走 currentStepAssignees 合并算法；ParkForEndWrite / ParkAgain 等直接构造行的路径——
// 当前步骤是系统节点、没有人工任务——传空）。
func stateOutboxRow(kind model.OutboxKind, p workflowengine.StatePayload) *pb.OutboxRow {
	row, err := workflowengine.NewStateOutbox(workflowengine.OutboxKind(kind), p)
	if err != nil {
		return rawOutboxRow(kind, p.WorkflowInstanceID, p)
	}
	return row
}

// rawOutboxRow 是 SDK 构造函数自检不过时的兜底：仍按类型化载荷原样写出，不静默丢行——宿主 Commit 会以
// OUTBOX_PAYLOAD_INVALID 整笔拒绝并经 app 层上报日志，问题在提交时立即暴露（正常路径不会走到这里：引擎产出的
// 实例行恒带 record_id / workflow_instance_id）。
func rawOutboxRow(kind model.OutboxKind, workflowInstanceID string, payload any) *pb.OutboxRow {
	raw, _ := json.Marshal(payload)
	return &pb.OutboxRow{WorkflowInstanceId: workflowInstanceID, Kind: string(kind), PayloadJson: string(raw)}
}

// —— 通用小工具 ——

func trim(s string) string { return strings.TrimSpace(s) }

// now 取时钟（UTC）。
func (e *Engine) now() *timestamppb.Timestamp { return timestamppb.New(e.Clock.Now().UTC()) }
