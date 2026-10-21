package engineapp

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// 同一个字段既是审批绑定字段、又在「回退时清空」清单里时，摊平出来的一次写入里
// 该字段只能出现一次（宿主保存链按重复字段整单拒绝），且留下的是「后写入」的审批值。
// 复现云端「采购入库 R20260921015」：理由绑定字段 = 回退时清空字段 = 备注。

// fieldCounts 统计一次写入里每个字段出现的次数。
func fieldCounts(writes []ports.FieldWrite) map[string]int {
	out := map[string]int{}
	for _, w := range writes {
		out[w.FieldID]++
	}
	return out
}

// writeOf 取某字段那一条写入；没有或不止一条都算失败。
func writeOf(t *testing.T, writes []ports.FieldWrite, fieldID string) ports.FieldWrite {
	t.Helper()
	var hit []ports.FieldWrite
	for _, w := range writes {
		if w.FieldID == fieldID {
			hit = append(hit, w)
		}
	}
	if len(hit) != 1 {
		t.Fatalf("字段 %s 应当恰好出现一次，实得 %d 次：%+v", fieldID, len(hit), writes)
	}
	return hit[0]
}

func TestPendingWrites_ReasonFieldAlsoInClearList_WriteWins(t *testing.T) {
	d := &core.Decision{
		PendingApproveWrite: &core.ApproveWrite{ReasonFieldID: "f-remark", Reason: "内容不够完整，做个详细说明"},
		PendingClearWrite: &core.ClearWrite{Fields: []model.ClearOnWithdrawField{
			{TableID: "t-main", FieldID: "f-remark"},
			{TableID: "t-main", FieldID: "f-amount"},
		}},
	}
	writes, reason := pendingWrites(d)
	for id, n := range fieldCounts(writes) {
		if n != 1 {
			t.Fatalf("字段 %s 在一次写入里出现 %d 次，宿主会按重复字段拒绝：%+v", id, n, writes)
		}
	}
	remark := writeOf(t, writes, "f-remark")
	if remark.Clear || remark.TextValue != "内容不够完整，做个详细说明" {
		t.Fatalf("重叠字段应当落下审批意见（先清空后写入），实得 %+v", remark)
	}
	if amount := writeOf(t, writes, "f-amount"); !amount.Clear {
		t.Fatalf("不重叠的字段照常清空，实得 %+v", amount)
	}
	// 先清空、后写入：清空段排在审批写入之前。
	if !writes[0].Clear || writes[len(writes)-1].FieldID != "f-remark" {
		t.Fatalf("次序应为先清空后写入，实得 %+v", writes)
	}
	if reason != approveCommentOnly {
		t.Fatalf("写入原因应为 %s，实得 %s", approveCommentOnly, reason)
	}
}

func TestPendingWrites_ResultFieldAlsoInClearList_WriteWins(t *testing.T) {
	d := &core.Decision{
		PendingApproveWrite: &core.ApproveWrite{ResultFieldID: "f-result", ResultTag: "rejected"},
		PendingClearWrite:   &core.ClearWrite{Fields: []model.ClearOnWithdrawField{{TableID: "t-main", FieldID: "f-result"}}},
	}
	writes, reason := pendingWrites(d)
	if len(writes) != 1 {
		t.Fatalf("应当只剩一条写入，实得 %+v", writes)
	}
	if w := writes[0]; w.Clear || w.TextValue != "rejected" {
		t.Fatalf("重叠字段应当落下结果标识，实得 %+v", w)
	}
	if reason != approveWriteReason {
		t.Fatalf("写入原因应为 %s，实得 %s", approveWriteReason, reason)
	}
}

// 没填理由时引擎不组装理由写入（approveWriteOf 的既有口径）——重叠字段这次没有要写的值，
// 照常被清空。
func TestPendingWrites_NoReasonThisTime_OverlapFieldStillCleared(t *testing.T) {
	d := &core.Decision{
		PendingClearWrite: &core.ClearWrite{Fields: []model.ClearOnWithdrawField{{TableID: "t-main", FieldID: "f-remark"}}},
	}
	writes, reason := pendingWrites(d)
	if w := writeOf(t, writes, "f-remark"); !w.Clear {
		t.Fatalf("本次没有审批写入时该字段按清空处理，实得 %+v", w)
	}
	if reason != clearOnBackReason {
		t.Fatalf("写入原因应为 %s，实得 %s", clearOnBackReason, reason)
	}
}

// 不重叠的配置：两段各自照旧，一条不少。
func TestPendingWrites_NoOverlap_Unchanged(t *testing.T) {
	d := &core.Decision{
		PendingApproveWrite: &core.ApproveWrite{ResultFieldID: "f-result", ResultTag: "rejected", ReasonFieldID: "f-reason", Reason: "退回重填"},
		PendingClearWrite:   &core.ClearWrite{Fields: []model.ClearOnWithdrawField{{TableID: "t-main", FieldID: "f-amount"}}},
	}
	writes, reason := pendingWrites(d)
	if len(writes) != 3 {
		t.Fatalf("应当三条写入，实得 %+v", writes)
	}
	if !writeOf(t, writes, "f-amount").Clear || writeOf(t, writes, "f-result").TextValue != "rejected" || writeOf(t, writes, "f-reason").TextValue != "退回重填" {
		t.Fatalf("不重叠时各写各的，实得 %+v", writes)
	}
	if reason != approveWriteReason {
		t.Fatalf("写入原因应为 %s，实得 %s", approveWriteReason, reason)
	}
}
