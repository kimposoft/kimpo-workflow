package node

import "github.com/kimposoft/kimpo-workflow/internal/model"

// notify_rules.go 是『通知渠道』发布期校验的共用实现：抄送节点的
// Channels 与四类主线节点（发起/办理/审批/结束）节点级 notify.channels 都要过同一道「渠道
// 必须在三档闭集内」的闸，不能各写一份、各判一次（同 assignee_rules.go 的纪律：同一件事两处
// 各判一次，口径迟早漂）。
//
// 「至少选一种」不算共用逻辑，两边刻意不同口径，各自在调用处判：
//   - 抄送的收件人一定要收到，空渠道就是配置没配完，报 N4_CHANNEL_REQUIRED（cc.go）；
//   - 节点级 notify.channels 空数组按默认处理（NodeNotify.ChannelsOrDefault 兜底仅 system），
//     不报错。

// validateNotifyChannels 校验渠道取值是否都落在三档闭集内（system / sms / email）；空切片
// 本身不在这里报错，是否允许空由调用方决定，这里只挑出非法取值。复用现有诊断码
// N4_CHANNEL_UNSUPPORTED，不新增码——节点级通知渠道与抄送渠道是同一件事的两处入口。
func validateNotifyChannels(nodeID string, channels []model.NotifyChannel) []model.Diagnostic {
	var out []model.Diagnostic
	for _, ch := range channels {
		switch ch {
		case model.NotifyChannelSystem, model.NotifyChannelSMS, model.NotifyChannelEmail:
		default:
			out = append(out, model.NewDiagnostic("N4_CHANNEL_UNSUPPORTED", nodeID, "", map[string]string{"channel": string(ch)}))
		}
	}
	return out
}

// validateNodeNotify 校验节点级 notify 配置（发起/办理/审批/结束四类节点共用）：只查渠道取值
// 合法性；事件开关是 *bool，取值只有「配」或「不配」两种状态，没有非法值可查。notify 为 nil
// （节点没配这个可选键）时直接放行。
func validateNodeNotify(nodeID string, notify *model.NodeNotify) []model.Diagnostic {
	if notify == nil {
		return nil
	}
	return validateNotifyChannels(nodeID, notify.Channels)
}
