package core_test

import (
	"encoding/json"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// —— 辅助链上连着两个子流程节点，前一个的发起不能被后一个顶掉 ——
//
// 若 arrival 只有单槽位 subflowStart，continueAfterAuxiliary 沿辅助链继续走拿到下游到达结果后，
// 只在下游没有发起时才补上本节点自己的发起——sfA（不等待）继续走到 sfB（等待）时，sfB 自己也有
// 发起，sfA 那份就被静默丢弃：账本里 sfA 步骤 PASSED/LAUNCHED 却没有任何子实例与链接行。

// fSubflowChain 发起 → 部门审批（王芳）→ sfA（子流程，不等待，主表字段）→ sfB（子流程，等待，
// 扩展表两行）→ 结束；sfA 与 sfB 之间是主线，同一次提交里连着走。
func fSubflowChain(t *testing.T) *compile.CompiledDefinition {
	t.Helper()
	mapA, err := json.Marshal([]model.SubflowFieldMapping{{SourceFieldID: "f-amount", TargetFieldID: "f-child-amount"}})
	if err != nil {
		t.Fatal(err)
	}
	mapB, err := json.Marshal([]model.SubflowFieldMapping{{SourceTableID: "dt-items", SourceFieldID: "f-item-amount", TargetFieldID: "f-child-item-amount"}})
	if err != nil {
		t.Fatal(err)
	}
	return &compile.CompiledDefinition{
		StartNodeID: "n0", SerialFieldID: "f-no",
		Nodes: []compile.NodeCompiled{
			{NodeID: "n0", NodeKind: "START", NodeName: "发起", NoRouteHint: "无路可走", TargetTemplateID: "tpl-1", AllowManualStart: true},
			{NodeID: "n1", NodeKind: "HANDLE", NodeName: "部门审批", NoRouteHint: "没有可走的路线", PassRule: "ANY", PassRatio: 100, StaticUserIDs: []int64{22}},
			{NodeID: "sfA", NodeKind: "SUBFLOW", NodeName: "子流程A", SubflowTargetDefinitionID: "def-child", SubflowMappingsJSON: string(mapA), SubflowWait: false, SubflowDisposition: string(model.SubflowDispositionIgnore)},
			{NodeID: "sfB", NodeKind: "SUBFLOW", NodeName: "子流程B", SubflowTargetDefinitionID: "def-child", SubflowMappingsJSON: string(mapB), SubflowWait: true, SubflowDisposition: string(model.SubflowDispositionIgnore)},
			{NodeID: "n2", NodeKind: "END", NodeName: "结束", EndLabel: "已通过"},
		},
		Links: []compile.LinkCompiled{
			{LinkID: "l1", FromNodeID: "n0", ToNodeID: "n1", IsMain: true},
			{LinkID: "l2", FromNodeID: "n1", ToNodeID: "sfA", IsMain: true},
			{LinkID: "l3", FromNodeID: "sfA", ToNodeID: "sfB", IsMain: true},
			{LinkID: "l4", FromNodeID: "sfB", ToNodeID: "n2", IsMain: true},
		},
	}
}

// TestSubflowChain_BothNodesPendingStarts：纯状态机判据——两个子流程节点连着走，
// Decision.PendingSubflowStarts 长度必须是 2，且顺序 sfA 在前（先到达先发起），sfB 在后
// 且带着它的等待档与两行扩展表算出来的两组参数。
func TestSubflowChain_BothNodesPendingStarts(t *testing.T) {
	h := newHarness(t, fSubflowChain(t))
	h.mustStart(starter, core.Choices{})

	h.rec.MainValues = []ports.FieldValue{{FieldID: "f-amount", TextValue: "500"}}
	h.rec.DetailRows = map[string][]ports.DetailRow{"dt-items": {
		{RecordID: "row-1", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "100"}}},
		{RecordID: "row-2", Values: []ports.FieldValue{{FieldID: "f-item-amount", TextValue: "200"}}},
	}}

	d, err := h.submit(wangFang, core.Choices{})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if len(d.PendingSubflowStarts) != 2 {
		t.Fatalf("want 2 pending subflow starts (sfA + sfB), got %d: %+v", len(d.PendingSubflowStarts), d.PendingSubflowStarts)
	}
	sfA, sfB := d.PendingSubflowStarts[0], d.PendingSubflowStarts[1]
	if sfA.NodeID != "sfA" || sfA.Wait || len(sfA.Params) != 1 {
		t.Fatalf("sfA (first, not-waiting, 1 param) = %+v", sfA)
	}
	if sfB.NodeID != "sfB" || !sfB.Wait || len(sfB.Params) != 2 {
		t.Fatalf("sfB (second, waiting, 2 params — one per detail row) = %+v", sfB)
	}

	// sfB 是等待档：本次提交之后流程停在 sfB（它持有单令牌），不会越过它走到结束节点；
	// sfA 不等待，没有留下任何当前站的痕迹，只在 PendingSubflowStarts 里出现过一次。
	agg := h.agg()
	if agg.GetInstance().GetCurrentNodeId() != "sfB" {
		t.Fatalf("current node = %s, want sfB (waiting subflow node holds the token)", agg.GetInstance().GetCurrentNodeId())
	}
}

// —— SUBFLOW_STARTED 载荷必须带通用信封，否则宿主投影通用轨道解码报错 ——
//
// SUBFLOW_STARTED 不是 NOTIFY / CC_SENT 那种独立轨道，它落的是宿主投影通用轨道，因此载荷必须
// 携带与其余状态类发件箱行同一份通用信封（至少 record_id 与 workflow_instance_id，宿主解码就靠
// 这两项校验），否则整行 FAILED、还会挡住该实例之后的状态行投影（宿主日志表现为
// outbox payload lacks record_id / workflow_instance_id）。

// TestSubflowStarted_PayloadCarriesGenericEnvelope：CommitLinks 追加的 SUBFLOW_STARTED 发件箱
// 行必须带 record_id / workflow_instance_id（与其余状态类发件箱行同款通用信封），items 之外。
func TestSubflowStarted_PayloadCarriesGenericEnvelope(t *testing.T) {
	h := newHarness(t, f1()) // 文档内容不重要，CommitLinks 只读 agg.Instance，不碰编译产物。
	agg := &pb.InstanceAggregate{
		Instance: &pb.InstanceRow{
			WorkflowInstanceId: "inst-parent", RecordId: "rec-p", TemplateId: "tpl-1", DefinitionId: "def-1",
			Status: "RUNNING", Version: 3, CurrentStepId: "step-sf", CurrentNodeId: "sfA", CurrentNodeName: "子流程A",
		},
	}
	links := []*pb.LinkRow{{LinkId: "link-1", ParentStepId: "step-sf", ChildWorkflowInstanceId: "inst-child", ChildDefinitionId: "def-child", WaitMode: "NO_WAIT"}}

	d := h.eng.CommitLinks(agg, links)

	var found *pb.OutboxRow
	for _, o := range d.Changeset.GetOutboxAppends() {
		if o.GetKind() == "SUBFLOW_STARTED" {
			found = o
		}
	}
	if found == nil {
		t.Fatalf("no SUBFLOW_STARTED outbox row: %+v", d.Changeset.GetOutboxAppends())
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(found.GetPayloadJson()), &payload); err != nil {
		t.Fatalf("payload not JSON: %s (%v)", found.GetPayloadJson(), err)
	}
	if payload["record_id"] != "rec-p" || payload["workflow_instance_id"] != "inst-parent" {
		t.Fatalf("payload missing generic envelope (record_id / workflow_instance_id): %s", found.GetPayloadJson())
	}
	if _, ok := payload["items"]; !ok {
		t.Fatalf("payload missing items: %s", found.GetPayloadJson())
	}
}
