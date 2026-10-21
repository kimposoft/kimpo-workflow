package core

import (
	"errors"
	"fmt"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// TestIncidentReasonCode 事故原因码归类：错误被 %w 包过一层
// 之后仍要认得出来——app 层 launchSubflowStart 给每个环节的错误都包了前缀。
func TestIncidentReasonCode(t *testing.T) {
	wrap := func(err error) error { return fmt.Errorf("start subflow instance: %w", err) }
	cases := []struct {
		name          string
		err           error
		subflowLaunch bool
		want          string
	}{
		{"nil", nil, true, ""},
		{"rejection_with_subcode", wrap(&ports.RecordWriteRejection{SubCode: "REQUIRED_FIELD_MISSING", Message: "RECORD_WRITE_REJECTED: x"}), true, "RECORD_WRITE_REJECTED:REQUIRED_FIELD_MISSING"},
		{"rejection_without_subcode", wrap(&ports.RecordWriteRejection{Message: "RECORD_WRITE_REJECTED: x"}), true, "RECORD_WRITE_REJECTED"},
		{"rejection_bare_sentinel", wrap(fmt.Errorf("%w: legacy", ports.ErrRecordWriteRejected)), false, "RECORD_WRITE_REJECTED"},
		{"no_instance_assignee_choice", &SubflowNoInstanceError{Outcome: OutcomeAssigneeChoiceRequired}, true, "SUBFLOW_ASSIGNEE_CHOICE_REQUIRED"},
		{"no_instance_route_choice", &SubflowNoInstanceError{Outcome: OutcomeRouteChoiceRequired}, true, "SUBFLOW_ROUTE_CHOICE_REQUIRED"},
		{"no_instance_no_route", &SubflowNoInstanceError{Outcome: OutcomeNoRoute}, true, "SUBFLOW_NO_ROUTE"},
		{"no_instance_no_candidate", &SubflowNoInstanceError{Outcome: OutcomeNoCandidate}, true, "SUBFLOW_NO_CANDIDATE"},
		{"no_instance_unexpected_outcome", &SubflowNoInstanceError{Outcome: OutcomeCommitted}, true, "SYSTEM_ERROR"},
		{"engine_definition_disabled", wrap(errf("DEFINITION_DISABLED", "definition d1 is disabled")), true, "DEFINITION_DISABLED"},
		{"engine_candidate_failed", wrap(errf("CANDIDATE_FAILED", "boom")), true, "CANDIDATE_FAILED"},
		{"engine_code_outside_whitelist", wrap(errf("INVALID_ARGUMENT", "mismatch")), true, "SYSTEM_ERROR"},
		{"engine_not_found_on_subflow", wrap(errf("NOT_FOUND", "definition not found")), true, "SUBFLOW_TARGET_NOT_FOUND"},
		{"ports_not_found_on_subflow", fmt.Errorf("get target definition d1: %w", ports.ErrNotFound), true, "SUBFLOW_TARGET_NOT_FOUND"},
		{"ports_not_found_on_field_write", wrap(ports.ErrNotFound), false, "SYSTEM_ERROR"},
		{"ports_system", wrap(ports.ErrSystem), true, "SYSTEM_ERROR"},
		{"plain_error", errors.New("launch service is not wired"), true, "SYSTEM_ERROR"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := incidentReasonCode(c.err, c.subflowLaunch); got != c.want {
				t.Fatalf("want %q, got %q", c.want, got)
			}
		})
	}
}

// TestSubflowNoInstanceError_Message 错误原文在没有节点名 / 提示语时要与此前 fmt.Errorf 的写法
// 逐字一致（它原样落进事故行 error_message，存量排障经验与日志检索都按这句话找）；有则追加在后。
func TestSubflowNoInstanceError_Message(t *testing.T) {
	got := (&SubflowNoInstanceError{Outcome: OutcomeAssigneeChoiceRequired}).Error()
	if want := "subflow start produced no instance, outcome=ASSIGNEE_CHOICE_REQUIRED"; got != want {
		t.Fatalf("want %q, got %q", want, got)
	}
	got = (&SubflowNoInstanceError{Outcome: OutcomeNoRoute, NodeName: "经理审批", Hint: "金额超限"}).Error()
	if want := `subflow start produced no instance, outcome=NO_ROUTE, node="经理审批", hint="金额超限"`; got != want {
		t.Fatalf("want %q, got %q", want, got)
	}
}
