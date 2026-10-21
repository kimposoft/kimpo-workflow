package engineapp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/observability"
)

// 幂等前置：决策之前先按 (app_id, request_key) 查宿主请求日志，命中且摘要 /
// 操作人都一致就直接回放首次结果，不再重新装载聚合、不再重新决策；命中但摘要或操作人不同，说明同一个
// 请求键被配了不同的内容（不同的选路 / 选人 / 请求体），按请求键复用拒绝，不静默吞掉。

// requestDigest 意图摘要（sha256 hex）：动作类型 + 目标 id + 选择项 + 操作人 + 请求体要点，
// 不含时钟与随机 id（避免同一次业务意图因为重试时钟不同而摘要不同）。extra 里的 key 由
// encoding/json 按字典序序列化，保证同一组内容摘要恒定。
func requestDigest(action, target string, actorUserID int64, extra map[string]any) string {
	raw, _ := json.Marshal(struct {
		Action string         `json:"action"`
		Target string         `json:"target"`
		Actor  int64          `json:"actor"`
		Extra  map[string]any `json:"extra,omitempty"`
	}{Action: action, Target: target, Actor: actorUserID, Extra: extra})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// uniqSortedInt64 去重 + 排序（选人 selected_assignees 纳入摘要前先归一，避免顺序不同致摘要不同）。
func uniqSortedInt64(ids []int64) []int64 {
	seen := map[int64]bool{}
	var out []int64
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// requestKeyReusedErr 同一 request_key 配了不同摘要 / 不同操作人。
func requestKeyReusedErr(requestKey string) error {
	return &core.Error{Code: "INVALID_ARGUMENT", Message: "REQUEST_KEY_REUSED: request_key " + requestKey + " was already committed with different content"}
}

// replayCheck 幂等前置：按 (app_id, request_key) 查宿主请求日志。action 只用来记日志（关键位置
// 分级上报），不参与判定——判定完全靠 digest（已经把 action 编码进去了）。
//   - 未命中：(nil, false, nil)，调用方照常装载 / 决策。
//   - 命中且摘要与操作人都一致：(found, true, nil)，调用方直接回放 found.OutcomeJSON，不再装载 / 决策
//     （记 info 日志）。
//   - 命中但摘要或操作人不同：(nil, false, requestKeyReusedErr)（记 error 日志——
//     请求键复用不是正常业务流程会遇到的情况，warn 级不足以引起重视）。
func (s *Service) replayCheck(ctx context.Context, meta Meta, action, digest string) (*ports.CommittedRequest, bool, error) {
	found, err := s.Ledger.FindCommit(ctx, meta.AppID, meta.RequestKey)
	if err != nil {
		return nil, false, ledgerErr(err)
	}
	if found == nil {
		return nil, false, nil
	}
	if found.RequestDigest != digest || found.ActorUserID != meta.Actor.UserID {
		observability.Logger(ctx).Error(ctx, "workflow", "engine", "workflow.engine.request_key_reused",
			"request_key reused with different content", map[string]any{"request_key": meta.RequestKey, "action": action, "actor_user_id": meta.Actor.UserID})
		return nil, false, requestKeyReusedErr(meta.RequestKey)
	}
	observability.Logger(ctx).Info(ctx, "workflow", "engine", "workflow.engine.replay",
		"replayed a previously committed request", map[string]any{"request_key": meta.RequestKey, "action": action})
	return found, true, nil
}

// decodeInstanceReplay 把请求日志里的 outcome_json 还原成实例动作的 Result（Replayed=true）。
func decodeInstanceReplay(found *ports.CommittedRequest) *Result {
	var outcome core.Outcome
	_ = json.Unmarshal([]byte(found.OutcomeJSON), &outcome)
	return &Result{Outcome: outcome, InstanceVersion: found.InstanceVersion, Replayed: true}
}
