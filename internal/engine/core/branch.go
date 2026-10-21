package core

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// branch.go 管两件互相咬合的事：
//
//  1. **辅助链**：抄送与子流程是辅助节点——它们做完本职之后，若还有主线出线就继续沿主线
//     往下走；若它们是末级辅助节点就到此为止，主线不受影响。「主线出线」的定义在发布期算好了
//     （`is_main`：指向主线节点、或指向本身还有出线的辅助节点），运行期只认这个标记。
//
//  2. **支线**：指向末级辅助节点的出线是支线。主线按 L2～L4 **成功流转的那一刻**，对每条
//     支线的条件求值，成立的各自触发一次；支线触发多少条都不需要人选。主线零命中转暂存时，
//     一条支线都不触发——「成功流转」是支线的前提，不是并列的两件事。
//
// 🔴 支线失败不回滚主线：支线是知会与派生（抄送算不出人、子流程发起不出去），主线该走还是要走。
// 这一条不是偷懒——反过来实现会让「财务那条抄送的收件人今天离职了」把整条采购流程卡住。

// continueAfterAuxiliary 辅助节点做完本职之后继续沿主线走。
// 不带 choices：辅助节点后面这一跳没有人在现场，要选路 / 选人都轮不到人来选，
// 于是与自动办理同一口径——选路多命中或零命中按各自的 outcome 交回上层，选人默认全选。
func (e *Engine) continueAfterAuxiliary(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor) (*arrival, error) {
	// 连着走多少步都没有人参与，用同一个上限兜住（F6 的「连环超限」口径）：抄送指回抄送
	// 这种画法发布期检查不出来，运行期必须有个底。
	if to.AutoDepth >= autoChainLimit {
		return e.parkAutoChain(l, b, inst, from, target, submitter, l.maxSeq()+1+int32(len(b.cs.StepUpserts))), nil
	}
	chosen, outcome, err := e.route(ctx, l, target.NodeID, submitter, Choices{})
	if err != nil {
		return nil, err
	}
	if outcome != nil {
		// 抄送自己不配无路提示，选路与无路都按上溯到的最近可办理节点的设置处理。
		// route 已经按同一口径填好提示，这里只把结果交回上层（上层按 L4 转暂存）。
		return &arrival{outcome: outcome}, nil
	}
	return e.arrive(ctx, l, b, inst, from, arriveTarget{
		NodeID: chosen.ToNodeID, ViaLinkID: chosen.LinkID, AutoSelectAll: true, AutoDepth: to.AutoDepth + 1,
	}, submitter, Choices{})
}

// fireBranches 主线成功流转之后触发支线。from 是刚刚过关的那一步；每条成立的支线各自
// 到达一次末级辅助节点，**不改实例的当前站**、不产生任务、不影响主线。
//
// 返回被追加的步骤（供调用方放进发件箱载荷）。任何一条支线失败只记 warn 不回滚主线。
func (e *Engine) fireBranches(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, submitter ports.Actor) ([]*pb.StepRow, []SubflowStart) {
	if l.compiled.Node(from.GetNodeId()) == nil {
		return nil, nil
	}
	var fired []*pb.StepRow
	var starts []SubflowStart
	for _, link := range l.compiled.OutLinks(from.GetNodeId()) {
		if link.IsMain {
			continue // 主线已经走过了
		}
		ok, err := e.branchHits(ctx, l, link, submitter)
		if err != nil {
			e.warnBranch(ctx, inst, link.LinkID, "condition", err)
			continue
		}
		if !ok {
			continue
		}
		a, err := e.arriveBranch(ctx, l, b, inst, from, &link, submitter)
		if err != nil {
			e.warnBranch(ctx, inst, link.LinkID, "arrive", err)
			continue
		}
		if a == nil {
			continue
		}
		if a.step != nil {
			fired = append(fired, a.step)
		}
		starts = append(starts, a.subflowStarts...)
	}
	return fired, starts
}

// branchHits 支线条件是否成立。没配条件即恒成立（与主线出线同一口径）。
func (e *Engine) branchHits(ctx context.Context, l *loaded, link compile.LinkCompiled, actor ports.Actor) (bool, error) {
	if link.ConditionPublicationID == "" {
		return true, nil
	}
	return e.Expr.EvaluateCondition(ctx, l.rec, link.ConditionPublicationID, link.ConditionDocumentJSON, actor)
}

// arriveBranch 沿一条支线到达末级辅助节点。与主线到达共用节点的本职逻辑，但**用一份独立的
// 实例副本**去接那些「到达时会改当前站」的写入——支线不该把实例的当前站挪走。
func (e *Engine) arriveBranch(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, link *compile.LinkCompiled, submitter ports.Actor) (*arrival, error) {
	target := l.compiled.Node(link.ToNodeID)
	if target == nil {
		return nil, errf("SYSTEM_ERROR", "branch %s points to unknown node %s", link.LinkID, link.ToNodeID)
	}
	if !target.IsTerminalAuxiliary {
		// 指向非末级节点的出线按定义就是主线，不该走到这里。
		return nil, errf("SYSTEM_ERROR", "link %s is not a branch", link.LinkID)
	}
	seq := l.maxSeq() + 1
	for _, s := range b.cs.StepUpserts {
		if s.GetSeqNo() >= seq {
			seq = s.GetSeqNo() + 1
		}
	}
	// 支线终点只能是辅助节点（BranchTarget 特征）——主线节点没有「作为支线终点」这回事，
	// 发布期本该拦住这种画法，运行期兜底不放过。
	if !traitsOf(target.KindOf()).BranchTarget {
		return nil, errf("SYSTEM_ERROR", "node kind %s cannot be a branch target", target.NodeKind)
	}
	rt, ok := runtimeOf(target.KindOf())
	if !ok {
		return nil, errf("SYSTEM_ERROR", "node kind %s is not supported yet", target.NodeKind)
	}
	// 影子实例：末级辅助节点的到达逻辑里若碰了当前站，改的是这份副本，主线那份不受影响。
	shadow := cloneInstance(inst)
	to := arriveTarget{NodeID: target.NodeID, ViaLinkID: link.LinkID, AutoSelectAll: true}
	return rt.arrive(e, ctx, l, b, shadow, from, target, to, submitter, seq)
}

// warnBranch 支线失败只记 warn：主线该走还是要走（见文件头注释）。
func (e *Engine) warnBranch(ctx context.Context, inst *pb.InstanceRow, linkID, phase string, err error) {
	observabilityWarn(ctx, "workflow.engine.branch_failed", "a branch did not fire, main line is unaffected",
		map[string]any{"workflow_instance_id": inst.GetWorkflowInstanceId(), "link_id": linkID, "phase": phase, "error": err.Error()})
}

// noRouteHintFor 抄送自己不配「无路可走时的提示」，由把流程送到它的那个可办理节点的设置
// 处理；连续多个抄送时一直上溯到最近的可办理节点。
//
// 沿**图**上溯而不是沿步骤链：提示是设计期的配置，跟这一趟实际怎么走过来的无关；同一个抄送
// 无论从哪条线进来，它没有提示这件事都成立。多条入线时取文档顺序里第一条有提示的。
func noRouteHintFor(c *compile.CompiledDefinition, nodeID string) string {
	seen := map[string]bool{}
	return upstreamHint(c, nodeID, seen, 0)
}

func upstreamHint(c *compile.CompiledDefinition, nodeID string, seen map[string]bool, depth int) string {
	if depth > autoChainLimit || seen[nodeID] {
		return ""
	}
	seen[nodeID] = true
	if n := c.Node(nodeID); n != nil && n.NoRouteHint != "" {
		return n.NoRouteHint
	}
	for _, l := range c.Links {
		if l.ToNodeID != nodeID {
			continue
		}
		if h := upstreamHint(c, l.FromNodeID, seen, depth+1); h != "" {
			return h
		}
	}
	return ""
}

// appendStarts 把主线这一趟（可能连着穿过好几个子流程节点，见 arrival.subflowStarts 注释）与
// 支线各自要发起的子实例合成一份清单（顺序：主线在前，主线内部保持先到达先发起）。
func appendStarts(main []SubflowStart, branches []SubflowStart) []SubflowStart {
	if len(main) == 0 && len(branches) == 0 {
		return nil
	}
	out := make([]SubflowStart, 0, len(main)+len(branches))
	out = append(out, main...)
	return append(out, branches...)
}
