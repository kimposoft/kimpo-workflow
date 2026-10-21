package core

import (
	"context"
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// namedCandidate 按静态用户 id 回带姓名的候选假体（生产里宿主 CandidateService 就是这么回的）。
type namedCandidate map[int64]string

func (n namedCandidate) Resolve(_ context.Context, _ ports.RecordRef, ids []int64, _ string, _ []int64) ([]ports.Person, error) {
	var out []ports.Person
	for _, id := range ids {
		out = append(out, ports.Person{UserID: id, DisplayName: n[id]})
	}
	return out, nil
}

// TestResumeSubflowSubmitter 事故恢复重新发起子流程时发起人的三档取值：
// 恢复点里记的优先；存量事故没记的退回子流程步骤的进入人（姓名借候选端口解析）；都取不到返回
// 零值（app 层退回本次操作人）。
func TestResumeSubflowSubmitter(t *testing.T) {
	l := &loaded{agg: &pb.InstanceAggregate{Steps: []*pb.StepRow{
		{StepId: "step-human", EnteredByUserId: 22},
		{StepId: "step-system", EnteredByUserId: 0},
	}}}
	e := &Engine{Candidate: namedCandidate{22: "王芳"}}
	ctx := context.Background()

	got := e.resumeSubflowSubmitter(ctx, l, resumePoint{StepID: "step-human", SubmitterUserID: 7, SubmitterName: "李雷", SubmitterSuperAdmin: true})
	if got != (ports.Actor{UserID: 7, DisplayName: "李雷", SuperAdmin: true}) {
		t.Fatalf("resume point must win, got %+v", got)
	}
	got = e.resumeSubflowSubmitter(ctx, l, resumePoint{StepID: "step-human"})
	if got != (ports.Actor{UserID: 22, DisplayName: "王芳"}) {
		t.Fatalf("legacy incident must fall back to the step's entered-by user with a resolved name, got %+v", got)
	}
	got = (&Engine{}).resumeSubflowSubmitter(ctx, l, resumePoint{StepID: "step-human"})
	if got != (ports.Actor{UserID: 22}) {
		t.Fatalf("name resolution is best effort, id must still come back, got %+v", got)
	}
	for _, stepID := range []string{"step-system", "step-missing"} {
		if got = e.resumeSubflowSubmitter(ctx, l, resumePoint{StepID: stepID}); got != (ports.Actor{}) {
			t.Fatalf("%s: want zero actor so the app layer falls back to the caller, got %+v", stepID, got)
		}
	}
}
