package core

import (
	"testing"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// D1 分母是本步选中的办理人数；D 两档判定：任一人即过 / 按比例达标才过。
func TestD1_PassedEnough(t *testing.T) {
	cases := []struct {
		name         string
		rule         string
		ratio        int32
		passed       int32
		assignee     int32
		wantPassed   bool
		whyItMatters string
	}{
		{"任一人：第一个通过即过", string(model.PassRuleAny), 100, 1, 3, true, "任一档不看比例"},
		{"按比例 60%：三人里一人通过不过关", string(model.PassRuleRatio), 60, 1, 3, false, "100 < 180"},
		{"按比例 60%：三人里两人通过即过", string(model.PassRuleRatio), 60, 2, 3, true, "200 >= 180"},
		{"按比例 100%：三人全过才过", string(model.PassRuleRatio), 100, 2, 3, false, "200 < 300"},
		{"按比例缺省按 100%", string(model.PassRuleRatio), 0, 2, 3, false, "ratio<=0 视为 100"},
		{"选中 0 人：一律不过关", string(model.PassRuleRatio), 60, 1, 0, false, "空步骤不能凭空放行"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := passedEnough(c.rule, c.ratio, c.passed, c.assignee); got != c.wantPassed {
				t.Fatalf("passedEnough(%s,%d,%d,%d) = %v，want %v（%s）", c.rule, c.ratio, c.passed, c.assignee, got, c.wantPassed, c.whyItMatters)
			}
		})
	}
}

// D3 / D4 共用的「收掉同步其余未完成任务」：待办与暂存都要收，已完成与已撤销的不动，
// 保留的那一条不动；原因按调用方给的写（过关是 STEP_PASSED，整步回退是 STEP_RETURNED）。
func TestD3_CloseOtherOpenTasks(t *testing.T) {
	l := &loaded{agg: &pb.InstanceAggregate{Tasks: []*pb.TaskRow{
		{TaskId: "keep", StepId: "s1", Status: string(model.TaskStatusDone)},
		{TaskId: "pending", StepId: "s1", Status: string(model.TaskStatusPending)},
		{TaskId: "saved", StepId: "s1", Status: string(model.TaskStatusSaved)},
		{TaskId: "already-withdrawn", StepId: "s1", Status: string(model.TaskStatusWithdrawn)},
		{TaskId: "other-step", StepId: "s2", Status: string(model.TaskStatusPending)},
	}}}
	changed := closeOtherOpenTasks(l, "s1", "keep", model.TaskWithdrawStepPassed, nil)
	got := map[string]string{}
	for _, t := range changed {
		got[t.GetTaskId()] = t.GetWithdrawReason()
	}
	if len(got) != 2 || got["pending"] != string(model.TaskWithdrawStepPassed) || got["saved"] != string(model.TaskWithdrawStepPassed) {
		t.Fatalf("应只收掉本步的待办与暂存两条，实得 %+v", got)
	}
}

// A5 上步处理人：取最近的人工步骤实际办过的所有人；自动步骤与辅助节点跳过；
// 一个都找不到时回落到传入的兜底（发起后的第一站就是发起人）。
func TestA5_PreviousHumanActors(t *testing.T) {
	agg := &pb.InstanceAggregate{
		Steps: []*pb.StepRow{
			{StepId: "s1", NodeKind: "START"},
			{StepId: "s2", NodeKind: "HANDLE"},
			{StepId: "s3", NodeKind: "CC"},
			{StepId: "s4", NodeKind: "HANDLE"}, // 自动办理的步骤：没有任何 DONE 任务
		},
		Tasks: []*pb.TaskRow{
			{TaskId: "t1", StepId: "s2", Status: string(model.TaskStatusDone), AssigneeUserId: 11},
			{TaskId: "t2", StepId: "s2", Status: string(model.TaskStatusDone), AssigneeUserId: 22},
			{TaskId: "t3", StepId: "s2", Status: string(model.TaskStatusWithdrawn), AssigneeUserId: 33},
		},
	}
	l := &loaded{agg: agg}

	got := previousHumanActors(l, nil, "s4", []int64{99})
	if len(got) != 2 || got[0] != 11 || got[1] != 22 {
		t.Fatalf("应回溯到 s2 的两名实际办理人 [11 22]，实得 %v（被撤销的 33 不算，抄送步骤跳过）", got)
	}

	// 发起之后的第一站：前面没有任何人工步骤办过 → 回落兜底（发起人）。
	first := previousHumanActors(&loaded{agg: &pb.InstanceAggregate{Steps: []*pb.StepRow{{StepId: "s1", NodeKind: "START"}}}}, nil, "s1", []int64{99})
	if len(first) != 1 || first[0] != 99 {
		t.Fatalf("找不到人工步骤时应回落兜底 [99]，实得 %v", first)
	}
}
