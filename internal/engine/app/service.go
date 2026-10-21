// Package engineapp 是流程引擎的应用服务层：
// 装载聚合 → core 决策 → 提交账本（CAS + request_key 幂等），VERSION_CONFLICT 时用新聚合重决策一次。
// 结束标识走两段式：先提交「停驻在结束节点、标识待写」占住实例版本，再写字段（宿主表单数据层），
// 成功提交第二段（RESOLVED + ENDED），失败 ParkAgain 留给管理员处理事故。
// transport 层只做 pb ↔ 本包入参 / 出参的翻译，不含业务判断。
package engineapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/observability"
)

// Service 应用服务；所有依赖显式注入（main.go 装配，单测用 testkit 假体）。
type Service struct {
	Ledger   ports.Ledger
	Record   ports.Record
	Engine   *core.Engine
	Compiler *compile.Compiler
	Clock    ports.Clock
	IDs      ports.IDGen
	// Launch 非人工发起通道的建单那一半（子流程）：commitLoop 在父实例提交
	// 成功之后，对 Decision.PendingSubflowStarts 逐个建单 + 发起子实例，就是靠它。
	Launch ports.Launch
	// Lease 编辑租约释放：改派提交成功之后，对 Decision.PendingLeaseRelease 调宿主
	// LeaseService.ReleaseEditLease；nil 时跳过释放只记 warn（生产装配必须注入，否则改派虽然
	// 生效，原办理人的编辑会话不会被打断——手感上像是「改派了但没生效」）。
	Lease ports.Lease
}

// Meta 一次调用的元信息（来自 RequestMeta）。
type Meta struct {
	AppID      string
	RequestKey string
	Actor      ports.Actor
	Locale     string
}

// Result 动作结果 + 提交信息。
type Result struct {
	Outcome         core.Outcome
	InstanceVersion int64
	// Replayed 同 request_key 重放：本次未写任何行。
	Replayed bool
}

// 写字段时给宿主表单数据层的原因码，与 host v1 FieldWrite 的 reason 枚举同名，
// 记录写入审计据此分辨这一笔是谁写的。
const (
	endWriteReason     = "END_LABEL"
	approveWriteReason = "APPROVE_RESULT"
	approveCommentOnly = "APPROVE_COMMENT"
	clearOnBackReason  = "CLEAR_ON_BACK"
)

// 两段式结束标识的派生请求键后缀：第二段（RESOLVED + ENDED）与写失败改判（ParkAgain）各自成一条
// 请求日志，重放时按主键命中停驻结果后再查派生键得到最终结果（replayResult）。
const (
	endPhaseKeySuffix  = ":end"
	parkPhaseKeySuffix = ":park"
)

func (s *Service) check(meta Meta) error {
	if s.Ledger == nil || s.Engine == nil {
		return core.SystemErrorf("engine service is not wired")
	}
	if meta.AppID == "" || meta.RequestKey == "" {
		return core.SystemErrorf("app_id and request_key are required")
	}
	return nil
}

// ledgerErr 把账本哨兵错误折成 core.Error（transport 统一按错误码映射）。
func ledgerErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ports.ErrNotFound):
		return &core.Error{Code: "NOT_FOUND", Message: err.Error()}
	case errors.Is(err, ports.ErrVersionConflict):
		return &core.Error{Code: "VERSION_CONFLICT", Message: err.Error()}
	case errors.Is(err, ports.ErrRecordHasInstance):
		return &core.Error{Code: "RECORD_ALREADY_HAS_INSTANCE", Message: err.Error()}
	case errors.Is(err, ports.ErrRequestKeyReused):
		// Commit 自己（宿主内部同事务的请求日志检查，⓪ 项）拒绝的请求键复用：engineapp 自己的
		// replayCheck 已经在决策之前查过一次，这里是 FindCommit → Commit 之间的极端竞态兜底
		// （别的并发请求用不同摘要抢先占了同一个键），同样折成 INVALID_ARGUMENT。
		return &core.Error{Code: "INVALID_ARGUMENT", Message: err.Error()}
	}
	if core.CodeOf(err) != "" {
		return err
	}
	// 宿主具名拒绝（跨引擎子流程、宿主依赖键 / 发件箱不合规等）把宿主的码原样带给网关。
	var rejected *ports.HostRejection
	if errors.As(err, &rejected) {
		return &core.Error{Code: rejected.Code, Message: rejected.Message}
	}
	return &core.Error{Code: "SYSTEM_ERROR", Message: err.Error()}
}

// execute 通用执行骨架：先按请求键查请求日志——命中就直接回放，不装载不决策；
// 未命中才 load → decide → 结束标识 → Commit（VERSION_CONFLICT 重试一次，重新 load / decide）。
func (s *Service) execute(ctx context.Context, meta Meta, action, digest string, load func(context.Context) (*pb.InstanceAggregate, error), decide func(*pb.InstanceAggregate) (*core.Decision, error)) (*Result, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	if found, hit, err := s.replayCheck(ctx, meta, action, digest); err != nil {
		return nil, err
	} else if hit {
		return s.replayResult(ctx, meta, found)
	}
	return s.commitLoop(ctx, meta, digest, load, decide)
}

// replayResult 回放已提交的结果；若首段结果是「停驻」且存在两段式的派生提交（:end 成功结束 /
// :park 写失败改判），以派生提交的结果为准——它才是这次请求最终落定的状态。
func (s *Service) replayResult(ctx context.Context, meta Meta, found *ports.CommittedRequest) (*Result, error) {
	res := decodeInstanceReplay(found)
	if res.Outcome.Kind != core.OutcomeParked || res.Outcome.IncidentID == "" {
		return res, nil
	}
	for _, suffix := range []string{endPhaseKeySuffix, parkPhaseKeySuffix} {
		derived, err := s.Ledger.FindCommit(ctx, meta.AppID, meta.RequestKey+suffix)
		if err != nil {
			return nil, ledgerErr(err)
		}
		if derived != nil {
			return decodeInstanceReplay(derived), nil
		}
	}
	return res, nil
}

// commitLoop 是 execute 去掉幂等前置之后的落地部分；Start 因为要先查定义 / 单据（不属于 load /
// decide 的范畴），自己做完 replayCheck 与前置校验后直接复用本函数，避免对同一个 request_key
// 打两次 FindCommit。
func (s *Service) commitLoop(ctx context.Context, meta Meta, digest string, load func(context.Context) (*pb.InstanceAggregate, error), decide func(*pb.InstanceAggregate) (*core.Decision, error)) (*Result, error) {
	for attempt := 0; ; attempt++ {
		var agg *pb.InstanceAggregate
		if load != nil {
			var err error
			agg, err = load(ctx)
			if err != nil {
				return nil, ledgerErr(err)
			}
		}
		d, err := decide(agg)
		if err != nil {
			return nil, ledgerErr(err)
		}
		if d == nil {
			// 状态机不应返回 nil 决策；防御：按系统错误处理，避免空指针。
			return nil, core.SystemErrorf("engine returned no decision")
		}
		if d.Changeset == nil {
			return &Result{Outcome: d.Outcome}, nil
		}
		// 审批结果与理由、回退清空字段，都要在提交状态变更**之前**写进单据并保存。
		// 写失败即整个动作失败、一行状态都不动——不留「字段写了一半、流程没走」的中间态。
		// （与结束标识那条两段式不同：那条写的是「已经走到结束之后」的字段，必须先占住实例版本；
		//   这两条写的是本步自己的单据字段，动作还没生效，失败直接回绝即可。）
		if err := s.writeBeforeCommit(ctx, meta, d); err != nil {
			return nil, err
		}
		twoPhase := d.PendingEndWrite != nil
		if twoPhase {
			if s.Record == nil {
				// 单据服务未装配：写不了，直接以事故停驻，不进两段式。
				d = s.Engine.ParkForEndWrite(d, fmt.Errorf("record service is not wired"))
				twoPhase = false
			} else {
				d = s.Engine.PrepareEndWrite(d)
			}
		}
		outcomeJSON, _ := json.Marshal(d.Outcome)
		result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON), Changeset: d.Changeset})
		if err != nil {
			if errors.Is(err, ports.ErrVersionConflict) && attempt == 0 && load != nil {
				observability.Logger(ctx).Info(ctx, "workflow", "engine", "workflow.engine.retry", "version conflict, retrying once", map[string]any{"request_key": meta.RequestKey})
				continue
			}
			return nil, ledgerErr(err)
		}
		if !result.Applied {
			// 重放：本次没有真的提交任何东西，Decision.PendingSubflowStarts 也不该再跑一遍
			// （子流程建单 / 发起没有做过，不能在回放路径上补做——回放的前提是「这次请求已经
			// 处理完了」，若上次处理到一半就崩溃，只能等管理员按事故处理，不在这里悄悄重试）。
			return s.replayResult(ctx, meta, &ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON, InstanceVersion: result.InstanceVersion})
		}
		// 本实例的变更集已经落库（result.Applied），此刻才发起 Decision 算出来的子流程。
		// 子实例是另一个实例，得走它自己的 Start + Commit；发起反复失败就把本实例改判停驻
		// （SUBFLOW_START_FAILED），已经成功发起的子实例不回滚。
		instanceID := d.Changeset.GetInstance().GetRow().GetWorkflowInstanceId()
		// 「不通过并结束流程」：变更集已落库，按级别上报宿主日志（谁点了哪个按钮、直达哪个结束节点、
		// 撤销了哪些人的待办）。放在提交成功之后，版本冲突重试与被拒的点击不会误记。
		if eb := d.EndedByButton; eb != nil {
			observability.Logger(ctx).Info(ctx, "workflow", "engine", "workflow.engine.approve.end_flow", "approval button ended the flow",
				map[string]any{"workflow_instance_id": eb.InstanceID, "step_id": eb.StepID, "task_id": eb.TaskID, "button_id": eb.ButtonID,
					"end_node_id": eb.EndNodeID, "actor_user_id": meta.Actor.UserID, "withdrawn_task_count": len(eb.WithdrawnTaskIDs),
					"withdrawn_task_ids": eb.WithdrawnTaskIDs, "two_phase_end_write": twoPhase})
		}
		var subflowResult *Result
		if len(d.PendingSubflowStarts) > 0 {
			res, err := s.runSubflowStarts(ctx, meta, instanceID, d.PendingSubflowStarts)
			if err != nil {
				return nil, err
			}
			subflowResult = res
		}
		// 本次回退把哪些子流程从时间线上抹掉了，逐个强制结束（删单据留缺口，
		// 见 core.SubflowCancel 注释）。失败只记 warn，不阻断本次回退——回退这边已经成功提交。
		if len(d.PendingSubflowCancels) > 0 {
			s.cancelSubflows(ctx, meta, d.PendingSubflowCancels)
		}
		// 改派成功后释放原办理人的编辑租约；失败只记 warn，不影响改派本身已经生效的结果。
		if d.PendingLeaseRelease != nil {
			s.releaseLease(ctx, meta, d.PendingLeaseRelease)
		}
		// 本实例这一次动作里就地结束（单段，没有走两段式）时，向下 / 向上传播子流程善后——
		// 两段式（twoPhase）此刻实例还没真的结束（停驻占位，见下方 finishEndWrite 那一半），
		// 不在这里传播。
		if !twoPhase && d.Outcome.Status == string(model.InstanceStatusEnded) {
			s.afterInstanceEnded(ctx, meta, instanceID)
		}
		if twoPhase {
			res, err := s.finishEndWrite(ctx, meta, d.Changeset.GetInstance().GetRow(), d.Outcome.IncidentID, d.PendingEndWrite)
			if err != nil {
				return nil, err
			}
			if subflowResult != nil {
				// 极少见的双停驻场景（不等待档发起失败，紧接着自己也走到了配了写入字段的结束
				// 节点）：以子流程失败的停驻结果为准，它是最后发生、也是需要管理员先处理的那个。
				return subflowResult, nil
			}
			return res, nil
		}
		if subflowResult != nil {
			return subflowResult, nil
		}
		return &Result{Outcome: d.Outcome, InstanceVersion: result.InstanceVersion}, nil
	}
}

// runSubflowStarts 逐个子流程节点地执行 Decision.PendingSubflowStarts；任一节点在发起过程中
// 停驻，立即停止（不再处理后面的节点）并把停驻结果交回调用方作为本次动作的最终结果。
func (s *Service) runSubflowStarts(ctx context.Context, meta Meta, parentInstanceID string, starts []core.SubflowStart) (*Result, error) {
	for _, start := range starts {
		res, err := s.launchSubflowStart(ctx, meta, parentInstanceID, start)
		if err != nil || res != nil {
			return res, err
		}
	}
	return nil, nil
}

// launchSubflowStart 一个子流程节点的全部子实例（Params 每组一个，扩展表几行就几个）：
// 逐个建单 → Start，全部成功后把链接行一次性追加到父实例；任一步失败即把父实例改判
// 停驻（SUBFLOW_START_FAILED），已经成功发起的子实例不回滚。返回非 nil *Result 表示已经
// 停驻，调用方应把它当作本次动作的最终结果；返回 (nil, nil) 表示这个节点顺利发完。
func (s *Service) launchSubflowStart(ctx context.Context, meta Meta, parentInstanceID string, start core.SubflowStart) (*Result, error) {
	if s.Launch == nil {
		return s.parkSubflowFailure(ctx, meta, parentInstanceID, start, fmt.Errorf("launch service is not wired"))
	}
	def, _, err := s.Ledger.GetDefinition(ctx, meta.AppID, start.TargetDefinitionID)
	if err != nil {
		return s.parkSubflowFailure(ctx, meta, parentInstanceID, start, fmt.Errorf("get target definition %s: %w", start.TargetDefinitionID, err))
	}
	// 子实例的发起人、目标单据的创建人一律是把父流程送到这个子流程节点的
	// 那位办理人（start.Submitter），不是「此刻在调用引擎的人」——两者在办理人正常提交时是同一个
	// 人，但管理员处理事故重新发起时调用者是管理员。取不到提交人（无人在场的系统推进）才退回
	// 本次动作的操作人。
	starter := meta.Actor
	if start.Submitter.UserID != 0 {
		starter = start.Submitter
	}
	links := make([]*pb.LinkRow, 0, len(start.Params))
	for i, params := range start.Params {
		// 建单与发起共用同一条派生键（幂等）：与本次顶层动作的 request_key 绑死，顶层动作本身
		// 已经在 commitLoop 前段做过重放拦截，正常重试根本到不了这里；这条派生键只是给
		// Launch.CreateRecord / Service.Start 各自内部的幂等机制一个稳定标识。
		derivedKey := fmt.Sprintf("%s:sub:%s:%d", meta.RequestKey, start.StepID, i)
		recordID, err := s.Launch.CreateRecord(ctx, meta.AppID, def.GetTemplateId(), params, starter, parentInstanceID, derivedKey)
		if err != nil {
			return s.parkSubflowFailure(ctx, meta, parentInstanceID, start, fmt.Errorf("create subflow record: %w", err))
		}
		// 非人工发起，子流程的发起人记为父流程的提交人（starter，见上）；不查目标流程的
		// 发起权限、「允许人工发起」关闭的流程也能被发起——Engine.Start 本身不校验这两条
		// （校验在宿主网关侧的人工发起入口），走这里天然绕过。
		childRes, err := s.Start(ctx, Meta{AppID: meta.AppID, RequestKey: derivedKey, Actor: starter, Locale: meta.Locale}, StartInput{
			DefinitionID: start.TargetDefinitionID,
			Record:       ports.RecordRef{RecordID: recordID},
			StartKind:    model.StartKindSubflow,
		})
		if err != nil {
			return s.parkSubflowFailure(ctx, meta, parentInstanceID, start, fmt.Errorf("start subflow instance: %w", err))
		}
		childID := childRes.Outcome.WorkflowInstanceID
		if childID == "" {
			// 子流程目标流程的发起节点选路 / 选人零命中、需要弹框等情形：没有形成实例，
			// 子流程没有人在场处理这些对话框，一律按发起失败处理。
			// 用带 Outcome 的类型化错误（文本不变），停驻事故据此记下是「要手选办理人」还是「无分支命中」等。
			return s.parkSubflowFailure(ctx, meta, parentInstanceID, start, &core.SubflowNoInstanceError{Outcome: childRes.Outcome.Kind, NodeName: childRes.Outcome.NodeName, Hint: childRes.Outcome.Hint})
		}
		links = append(links, &pb.LinkRow{
			LinkId: s.IDs.New("link"), ParentWorkflowInstanceId: parentInstanceID, ParentStepId: start.StepID,
			ChildWorkflowInstanceId: childID, ChildDefinitionId: start.TargetDefinitionID,
			WaitMode: string(model.LinkWaitModeOf(start.Wait)), OrphanPolicy: string(model.LinkOrphanPolicyOf(model.SubflowDisposition(start.Disposition))),
			ChildStatus: string(model.LinkChildStatusRunning),
		})
	}
	if len(links) == 0 {
		return nil, nil // 扩展表零行：core 层已经保证这种情形 Params 为空，不会走到这里
	}
	if err := s.commitLinks(ctx, meta, parentInstanceID, links); err != nil {
		return s.parkSubflowFailure(ctx, meta, parentInstanceID, start, fmt.Errorf("commit parent link: %w", err))
	}
	return nil, nil
}

// commitLinks 把这一节点新发起的链接行一次性追加到父实例（带 CAS，版本冲突重装载重试一次）。
func (s *Service) commitLinks(ctx context.Context, meta Meta, parentInstanceID string, links []*pb.LinkRow) error {
	suffix := ":link:" + links[0].GetParentStepId()
	_, err := s.commitWithReload(ctx, meta, parentInstanceID, suffix, "SUBFLOW_LINK", map[string]any{"step_id": links[0].GetParentStepId(), "count": len(links)},
		func(agg *pb.InstanceAggregate) (*core.Decision, error) { return s.Engine.CommitLinks(agg, links), nil })
	return err
}

// parkSubflowFailure 子流程发起在任一环节失败：记 error 日志 + 把父实例改判停驻。
// suffix 按节点步骤区分，避免同一动作里发起多个子流程节点时互相撞派生键。
func (s *Service) parkSubflowFailure(ctx context.Context, meta Meta, parentInstanceID string, start core.SubflowStart, cause error) (*Result, error) {
	observability.Logger(ctx).Error(ctx, "workflow", "engine", "workflow.engine.subflow_start_failed", "subflow start failed, instance parked",
		map[string]any{"workflow_instance_id": parentInstanceID, "node_id": start.NodeID, "step_id": start.StepID, "error": cause.Error()})
	suffix := ":subpark:" + start.StepID
	return s.commitWithReload(ctx, meta, parentInstanceID, suffix, "SUBFLOW_START_PARK", map[string]any{"step_id": start.StepID},
		func(agg *pb.InstanceAggregate) (*core.Decision, error) {
			return s.Engine.ParkSubflowStart(agg, start, cause), nil
		})
}

// commitWithReload 是「装载最新聚合 → 按它算一次 Decision → 派生键提交」的通用骨架，供子流程
// 全部「不是当前顶层动作主线、但要另开一次提交」的场合复用（子流程建单成功
// 后回写链接、发起失败停驻、子实例结束后回写链接与推进父流程……）。VERSION_CONFLICT 时重新
// 装载、用 build 重新算一遍再提交一次（与 commitLoop 同一策略，最多重试一次）。
// build 返回 (nil, nil) 表示这次不需要提交任何东西（调用方据此把 (nil, nil) 当作「无事可做」）。
func (s *Service) commitWithReload(ctx context.Context, meta Meta, instanceID, suffix, digestKind string, digestExtra map[string]any, build func(*pb.InstanceAggregate) (*core.Decision, error)) (*Result, error) {
	digest := requestDigest(digestKind, instanceID, meta.Actor.UserID, digestExtra)
	for attempt := 0; ; attempt++ {
		agg, err := s.Ledger.LoadInstanceByID(ctx, meta.AppID, instanceID)
		if err != nil {
			return nil, ledgerErr(err)
		}
		d, err := build(agg)
		if err != nil {
			return nil, err
		}
		if d == nil || d.Changeset == nil {
			return nil, nil
		}
		res, err := s.commitDerived(ctx, meta, suffix, digest, d)
		if err != nil {
			if core.CodeOf(err) == "VERSION_CONFLICT" && attempt == 0 {
				continue
			}
			return nil, err
		}
		return res, nil
	}
}

// systemActor 是子流程善后里全部「没有人在现场、由引擎自己推进」的系统动作的操作人身份
// （子实例结束回来推父流程、父流程结束强制结束子实例）：UserID=0 不对应任何真实用户，
// 流转明细 / 通知等消费方按「系统」展示。
var systemActor = ports.Actor{UserID: 0, DisplayName: "系统"}

// afterInstanceEnded 一个实例（不论是正常走到结束节点、事故恢复后结束、被回退到发起人
// 等等，还是本文件自己的 ForceEnd）在这一刻变成 ENDED 之后要做的两件事：
//   - 向下：把它自己发起、配了「强制结束」且尚未结束的「不等待」子实例强制结束；
//   - 向上：如果它自己是别人的子实例，通知那个父实例——可能会推着父实例往前走，
//     父实例因此也结束的话（嵌套子流程），递归再做一遍这两件事。
//
// 两步都只记 warn 日志、不向上抛错——本实例自己已经成功结束，不能因为「善后」失败而让这次
// 提交本身报错（用户看到的是自己那个动作成功了，子流程的连锁反应属于系统后台自愈的范畴）。
func (s *Service) afterInstanceEnded(ctx context.Context, meta Meta, instanceID string) {
	s.forceEndOrphanedChildren(ctx, meta, instanceID)
	s.propagateChildEnded(ctx, meta, instanceID)
}

// cancelSubflows 回退把这些子实例从时间线上抹掉了（链接已经在同一变更集里随回退一起删除），
// 逐个 ForceEnd——不是回滚，它已经跑过一段，只是不再需要了；删单据是缺口，宿主目前没有对应
// RPC，暂不处理。失败只记 warn，不阻断回退本身（回退那边已经成功提交）。
func (s *Service) cancelSubflows(ctx context.Context, meta Meta, cancels []core.SubflowCancel) {
	sysMeta := Meta{AppID: meta.AppID, RequestKey: meta.RequestKey, Actor: systemActor}
	for _, c := range cancels {
		res, err := s.commitWithReload(ctx, sysMeta, c.ChildInstanceID, ":cancelsubflow:"+c.NodeID, "SUBFLOW_CANCEL", map[string]any{"node_id": c.NodeID},
			func(a *pb.InstanceAggregate) (*core.Decision, error) {
				return s.Engine.ForceEnd(a, "BACK_CANCELLED", systemActor)
			})
		if err != nil {
			observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.subflow_cancel_failed", "cancel subflow on back failed",
				map[string]any{"child_instance_id": c.ChildInstanceID, "node_id": c.NodeID, "error": err.Error()})
			continue
		}
		if res != nil {
			// 一并善后：链接已经删了，propagateChildEnded 会落空静默跳过；若它自己也发起过
			// 子子流程（嵌套），forceEndOrphanedChildren 照样接手处置。
			s.afterInstanceEnded(ctx, meta, c.ChildInstanceID)
		}
	}
}

// forceEndOrphanedChildren parentInstanceID 结束（含被终止）那一刻，把尚未结束
// 的子实例逐个强制结束（ForceEnd），按两条口径合并：
//   - 「不等待」（wait_mode=NO_WAIT）配了「强制结束」（orphan_policy=FORCE_END）的——正常结束
//     链路；「不管」（IGNORE）的链接不动，子流程照常跑完；
//   - 「等待」（wait_mode=WAIT）的一律强制结束，不看 orphan_policy——等待档的
//     orphan_policy 字段本来就仅在「不等待」时有意义，平时压根碰不到这一支：
//     正常流转时父实例走到等待档就停在那一步，不可能同时结束；只有管理员终止把父实例的当前站
//     直接摁成 CANCELLED、绕开了「等全部子实例结束才能往后走」这条闸，才会出现「父已结束、
//     等待中的子实例还留着」这种此前不存在的状态，必须无条件收掉，不然这些子实例永远没人管。
func (s *Service) forceEndOrphanedChildren(ctx context.Context, meta Meta, parentInstanceID string) {
	agg, err := s.Ledger.LoadInstanceByID(ctx, meta.AppID, parentInstanceID)
	if err != nil {
		observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.subflow_force_end_lookup_failed", "load parent for orphan sweep failed",
			map[string]any{"parent_instance_id": parentInstanceID, "error": err.Error()})
		return
	}
	var toForce []string
	for _, l := range agg.GetLinks() {
		if l.GetChildStatus() == string(model.LinkChildStatusEnded) {
			continue
		}
		waiting := l.GetWaitMode() == string(model.LinkWaitModeWait)
		forceEndConfigured := l.GetOrphanPolicy() == string(model.LinkOrphanPolicyForceEnd)
		if waiting || forceEndConfigured {
			toForce = append(toForce, l.GetChildWorkflowInstanceId())
		}
	}
	sysMeta := Meta{AppID: meta.AppID, RequestKey: meta.RequestKey, Actor: systemActor}
	for _, childID := range toForce {
		res, err := s.commitWithReload(ctx, sysMeta, childID, ":forceend:"+parentInstanceID, "SUBFLOW_FORCE_END", map[string]any{"parent_instance_id": parentInstanceID},
			func(a *pb.InstanceAggregate) (*core.Decision, error) {
				return s.Engine.ForceEnd(a, "PARENT_ENDED", systemActor)
			})
		if err != nil {
			observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.subflow_force_end_failed", "force end orphaned child failed",
				map[string]any{"child_instance_id": childID, "parent_instance_id": parentInstanceID, "error": err.Error()})
			continue
		}
		if res != nil {
			// 被强制结束的子实例自己也可能持有等待中的子子实例（嵌套），继续善后。
			s.afterInstanceEnded(ctx, meta, childID)
		}
	}
}

// propagateChildEnded childInstanceID 刚刚结束（正常到达 / 事故恢复 / 被强制结束都
// 算），回去检查它是不是某个父实例「等待」中的子流程——是的话把父实例里对应的链接行标成
// ENDED；若该父步骤下全部等待档链接都已结束，推进父实例（core.ResumeSubflowWait）。
// 没有父链接（顶层实例，或链接已被删除）时静默返回，不是错误。
func (s *Service) propagateChildEnded(ctx context.Context, meta Meta, childInstanceID string) {
	parentAgg, err := s.Ledger.LoadParentOfChild(ctx, meta.AppID, childInstanceID)
	if err != nil {
		if !errors.Is(err, ports.ErrNotFound) {
			observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.subflow_parent_lookup_failed", "load parent of ended child failed",
				map[string]any{"child_instance_id": childInstanceID, "error": err.Error()})
		}
		return
	}
	parentInstanceID := parentAgg.GetInstance().GetWorkflowInstanceId()
	sysMeta := Meta{AppID: meta.AppID, RequestKey: meta.RequestKey, Actor: systemActor}
	var parentStepID string
	_, err = s.commitWithReload(ctx, sysMeta, parentInstanceID, ":childend:"+childInstanceID, "SUBFLOW_CHILD_ENDED", map[string]any{"child_instance_id": childInstanceID},
		func(a *pb.InstanceAggregate) (*core.Decision, error) {
			d, stepID, err := s.Engine.MarkChildEnded(a, childInstanceID)
			parentStepID = stepID
			return d, err
		})
	if err != nil {
		observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.subflow_mark_child_ended_failed", "mark child ended failed",
			map[string]any{"child_instance_id": childInstanceID, "parent_instance_id": parentInstanceID, "error": err.Error()})
		return
	}
	if parentStepID == "" {
		return
	}
	agg2, err := s.Ledger.LoadInstanceByID(ctx, meta.AppID, parentInstanceID)
	if err != nil || !allSiblingLinksEnded(agg2, parentStepID) {
		return
	}
	// resumed 记下最后一次真正拿去提交的 Decision（版本冲突重试时以重算的那份为准）：提交成功后
	// 要靠它取待发起的子流程清单——commitWithReload 只管提交变更集，不执行清单。
	var resumed *core.Decision
	res, err := s.commitWithReload(ctx, sysMeta, parentInstanceID, ":resumewait:"+parentStepID, "SUBFLOW_RESUME_WAIT", map[string]any{"step_id": parentStepID},
		func(a *pb.InstanceAggregate) (*core.Decision, error) {
			d, derr := s.Engine.ResumeSubflowWait(ctx, meta.AppID, a, parentStepID, systemActor)
			resumed = d
			return d, derr
		})
	if err != nil {
		// 无人在场时选路 / 选人失败（core.ResumeSubflowWait 的两类拒绝）：父步骤留在 ACTIVE
		// （没有提交任何变更），记 warn 等管理员介入；不当错误向上抛——子实例自己已经结束了。
		observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.subflow_resume_wait_failed", "resume subflow wait failed, parent step stays active",
			map[string]any{"parent_instance_id": parentInstanceID, "step_id": parentStepID, "error": err.Error()})
		return
	}
	// 回推之后下一站又是子流程节点（或经辅助链连着的子流程节点）时，这批子流程要与
	// 办理人提交时到达的一样真的发起——与 commitLoop / ResumeIncident 同一口径：父实例这段变更
	// 已经落库之后才发起，重放（res.Replayed）不补做；不能只提交变更集而丢掉清单，否则子流程
	// 从未发起、不开事故、不留链接，父流程那一步却已标成「已发起」。发起人取清单自带的
	// 提交人（core 已回溯到最近一位真人办理人）；发起失败由 runSubflowStarts 内部把父实例
	// 改判停驻。这里自身出错只记 error 日志、不向上抛——子实例自己已经成功结束了。
	if res != nil && !res.Replayed && resumed != nil && len(resumed.PendingSubflowStarts) > 0 {
		if _, serr := s.runSubflowStarts(ctx, sysMeta, parentInstanceID, resumed.PendingSubflowStarts); serr != nil {
			observability.Logger(ctx).Error(ctx, "workflow", "engine", "workflow.engine.subflow_start_after_resume_wait_failed", "launch subflows after resume wait failed",
				map[string]any{"parent_instance_id": parentInstanceID, "step_id": parentStepID, "error": serr.Error()})
		}
	}
	if res != nil && res.Outcome.Status == string(model.InstanceStatusEnded) {
		s.propagateChildEnded(ctx, meta, parentInstanceID) // 嵌套子流程，向上继续传播
	}
}

// allSiblingLinksEnded 父步骤 parentStepID 下全部「等待档」链接是否都已结束；
// 「不等待」的链接（wait_mode=NO_WAIT）不参与判定——那些子流程发起完父流程就已经继续往前走了，
// 它们的结束不该触发再次推进。一条等待档链接都没有时按「不满足」处理（没什么好推进的）。
func allSiblingLinksEnded(agg *pb.InstanceAggregate, parentStepID string) bool {
	found := false
	for _, l := range agg.GetLinks() {
		if l.GetParentStepId() != parentStepID || l.GetWaitMode() != string(model.LinkWaitModeWait) {
			continue
		}
		found = true
		if l.GetChildStatus() != string(model.LinkChildStatusEnded) {
			return false
		}
	}
	return found
}

// writeBeforeCommit 提交状态变更之前要先落到单据上的字段（审批结果与理由、回退清空）。
// 两者都没有就什么也不做。
//
// 版本冲突重试会让这一段重跑一次：写的是同一份确定值（同一个按钮的结果标识与同一句理由，
// 或同一批字段清空），重复写是幂等的，不会把单据写花。
func (s *Service) writeBeforeCommit(ctx context.Context, meta Meta, d *core.Decision) error {
	writes, reason := pendingWrites(d)
	if len(writes) == 0 {
		return nil
	}
	if s.Record == nil {
		return core.SystemErrorf("record service is not wired, cannot write record fields")
	}
	inst := d.Changeset.GetInstance().GetRow()
	rec := ports.RecordRef{AppID: meta.AppID, TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId(), WorkflowInstanceID: inst.GetWorkflowInstanceId()}
	if err := s.Record.WriteFields(ctx, rec, writes, reason, meta.Actor, meta.RequestKey); err != nil {
		observability.Logger(ctx).Error(ctx, "workflow", "engine", "workflow.engine.record_write_failed", "writing record fields before commit failed, action rejected",
			map[string]any{"workflow_instance_id": inst.GetWorkflowInstanceId(), "reason": reason, "error": err.Error()})
		return &core.Error{Code: "RECORD_WRITE_FAILED", Message: err.Error()}
	}
	return nil
}

// pendingWrites 把决策里待写的内容摊平成一次写入。审批的结果与理由要在同一次保存里落下
// （两者都写完才保存单据），所以是一个请求而不是两个。
//
// 同一个字段既是审批绑定字段、又在「回退时清空」清单里是允许的配置：
// 次序为「先清空，后将意见写入绑定字段」，所以清空排在前、审批写入排在后；而一次请求里同一
// 字段不得出现两次（宿主保存链按重复字段整单拒绝，回退就永远执行不了），所以本次审批确实要写
// 的字段不再进清空段——先清后写的净效果就是只留写入那一条。审批这次没有要写的值（例如没填
// 理由，PendingApproveWrite 里该字段为空）时它不在 approved 里，照常被清空。
func pendingWrites(d *core.Decision) ([]ports.FieldWrite, string) {
	var approveWrites []ports.FieldWrite
	approved := map[string]bool{} // 本次审批确实要写的字段
	reason := ""
	if w := d.PendingApproveWrite; w != nil {
		if w.ResultFieldID != "" {
			approveWrites = append(approveWrites, ports.FieldWrite{FieldID: w.ResultFieldID, TextValue: w.ResultTag})
			approved[w.ResultFieldID] = true
			reason = approveWriteReason
		}
		if w.ReasonFieldID != "" {
			approveWrites = append(approveWrites, ports.FieldWrite{FieldID: w.ReasonFieldID, TextValue: w.Reason})
			approved[w.ReasonFieldID] = true
			if reason == "" {
				reason = approveCommentOnly
			}
		}
	}
	var writes []ports.FieldWrite
	if c := d.PendingClearWrite; c != nil {
		for _, f := range c.Fields {
			if approved[f.FieldID] {
				continue // 先清空后写入：净效果是写入的值，清空那一条不必（也不能）再发
			}
			writes = append(writes, ports.FieldWrite{FieldID: f.FieldID, Clear: true})
		}
		if reason == "" {
			reason = clearOnBackReason
		}
	}
	return append(writes, approveWrites...), reason
}

// finishEndWrite 两段式第二段：第一段已把实例停驻在结束节点（END_WRITE_PENDING），
// 此刻任何并发办理都会被 INSTANCE_PARKED 挡住，再写结束标识；成功 → ResumeIncident 提交 RESOLVED + ENDED
// （派生键 :end，版本冲突重装载重试一次）；失败 → ParkAgain 改判 WRITE_FIELD_FAILED（派生键 :park），
// 结果为停驻交管理员处理。
func (s *Service) finishEndWrite(ctx context.Context, meta Meta, inst *pb.InstanceRow, incidentID string, w *core.EndWrite) (*Result, error) {
	rec := ports.RecordRef{AppID: meta.AppID, TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId(), WorkflowInstanceID: inst.GetWorkflowInstanceId()}
	instanceID := inst.GetWorkflowInstanceId()
	if err := s.Record.WriteFields(ctx, rec, []ports.FieldWrite{{FieldID: w.FieldID, TextValue: w.Label}}, endWriteReason, meta.Actor, meta.RequestKey); err != nil {
		// 结束写入失败会让实例事故停驻，需要管理员介入，用 error 级保证醒目。
		observability.Logger(ctx).Error(ctx, "workflow", "engine", "workflow.engine.end_write_failed", "write end label failed, instance stays parked",
			map[string]any{"workflow_instance_id": instanceID, "field_id": w.FieldID, "error": err.Error()})
		agg, lerr := s.Ledger.LoadInstanceByID(ctx, meta.AppID, instanceID)
		if lerr != nil {
			return nil, ledgerErr(lerr)
		}
		d := s.Engine.ParkAgain(agg, incidentID, err)
		return s.commitDerived(ctx, meta, parkPhaseKeySuffix, requestDigest("END_WRITE_PARK", instanceID, meta.Actor.UserID, nil), d)
	}
	digest := requestDigest("END_WRITE_END", instanceID, meta.Actor.UserID, nil)
	for attempt := 0; ; attempt++ {
		agg, err := s.Ledger.LoadInstanceByID(ctx, meta.AppID, instanceID)
		if err != nil {
			return nil, ledgerErr(err)
		}
		d, err := s.Engine.ResumeIncident(ctx, core.ResumeInput{AppID: meta.AppID, Agg: agg, IncidentID: incidentID, Actor: meta.Actor})
		if err != nil {
			return nil, err
		}
		res, err := s.commitDerived(ctx, meta, endPhaseKeySuffix, digest, d)
		if err != nil {
			if core.CodeOf(err) == "VERSION_CONFLICT" && attempt == 0 {
				continue
			}
			return nil, err
		}
		// 两段式第二段落定，实例这一刻才真的变成 ENDED（做子流程善后）。
		s.afterInstanceEnded(ctx, meta, instanceID)
		return res, nil
	}
}

// commitDerived 以派生请求键提交（两段式的 :end / :park）。
func (s *Service) commitDerived(ctx context.Context, meta Meta, suffix, digest string, d *core.Decision) (*Result, error) {
	outcomeJSON, _ := json.Marshal(d.Outcome)
	result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey + suffix, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON), Changeset: d.Changeset})
	if err != nil {
		return nil, ledgerErr(err)
	}
	if !result.Applied {
		return decodeInstanceReplay(&ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON, InstanceVersion: result.InstanceVersion}), nil
	}
	return &Result{Outcome: d.Outcome, InstanceVersion: result.InstanceVersion}, nil
}

// —— 实例动作 ——

// StartInput 发起入参。
type StartInput struct {
	DefinitionID string
	Record       ports.RecordRef
	StartKind    model.StartKind
	Choices      core.Choices
}

// startDigest Start 的意图摘要：定义 + 单据 + 操作人 + 发起方式 + 选路 / 选人。
func startDigest(in StartInput, actorUserID int64) string {
	return requestDigest("START", in.Record.RecordID, actorUserID, map[string]any{
		"definition_id": in.DefinitionID, "start_kind": string(in.StartKind),
		"route_link_id": in.Choices.RouteLinkID, "selected_assignees": uniqSortedInt64(in.Choices.SelectedAssignees),
	})
}

// Start 发起：定义 + 最新版本 + 是否已有实例 → core.Start。
// 单据模板必须与定义绑定的模板一致（不一致 → INVALID_ARGUMENT），且单据必须存在
// （不存在 → NOT_FOUND，越权占坑见宿主网关侧的应用 / 模板 / 单据读权校验，本层只管这两条）。
// 决策之前先查请求日志，命中直接回放，不再重新查定义 / 单据、不再重新决策。
func (s *Service) Start(ctx context.Context, meta Meta, in StartInput) (*Result, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	digest := startDigest(in, meta.Actor.UserID)
	if found, hit, err := s.replayCheck(ctx, meta, "START", digest); err != nil {
		return nil, err
	} else if hit {
		return s.replayResult(ctx, meta, found)
	}
	def, _, err := s.Ledger.GetDefinition(ctx, meta.AppID, in.DefinitionID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	var version *pb.DefinitionVersionRow
	if def.GetLatestVersionNo() > 0 {
		version, err = s.Ledger.GetVersion(ctx, meta.AppID, in.DefinitionID, 0)
		if err != nil && !errors.Is(err, ports.ErrNotFound) {
			return nil, ledgerErr(err)
		}
	}
	rec := in.Record
	rec.AppID = meta.AppID
	if rec.TemplateID != "" && rec.TemplateID != def.GetTemplateId() {
		return nil, &core.Error{Code: "INVALID_ARGUMENT", Message: fmt.Sprintf("record template %s does not match definition template %s", rec.TemplateID, def.GetTemplateId())}
	}
	rec.TemplateID = def.GetTemplateId()
	// 先预分配实例 ID，发起前读单据头即可带上（实例尚未落库，宿主按单据反查归属）；
	// 同一次请求的版本冲突重试沿用同一个 ID。
	if rec.WorkflowInstanceID == "" && s.IDs != nil {
		rec.WorkflowInstanceID = s.IDs.New("inst")
	}
	if s.Record != nil {
		exists, _, err := s.Record.Header(ctx, rec, "")
		if err != nil {
			return nil, ledgerErr(err)
		}
		if !exists {
			return nil, &core.Error{Code: "NOT_FOUND", Message: fmt.Sprintf("record %s not found", rec.RecordID)}
		}
	}
	// 发起没有已有聚合可锁：Existing 只用于 P1 预检，真正的唯一性由账本 record_id 唯一键兜底。
	return s.commitLoop(ctx, meta, digest, nil, func(*pb.InstanceAggregate) (*core.Decision, error) {
		existing, err := s.Ledger.LoadInstanceByRecord(ctx, meta.AppID, rec.RecordID)
		if err != nil && !errors.Is(err, ports.ErrNotFound) {
			return nil, err
		}
		return s.Engine.Start(ctx, core.StartInput{AppID: meta.AppID, Definition: def, Version: version, Existing: existing, Record: rec, Actor: meta.Actor, StartKind: in.StartKind, Choices: in.Choices, WorkflowInstanceID: rec.WorkflowInstanceID})
	})
}

// Save 暂存。
func (s *Service) Save(ctx context.Context, meta Meta, taskID string) (*Result, error) {
	digest := requestDigest("SAVE", taskID, meta.Actor.UserID, nil)
	return s.execute(ctx, meta, "SAVE", digest, s.byTask(meta, taskID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.Save(ctx, core.TaskInput{AppID: meta.AppID, Agg: agg, TaskID: taskID, Actor: meta.Actor})
	})
}

// Submit 提交（含弹框后带选项的重调）。
func (s *Service) Submit(ctx context.Context, meta Meta, taskID string, choices core.Choices) (*Result, error) {
	digest := requestDigest("SUBMIT", taskID, meta.Actor.UserID, map[string]any{"route_link_id": choices.RouteLinkID, "selected_assignees": uniqSortedInt64(choices.SelectedAssignees)})
	return s.execute(ctx, meta, "SUBMIT", digest, s.byTask(meta, taskID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.Submit(ctx, core.TaskInput{AppID: meta.AppID, Agg: agg, TaskID: taskID, Actor: meta.Actor, Choices: choices})
	})
}

// Withdraw 撤销提交。
func (s *Service) Withdraw(ctx context.Context, meta Meta, taskID string) (*Result, error) {
	digest := requestDigest("WITHDRAW", taskID, meta.Actor.UserID, nil)
	return s.execute(ctx, meta, "WITHDRAW", digest, s.byTask(meta, taskID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.Withdraw(ctx, core.TaskInput{AppID: meta.AppID, Agg: agg, TaskID: taskID, Actor: meta.Actor})
	})
}

// BackInput 回退入参（transport 的 back_mode 已翻译成回退方式）。
type BackInput struct {
	Method       model.WithdrawMethod
	TargetStepID string
	Comment      string
	Choices      core.Choices
}

// Back 回退（E）。
func (s *Service) Back(ctx context.Context, meta Meta, taskID string, in BackInput) (*Result, error) {
	digest := requestDigest("BACK", taskID, meta.Actor.UserID, map[string]any{
		"method": string(in.Method), "target_step_id": in.TargetStepID, "comment": in.Comment,
		"route_link_id": in.Choices.RouteLinkID, "selected_assignees": uniqSortedInt64(in.Choices.SelectedAssignees),
	})
	return s.execute(ctx, meta, "BACK", digest, s.byTask(meta, taskID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.Back(ctx, core.BackInput{
			TaskInput:    core.TaskInput{AppID: meta.AppID, Agg: agg, TaskID: taskID, Actor: meta.Actor, Choices: in.Choices},
			Method:       in.Method,
			TargetStepID: in.TargetStepID,
			Comment:      in.Comment,
		})
	})
}

// PressButtonInput 审批按钮入参。
type PressButtonInput struct {
	ButtonID     string
	Reason       string
	TargetStepID string
	Choices      core.Choices
}

// PressButton 审批人点按钮。
func (s *Service) PressButton(ctx context.Context, meta Meta, taskID string, in PressButtonInput) (*Result, error) {
	digest := requestDigest("PRESS_BUTTON", taskID, meta.Actor.UserID, map[string]any{
		"button_id": in.ButtonID, "reason": in.Reason, "target_step_id": in.TargetStepID,
		"route_link_id": in.Choices.RouteLinkID, "selected_assignees": uniqSortedInt64(in.Choices.SelectedAssignees),
	})
	return s.execute(ctx, meta, "PRESS_BUTTON", digest, s.byTask(meta, taskID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.PressButton(ctx, core.ApproveInput{
			TaskInput:    core.TaskInput{AppID: meta.AppID, Agg: agg, TaskID: taskID, Actor: meta.Actor, Choices: in.Choices},
			ButtonID:     in.ButtonID,
			Reason:       in.Reason,
			TargetStepID: in.TargetStepID,
		})
	})
}

// Preview 只读地预告本任务可用的操作（不落库、不走请求键幂等）。
func (s *Service) Preview(ctx context.Context, meta Meta, taskID string) (*core.PreviewInfo, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	agg, err := s.Ledger.LoadInstanceByTask(ctx, meta.AppID, taskID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	return core.Preview(meta.AppID, agg, taskID, meta.Actor.UserID)
}

// WithdrawStart 撤销发起。
func (s *Service) WithdrawStart(ctx context.Context, meta Meta, instanceID string) (*Result, error) {
	digest := requestDigest("WITHDRAW_START", instanceID, meta.Actor.UserID, nil)
	return s.execute(ctx, meta, "WITHDRAW_START", digest, s.byInstance(meta, instanceID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.WithdrawStart(ctx, meta.AppID, agg, meta.Actor)
	})
}

// —— 管理员能力（终止 / 改派 / 事故清单） ——
//
// 只许超管这条闸放在宿主网关（与事故恢复端点同一套闸，见 ResumeIncident 的调用方），
// 三个方法本身不判角色，走的都是与其余动作同一条 execute/commitLoop 骨架
// （幂等 / CAS 重试 / 子流程善后一样不漏）。

// TerminateInput 终止入参。
type TerminateInput struct {
	InstanceID string
	Reason     string
}

// Terminate 终止一个仍在跑的实例。终止是不可逆的破坏性管理动作（对外显示「已终止」，
// 待办任务全部撤销），成功与失败都在关键位置按级别上报宿主日志中心：成功记 info（供事后审计
// 「谁在什么时候终止了哪个实例」）；失败沿用 transport 层 fail() 按错误码分级，这里不重复记。
func (s *Service) Terminate(ctx context.Context, meta Meta, in TerminateInput) (*Result, error) {
	digest := requestDigest("TERMINATE", in.InstanceID, meta.Actor.UserID, map[string]any{"reason": in.Reason})
	res, err := s.execute(ctx, meta, "TERMINATE", digest, s.byInstance(meta, in.InstanceID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.Terminate(ctx, core.TerminateInput{AppID: meta.AppID, Agg: agg, Actor: meta.Actor, Reason: in.Reason})
	})
	if err == nil {
		observability.Logger(ctx).Info(ctx, "workflow", "engine", "workflow.engine.admin.terminated", "instance terminated by admin",
			map[string]any{"workflow_instance_id": in.InstanceID, "actor_user_id": meta.Actor.UserID, "reason": in.Reason, "replayed": res.Replayed})
	}
	return res, err
}

// ReassignInput 改派入参。
type ReassignInput struct {
	TaskID   string
	ToUserID int64
	Reason   string
}

// Reassign 把一条待办任务换给另一个人（原任务 REASSIGNED、新任务 PENDING、计数不变），
// M4 释放原办理人编辑租约由 commitLoop 按 Decision.PendingLeaseRelease 统一处理。改派动了别人
// 的待办、还会打断别人正在编辑的会话，同样在成功时记 info 供审计；租约释放失败已在
// releaseLease 里单独记 warn（不影响这里的成功判定，改派本身已经生效）。
func (s *Service) Reassign(ctx context.Context, meta Meta, in ReassignInput) (*Result, error) {
	digest := requestDigest("REASSIGN", in.TaskID, meta.Actor.UserID, map[string]any{"to_user_id": in.ToUserID, "reason": in.Reason})
	res, err := s.execute(ctx, meta, "REASSIGN", digest, s.byTask(meta, in.TaskID), func(agg *pb.InstanceAggregate) (*core.Decision, error) {
		return s.Engine.Reassign(ctx, core.ReassignInput{AppID: meta.AppID, Agg: agg, TaskID: in.TaskID, ToUserID: in.ToUserID, Actor: meta.Actor, Reason: in.Reason})
	})
	if err == nil {
		observability.Logger(ctx).Info(ctx, "workflow", "engine", "workflow.engine.admin.reassigned", "task reassigned by admin",
			map[string]any{"task_id": in.TaskID, "to_user_id": in.ToUserID, "actor_user_id": meta.Actor.UserID, "reason": in.Reason, "replayed": res.Replayed})
	}
	return res, err
}

// ListIncidents 查看一个实例的事故清单（只读，不落库、不走请求键幂等，同 Preview）。
// 只读查询按 debug 级记一条即可（不是 info：这不是「发生了什么」，只是「有人看了一眼」），
// 失败已由 ledgerErr 折成状态码交给 transport 层 fail() 统一分级。
func (s *Service) ListIncidents(ctx context.Context, meta Meta, instanceID string) ([]*pb.IncidentRow, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	agg, err := s.Ledger.LoadInstanceByID(ctx, meta.AppID, instanceID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	incidents := core.ListIncidents(agg)
	observability.Logger(ctx).Debug(ctx, "workflow", "engine", "workflow.engine.admin.list_incidents", "admin viewed incident list",
		map[string]any{"workflow_instance_id": instanceID, "actor_user_id": meta.Actor.UserID, "count": len(incidents)})
	return incidents, nil
}

// releaseLease 改派成功后释放原办理人的编辑租约；Lease 端口未装配或释放失败都只记 warn，
// 不影响改派本身已经生效的结果——M4 是锦上添花的即时打断，不是改派的前置条件。
func (s *Service) releaseLease(ctx context.Context, meta Meta, r *core.LeaseRelease) {
	if s.Lease == nil {
		observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.lease_service_not_wired", "lease service is not wired, skip release",
			map[string]any{"record_id": r.RecordID, "holder_user_id": r.HolderUserID})
		return
	}
	rec := ports.RecordRef{AppID: meta.AppID, TemplateID: r.TemplateID, RecordID: r.RecordID, WorkflowInstanceID: r.WorkflowInstanceID}
	if _, err := s.Lease.ReleaseEditLease(ctx, rec, r.HolderUserID, r.Reason); err != nil {
		observability.Logger(ctx).Warn(ctx, "workflow", "engine", "workflow.engine.lease_release_failed", "release edit lease failed after reassign",
			map[string]any{"record_id": r.RecordID, "holder_user_id": r.HolderUserID, "error": err.Error()})
	}
}

// ResumeIncident 事故恢复：从停驻点继续；再次写失败 → ParkAgain（attempts+1，仍停驻）。
// 决策之前先查请求日志，命中直接回放；版本冲突重装载重试一次。
func (s *Service) ResumeIncident(ctx context.Context, meta Meta, incidentID, note string) (*Result, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	digest := requestDigest("RESUME_INCIDENT", incidentID, meta.Actor.UserID, map[string]any{"note": note})
	if found, hit, err := s.replayCheck(ctx, meta, "RESUME_INCIDENT", digest); err != nil {
		return nil, err
	} else if hit {
		return decodeInstanceReplay(found), nil
	}
	written := false // 停驻态下没有并发办理，写字段一次即可；版本冲突重试时不重写
	for attempt := 0; ; attempt++ {
		agg, err := s.Ledger.LoadInstanceByIncident(ctx, meta.AppID, incidentID)
		if err != nil {
			return nil, ledgerErr(err)
		}
		d, err := s.Engine.ResumeIncident(ctx, core.ResumeInput{AppID: meta.AppID, Agg: agg, IncidentID: incidentID, Actor: meta.Actor, Note: note})
		if err != nil {
			return nil, err
		}
		if d.PendingEndWrite != nil && !written {
			inst := agg.GetInstance()
			rec := ports.RecordRef{AppID: meta.AppID, TemplateID: inst.GetTemplateId(), RecordID: inst.GetRecordId(), WorkflowInstanceID: inst.GetWorkflowInstanceId()}
			w := d.PendingEndWrite
			var werr error
			if s.Record == nil {
				werr = fmt.Errorf("record service is not wired")
			} else {
				werr = s.Record.WriteFields(ctx, rec, []ports.FieldWrite{{FieldID: w.FieldID, TextValue: w.Label}}, endWriteReason, meta.Actor, meta.RequestKey)
			}
			if werr != nil {
				// 事故恢复时结束写入再次失败，实例仍停驻，同上用 error 级。
				observability.Logger(ctx).Error(ctx, "workflow", "engine", "workflow.engine.resume_write_failed", "end label write failed again, instance stays parked",
					map[string]any{"incident_id": incidentID, "error": werr.Error()})
				d = s.Engine.ParkAgain(agg, incidentID, werr)
			} else {
				written = true
			}
		}
		outcomeJSON, _ := json.Marshal(d.Outcome)
		result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON), Changeset: d.Changeset})
		if err != nil {
			if errors.Is(err, ports.ErrVersionConflict) && attempt == 0 {
				continue
			}
			return nil, ledgerErr(err)
		}
		if !result.Applied {
			return decodeInstanceReplay(&ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON, InstanceVersion: result.InstanceVersion}), nil
		}
		instanceID := agg.GetInstance().GetWorkflowInstanceId()
		// SUBFLOW_START 停驻点恢复出来的 Decision 可能带 PendingSubflowStarts——
		// 与 commitLoop 同一口径，本实例这段变更已经落库之后才真正发起子实例；发起若再次失败，
		// 以子流程的停驻结果为准（它是这次恢复动作最后落定的状态）。
		var subflowResult *Result
		if len(d.PendingSubflowStarts) > 0 {
			res, rerr := s.runSubflowStarts(ctx, meta, instanceID, d.PendingSubflowStarts)
			if rerr != nil {
				return nil, rerr
			}
			subflowResult = res
		}
		if d.Outcome.Status == string(model.InstanceStatusEnded) {
			// 管理员手动从停驻点恢复也可能让实例这一刻结束（子流程善后同 finishEndWrite）。
			s.afterInstanceEnded(ctx, meta, instanceID)
		}
		if subflowResult != nil {
			return subflowResult, nil
		}
		return &Result{Outcome: d.Outcome, InstanceVersion: result.InstanceVersion}, nil
	}
}

// GetDetail 实例聚合（流程进度页 / 管理页）。
func (s *Service) GetDetail(ctx context.Context, meta Meta, instanceID string) (*pb.InstanceAggregate, error) {
	if s.Ledger == nil {
		return nil, core.SystemErrorf("engine service is not wired")
	}
	agg, err := s.Ledger.LoadInstanceByID(ctx, meta.AppID, instanceID)
	return agg, ledgerErr(err)
}

// GetDetailWithFlags 聚合 + 每条任务的派生标志（可否撤销，供任务中心「撤销」两态）。
func (s *Service) GetDetailWithFlags(ctx context.Context, meta Meta, instanceID string) (*pb.InstanceAggregate, []core.TaskFlag, error) {
	agg, err := s.GetDetail(ctx, meta, instanceID)
	if err != nil {
		return nil, nil, err
	}
	return agg, core.TaskFlags(agg), nil
}

func (s *Service) byTask(meta Meta, taskID string) func(context.Context) (*pb.InstanceAggregate, error) {
	return func(ctx context.Context) (*pb.InstanceAggregate, error) {
		return s.Ledger.LoadInstanceByTask(ctx, meta.AppID, taskID)
	}
}

func (s *Service) byInstance(meta Meta, instanceID string) func(context.Context) (*pb.InstanceAggregate, error) {
	return func(ctx context.Context) (*pb.InstanceAggregate, error) {
		return s.Ledger.LoadInstanceByID(ctx, meta.AppID, instanceID)
	}
}
