// Package observability 是本插件的日志出口：统一从入站 ctx 取宿主注入的分级日志器
// （plugin.HostFrom(ctx).Logger()），取不到时退化到标准库 log（stderr），保证任何路径
// 下调用 Logger(ctx) 都能拿到一个可用的记录器，不会因为宿主未注入而 panic。
//
// 插件要在关键位置把不同级别日志信息上报给宿主——四个
// gRPC 服务（internal/transport/grpc）与引擎实现在关键位置（收到请求、发生
// 错误、发布期检查失败等）都应经这里取日志器上报，不要各自直连 fmt/log 散落调用点。
package observability

import (
	"context"
	"log"

	"github.com/kimposoft/kimpo-plugin-sdk/plugin"
)

// stderrLogger 是取不到宿主日志器时的退化实现（形状照 plugin.Logger 接口），
// 只保证不 panic、消息不丢在本地终端，不做攒批。
type stderrLogger struct{}

func (stderrLogger) Debug(_ context.Context, category, module, eventCode, message string, fields map[string]any) {
	log.Printf("[kimpo-workflow][DEBUG][%s/%s] %s: %s %v", category, module, eventCode, message, fields)
}
func (stderrLogger) Info(_ context.Context, category, module, eventCode, message string, fields map[string]any) {
	log.Printf("[kimpo-workflow][INFO][%s/%s] %s: %s %v", category, module, eventCode, message, fields)
}
func (stderrLogger) Warn(_ context.Context, category, module, eventCode, message string, fields map[string]any) {
	log.Printf("[kimpo-workflow][WARN][%s/%s] %s: %s %v", category, module, eventCode, message, fields)
}
func (stderrLogger) Error(_ context.Context, category, module, eventCode, message string, fields map[string]any) {
	log.Printf("[kimpo-workflow][ERROR][%s/%s] %s: %s %v", category, module, eventCode, message, fields)
}
func (stderrLogger) Fatal(_ context.Context, category, module, eventCode, message string, fields map[string]any) {
	log.Printf("[kimpo-workflow][FATAL][%s/%s] %s: %s %v", category, module, eventCode, message, fields)
}
func (stderrLogger) Emit(_ context.Context, severity, category, module, eventCode, message string, fields map[string]any) {
	log.Printf("[kimpo-workflow][%s][%s/%s] %s: %s %v", severity, category, module, eventCode, message, fields)
}
func (stderrLogger) Flush() {}

// Logger 从 ctx 取宿主注入的分级日志器；ctx 里没有宿主句柄（尚未接入 hostInjector 拦截器的
// 路径，例如单测）时返回 stderrLogger，调用方无需判空。
func Logger(ctx context.Context) plugin.Logger {
	if host := plugin.HostFrom(ctx); host != nil {
		if l := host.Logger(); l != nil {
			return l
		}
	}
	return stderrLogger{}
}
