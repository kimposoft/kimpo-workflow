package grpc

import (
	"testing"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"

	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// TestTransport_OutcomeMapping：outcomeToPB 六种 core.OutcomeKind 都要落到 engine.v1
// ActionOutcome 对应的 oneof 分支，且分支里每个字段都要搬过去。
func TestTransport_OutcomeMapping(t *testing.T) {
	t.Run("Committed", func(t *testing.T) {
		res := &engineapp.Result{
			Outcome:         core.Outcome{Kind: core.OutcomeCommitted, WorkflowInstanceID: "inst-1", StepID: "step-1", Status: "RUNNING", EndLabel: "已通过"},
			InstanceVersion: 3, Replayed: true,
		}
		out := outcomeToPB(res).GetCommitted()
		if out == nil {
			t.Fatalf("want Committed branch, got %+v", outcomeToPB(res))
		}
		if out.GetWorkflowInstanceId() != "inst-1" || out.GetStepId() != "step-1" || out.GetStatus() != "RUNNING" ||
			out.GetEndLabel() != "已通过" || out.GetInstanceVersion() != 3 || !out.GetReplayed() {
			t.Fatalf("Committed = %+v", out)
		}
	})

	t.Run("RouteChoiceRequired", func(t *testing.T) {
		res := &engineapp.Result{Outcome: core.Outcome{
			Kind: core.OutcomeRouteChoiceRequired, FromNodeID: "n1",
			Routes: []core.RouteOption{{LinkID: "l1", ToNodeID: "n2", ToNodeName: "结束"}, {LinkID: "l2", ToNodeID: "n3", ToNodeName: "驳回"}},
		}}
		out := outcomeToPB(res).GetRouteChoiceRequired()
		if out == nil {
			t.Fatalf("want RouteChoiceRequired branch, got %+v", outcomeToPB(res))
		}
		if out.GetFromNodeId() != "n1" || len(out.GetOptions()) != 2 {
			t.Fatalf("RouteChoiceRequired = %+v", out)
		}
		if opt := out.GetOptions()[0]; opt.GetLinkId() != "l1" || opt.GetToNodeId() != "n2" || opt.GetToNodeName() != "结束" {
			t.Fatalf("option[0] = %+v", opt)
		}
	})

	t.Run("AssigneeChoiceRequired", func(t *testing.T) {
		res := &engineapp.Result{Outcome: core.Outcome{
			Kind: core.OutcomeAssigneeChoiceRequired, NodeID: "n3", NodeName: "财务复核", ViaLinkID: "l2",
			Candidates: []ports.Person{{UserID: 22, DisplayName: "王芳", Notes: []string{"直属主管"}}},
		}}
		out := outcomeToPB(res).GetAssigneeChoiceRequired()
		if out == nil {
			t.Fatalf("want AssigneeChoiceRequired branch, got %+v", outcomeToPB(res))
		}
		if out.GetNodeId() != "n3" || out.GetNodeName() != "财务复核" || out.GetViaLinkId() != "l2" || len(out.GetCandidates()) != 1 {
			t.Fatalf("AssigneeChoiceRequired = %+v", out)
		}
		if c := out.GetCandidates()[0]; c.GetUserId() != 22 || c.GetDisplayName() != "王芳" || len(c.GetSourceNotes()) != 1 || c.GetSourceNotes()[0] != "直属主管" {
			t.Fatalf("candidate[0] = %+v", c)
		}
	})

	t.Run("NoRoute", func(t *testing.T) {
		res := &engineapp.Result{Outcome: core.Outcome{Kind: core.OutcomeNoRoute, Hint: "无路可走", Saved: true}}
		out := outcomeToPB(res).GetNoRoute()
		if out == nil || out.GetHint() != "无路可走" || !out.GetSaved() {
			t.Fatalf("NoRoute = %+v", out)
		}
	})

	t.Run("NoCandidate", func(t *testing.T) {
		res := &engineapp.Result{Outcome: core.Outcome{Kind: core.OutcomeNoCandidate, Saved: true}}
		out := outcomeToPB(res).GetNoCandidate()
		if out == nil || !out.GetSaved() {
			t.Fatalf("NoCandidate = %+v", out)
		}
	})

	t.Run("Parked", func(t *testing.T) {
		res := &engineapp.Result{Outcome: core.Outcome{Kind: core.OutcomeParked, IncidentID: "inc-1"}}
		out := outcomeToPB(res).GetParked()
		if out == nil || out.GetIncidentId() != "inc-1" {
			t.Fatalf("Parked = %+v", out)
		}
	})

	// nil 输入安全：不 panic，回一个没有任何分支置位的空 ActionOutcome。
	t.Run("NilResult", func(t *testing.T) {
		out := outcomeToPB(nil)
		if out == nil {
			t.Fatalf("outcomeToPB(nil) must not return nil")
		}
		if _, ok := out.GetOutcome().(*workflowenginev1.ActionOutcome_Committed); ok {
			t.Fatalf("nil result must not synthesize a Committed branch")
		}
	})
}
