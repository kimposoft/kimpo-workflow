package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// subflow.go 是『子流程』的运行期：用当前流程表单里的数据，发起另一条流程。
//
// 为什么发起分成两段（本文件算参数、app 层真发起）：**一个变更集只写一个实例**。子实例是另一个
// 实例，它自己的发起要走自己那一遍 Engine.Start 与自己那一次 Commit。状态机是纯计算、不做 I/O，
// 所以这里只把「要发起几个、每个带哪些值」算清楚交出去（Decision.PendingSubflowStarts），
// 由 app 层在父实例提交之后逐个发起，再回写父子链接。发起反复失败按 M5 开事故。
//
// 传递字段的两档来源是同一段代码的两条路，不是两套逻辑：
//   - 传递字段全是主表字段 → 发起一个，参数就是那些主表值；
//   - 有扩展表字段 → 读那张扩展表（发布期保证只会有一张），有几行发起几个，每个拿自己那一行的
//     扩展表值，主表值每个都一样；零行发起零个（节点按「发起了零个」处理）。

// SubflowStart 一个子流程节点这一次要发起的全部子实例（app 层执行）。
type SubflowStart struct {
	NodeID string
	StepID string
	// TargetDefinitionID 目标流程（只支持同一应用内）。用它当时的最新已发布版本。
	TargetDefinitionID string
	// Wait 等待档：父流程停在这一步，直到本次发起的全部子实例都结束。
	Wait bool
	// Disposition 父流程先结束时对未结束子实例的处置（仅「不等待」时有意义）。
	Disposition string
	// Params 每个子实例一组字段写入（一行扩展表一组）。长度即要发起的子实例个数。
	Params [][]ports.FieldWrite
	// Submitter 把父流程送到这个子流程节点的那位办理人（触发过关的人）：
	// 子实例的发起人、新建目标单据的创建人一律是他，**与此刻是谁在调用引擎无关**——管理员处理
	// 「发起子流程失败」事故重新发起时，调用者是管理员，发起人仍须是当初这位办理人。
	// UserID 为 0（无人在场的系统推进、或取不回来）时 app 层退回本次动作的操作人。
	Submitter ports.Actor
}

// arriveSubflow 到达子流程节点。
//
// 三种收场：
//   - 本节点这一轮不该再发起（同实例同节点只发起一次，且上一次的子实例还在）：直接当作
//     已经发过，按等待 / 不等待各自的口径处置；
//   - 等待档且要发起的个数 > 0：步骤停在 ACTIVE（它持有单令牌），等子实例回来推；
//   - 其余（不等待，或等待但零个）：步骤到达即关闭，继续沿辅助链往下走。
func (e *Engine) arriveSubflow(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor, seq int32) (*arrival, error) {
	now := e.now()
	step := &pb.StepRow{
		StepId: e.IDs.New("step"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), SeqNo: seq,
		NodeId: target.NodeID, NodeKind: target.NodeKind, NodeName: target.NodeName,
		EnteredByUserId: submitter.UserID, EnteredAt: now,
	}
	if from != nil {
		step.EnteredFromStepId = from.GetStepId()
	}
	// 子实例的发起人 / 目标单据的填报人：触发过关的办理人。这一跳若无人在场（等待档
	// 子流程结束后系统回推父流程，submitter 是系统），回溯最近一位把流程往前送的真人。
	starter := submitter
	if starter.UserID == 0 {
		starter = e.lastHumanSubmitter(ctx, l, b, from)
	}
	summary, err := e.summaryFor(ctx, l, target, submitter)
	if err != nil {
		return nil, err
	}
	step.SummaryText = summary

	mappings := subflowMappingsOf(target)
	params, err := e.subflowParams(ctx, l, target, mappings)
	if err != nil {
		return nil, err
	}
	// 同一实例同一子流程节点只发起一次：已经发过就不再发（回退删掉子实例后，
	// 那些链接行也一并删掉，于是这里又会重新发）。
	if subflowAlreadyLaunched(l, target.NodeID) {
		params = nil
	}

	waiting := target.SubflowWait && len(params) > 0
	if waiting {
		// 等待档：本步停住，子实例结束时回来推。它是当前站，持有单令牌。
		step.Status = string(model.StepStatusActive)
		inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, target.NodeID, target.NodeName
		inst.LastActionAt = now
		b.step(step)
		a := &arrival{step: step}
		if len(params) > 0 {
			a.subflowStarts = []SubflowStart{{NodeID: target.NodeID, StepID: step.StepId, TargetDefinitionID: target.SubflowTargetDefinitionID,
				Wait: true, Disposition: target.SubflowDisposition, Params: params, Submitter: starter}}
		}
		return a, nil
	}

	// 不等待（或等待但零个子实例，「零个子流程时立即向后走」）：到达即完成。
	step.Status, step.ClosedAt, step.Outcome = string(model.StepStatusPassed), now, string(model.StepOutcomeLaunched)
	b.step(step)
	var start *SubflowStart
	if len(params) > 0 {
		start = &SubflowStart{NodeID: target.NodeID, StepID: step.StepId, TargetDefinitionID: target.SubflowTargetDefinitionID,
			Wait: false, Disposition: target.SubflowDisposition, Params: params, Submitter: starter}
	}
	if target.IsTerminalAuxiliary {
		a := &arrival{step: step, auxiliaryOnly: true}
		if start != nil {
			a.subflowStarts = []SubflowStart{*start}
		}
		return a, nil
	}
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = step.StepId, target.NodeID, target.NodeName
	inst.LastActionAt = now
	a, err := e.continueAfterAuxiliary(ctx, l, b, inst, step, target, to, submitter)
	if err != nil {
		return nil, err
	}
	// 本节点自己这一份发起要排在下游（continueAfterAuxiliary 沿辅助链继续走可能穿过的下一个
	// 子流程节点）之前——顺序＝先到达的先发起，两者都存在时不能互相顶掉（原 bug：`if ==nil` 只
	// 认一个槽位，辅助链上前一个子流程节点的发起会被后一个悄悄丢掉）。
	if start != nil {
		a.subflowStarts = append([]SubflowStart{*start}, a.subflowStarts...)
	}
	return a, nil
}

// subflowParams 按传递字段整理出「每个子实例一组字段写入」。
func (e *Engine) subflowParams(ctx context.Context, l *loaded, target *compile.NodeCompiled, mappings []model.SubflowFieldMapping) ([][]ports.FieldWrite, error) {
	if len(mappings) == 0 {
		// 没配传递字段：发起一个，不带任何值（传递字段是可选的）。
		return [][]ports.FieldWrite{nil}, nil
	}
	var mainIDs, detailIDs []string
	detailTable := ""
	for _, m := range mappings {
		if m.SourceTableID == "" {
			mainIDs = append(mainIDs, m.SourceFieldID)
			continue
		}
		detailTable = m.SourceTableID // 发布期已保证只有一张
		detailIDs = append(detailIDs, m.SourceFieldID)
	}
	if e.Record == nil {
		return nil, errf("SYSTEM_ERROR", "record service is not wired, cannot read subflow parameters")
	}
	read, err := e.Record.ReadFields(ctx, ports.ReadFieldsInput{
		Record: l.rec, MainFieldIDs: mainIDs, DetailTableID: detailTable, DetailFieldIDs: detailIDs,
	})
	if err != nil {
		return nil, errf("SYSTEM_ERROR", "read subflow parameters of node %s: %v", target.NodeID, err)
	}
	mainByID := map[string]ports.FieldValue{}
	for _, v := range read.MainValues {
		mainByID[v.FieldID] = v
	}

	// 主表那一半每个子实例都一样。
	var mainWrites []ports.FieldWrite
	for _, m := range mappings {
		if m.SourceTableID != "" {
			continue
		}
		if w, ok := writeOf(m.TargetFieldID, mainByID[m.SourceFieldID]); ok {
			mainWrites = append(mainWrites, w)
		}
	}
	if detailTable == "" {
		return [][]ports.FieldWrite{mainWrites}, nil
	}
	// 扩展表有几行发起几个；零行发起零个。
	var out [][]ports.FieldWrite
	for _, row := range read.DetailRows {
		byID := map[string]ports.FieldValue{}
		for _, v := range row.Values {
			byID[v.FieldID] = v
		}
		writes := make([]ports.FieldWrite, 0, len(mappings))
		writes = append(writes, mainWrites...)
		for _, m := range mappings {
			if m.SourceTableID == "" {
				continue
			}
			if w, ok := writeOf(m.TargetFieldID, byID[m.SourceFieldID]); ok {
				writes = append(writes, w)
			}
		}
		out = append(out, writes)
	}
	return out, nil
}

// lastHumanSubmitter 从 from 这一步起沿「从哪一步进来」往回找，返回第一个进入人不是系统的步骤的
// 进入人——最近一位把流程往前送的真人。典型情形：办理人提交 → 子流程 A（等待）
// → 子流程 B：A 结束后系统回推到 B，这一跳的提交人是系统，B 的发起人应当还是当初把流程送到 A
// 的那位办理人（即 A 这一步的进入人）。步骤要看「快照 + 本次变更集」的叠加视图：辅助链上连着的
// 几个节点是同一个变更集里刚建出来的，还不在快照里。找不到返回零值（app 层退回本次操作人）。
func (e *Engine) lastHumanSubmitter(ctx context.Context, l *loaded, b *csBuilder, from *pb.StepRow) ports.Actor {
	steps := overlaySteps(l, b)
	byID := make(map[string]*pb.StepRow, len(steps))
	for _, s := range steps {
		byID[s.GetStepId()] = s
	}
	// 步数上限只为防御坏数据里的环；正常实例的步骤链远短于此。
	for s, hops := from, 0; s != nil && hops <= len(steps); hops++ {
		if s.GetEnteredByUserId() != 0 {
			return e.actorOfUser(ctx, l, s.GetEnteredByUserId())
		}
		s = byID[s.GetEnteredFromStepId()]
	}
	return ports.Actor{}
}

// actorOfUser 按用户 id 拼一个操作人。账本步骤行只存用户 id，姓名借候选端口按静态用户解析一次
// ——只为让子实例的默认摘要（「某某发起的……」）带得上人名；解析不到或报错都不影响发起，姓名留空。
func (e *Engine) actorOfUser(ctx context.Context, l *loaded, userID int64) ports.Actor {
	actor := ports.Actor{UserID: userID}
	if e.Candidate == nil {
		return actor
	}
	if people, err := e.Candidate.Resolve(ctx, l.rec, []int64{userID}, "", nil); err == nil {
		for _, p := range people {
			if p.UserID == userID {
				actor.DisplayName = p.DisplayName
			}
		}
	}
	return actor
}

// subflowLaunchErrorCode 停驻事件的原因码（分档）：
// 宿主业务校验拒绝建单记 RECORD_WRITE_REJECTED[:子码]，目标流程发起后没形成实例记 SUBFLOW_<结果>，
// 目标流程停用 / 未发布等引擎拒绝原样记引擎码，其余 SYSTEM_ERROR。归类规则见 incidentReasonCode；
// 流程管理页据此给管理员显示业务话原因，不再只有一句英文原文。
func subflowLaunchErrorCode(launchErr error) string {
	return incidentReasonCode(launchErr, true)
}

// writeOf 把一个读到的字段值翻成一条写入。源字段没有值（IsNull）时不写——写空串与「没有值」
// 是两件事，前者会把目标字段上原有的默认值抹掉。
func writeOf(targetFieldID string, v ports.FieldValue) (ports.FieldWrite, bool) {
	if targetFieldID == "" || v.IsNull {
		return ports.FieldWrite{}, false
	}
	return ports.FieldWrite{FieldID: targetFieldID, TextValue: v.TextValue}, true
}

// subflowMappingsOf 从编译产物取传递字段清单。
func subflowMappingsOf(target *compile.NodeCompiled) []model.SubflowFieldMapping {
	var out []model.SubflowFieldMapping
	if target.SubflowMappingsJSON != "" {
		_ = json.Unmarshal([]byte(target.SubflowMappingsJSON), &out)
	}
	return out
}

// subflowAlreadyLaunched 这个子流程节点在本实例里是否已经发起过。
//
// 按**节点**判重而不是按步骤：同一节点走两次是两条步骤行，但规则说的是「同一实例同一
// 子流程节点只发起一次」。链接行记的是父步骤 id，所以要把它翻回节点 id 再比。
func subflowAlreadyLaunched(l *loaded, nodeID string) bool {
	for _, link := range l.agg.GetLinks() {
		if s := l.step(link.GetParentStepId()); s != nil && s.GetNodeId() == nodeID {
			return true
		}
	}
	return false
}

// init 登记子流程节点的运行期行为：辅助节点，没有回退这回事（backMethods 留空）。
func init() {
	registerRuntime(model.NodeKindSubflow, kindRuntime{arrive: (*Engine).arriveSubflow})
}

// —— app 层执行 Decision.PendingSubflowStarts 之后回写父实例的两条派生提交 ——
//
// 状态机只算“发几个、带什么值”；真正的“建单 → Start → 提交”都在 app 层完成（一个变更集只写一
// 个实例）。app 层每成功发起一批子实例后，回来调用 CommitLinks 把链接行 + SUBFLOW_STARTED 发件
// 箱行追加到父实例；建单 / 发起 / 回写反复失败则调用 ParkSubflowStart 把父实例改判停驻。

// CommitLinks 把这一次子流程节点发起出来的链接行追加到父实例（app 层子实例逐个 Start 成功之后
// 调用，agg 是这次提交前重新装载的最新父实例聚合）。父实例本身不改内容，只作为 CAS 锚点——
// 账本要求触碰 LinkUpserts 的变更集必须带实例写入（与结束标识两段式同一约束）。
func (e *Engine) CommitLinks(agg *pb.InstanceAggregate, links []*pb.LinkRow) *Decision {
	inst := agg.GetInstance()
	instRow := cloneInstance(inst)
	instRow.LastActionAt = e.now()
	b := newCS()
	b.instance(instRow, inst.GetVersion())
	for _, l := range links {
		b.link(l)
	}
	b.subflowStarted(agg, instRow, links)
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus()}}
}

// ParkSubflowStart 子流程发起反复失败（M5 SUBFLOW_START_FAILED）：把父实例（已经提交过本次动作
// 之后重新装载的最新聚合）改判为停驻，已经成功发起的子实例不回滚（app 层不撤销）。
// 停驻点记子流程节点与步骤，供管理员按 M3 定位；若父实例这一刻已经结束（不等待档紧接着自己
// 也跑到了结束节点），不再动实例状态——已结束的实例不可能再被停驻，只留一条事故行供事后排查。
func (e *Engine) ParkSubflowStart(agg *pb.InstanceAggregate, start SubflowStart, launchErr error) *Decision {
	inst := agg.GetInstance()
	instRow := cloneInstance(inst)
	now := e.now()
	instRow.LastActionAt = now
	incident := &pb.IncidentRow{
		IncidentId: e.IDs.New("inc"), WorkflowInstanceId: inst.GetWorkflowInstanceId(), StepId: start.StepID,
		Kind: string(model.IncidentSubflowStartFailed), Status: string(model.IncidentStatusOpen), OpenedAt: now,
		// 提交人一并记进恢复点：管理员恢复时发起人要取回当初这位办理人，而姓名只在请求
		// 当刻可得（账本步骤行只存用户 id），不在这里记下来，恢复出来的子实例默认摘要就没有人名。
		ResumePointJson: resumePoint{Action: "SUBFLOW_START", NodeID: start.NodeID, StepID: start.StepID,
			SubmitterUserID: start.Submitter.UserID, SubmitterName: start.Submitter.DisplayName, SubmitterSuperAdmin: start.Submitter.SuperAdmin}.json(),
	}
	if launchErr != nil {
		incident.ErrorCode, incident.ErrorMessage = subflowLaunchErrorCode(launchErr), launchErr.Error()
	}
	b := newCS()
	if inst.GetStatus() != string(model.InstanceStatusEnded) {
		instRow.Status = string(model.InstanceStatusParked)
		instRow.ParkedIncidentId = incident.IncidentId
		b.outbox(model.OutboxInstanceParked, agg, instRow, nil)
	}
	b.instance(instRow, inst.GetVersion())
	b.incident(incident)
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeParked, IncidentID: incident.IncidentId, WorkflowInstanceID: inst.GetWorkflowInstanceId()}}
}

// —— 子实例结束后回来推父流程 ——

// MarkChildEnded 子实例结束（正常走到结束节点、或被强制结束）那一刻，在父实例聚合里把它对应
// 的链接行标成 ENDED（agg 是调用方重新装载的最新父实例聚合）。返回这条链接归属的父步骤 id，
// 供调用方据此判断「该步骤下全部（等待档）链接是否都已结束」，从而决定要不要调用
// ResumeSubflowWait 把父流程推进。找不到该子实例对应的链接（父链接已被删除，或本来就没有，
// 例如顶层实例）时返回 (nil, "", nil)——不是错误。链接已经是 ENDED（重复推送 / 竞态）时同样
// 返回 nil 变更集，幂等跳过。
func (e *Engine) MarkChildEnded(agg *pb.InstanceAggregate, childInstanceID string) (*Decision, string, error) {
	inst := agg.GetInstance()
	var link *pb.LinkRow
	for _, l := range agg.GetLinks() {
		if l.GetChildWorkflowInstanceId() == childInstanceID {
			link = l
		}
	}
	if link == nil {
		return nil, "", nil
	}
	if link.GetChildStatus() == string(model.LinkChildStatusEnded) {
		return nil, link.GetParentStepId(), nil
	}
	updated := cloneLink(link)
	updated.ChildStatus = string(model.LinkChildStatusEnded)
	instRow := cloneInstance(inst)
	instRow.LastActionAt = e.now()
	b := newCS()
	b.instance(instRow, inst.GetVersion())
	b.link(updated)
	return &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: instRow,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus()}}, link.GetParentStepId(), nil
}

// ResumeSubflowWait 等待档的全部子实例都已结束，把停在子流程步骤的父实例推进——本步
// PASSED（Outcome=LAUNCHED），沿主线出线求路继续（同 L）。agg 是调用方重新装载的最新父实例
// 聚合，actor 是系统身份（没有人在现场触发这一跳）。
//
// 无人在场时两类情况都不能替用户拿主意，直接报错交调用方处理（父步骤留在 ACTIVE、记 warn，
// 不提交任何变更）：
//   - 选路零命中 / 多命中（L3/L4 需要人选，但这里没有提交人）；
//   - 到达下一站需要选人且候选不止一人（AssigneeChoiceRequired，同样没有人能弹框去选）；
//     候选为空时按 C4 走（提交人任务转暂存的口径在这里不适用——改成父步骤留在原地，同样报错）。
//
// 已经被别的路径推进过（本步不再是 ACTIVE，或已经不是当前站，重复调用 / 竞态）时幂等跳过，
// 返回空变更集的 Decision（调用方按「无事可做」处理，不当错误）。
func (e *Engine) ResumeSubflowWait(ctx context.Context, appID string, agg *pb.InstanceAggregate, stepID string, actor ports.Actor) (*Decision, error) {
	l, err := loadCompiled(appID, agg)
	if err != nil {
		return nil, err
	}
	inst := cloneInstance(l.agg.GetInstance())
	step := l.step(stepID)
	if step == nil {
		return nil, errf("SYSTEM_ERROR", "resume step %s not found", stepID)
	}
	if step.GetStatus() != string(model.StepStatusActive) || inst.GetCurrentStepId() != stepID {
		return &Decision{Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus()}}, nil
	}
	target := l.compiled.Node(step.GetNodeId())
	if target == nil {
		return nil, errf("SYSTEM_ERROR", "step %s points to unknown node %s", stepID, step.GetNodeId())
	}
	now := e.now()
	expected := inst.GetVersion()
	b := newCS()
	s := cloneStep(step)
	s.Status, s.ClosedAt, s.Outcome = string(model.StepStatusPassed), now, string(model.StepOutcomeLaunched)
	chosen, outcome, err := e.route(ctx, l, target.NodeID, actor, Choices{})
	if err != nil {
		return nil, err
	}
	if outcome != nil {
		return nil, SystemErrorf("subflow wait resume: step %s cannot resume routing: %s", stepID, outcome.Hint)
	}
	s.RouteLinkId = chosen.LinkID
	b.step(s)
	inst.LastActionAt = now
	b.instance(inst, expected)
	a, err := e.arrive(ctx, l, b, inst, s, arriveTarget{NodeID: chosen.ToNodeID, ViaLinkID: chosen.LinkID, AutoSelectAll: true}, actor, Choices{})
	if err != nil {
		return nil, err
	}
	if a.outcome != nil && a.outcome.Kind != OutcomeParked {
		return nil, SystemErrorf("subflow wait resume: step %s cannot resume arrival: outcome %s", stepID, a.outcome.Kind)
	}
	d := &Decision{Changeset: b.cs, ExpectedVersion: inst.GetVersion(), instance: inst, tasks: a.tasks, PendingEndWrite: a.endWrite,
		Outcome: Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus(), EndLabel: inst.GetEndLabel()}}
	d.PendingSubflowStarts = appendStarts(a.subflowStarts, nil)
	if a.ended {
		d.Outcome.StepID = a.step.GetStepId()
	}
	if a.outcome != nil {
		d.Outcome = *a.outcome // F6 自动办理链超长：实例已停驻，结果如实报停驻
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return d, nil
}
