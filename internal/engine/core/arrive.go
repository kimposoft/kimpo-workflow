package core

import (
	"context"
	"encoding/json"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// arrival 到达下一站的结果。
type arrival struct {
	outcome  *Outcome // 非 nil：需要人处理（选人 / 无候选）；nil：已到达
	step     *pb.StepRow
	tasks    []*pb.TaskRow
	endWrite *EndWrite
	ended    bool
	// auxiliaryOnly 这一跳只落了一个末级辅助节点的步骤（抄送 / 子流程），实例的当前站没有移动
	// （N4.2 / N6.6「末级节点不影响主线」）。调用方据此知道「流程其实还停在原处」。
	auxiliaryOnly bool
	// subflowStarts 这一跳（含它继续沿辅助链往下走经过的每一个子流程节点）要发起的子实例清单
	// 。状态机只算「发几个、各带什么值」，真发起在 app 层——一个变更集只写一个实例，
	// 子实例得走它自己那一遍 Start 与 Commit。
	//
	// 之所以是清单而不是单槽位：抄送 → 子流程、子流程 → 子流程这类辅助链画法里，一跳
	// arrive 可能连着穿过好几个子流程节点（continueAfterAuxiliary 递归下去），每个都要
	// 发起自己的子实例，谁都不能被后面的顶掉。顺序＝先到达的先发起（本节点在前，下游在后）。
	subflowStarts []SubflowStart
}

// arriveTarget 到达目标。回退（E）与正常流转（L）只差「怎么来的」：正常流转沿引导线来，
// 回退没有线、由回退人指定一个走过的节点；到达之后的选人派发两者完全一样（C5 明文要求
// 回退后按 C1～C4 重新执行，此时提交人是回退人），所以到达逻辑只有这一份。
type arriveTarget struct {
	NodeID string
	// ViaLinkID 沿引导线来的线 id；回退为空（要弹选人框时原样带回，前端重调时照传）。
	ViaLinkID string
	// Returned 本次到达是回退造成的（E）。它一处标记、三处生效：
	//   - E5 目标节点即使配了自动办理也不触发，按人工走 C（否则「请前面的人重做」会被系统一脚
	//     踩过去，回退等于没回）；
	//   - T3 通知发的是「被回退」而不是「收到任务」（收件人同为回退目标步骤的办理人，不重复发）；
	//   - 步骤结果按回退记（P7 流程进度里用橙色画这一段）。
	Returned bool
	// AutoSelectAll 到达时若需要选人，默认选中全部候选、不弹对话框（F3：上一步是系统自动办理的，
	// 现场没有人可以弹框给他看）。
	AutoSelectAll bool
	// AutoDepth 本次流转已经连续自动办理了几步（F6 上限计数）；人工插一步即归零。
	AutoDepth int32
	// PrevActors 显式指定「上一步处理人」（A5 的基准人）。回退用：C5 明文规定回退后目标步骤
	// 按 C1～C4 重新执行、**此时提交人是回退人**，所以基准人就是按下回退的那个人，而不是从
	// 账本往前找到的某个更早的人。留空表示按 A5 常规口径从账本回溯。
	PrevActors []int64
	// Choices 弹框后回填的选择（C3 选人）。只有人工节点（办理 / 审批）的到达行为会用到；
	// 由 arrive() 统一从其 choices 形参灌进来，调用方构造 arriveTarget 字面量时不必填。
	// 运行期注册表把「到达」收成统一的 arriveFunc 签名，不单独带 choices 形参，
	// 所以随 arriveTarget 一起传给各类节点的到达实现。
	Choices Choices
}

// arrive 到达目标节点：
//   - 办理节点：算候选（宿主 CandidateService）→ 0 人 NoCandidate；>1 人无选择 AssigneeChoiceRequired；
//     选择不在候选内 INVALID_CHOICE；否则新建步骤（ACTIVE）与每人一条待办；
//   - 结束节点：新建步骤并直接 PASSED、实例 ENDED；配了写入字段的先记 EndWrite 交 app 层写；
//   - 其余类型（审批、抄送、子流程）按节点类型注册表各自的到达实现处理。
func (e *Engine) arrive(ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, to arriveTarget, submitter ports.Actor, choices Choices) (*arrival, error) {
	target := l.compiled.Node(to.NodeID)
	if target == nil {
		return nil, errf("SYSTEM_ERROR", "unknown target node %s", to.NodeID)
	}
	seq := l.maxSeq() + 1
	for _, s := range b.cs.StepUpserts {
		if s.GetSeqNo() >= seq {
			seq = s.GetSeqNo() + 1
		}
	}
	// 到达行为按类型走运行期注册表（node_registry.go），不在本函数里写 switch——
	// 加一类节点只在它自己的 node_<kind>.go 里注册一行，这里不用回头改。choices 是 arrive()
	// 独有的形参（与 arriveCC / arriveSubflow 等到达实现共用的 arriveFunc 签名里没有它），
	// 灌进 to.Choices 一起带过去。
	to.Choices = choices
	rt, ok := runtimeOf(target.KindOf())
	if !ok {
		return nil, errf("SYSTEM_ERROR", "node kind %s is not supported yet", target.NodeKind)
	}
	return rt.arrive(e, ctx, l, b, inst, from, target, to, submitter, seq)
}

// resumePoint 事故停驻点（存 incident.resume_point_json）。
type resumePoint struct {
	Action   string `json:"action"` // END_ARRIVE
	NodeID   string `json:"node_id"`
	StepID   string `json:"step_id"`
	FieldID  string `json:"field_id"`
	EndLabel string `json:"end_label"`
	// 以下三项只有 SUBFLOW_START 停驻点才写：把父流程送到子流程节点的那位办理人。
	// 管理员恢复事故重新发起子流程时据此取回发起人；omitempty 保持其余停驻点的 JSON 原样不变。
	SubmitterUserID     int64  `json:"submitter_user_id,omitempty"`
	SubmitterName       string `json:"submitter_name,omitempty"`
	SubmitterSuperAdmin bool   `json:"submitter_super_admin,omitempty"`
}

func (r resumePoint) json() string {
	raw, _ := json.Marshal(r)
	return string(raw)
}
