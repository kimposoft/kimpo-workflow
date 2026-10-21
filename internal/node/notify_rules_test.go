package node

import (
	"encoding/json"
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// —— 测试夹具：另外三类主线节点的 Config 封装成 *model.Node（approveNode/ccNode 已在
// approve_test.go / cc.go 所在包内，这里补齐发起/办理/结束三个） ——

func startNode(t *testing.T, cfg model.StartConfig) *model.Node {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal start config: %v", err)
	}
	return &model.Node{ID: "n0", Kind: model.NodeKindStart, Name: "发起", Config: raw}
}

func handleNode(t *testing.T, cfg model.HandleConfig) *model.Node {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal handle config: %v", err)
	}
	return &model.Node{ID: "n1", Kind: model.NodeKindHandle, Name: "部门办理", Config: raw}
}

func endNode(t *testing.T, cfg model.EndConfig) *model.Node {
	t.Helper()
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal end config: %v", err)
	}
	return &model.Node{ID: "n2", Kind: model.NodeKindEnd, Name: "结束", Config: raw}
}

func boolPtr(b bool) *bool { return &b }

// TestValidateNotifyChannels_ClosedSet 渠道闭集校验的独立单测：三档放行，未知值报
// N4_CHANNEL_UNSUPPORTED；空切片本身不在这里报错（是否允许空由调用方决定）。
func TestValidateNotifyChannels_ClosedSet(t *testing.T) {
	if got := validateNotifyChannels("n1", nil); len(got) != 0 {
		t.Fatalf("空切片不该报错，实得 %+v", got)
	}
	if got := validateNotifyChannels("n1", []model.NotifyChannel{model.NotifyChannelSystem, model.NotifyChannelSMS, model.NotifyChannelEmail}); len(got) != 0 {
		t.Fatalf("三档都合法，实得 %+v", got)
	}
	got := validateNotifyChannels("n1", []model.NotifyChannel{model.NotifyChannel("carrier_pigeon")})
	if len(got) != 1 || got[0].Code != "N4_CHANNEL_UNSUPPORTED" {
		t.Fatalf("未知渠道应报 N4_CHANNEL_UNSUPPORTED，实得 %+v", got)
	}
}

// TestNodeNotify_ChannelValidation_WiredIntoFourKinds：发起/办理/审批/结束四类节点的
// Validate 都接上了节点级 notify.channels 的闭集校验，不新增诊断码——复用
// N4_CHANNEL_UNSUPPORTED，与抄送节点渠道校验同一个码。
func TestNodeNotify_ChannelValidation_WiredIntoFourKinds(t *testing.T) {
	bad := []model.NotifyChannel{model.NotifyChannel("carrier_pigeon")}

	startCfg := model.StartConfig{TargetTemplateID: "tpl-1", AllowManualStart: true, NoRouteHint: "无路可走", Notify: &model.NodeNotify{Channels: bad}}
	if !codes(NewStartHandler().Validate(nil, startNode(t, startCfg)))["N4_CHANNEL_UNSUPPORTED"] {
		t.Fatal("发起节点 notify.channels 非法值应报 N4_CHANNEL_UNSUPPORTED")
	}

	handleCfg := model.HandleConfig{
		Assignees:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint:  "没有可走的路线",
		Notify:       &model.NodeNotify{Channels: bad},
	}
	if !codes(NewHandleHandler().Validate(nil, handleNode(t, handleCfg)))["N4_CHANNEL_UNSUPPORTED"] {
		t.Fatal("办理节点 notify.channels 非法值应报 N4_CHANNEL_UNSUPPORTED")
	}

	approveCfg := model.ApproveConfig{
		Approvers:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		Buttons:      []model.ApprovalButton{{ID: "b1", Name: "同意", Action: model.ButtonActionSubmitApprove}},
		NoRouteHint:  "x",
		Notify:       &model.NodeNotify{Channels: bad},
	}
	if !codes(NewApproveHandler().Validate(nil, approveNode(t, approveCfg)))["N4_CHANNEL_UNSUPPORTED"] {
		t.Fatal("审批节点 notify.channels 非法值应报 N4_CHANNEL_UNSUPPORTED")
	}

	endCfg := model.EndConfig{EndFlag: "已通过", Notify: &model.NodeNotify{Channels: bad}}
	if !codes(NewEndHandler().Validate(nil, endNode(t, endCfg)))["N4_CHANNEL_UNSUPPORTED"] {
		t.Fatal("结束节点 notify.channels 非法值应报 N4_CHANNEL_UNSUPPORTED")
	}
}

// TestNodeNotify_EmptyOrNilDoesNotError：notify 整体不配、或配了但 channels 留空，都不报错——
// 事件开关缺席=默认开、渠道缺席=默认仅 system，两者都是合法的「没配」，不是「配错」。
func TestNodeNotify_EmptyOrNilDoesNotError(t *testing.T) {
	base := model.HandleConfig{
		Assignees:    []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: model.IDList{22}}},
		CompleteMode: model.CompleteMode{Kind: model.CompleteModeAny},
		NoRouteHint:  "没有可走的路线",
	}
	if got := NewHandleHandler().Validate(nil, handleNode(t, base)); len(got) != 0 {
		t.Fatalf("没配 notify 不该有诊断，实得 %+v", got)
	}
	base.Notify = &model.NodeNotify{OnAssigned: boolPtr(false)} // 只关一个开关，渠道留空
	if got := NewHandleHandler().Validate(nil, handleNode(t, base)); len(got) != 0 {
		t.Fatalf("配了 notify 但渠道留空不该有诊断，实得 %+v", got)
	}
}
