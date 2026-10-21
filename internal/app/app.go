// Package app 是流程引擎的顶层装配点：main.go 构造一个 *App，把宿主出站依赖
// （internal/transport/hostclient，经 plugin.WorkflowHostFrom(ctx) 拿宿主七个客户端里的
// 三个）、状态机（internal/engine/core.Engine）、发布期编译器（internal/compile）、
// 应用服务层（internal/engine/app，包名 engineapp）都装配在这里；四个 gRPC server
// （internal/transport/grpc）经它取到 *engineapp.Service。
package app

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	engineapp "github.com/kimposoft/kimpo-workflow/internal/engine/app"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/node"
	"github.com/kimposoft/kimpo-workflow/internal/transport/hostclient"
)

// App 是引擎运行期的依赖容器：目前只装应用服务层；账本存储、节点注册表、
// 出站宿主客户端都已经在 New() 里挂到 Service 上。
type App struct {
	Service *engineapp.Service
}

// New 装配一个 *App：宿主出站五适配器（账本 / 单据 / 表达式 / 候选 / 发起通道，经 SDK
// plugin.WorkflowHostFrom(ctx) 逐请求取客户端）+ 生产时钟 / id 生成器 + 发布期编译器
// （默认节点注册表 + 表达式冻结适配器）。
func New() *App {
	ledger := hostclient.NewLedger()
	record := hostclient.NewRecord()
	expr := hostclient.NewExpression()
	// catalog K4 / N6.10 字段类型闸用的字段目录适配器：生产装配必须注入，否则
	// bindingFieldTypeChecks 与 subflowMappingChecks 会静默跳过（compile.Compiler.catalog
	// 字段注释）。
	catalog := hostclient.NewTemplateCatalog()
	// definitions K3 目标流程状态闸用的定义目录适配器：薄封装 ledger.GetDefinition，
	// 只取定义头、丢弃版本清单——compile.Compiler 不需要知道账本的其余五本账。生产装配必须
	// 注入，否则 subflowMappingChecks 整段跳过（compile.Compiler.definitions 字段注释）。
	definitions := definitionCatalogAdapter{ledger: ledger}
	clock := engineapp.UTCClock{}
	ids := engineapp.RandomIDs{}

	return &App{Service: &engineapp.Service{
		Ledger:   ledger,
		Record:   record,
		Clock:    clock,
		IDs:      ids,
		Launch:   hostclient.NewLaunch(),
		Lease:    hostclient.NewLease(),
		Compiler: compile.New(node.NewDefaultRegistry(), expr, catalog, definitions),
		Engine: &core.Engine{
			Expr:      expr,
			Candidate: hostclient.NewCandidate(),
			Record:    record,
			Launch:    hostclient.NewLaunch(),
			Clock:     clock,
			IDs:       ids,
		},
	}}
}

// definitionCatalogAdapter 实现 ports.DefinitionCatalog：薄封装 hostclient.Ledger.GetDefinition，
// 只把定义头透传出去、丢弃它的第二个返回值（版本清单）——ports.DefinitionCatalog 与
// ports.Ledger 签名不同（后者多带一份版本清单），不能直接互相实现，装配层补一层转换即可，
// 不用为此改 hostclient.Ledger 本身（它仍要满足 ports.Ledger 的原样三返回值签名）。
type definitionCatalogAdapter struct{ ledger *hostclient.Ledger }

func (a definitionCatalogAdapter) GetDefinition(ctx context.Context, appID, definitionID string) (*pb.DefinitionRow, error) {
	def, _, err := a.ledger.GetDefinition(ctx, appID, definitionID)
	return def, err
}
