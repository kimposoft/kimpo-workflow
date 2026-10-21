package compile

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

func boolPtr(b bool) *bool { return &b }

// nodeCompiledOf 从编译结果里按 id 取一个节点（找不到直接失败），供本文件几条 NotifyJSON
// 摊平断言复用。
func nodeCompiledOf(t *testing.T, res Result, nodeID string) *NodeCompiled {
	t.Helper()
	for i := range res.Compiled.Nodes {
		if res.Compiled.Nodes[i].NodeID == nodeID {
			return &res.Compiled.Nodes[i]
		}
	}
	t.Fatalf("node %s not found in compiled result", nodeID)
	return nil
}

// TestNotify_FlattenedIntoNodeCompiled：发起/办理/结束三类节点（f1Lite 自带）的节点级 notify
// 配置发布期原样摊平进 NodeCompiled.NotifyJSON，运行期经 Notify() 能读回同样的开关与渠道。
func TestNotify_FlattenedIntoNodeCompiled(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[0].Config = cfgJSON(t, model.StartConfig{
		TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走",
		Notify: &model.NodeNotify{OnWithdrawn: boolPtr(false), Channels: []model.NotifyChannel{model.NotifyChannelSystem, model.NotifyChannelEmail}},
	})
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
		Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint: "审批后没有可走的路线",
		Notify:      &model.NodeNotify{OnAssigned: boolPtr(false)},
	})
	doc.Nodes[2].Config = cfgJSON(t, model.EndConfig{EndFlag: "已通过", Notify: &model.NodeNotify{OnEnded: boolPtr(false)}})

	// f1Lite 的 l1 是条件引导线，必须真冻结出一条发布物，否则编译在「求值收集」阶段就因为
	// 找不到发布物报错——与本文件其余用例、compile_test.go 里同款夹具的写法一致。
	res := compileOK(t, doc, &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	if len(res.Diagnostics) != 0 {
		t.Fatalf("配全不该有诊断，实得 %+v", res.Diagnostics)
	}

	n0 := nodeCompiledOf(t, res, "n0").Notify()
	if n0.Enabled(model.NotifyKeyWithdrawn) {
		t.Fatal("n0 的 on_withdrawn 应摊平成关闭")
	}
	if n0.Enabled(model.NotifyKeyReturned) == false {
		t.Fatal("n0 没配的 on_returned 应保持默认开")
	}
	if got := n0.ChannelsOrDefault(); len(got) != 2 || got[0] != model.NotifyChannelSystem || got[1] != model.NotifyChannelEmail {
		t.Fatalf("n0 渠道应摊平成 [system email]，实得 %v", got)
	}

	n1 := nodeCompiledOf(t, res, "n1").Notify()
	if n1.Enabled(model.NotifyKeyAssigned) {
		t.Fatal("n1 的 on_assigned 应摊平成关闭")
	}
	if got := n1.ChannelsOrDefault(); len(got) != 1 || got[0] != model.NotifyChannelSystem {
		t.Fatalf("n1 没配渠道应默认仅 system，实得 %v", got)
	}

	n2 := nodeCompiledOf(t, res, "n2").Notify()
	if n2.Enabled(model.NotifyKeyEnded) {
		t.Fatal("n2 的 on_ended 应摊平成关闭")
	}
}

// TestNotify_UnconfiguredNodeHasEmptyNotifyJSON：节点没配 notify 时 NotifyJSON 落空字符串，
// Notify() 返回 nil——与旧编译产物（压根没有这个字段）行为一致，运行期不用另外分支兼容。
func TestNotify_UnconfiguredNodeHasEmptyNotifyJSON(t *testing.T) {
	res := compileOK(t, f1Lite(t), &fakeFreezer{out: FreezeOutput{Frozen: []FrozenExpression{{ExpressionID: "l1", PublicationID: "p1"}}}})
	n1 := nodeCompiledOf(t, res, "n1")
	if n1.NotifyJSON != "" {
		t.Fatalf("没配 notify 时 NotifyJSON 应为空串，实得 %q", n1.NotifyJSON)
	}
	if !n1.Notify().Enabled(model.NotifyKeyAssigned) {
		t.Fatal("空 NotifyJSON 应按默认开处理")
	}
}

// TestNotify_ChannelUnsupportedRejectsPublish：节点级 notify.channels 配了三档之外的值，
// 发布期报 N4_CHANNEL_UNSUPPORTED（复用抄送节点同一个码，不新增码）。
func TestNotify_ChannelUnsupportedRejectsPublish(t *testing.T) {
	doc := f1Lite(t)
	doc.Nodes[1].Config = cfgJSON(t, model.HandleConfig{
		Assignees: []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}}, CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint: "x",
		Notify:      &model.NodeNotify{Channels: []model.NotifyChannel{model.NotifyChannel("carrier_pigeon")}},
	})
	res := compileOK(t, doc, &fakeFreezer{})
	if !hasCode(res.Diagnostics, "N4_CHANNEL_UNSUPPORTED", "n1") || res.Compiled != nil {
		t.Fatalf("非法渠道应拒绝发布，实得 diags=%+v compiled=%v", res.Diagnostics, res.Compiled)
	}
}
