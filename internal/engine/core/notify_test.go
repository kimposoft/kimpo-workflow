package core_test

import (
	"encoding/json"
	"fmt"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// notify_test.go 覆盖节点级通知配置的 8 个引擎派发点 +「被终止」事件 + 旧编译产物兼容。核心断言口径统一是：找一条 NOTIFY 发件箱行，看 event 对不对、
// 开关关掉是否真的不发、渠道摊平对不对。

// withNodeNotify 把 c 里某个节点的 NotifyJSON 原地改写成给定的 JSON 字面量，返回 c 本身方便
// 链式写。调用方一律先拿一份新鲜的 f1()/f2()/f3()/f4()，不会污染其它用例。
func withNodeNotify(c *compile.CompiledDefinition, nodeID, notifyJSON string) *compile.CompiledDefinition {
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == nodeID {
			c.Nodes[i].NotifyJSON = notifyJSON
		}
	}
	return c
}

// lastNotify 取发件箱里最后一条 NOTIFY 行的载荷（找不到直接判失败）。
func lastNotify(t *testing.T, h *harness) map[string]any {
	t.Helper()
	for i := len(h.ledger.Outbox) - 1; i >= 0; i-- {
		if h.ledger.Outbox[i].GetKind() == string(model.OutboxNotify) {
			var p map[string]any
			if err := json.Unmarshal([]byte(h.ledger.Outbox[i].GetPayloadJson()), &p); err != nil {
				t.Fatalf("unmarshal notify payload: %v", err)
			}
			return p
		}
	}
	t.Fatal("outbox 里没有 NOTIFY 行")
	return nil
}

// hasNotifyEvent 发件箱里是否存在某个 event 的 NOTIFY 行。用于事件类型在整条测试流程里只可能
// 出现一次的场景（TASK_RETURNED/TASK_WITHDRAWN/INSTANCE_ENDED/INSTANCE_TERMINATED 这几类
// 通常如此）；同一 event 类型可能因流程更早的到达就已经出现过一次的场景（典型是
// TASK_ASSIGNED——发起后第一站到达就会发一条），要用下面的 changesetHasNotifyEvent 只看
// 「这一步决策自己产出的」变更集，否则会把更早那次无关的发生误判为「这一步也发了」。
func hasNotifyEvent(h *harness, event string) bool {
	for _, o := range h.ledger.Outbox {
		if o.GetKind() != string(model.OutboxNotify) {
			continue
		}
		var p map[string]any
		_ = json.Unmarshal([]byte(o.GetPayloadJson()), &p)
		if fmt.Sprint(p["event"]) == event {
			return true
		}
	}
	return false
}

// changesetHasNotifyEvent 只看某一次决策自己产出的变更集里有没有某个 event 的 NOTIFY 行，
// 不受流程更早阶段已经发生过的同类事件干扰（见 hasNotifyEvent 注释）。
func changesetHasNotifyEvent(cs *pb.Changeset, event string) bool {
	for _, o := range cs.GetOutboxAppends() {
		if o.GetKind() != string(model.OutboxNotify) {
			continue
		}
		var p map[string]any
		_ = json.Unmarshal([]byte(o.GetPayloadJson()), &p)
		if fmt.Sprint(p["event"]) == event {
			return true
		}
	}
	return false
}

// atApproveWith 与 approve_back_test.go 的 atApprove 同一套步骤（发起 → 王芳提交到审批站），
// 但吃自定义编译产物，供本文件按需关掉某个节点的通知开关。
func atApproveWith(t *testing.T, c *compile.CompiledDefinition) *harness {
	t.Helper()
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	return h
}

// ═══ 派发点 1／2：node_human.go arriveHuman（到达办理/审批，on_assigned / on_returned）═══

// 默认（n1 没配 notify）到达办理节点照发 TASK_ASSIGNED，渠道默认仅 system。
func TestNotify_HandleArrive_OnAssigned_Default(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	if !hasNotifyEvent(h, "TASK_ASSIGNED") {
		t.Fatal("默认应照发 TASK_ASSIGNED")
	}
	p := lastNotify(t, h)
	wantEqual(t, "event", p["event"], "TASK_ASSIGNED")
	wantEqual(t, "channels", fmt.Sprint(p["channels"]), "[system]")
}

// n1 关掉 on_assigned：到达不发 TASK_ASSIGNED。
func TestNotify_HandleArrive_OnAssigned_Off(t *testing.T) {
	c := withNodeNotify(f1(), "n1", `{"on_assigned":false}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	if hasNotifyEvent(h, "TASK_ASSIGNED") {
		t.Fatal("on_assigned=false 不该发 TASK_ASSIGNED")
	}
}

// 默认（回退目标节点 n1 没配 notify）「退回上一步」到达时照发 TASK_RETURNED，收件人是王芳。
func TestNotify_HandleArriveReturned_Default(t *testing.T) {
	h := atApprove(t) // f3()：发起 → 王芳（n1）→ 李四审批（n4）
	d, err := h.press(liSi, "b-prev", "金额不对，请重填", "")
	if err != nil {
		t.Fatalf("press b-prev: %v", err)
	}
	h.commit(d)
	if !hasNotifyEvent(h, "TASK_RETURNED") {
		t.Fatal("默认应照发 TASK_RETURNED")
	}
	p := lastNotify(t, h)
	wantEqual(t, "recipients", fmt.Sprint(p["recipient_user_ids"]), fmt.Sprintf("[%d]", wangFang.UserID))
}

// 回退目标节点 n1 关掉 on_returned：退回上一步到达时不发。
func TestNotify_HandleArriveReturned_TargetOff(t *testing.T) {
	c := withNodeNotify(f3(), "n1", `{"on_returned":false}`)
	h := atApproveWith(t, c)
	d, err := h.press(liSi, "b-prev", "金额不对，请重填", "")
	if err != nil {
		t.Fatalf("press b-prev: %v", err)
	}
	h.commit(d)
	if hasNotifyEvent(h, "TASK_RETURNED") {
		t.Fatal("回退目标节点 on_returned=false 不该发")
	}
}

// 最容易读反的一处：触发回退的节点（n4 审批）关掉 on_returned，回退目标节点（n1 办理）开着——
// 到达时仍要照发，证明读的是目标节点，不是触发回退的那个节点。
func TestNotify_HandleArriveReturned_ReadsTargetNotSource(t *testing.T) {
	c := f3()
	withNodeNotify(c, "n4", `{"on_returned":false}`) // 触发回退的审批节点：关
	withNodeNotify(c, "n1", `{"on_returned":true}`)  // 回退目标办理节点：显式开（同默认）
	h := atApproveWith(t, c)
	d, err := h.press(liSi, "b-prev", "金额不对，请重填", "")
	if err != nil {
		t.Fatalf("press b-prev: %v", err)
	}
	h.commit(d)
	if !hasNotifyEvent(h, "TASK_RETURNED") {
		t.Fatal("应读回退目标节点 n1 的 on_returned，不是触发回退的 n4——读反了才会漏发")
	}
}

// ═══ 派发点 3：withdraw.go（提交人撤销提交，on_withdrawn，读发起节点）═══

func TestNotify_Withdraw_OnWithdrawn_Default(t *testing.T) {
	h := newHarness(t, f2()) // 三站链：n0 → n1（王芳）→ n3（李四）→ n2
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatal(err)
	}
	if !hasNotifyEvent(h, "TASK_WITHDRAWN") {
		t.Fatal("默认应照发 TASK_WITHDRAWN")
	}
}

func TestNotify_Withdraw_OnWithdrawn_Off(t *testing.T) {
	c := withNodeNotify(f2(), "n0", `{"on_withdrawn":false}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if _, err := h.withdraw(wangFang); err != nil {
		t.Fatal(err)
	}
	if hasNotifyEvent(h, "TASK_WITHDRAWN") {
		t.Fatal("发起节点 on_withdrawn=false 不该发")
	}
}

// ═══ 派发点 4：back.go backToStart（回退到发起人，on_returned，读发起节点）═══

func TestNotify_BackToStart_OnReturned_Default(t *testing.T) {
	h := newHarness(t, f3())
	h.mustStart(starter, core.Choices{})
	d, err := h.back(wangFang, model.WithdrawMethodInitiator, "", "请补充说明")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(d)
	if !hasNotifyEvent(h, "TASK_RETURNED") {
		t.Fatal("默认应照发 TASK_RETURNED")
	}
}

func TestNotify_BackToStart_OnReturned_Off(t *testing.T) {
	c := withNodeNotify(f3(), "n0", `{"on_returned":false}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	d, err := h.back(wangFang, model.WithdrawMethodInitiator, "", "请补充说明")
	if err != nil {
		t.Fatalf("back: %v", err)
	}
	h.commit(d)
	if hasNotifyEvent(h, "TASK_RETURNED") {
		t.Fatal("发起节点 on_returned=false 不该发")
	}
}

// ═══ 派发点 5：node_end.go arriveEnd（单段到达结束节点，on_ended）═══
// f3() 的结束节点 n2 没配写入字段，走单段提交，不经两段式。

func TestNotify_ArriveEnd_OnEnded_Default(t *testing.T) {
	h := atApprove(t)
	d, err := h.press(liSi, "b-ok", "", "")
	if err != nil {
		t.Fatalf("press b-ok: %v", err)
	}
	h.commit(d)
	if !hasNotifyEvent(h, "INSTANCE_ENDED") {
		t.Fatal("默认应照发 INSTANCE_ENDED")
	}
}

func TestNotify_ArriveEnd_OnEnded_Off(t *testing.T) {
	c := withNodeNotify(f3(), "n2", `{"on_ended":false}`)
	h := atApproveWith(t, c)
	d, err := h.press(liSi, "b-ok", "", "")
	if err != nil {
		t.Fatalf("press b-ok: %v", err)
	}
	h.commit(d)
	if hasNotifyEvent(h, "INSTANCE_ENDED") {
		t.Fatal("结束节点 on_ended=false 不该发")
	}
}

// ═══ 派发点 6：end.go resumeEndArrive（两段式提交第二段，on_ended）═══
// f1() 的结束节点 n2 配了写入字段（f-status），触发两段式；harness.commit 按生产路径自动走完。

func TestNotify_ResumeEndArrive_OnEnded_Default(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if !hasNotifyEvent(h, "INSTANCE_ENDED") {
		t.Fatal("默认应照发 INSTANCE_ENDED")
	}
}

func TestNotify_ResumeEndArrive_OnEnded_Off(t *testing.T) {
	c := withNodeNotify(f1(), "n2", `{"on_ended":false}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	h.mustSubmit(wangFang, core.Choices{})
	if hasNotifyEvent(h, "INSTANCE_ENDED") {
		t.Fatal("结束节点 on_ended=false 不该发（两段式第二段同样要读节点配置）")
	}
}

// ═══ 派发点 7：admin.go Reassign（管理员改派，on_assigned，读任务所在步骤的节点）═══

func TestNotify_Reassign_OnAssigned_Default(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	task := h.task(agg, wangFang.UserID, "PENDING")
	d, err := h.eng.Reassign(h.ctx(), core.ReassignInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), ToUserID: liSi.UserID, Actor: admin, Reason: "请假"})
	if err != nil {
		t.Fatalf("reassign: %v", err)
	}
	// 只看改派这一次决策自己产出的变更集——发起后第一站到达时已经发过一条 TASK_ASSIGNED
	// （王芳），混进整个账本会把「改派本身有没有发」这件事测糊。
	if !changesetHasNotifyEvent(d.Changeset, "TASK_ASSIGNED") {
		t.Fatal("默认应照发 TASK_ASSIGNED")
	}
	h.rawCommit(d.Changeset)
	p := lastNotify(t, h)
	wantEqual(t, "recipients", fmt.Sprint(p["recipient_user_ids"]), fmt.Sprintf("[%d]", liSi.UserID))
}

func TestNotify_Reassign_OnAssigned_Off(t *testing.T) {
	c := withNodeNotify(f1(), "n1", `{"on_assigned":false}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	task := h.task(agg, wangFang.UserID, "PENDING")
	d, err := h.eng.Reassign(h.ctx(), core.ReassignInput{AppID: appID, Agg: agg, TaskID: task.GetTaskId(), ToUserID: liSi.UserID, Actor: admin})
	if err != nil {
		t.Fatalf("reassign: %v", err)
	}
	if changesetHasNotifyEvent(d.Changeset, "TASK_ASSIGNED") {
		t.Fatal("任务所在步骤的节点 on_assigned=false 不该发")
	}
	h.rawCommit(d.Changeset)
}

// ═══ 派发点 8：resume_incident.go resumeAutoChainLimit（事故恢复重派，on_assigned）═══

// autoChainLimitCompiled 复用 auto_test.go 的 f4() 夹具，让 n5/n6 互相自动办理形成环，超过
// 连续自动办理上限后停在 n5（TestB11 系列已验证：深度 20 是偶数，第一个停下来的必是 n5）。
func autoChainLimitCompiled() *compile.CompiledDefinition {
	c := f4()
	c.Nodes[3].AutoConditionPubID, c.Nodes[3].AutoConditionDocJSON = "p-auto", `{"mode":"condition"}`
	c.Links[3] = compile.LinkCompiled{LinkID: "l4", FromNodeID: "n6", ToNodeID: "n5", IsMain: true}
	return c
}

func TestNotify_ResumeAutoChainLimit_OnAssigned_Default(t *testing.T) {
	h := newHarness(t, autoChainLimitCompiled())
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	parked := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, parked, core.OutcomeParked)
	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: h.agg(), IncidentID: parked.Outcome.IncidentID, Actor: ports.Actor{UserID: 9, DisplayName: "管理员"}, Note: "已排查"})
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	// 只看恢复这一次决策自己产出的变更集——发起后第一站（n1）到达时已经发过一条
	// TASK_ASSIGNED，混进整个账本会把「恢复本身有没有发」这件事测糊。
	if !changesetHasNotifyEvent(rd.Changeset, "TASK_ASSIGNED") {
		t.Fatal("默认应照发 TASK_ASSIGNED")
	}
	h.rawCommit(rd.Changeset)
}

func TestNotify_ResumeAutoChainLimit_OnAssigned_Off(t *testing.T) {
	c := withNodeNotify(autoChainLimitCompiled(), "n5", `{"on_assigned":false}`)
	h := newHarness(t, c)
	h.expr.Conditions["p-auto"] = true
	h.mustStart(starter, core.Choices{})
	parked := h.mustSubmit(wangFang, core.Choices{})
	wantKind(t, parked, core.OutcomeParked)
	rd, err := h.eng.ResumeIncident(h.ctx(), core.ResumeInput{AppID: appID, Agg: h.agg(), IncidentID: parked.Outcome.IncidentID, Actor: ports.Actor{UserID: 9, DisplayName: "管理员"}, Note: "已排查"})
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if changesetHasNotifyEvent(rd.Changeset, "TASK_ASSIGNED") {
		t.Fatal("停驻节点 n5 的 on_assigned=false 不该发")
	}
	h.rawCommit(rd.Changeset)
}

// ═══ 渠道摊平：节点配了子集渠道，载荷原样携带 ═══

func TestNotify_Channels_ConfiguredSubsetPropagatesToPayload(t *testing.T) {
	c := withNodeNotify(f1(), "n1", `{"channels":["system","email"]}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	p := lastNotify(t, h)
	wantEqual(t, "channels", fmt.Sprint(p["channels"]), "[system email]")
}

// ═══ 新增事件：被终止═══

// 管理员终止时，手上还有未完成任务的人（王芳，n1 的 PENDING 任务）收到 INSTANCE_TERMINATED；
// 默认（发起节点没配 notify）照发。
func TestNotify_Terminate_OnTerminated_Default(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	d, err := h.eng.Terminate(h.ctx(), core.TerminateInput{AppID: appID, Agg: agg, Actor: admin, Reason: "违规单据"})
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	h.rawCommit(d.Changeset)
	if !hasNotifyEvent(h, "INSTANCE_TERMINATED") {
		t.Fatal("默认应照发 INSTANCE_TERMINATED")
	}
	p := lastNotify(t, h)
	wantEqual(t, "event", p["event"], "INSTANCE_TERMINATED")
	wantEqual(t, "recipients", fmt.Sprint(p["recipient_user_ids"]), fmt.Sprintf("[%d]", wangFang.UserID))
}

// 发起节点关掉 on_terminated：管理员终止不发。
func TestNotify_Terminate_OnTerminated_Off(t *testing.T) {
	c := withNodeNotify(f1(), "n0", `{"on_terminated":false}`)
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	d, err := h.eng.Terminate(h.ctx(), core.TerminateInput{AppID: appID, Agg: agg, Actor: admin})
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	h.rawCommit(d.Changeset)
	if hasNotifyEvent(h, "INSTANCE_TERMINATED") {
		t.Fatal("on_terminated=false 不该发")
	}
}

// ForceEnd 被子流程处置复用的那条路径不经过 Terminate，不该发
// INSTANCE_TERMINATED——直调 core.ForceEnd（不经管理员终止）验证这一点。
func TestNotify_ForceEndViaSubflowDisposition_DoesNotNotifyTerminated(t *testing.T) {
	h := newHarness(t, f1())
	h.mustStart(starter, core.Choices{})
	agg := h.agg()
	d, err := h.eng.ForceEnd(agg, "父流程结束，强制处置子流程", ports.Actor{})
	if err != nil {
		t.Fatalf("force end: %v", err)
	}
	if d == nil {
		t.Fatal("实例仍在跑，ForceEnd 不该返回 nil")
	}
	h.rawCommit(d.Changeset)
	if hasNotifyEvent(h, "INSTANCE_TERMINATED") {
		t.Fatal("ForceEnd 直调（子流程处置路径）不该发 INSTANCE_TERMINATED，那是 Terminate 专属")
	}
}

// ═══ 旧编译产物兼容 ═══

// 手写一份「旧编译产物」JSON：节点对象里压根没有 notify_json 键（模拟节点级通知之前落库的
// compiled_json，而不是依赖 Go 结构体零值——更贴近真实的旧字节）。解码后到达办理节点必须照发
// NOTIFY、渠道默认仅 system。
func TestNotify_LegacyCompiledJSONWithoutNotifyField_DefaultsOnSystem(t *testing.T) {
	raw := `{
		"start_node_id": "n0",
		"serial_field_id": "f-no",
		"nodes": [
			{"node_id": "n0", "node_kind": "START", "node_name": "发起", "no_route_hint": "无路可走", "target_template_id": "tpl-1", "allow_manual_start": true},
			{"node_id": "n1", "node_kind": "HANDLE", "node_name": "部门审批", "no_route_hint": "审批后没有可走的路线", "pass_rule": "ANY", "pass_ratio": 100, "static_user_ids": [22]},
			{"node_id": "n2", "node_kind": "END", "node_name": "结束", "end_label": "已通过"}
		],
		"links": [
			{"link_id": "l1", "from_node_id": "n0", "to_node_id": "n1", "is_main": true},
			{"link_id": "l2", "from_node_id": "n1", "to_node_id": "n2", "is_main": true}
		]
	}`
	c, err := compile.Decode([]byte(raw))
	if err != nil {
		t.Fatalf("decode legacy compiled_json: %v", err)
	}
	for _, nc := range c.Nodes {
		if nc.NotifyJSON != "" {
			t.Fatalf("夹具本身不该带 notify_json，测的就是它缺席的情况：%+v", nc)
		}
	}
	h := newHarness(t, c)
	h.mustStart(starter, core.Choices{})
	if !hasNotifyEvent(h, "TASK_ASSIGNED") {
		t.Fatal("旧编译产物（没有 notify_json）到达办理节点应照发 TASK_ASSIGNED")
	}
	p := lastNotify(t, h)
	wantEqual(t, "channels", fmt.Sprint(p["channels"]), "[system]")
}
