package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// back.go 是『回退』的唯一实现。办理节点的「回退」操作与审批节点的三档回退按钮
// 走同一条路：本文件只认「回退方式 + 目标」，谁把它翻译出来（按钮还是操作）不关心。
//
// 回退与撤销（G）是两件事，别混：
//   - 撤销是「我刚把流程送出去，我后悔了」——把下一站整站撤掉，回到我自己那一站，表单不动；
//   - 回退是「单据有问题，请前面的人重做」——本步整步作废，在目标节点**新开一步**重新选人
//     派发，并可按节点配置清空一批字段。
//
// 「新开一步」而不是复活旧步骤，是 P5 定的：流转明细按到达顺序编号，同一节点走两次就是两步。
// 复活旧步骤会让明细里少一行、让「第几次到这」无从分辨。

// BackInput 回退入参。
type BackInput struct {
	TaskInput
	// Method 回退方式（E1 三档），运行期只能选节点允许的那几档。
	Method model.WithdrawMethod
	// TargetStepID 「回退到指定步骤」时由回退人从本实例实际走过的办理 / 审批步骤里选一个
	// （人工发起的实例另含发起步骤）；另两档不填（填了也不看）。
	TargetStepID string
	// Comment 回退说明（可选），写进流转明细。
	Comment string
}

// ClearWrite 是『回退时清空』：app 层在提交变更集之前把这些字段清空并保存单据。
// 与审批写字段同一口径——写失败即整个回退失败，不留「字段清了、流程没退」的中间态。
type ClearWrite struct {
	Fields []model.ClearOnWithdrawField
	NodeID string
	StepID string
}

// SubflowCancel 是回退善后的一条：回退把某个子流程节点已经发起过的子实例从时间线上抹掉了，
// app 层据此逐个 ForceEnd。删单据是缺口——宿主目前没有「删单据」RPC，这里只做到 ForceEnd +
// 删链接（链接行已经在同一变更集的 LinkDeleteIds 里）。
type SubflowCancel struct {
	NodeID          string
	ChildInstanceID string
}

// cancelSubflowsBefore 回退目标在某个子流程节点之前时，该节点已发起的子流程实例连同其
// 链接一并处置。判定口径：本实例里 seq 大于目标步骤、节点类型是子流程、还没被撤销过的步骤——
// 这些都是「目标步骤之后才发生」的子流程发起，回退把它们从时间线上抹掉，已经发出去的子流程
// 不该悬空留着（再次到达时重新发起）。链接行直接从变更集里登记删除；子实例交给
// app 层 ForceEnd。
func cancelSubflowsBefore(l *loaded, b *csBuilder, target *pb.StepRow) []SubflowCancel {
	var out []SubflowCancel
	for _, s := range l.agg.GetSteps() {
		if s.GetSeqNo() <= target.GetSeqNo() || s.GetNodeKind() != model.StepNodeKind(model.NodeKindSubflow) {
			continue
		}
		if s.GetStatus() == string(model.StepStatusWithdrawn) {
			continue // 已经被更早一次撤销/回退处理过，链接同样处理过，避免重复登记
		}
		for _, link := range l.agg.GetLinks() {
			if link.GetParentStepId() != s.GetStepId() {
				continue
			}
			b.linkDelete(link.GetLinkId())
			out = append(out, SubflowCancel{NodeID: s.GetNodeId(), ChildInstanceID: link.GetChildWorkflowInstanceId()})
		}
	}
	return out
}

// Back 回退（触发 D4）。
func (e *Engine) Back(ctx context.Context, in BackInput) (*Decision, error) {
	l, err := loadCompiled(in.AppID, in.Agg)
	if err != nil {
		return nil, err
	}
	task := l.task(in.TaskID)
	if err := checkActionable(l, task, in.Actor); err != nil {
		return nil, err
	}
	step := l.step(task.GetStepId())
	if step == nil || step.GetStatus() != string(model.StepStatusActive) {
		return nil, errf("TASK_NOT_ACTIONABLE", "step %s is not active", task.GetStepId())
	}
	node := l.compiled.Node(step.GetNodeId())
	if node == nil {
		return nil, errf("SYSTEM_ERROR", "step %s points to unknown node %s", step.GetStepId(), step.GetNodeId())
	}
	// 审批站的回退只能来自按钮：直接调 Back 会跳过理由必填与结果 / 理由写字段
	// ，动作码也记成 BACK_* 而不是 BTN:<id>。接口是公开的，与「审批站拒提交」同一道理，Submit
	// 与 Back 都要堵。判据走静态特征（Back）。
	if !traitsOf(node.KindOf()).Back {
		return nil, errf("TASK_NOT_ACTIONABLE", "step %s is an approval step, use PressButton", step.GetStepId())
	}
	if !backMethodAllowed(node, in.Method) {
		return nil, errf("BACK_METHOD_NOT_ALLOWED", "node %s does not allow %s", node.NodeID, in.Method)
	}
	target, downgraded, err := backTarget(l, step, in.Method, in.TargetStepID)
	if err != nil {
		return nil, err
	}
	if downgraded {
		in.Comment = downgradeInitiatorComment(in.Comment)
	}
	return e.back(ctx, l, in, step, task, node, target, string(model.TaskActionOfBackMethod(in.Method)))
}

// back 回退的执行段，Back（办理节点的回退操作）与 PressButton（审批节点的回退按钮）共用。
// 入参里的 target 已经解析并校验过，actionCode 由调用方决定（办理是 BACK_*，审批是 BTN:<id>）。
func (e *Engine) back(ctx context.Context, l *loaded, in BackInput, step *pb.StepRow, task *pb.TaskRow, node *compile.NodeCompiled, target *pb.StepRow, actionCode string) (*Decision, error) {
	inst := cloneInstance(l.agg.GetInstance())
	expected := inst.GetVersion()
	now := e.now()

	// 本步整步回退：回退人的任务记成已完成（动作码是回退，不是提交，不计过关数），
	// 同步其余未完成的任务一并撤销，原因 STEP_RETURNED。
	t := cloneTask(task)
	t.Status, t.DoneAt, t.ActionCode, t.Comment = string(model.TaskStatusDone), now, actionCode, in.Comment
	s := cloneStep(step)
	s.Status, s.ClosedAt, s.Outcome = string(model.StepStatusReturned), now, string(model.StepOutcomeReturned)

	b := newCS()
	b.instance(inst, expected)
	b.task(t)
	b.step(s)
	changed := []*pb.TaskRow{t}
	for _, o := range closeOtherOpenTasks(l, step.GetStepId(), t.GetTaskId(), model.TaskWithdrawStepReturned, now) {
		b.task(o)
		changed = append(changed, o)
	}
	b.outbox(model.OutboxStepReturned, l.agg, inst, changed)

	// 目标步骤之前已经发起过的子流程，这次回退会把它们从时间线上抹掉，一并处置。
	// 用 l.agg（本次动作装载时的原始聚合）判定，不受本函数接下来要做的改动影响。
	cancels := cancelSubflowsBefore(l, b, target)

	// 目标是发起步骤时不新开步骤：「回退到发起人或撤销发起后，这条发起任务回到待办」，
	// 与撤销发起同一口径。判据是**目标步骤是不是发起步骤**，不是用了哪一档：
	//   - 「回退到上一步」「回退到指定步骤」的目标也可以是发起步骤，走普通到达会撞上发起节点
	//     「不可到达」的登记（node_registry.go）；
	//   - 反过来，非人工发起的实例把「回退到发起人」降级成「回退到上一步」后，目标是一个
	//     普通人工步骤，必须照 P5 新开一步——此前按方式判，会把那个旧步骤原地复活。
	if isStartStep(target) {
		d, err := e.backToStart(l, in, b, inst, expected, target, changed, node, s)
		if err == nil && d != nil {
			d.PendingSubflowCancels = cancels
		}
		return d, err
	}

	// 目标节点按 C1～C4 重新选人派发，此时提交人是回退人。
	a, err := e.arrive(ctx, l, b, inst, s, arriveTarget{NodeID: target.GetNodeId(), Returned: true, PrevActors: []int64{in.Actor.UserID}}, in.Actor, in.Choices)
	if err != nil {
		return nil, err
	}
	if a.outcome != nil && a.outcome.Kind != OutcomeParked {
		// F6 停驻（OutcomeParked）不在这里分流：那一包变更集（步骤 + 事故 + 实例停驻）已经在 b 里，
		// 照常落库，只是最终结果报「已停驻」而不是「已提交」。
		if a.outcome.Kind == OutcomeAssigneeChoiceRequired {
			return &Decision{Outcome: *a.outcome}, nil
		}
		// C4 目标步骤选不出人：回退不成立，回退人的任务转暂存等人来看；本步不作废、流程不动。
		return e.parkSubmitter(l, cloneInstance(l.agg.GetInstance()), task, step, expected, *a.outcome)
	}

	d := &Decision{Changeset: b.cs, ExpectedVersion: expected, instance: inst, tasks: append(changed, a.tasks...),
		PendingClearWrite:     clearWriteOf(node, s),
		PendingSubflowStarts:  appendStarts(a.subflowStarts, nil),
		PendingSubflowCancels: cancels,
		Outcome:               Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: inst.GetCurrentStepId(), Status: inst.GetStatus()}}
	if a.outcome != nil {
		d.Outcome = *a.outcome // F6 自动办理链超长：实例已停驻，结果如实报停驻
	}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return d, nil
}

// backToStart 回退到发起步骤：发起步骤回到当前站，那条发起任务回到待办并累加回到待办次数，
// 发起人在任务中心重新看到它，提交即再次发起。不新开步骤——发起任务全实例只有那一条。
// 三档回退只要目标是发起步骤都走这里（见 back 里的分派）。
func (e *Engine) backToStart(l *loaded, in BackInput, b *csBuilder, inst *pb.InstanceRow, expected int64, target *pb.StepRow, changed []*pb.TaskRow, node *compile.NodeCompiled, returned *pb.StepRow) (*Decision, error) {
	now := e.now()
	st := cloneStep(target)
	st.Status, st.ClosedAt, st.Outcome, st.RouteLinkId, st.PassedCount = string(model.StepStatusActive), nil, "", "", 0
	b.step(st)
	var recipients []int64
	for _, t := range l.tasksOfStep(target.GetStepId()) {
		c := cloneTask(t)
		c.Status, c.DoneAt, c.ActionCode, c.WithdrawnAt, c.WithdrawReason = string(model.TaskStatusPending), nil, "", nil, ""
		c.ReopenCount = c.GetReopenCount() + 1
		b.task(c)
		changed = append(changed, c)
		recipients = append(recipients, c.GetAssigneeUserId())
	}
	inst.CurrentStepId, inst.CurrentNodeId, inst.CurrentNodeName = st.GetStepId(), st.GetNodeId(), st.GetNodeName()
	inst.LastActionAt = now
	// 与正常流转同一节拍：本步作废记一行 STEP_RETURNED（上面），到达目标站再记一行 STEP_ARRIVED。
	b.outbox(model.OutboxStepArrived, l.agg, inst, changed)
	// 被回退通知：收件人是回退目标步骤的办理人——这一档就是发起人本人。开关读
	// 目标节点（这里恒是发起节点，backToStart 只在目标是发起步骤时调用）的 on_returned，
	// 不是回退发生的那个节点——这是最容易读反的一处，target 才是「回退到」的那个节点。
	targetNotify := l.compiled.Node(target.GetNodeId()).Notify()
	if targetNotify.Enabled(model.NotifyKeyReturned) {
		b.notify(model.NotifyTaskReturned, inst, recipients, "", st.GetSummaryText(), st.GetNodeName(), targetNotify.ChannelsOrDefault())
	}
	d := &Decision{Changeset: b.cs, ExpectedVersion: expected, instance: inst, tasks: changed,
		PendingClearWrite: clearWriteOf(node, returned),
		Outcome:           Outcome{Kind: OutcomeCommitted, WorkflowInstanceID: inst.GetWorkflowInstanceId(), StepID: st.GetStepId(), Status: inst.GetStatus()}}
	if err := checkInvariant(b, l.agg); err != nil {
		return nil, err
	}
	return d, nil
}

// backByButton 把审批的三档回退按钮翻译成回退方式后交给同一条回退链路。
// 按钮存在即代表这一档被允许（审批节点不另配允许清单），所以不再过 backMethodAllowed。
func (e *Engine) backByButton(ctx context.Context, l *loaded, in ApproveInput, step *pb.StepRow, task *pb.TaskRow, btn model.ApprovalButton) (*Decision, error) {
	node := l.compiled.Node(step.GetNodeId())
	if node == nil {
		return nil, errf("SYSTEM_ERROR", "step %s points to unknown node %s", step.GetStepId(), step.GetNodeId())
	}
	method := model.BackMethodOfButton(btn.Action)
	target, downgraded, err := backTarget(l, step, method, in.TargetStepID)
	if err != nil {
		return nil, err
	}
	comment := in.Reason
	if downgraded {
		comment = downgradeInitiatorComment(comment)
	}
	backIn := BackInput{TaskInput: in.TaskInput, Method: method, TargetStepID: in.TargetStepID, Comment: comment}
	d, err := e.back(ctx, l, backIn, step, task, node, target, model.TaskActionButton(btn.ID))
	if err != nil {
		return nil, err
	}
	// 按钮「确认时」写绑定字段不分按钮种类：回退类按钮同样把结果标识与理由写进绑定字段，
	// 与「提交通过」共用 app 层同一条写入顺序（结果 → 理由 → 保存 → 再提交状态变更）。只在回退
	// 真的成立（变更集要落库）时挂上；目标站选不出人或要先弹选人框时回退没有发生，字段也
	// 不能写——否则单据上写着「已拒绝」，流程却还停在审批站。
	if d.Changeset != nil && (d.Outcome.Kind == OutcomeCommitted || d.Outcome.Kind == OutcomeParked) {
		d.PendingApproveWrite = approveWriteOf(node, btn, in.Reason, step)
	}
	return d, nil
}

// backMethodAllowed 节点上逐个勾选允许哪些回退方式，运行期只能选被允许的。
// 只有办理节点会走到这里（Back 对审批站直接拒）；审批节点的回退档由按钮表达、只能经
// PressButton → backByButton 进来，按钮存在即允许，不再在这里按按钮放行。
func backMethodAllowed(node *compile.NodeCompiled, method model.WithdrawMethod) bool {
	if method == "" {
		return false
	}
	for _, m := range backMethodsOf(node) {
		if m == method {
			return true
		}
	}
	return false
}

// backMethodsOf 节点「允许哪几档回退」的清单，经运行期注册表按类型分派（node_human.go 的
// backMethodsHandle / backMethodsApprove）：办理节点读 allowed_withdraws_json；审批节点由按钮
// 清单表达（配了对应动作的按钮即那一档）；没登记 backMethods 的类型（抄送 / 子流程 / 结束 /
// 发起）返回 nil，即没有回退这回事。预告（Preview）用它告诉界面要不要画目标步骤选择框，
// 真正执行时办理走 backMethodAllowed、审批走按钮，口径与此一致。
func backMethodsOf(node *compile.NodeCompiled) []model.WithdrawMethod {
	rt, ok := runtimeOf(node.KindOf())
	if !ok || rt.backMethods == nil {
		return nil
	}
	return rt.backMethods(node)
}

// backTarget 解析回退目标步骤：
//   - 回退到上一步：本实例紧邻的上一个办理或审批步骤；自动办理的步骤、辅助节点（抄送）、
//     被撤销的步骤都跳过——它们没有人，退过去没有意义。人工发起的实例里，前面一个办理 /
//     审批步骤都没有时，上一步就是发起步骤；
//   - 回退到发起人：发起步骤（seq 1）。**非人工发起的实例没有发起表单可回**（G9 同源）：
//     这一档运行期降级为「回退到上一步」，downgraded 报 true 供调用方在流转明细里追加固定
//     文案（发布期不禁止这么配，同一条流程既可人工发起也可被子流程发起）；
//   - 回退到指定步骤：回退人从本实例实际走过的办理 / 审批步骤里选一个，必须在本步之前；
//     人工发起的实例另含发起步骤（判据见 isBackTargetStep）。
//     **自动办理过的步骤也在可选之列**——它的节点类型本来就是办理或审批，只是那一趟被系统
//     替人走了；而「回退目标是配了自动办理的节点时，到达后不触发自动办理」这条规则要求自动
//     步骤可以被选作目标，否则它永远没有触发路径。跳过自动步骤是
//     「回退到上一步」那一档独有的口径，不是所有档共用。
//
// 子流程节点不作回退目标，由 isHumanStepKind 一并挡住——它只认
// 办理与审批两类，新增节点类型默认不是合法目标，不需要回头改这里。
func backTarget(l *loaded, current *pb.StepRow, method model.WithdrawMethod, targetStepID string) (target *pb.StepRow, downgraded bool, err error) {
	if method == model.WithdrawMethodInitiator && l.agg.GetInstance().GetStartKind() != string(model.StartKindManual) {
		s, err := previousHumanStepTarget(l, current)
		if err != nil {
			return nil, false, err
		}
		return s, true, nil
	}
	switch method {
	case model.WithdrawMethodPreviousStep:
		s, err := previousHumanStepTarget(l, current)
		return s, false, err
	case model.WithdrawMethodInitiator:
		for _, s := range l.agg.GetSteps() {
			if s.GetSeqNo() == 1 {
				return s, false, nil
			}
		}
		return nil, false, errf("BACK_TARGET_NOT_FOUND", "start step not found")
	case model.WithdrawMethodSpecified:
		if targetStepID == "" {
			return nil, false, errf("BACK_TARGET_REQUIRED", "a target step is required")
		}
		s := l.step(targetStepID)
		if s == nil || !isBackTargetStep(l.agg.GetInstance(), s, current.GetSeqNo()) {
			return nil, false, errf("BACK_TARGET_INVALID", "step %s is not a valid back target", targetStepID)
		}
		return s, false, nil
	default:
		return nil, false, errf("BACK_METHOD_UNSUPPORTED", "unknown back method %q", method)
	}
}

// previousHumanStepTarget 「回退到上一步」的解析（E6：跳过自动办理过的步骤，取最近的人工步骤）；
// 也是 C5 降级档的落点——非人工发起的实例遇「回退到发起人」时改走这一条。
func previousHumanStepTarget(l *loaded, current *pb.StepRow) (*pb.StepRow, error) {
	var best *pb.StepRow
	for _, s := range l.agg.GetSteps() {
		if !isBackTargetStep(l.agg.GetInstance(), s, current.GetSeqNo()) || s.GetAutoHandled() {
			continue
		}
		if best == nil || s.GetSeqNo() > best.GetSeqNo() {
			best = s
		}
	}
	if best == nil {
		// 走到这里只剩非人工发起的实例：人工发起的实例最差也能退到发起步骤（isBackTargetStep 已把
		// 它算进来）；非人工发起的没有发起表单可回，前面又没有人工步骤，
		// 压根无处可退，报「找不到目标」。
		return nil, errf("BACK_TARGET_NOT_FOUND", "no previous human step before step %s", current.GetStepId())
	}
	return best, nil
}

// downgradeInitiatorComment 非人工发起的实例遇「回退到发起人」降级为「回退到上一步」时，
// 在流转明细的说明前追加固定文案（中文硬编码，业务备注，与 H2 默认摘要同一口径）；
// 动作码仍记原按钮 / 原方式（TaskActionOfBackMethod 不看这个降级）。
func downgradeInitiatorComment(comment string) string {
	const note = "无发起人，已按回退到上一步处理"
	if comment == "" {
		return note
	}
	return note + "；" + comment
}

// isBackTargetStep 一个步骤能否作回退目标：在本步之前、没被撤销，且节点类型是办理或审批，
// 或者它是人工发起的实例的发起步骤。
//
// 自动办理过的步骤**算**合法目标（见 backTarget 的注释）：「跳过自动步骤」只是「回退到上一步」
// 那一档的取法，由调用方自己再过一道，不写死在这里。
//
// 发起步骤单独判、不去翻静态特征表里 Start 的 Human：那个特征还管着「上步处理人」的取法，
// 不能为回退目标去动它（发起人靠兜底覆盖，结果本来就对）。非人工发起（动作 / 子流程发起）的实例
// 没有发起表单可回，发起步骤不作目标——与 backTarget 里非人工发起的降级同一个判据。
func isBackTargetStep(inst *pb.InstanceRow, s *pb.StepRow, beforeSeq int32) bool {
	if s.GetSeqNo() >= beforeSeq {
		return false
	}
	if s.GetStatus() == string(model.StepStatusWithdrawn) {
		return false
	}
	if isStartStep(s) {
		return inst.GetStartKind() == string(model.StartKindManual)
	}
	return isHumanStepKind(s.GetNodeKind())
}

// isStartStep 一个步骤是不是发起步骤。回退的目标判定与执行分派（新开一步还是发起任务回到待办）
// 共用这一个判据，免得两边各认各的。
func isStartStep(s *pb.StepRow) bool {
	return s.GetNodeKind() == model.StepNodeKind(model.NodeKindStart)
}

// BackTargets 「回退到指定步骤」的可选清单（运行期由回退人挑一个），按到达顺序给出。
// 网关据此渲染选择框，不让前端自己从流转明细里猜哪些步骤能退。
func BackTargets(agg *pb.InstanceAggregate) []*pb.StepRow {
	if agg == nil || agg.GetInstance() == nil {
		return nil
	}
	l := &loaded{agg: agg}
	current := l.activeStep()
	if current == nil {
		return nil
	}
	var out []*pb.StepRow
	for _, s := range agg.GetSteps() {
		if isBackTargetStep(agg.GetInstance(), s, current.GetSeqNo()) {
			out = append(out, s)
		}
	}
	return out
}

// clearWriteOf 节点配了「回退时清空」的字段清单时，交 app 层在提交前清空并保存单据。
// 清单空就返回 nil（app 层跳过，不做一次空写）。
func clearWriteOf(node *compile.NodeCompiled, step *pb.StepRow) *ClearWrite {
	var fields []model.ClearOnWithdrawField
	if node.ClearOnWithdrawJSON != "" {
		_ = json.Unmarshal([]byte(node.ClearOnWithdrawJSON), &fields)
	}
	if len(fields) == 0 {
		return nil
	}
	return &ClearWrite{Fields: fields, NodeID: node.NodeID, StepID: step.GetStepId()}
}
