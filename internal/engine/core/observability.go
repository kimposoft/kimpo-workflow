package core

import (
	"context"

	"github.com/kimposoft/kimpo-workflow/internal/observability"
)

// observabilityWarn 状态机里「记一笔但不影响结果」的日志出口（支线失败 L9、自动办理条件求值
// 报错 F7 都走它）。集中一处是为了让这类「咽下去但要留痕」的地方一眼数得出来——它们每一个
// 都是潜在的「现场看不出哪里不对」，不该散落在各文件里各写一遍。
func observabilityWarn(ctx context.Context, eventCode, message string, fields map[string]any) {
	observability.Logger(ctx).Warn(ctx, "workflow", "engine", eventCode, message, fields)
}
