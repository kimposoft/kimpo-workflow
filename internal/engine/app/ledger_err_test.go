package engineapp

import (
	"errors"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// TestLedgerErrKeepsHostRejectionCode 宿主具名拒绝（例如官方定义的子流程指向第三方引擎的定义，Commit 拒
// WORKFLOW_SUBFLOW_CROSS_ENGINE）原样回给网关，不折成 SYSTEM_ERROR（否则网关会报 500）。
func TestLedgerErrKeepsHostRejectionCode(t *testing.T) {
	err := ledgerErr(&ports.HostRejection{Code: "WORKFLOW_SUBFLOW_CROSS_ENGINE", Message: "WORKFLOW_SUBFLOW_CROSS_ENGINE: node n_sub target exdef_1"})
	var ce *core.Error
	if !errors.As(err, &ce) || ce.Code != "WORKFLOW_SUBFLOW_CROSS_ENGINE" {
		t.Fatalf("want core.Error WORKFLOW_SUBFLOW_CROSS_ENGINE, got %#v", err)
	}
	if got := core.CodeOf(ledgerErr(errors.New("boom"))); got != "SYSTEM_ERROR" {
		t.Fatalf("plain error should stay SYSTEM_ERROR, got %q", got)
	}
}
