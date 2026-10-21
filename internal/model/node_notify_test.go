package model

import (
	"encoding/json"
	"testing"
)

func boolPtr(b bool) *bool { return &b }

// TestNodeNotify_Enabled_NilReceiverDefaultsOpen：nil 接收者（节点整个没配 notify）、nil 开关
// （配了 notify 但没配这个键）、以及不认识的 key，三种情况都按「开」处理。
func TestNodeNotify_Enabled_NilReceiverDefaultsOpen(t *testing.T) {
	var n *NodeNotify
	if !n.Enabled(NotifyKeyAssigned) {
		t.Fatal("nil 接收者应按默认开处理")
	}
	n = &NodeNotify{}
	if !n.Enabled(NotifyKeyReturned) {
		t.Fatal("配了 notify 但没配这个键应按默认开处理")
	}
	if !n.Enabled("on_unknown_future_event") {
		t.Fatal("不认识的 key 应按默认开处理，不能把新事件当成关闭")
	}
}

// TestNodeNotify_Enabled_ExplicitFalse：显式配 false 才是真正关闭；配 true 与不配同一效果。
func TestNodeNotify_Enabled_ExplicitFalse(t *testing.T) {
	n := &NodeNotify{OnAssigned: boolPtr(false), OnReturned: boolPtr(true)}
	if n.Enabled(NotifyKeyAssigned) {
		t.Fatal("显式 false 应当关闭")
	}
	if !n.Enabled(NotifyKeyReturned) {
		t.Fatal("显式 true 应当打开")
	}
	// 五个键各自独立：只关 OnAssigned 不该连带关掉其余没配的键。
	if !n.Enabled(NotifyKeyWithdrawn) || !n.Enabled(NotifyKeyTerminated) || !n.Enabled(NotifyKeyEnded) {
		t.Fatal("没配的键不该被其它键的显式 false 连带关闭")
	}
}

// TestNodeNotify_ChannelsOrDefault：nil 接收者与空数组都兜底为仅 system；配了非空渠道原样返回。
func TestNodeNotify_ChannelsOrDefault(t *testing.T) {
	var n *NodeNotify
	if got := n.ChannelsOrDefault(); len(got) != 1 || got[0] != NotifyChannelSystem {
		t.Fatalf("nil 接收者应兜底仅 system，实得 %v", got)
	}
	n = &NodeNotify{}
	if got := n.ChannelsOrDefault(); len(got) != 1 || got[0] != NotifyChannelSystem {
		t.Fatalf("空数组应兜底仅 system，实得 %v", got)
	}
	n = &NodeNotify{Channels: []NotifyChannel{NotifyChannelSystem, NotifyChannelEmail}}
	got := n.ChannelsOrDefault()
	if len(got) != 2 || got[0] != NotifyChannelSystem || got[1] != NotifyChannelEmail {
		t.Fatalf("配了渠道应原样返回，实得 %v", got)
	}
}

// TestNodeNotify_JSONRoundTrip_KeyAbsentVsExplicitFalse：JSON 编解码时「键缺席」与「显式
// false」必须保持可分辨——这是 *bool 而不是 bool 的存在意义，往返一次不能把二者混同。
func TestNodeNotify_JSONRoundTrip_KeyAbsentVsExplicitFalse(t *testing.T) {
	raw := []byte(`{"on_returned":false,"channels":["system","email"]}`)
	var n NodeNotify
	if err := json.Unmarshal(raw, &n); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if n.OnAssigned != nil {
		t.Fatalf("on_assigned 键缺席应解出 nil，实得 %v", n.OnAssigned)
	}
	if n.OnReturned == nil || *n.OnReturned != false {
		t.Fatalf("on_returned 显式 false 应解出非 nil 的 false，实得 %v", n.OnReturned)
	}
	if !n.Enabled(NotifyKeyAssigned) {
		t.Fatal("on_assigned 缺席应按开处理")
	}
	if n.Enabled(NotifyKeyReturned) {
		t.Fatal("on_returned 显式 false 应按关处理")
	}
}
