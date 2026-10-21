// Command plugin 是流程引擎插件的独立 sidecar 入口。
//
// app.New() 装配好接了宿主出站适配器的 *engineapp.Service，注册 DirectionWorkflow
// 方向（挂载四个 gRPC 服务——DefinitionService / InstanceService / TaskService /
// AdminService，均接到该 Service；少数仍为冻结壳的方法返回 codes.Unimplemented，见
// internal/transport/grpc/errors.go 包注释），交由 SDK 内核 plugin.Serve 托管：解析 flag/env ->
// 自检(manifest) -> 起 gRPC server -> 回连宿主 -> 监听并优雅退出。
package main

import (
	_ "embed"
	"encoding/json"
	"log"
	"os"

	"google.golang.org/grpc"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowenginev1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/app"
	workflowgrpc "github.com/kimposoft/kimpo-workflow/internal/transport/grpc"
)

const Version = "1.0.0"

// 内嵌 manifest 供内核启动自检（声明=实现）。本文件旁的 manifest.json 是构建期由
// `make sync-manifest` 从仓库根 manifest.json 复制的派生副本（go:embed 禁止跨目录引用
// ../..），勿手改——改声明一律改仓库根那份，build.sh 每次构建前都会重新同步。
//
//go:embed manifest.json
var manifest []byte

// pluginConfig 是 config.schema.json 声明的两个可配项在 Go 侧的镜像。
type pluginConfig struct {
	LogLevel     string `json:"log_level"`
	AutoHopLimit int    `json:"auto_hop_limit"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		log.Printf("kimpo-workflow v%s", Version)
		return
	}

	opts := plugin.ParseFlags()
	opts.Manifest = manifest

	if rawConfig, err := opts.LoadConfig(); err == nil {
		if _, cfgErr := parsePluginConfig(rawConfig); cfgErr != nil {
			log.Printf("[kimpo-workflow] parse config skipped: %v", cfgErr)
		}
		// LogLevel 由 SDK 自己生效：plugin.Serve 回连宿主时会独立解析 config.json 的
		// log_level，据此设分级日志器的 min_severity 门槛，不经本地 pluginConfig 中转。
		// 本地这份解析只为尽早校验 config.json 格式（解析失败要出可见日志，不静默吞掉）。
		// AutoHopLimit（自动连续办理上限）目前在此尚无消费方。
	} else if opts.ConfigPath != "" {
		log.Printf("[kimpo-workflow] read config skipped: %v", err)
	}

	application := app.New()

	// 四个 gRPC 服务挂在同一个 DirectionWorkflow 注册项下；内核按 manifest.capabilities
	// .directions 做「声明=实现」的一致性自检（见 plugin.validateManifest）。
	registration := plugin.NewRegistration(plugin.DirectionWorkflow, func(s *grpc.Server) {
		mountServices(s, application)
	})

	if err := plugin.Serve(opts, registration); err != nil {
		log.Fatalf("[kimpo-workflow] %v", err)
	}
}

// mountServices 把四个 gRPC 服务注册到 server，四个构造函数都接 application.Service
// （记录 / 定义生命周期等仍为冻结壳的方法见 internal/transport/grpc/admin.go）。
func mountServices(s *grpc.Server, application *app.App) {
	workflowenginev1.RegisterDefinitionServiceServer(s, workflowgrpc.NewDefinitionServer(application.Service))
	workflowenginev1.RegisterInstanceServiceServer(s, workflowgrpc.NewInstanceServer(application.Service))
	workflowenginev1.RegisterTaskServiceServer(s, workflowgrpc.NewTaskServer(application.Service))
	workflowenginev1.RegisterAdminServiceServer(s, workflowgrpc.NewAdminServer(application.Service))
}

func parsePluginConfig(raw []byte) (pluginConfig, error) {
	var cfg pluginConfig
	if len(raw) == 0 {
		return cfg, nil
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}
