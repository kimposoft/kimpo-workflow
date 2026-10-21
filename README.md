# kimpo-workflow（流程引擎）

Kimpo 官方「流程引擎」插件的源码。插件 ID：`com.kimposoft.workflow`。

面向业务设计者与业务用户的审批 / 办理流程插件：设计者在流程设计器里画流程图、配置节点；业务用户在宿主的任务中心与办理面上发起、办理、审批、退回、撤销；管理员在流程管理里处置实例。

- **节点**：开始（START）、办理（HANDLE）、审批（APPROVE）、抄送（CC）、子流程（SUBFLOW）、结束（END）；
- **能力**：任务分派（指定用户 / 部门 / 角色 / 上级等人员来源）、引导线条件选路、按比例通过、自动办理、退回、撤销、子流程、写结束标识失败等异常的停驻与恢复；
- **设计器**：`workflow-designer` surface，画布基于 [AntV X6](https://x6.antv.antgroup.com/)，条件与取值表达式复用 [`@kimposoft/expression-editor`](https://www.npmjs.com/package/@kimposoft/expression-editor)。

## 架构（表归宿主，引擎纯计算）

```
宿主 ──gRPC kimpo.workflow.engine.v1──▶ internal/transport/grpc ──▶ internal/engine/app（装载 → 决策 → 写字段 → 提交）
                                                                        │
                                                                        ▼
                                                                internal/engine/core（状态机，无 I/O）
                                                                        │ ports（账本 / 表达式 / 候选人 / 单据）
                                                                        ▼
                         internal/transport/hostclient ──gRPC kimpo.workflow.host.v1──▶ 宿主账本 / 表达式 / 单据服务
```

- 流程定义、实例、步骤等数据表在宿主应用库；引擎经 `LedgerService` 读聚合、提交变更集（实例行 CAS + 请求幂等键 + 发件箱同事务）。引擎不写派生表，记录状态 / 待办索引等投影由宿主完成。
- 单令牌不变量：未结束的实例恰有一条活动步骤，每次决策后自检。
- 发布期编译器（`internal/compile`）把设计器文档编译成运行期只读的编译产物，并冻结其中的表达式。

## 目录结构

```
manifest.json            插件声明（唯一权威）；cmd/plugin/manifest.json 是 go:embed 用的副本，由 make sync-manifest / build.sh 同步
config.schema.json       插件配置：log_level、auto_hop_limit（一次流转里连续自动办理的步骤上限）
cmd/plugin/main.go       sidecar 入口：注册 workflow 方向，挂载 Definition / Instance / Task / Admin 四个 gRPC 服务
internal/model/          流程文档模型、状态常量、节点配置解码
internal/node/           节点类型注册表与节点校验
internal/compile/        发布期编译器
internal/engine/         状态机（core）、应用服务层（app）、端口接口（ports）
internal/transport/      引擎 gRPC 服务端（grpc）与宿主 gRPC 客户端（hostclient）
internal/testkit/        内存账本与测试替身
capability-knowledge/    流程能力说明（供 Kimpo 内的 AI 助手检索）
frontend/                流程设计器前端（Vue 3 + naive-ui + AntV X6）
scripts/kpp-integrity.mjs 打包时给 manifest 写入包内文件 sha256（integrity）
```

## 依赖

- Go ≥ 1.25
- Node.js 18+ 与 npm
- Kimpo 插件 SDK：Go 模块 [`github.com/kimposoft/kimpo-plugin-sdk`](https://github.com/kimposoft/kimpo-plugin-sdk) `v1.1.0-tp.20`（见 `go.mod`；不使用 `replace` / `go.work`），前端包 [`@kimposoft/plugin-sdk`](https://www.npmjs.com/package/@kimposoft/plugin-sdk) `1.1.0-tp.20`
- 前端共享包：`@kimposoft/expression-editor` `1.1.0-tp.2`（打进 bundle）、`@kimposoft/ui-kit` `1.1.0-tp.2`（见下文「运行期依赖」）；AntV X6 及其插件（MIT，打进 bundle）
- 打包与预检：`zip`，以及 SDK 自带的签名 / 预检工具 `kimpo-plugin-sign`

以上 Kimpo 包均为预览版。

## 运行期依赖（宿主提供）

前端 UMD 产物把下面三个依赖外部化，不打进 bundle，运行时由 Kimpo 宿主以全局变量注入：

| 包 | 全局变量 |
|---|---|
| `vue` | `Vue` |
| `naive-ui` | `naive` |
| `@kimposoft/ui-kit` | `KimpoUi` |

`frontend/package.json` 里把它们列为 devDependencies / peerDependencies，只用于本地类型检查、单测与构建；脱离 Kimpo 宿主单独加载 `plugin.umd.js` 不能运行。

## 从源码构建 .kpp

```sh
# 可选：先装好预检工具（不装时 build.sh 会用 go run 临时编译）
GOWORK=off go install github.com/kimposoft/kimpo-plugin-sdk/cmd/kimpo-plugin-sign@v1.1.0-tp.20

bash build.sh                          # 本机平台
GOOS=linux GOARCH=amd64 bash build.sh  # 实例跑在 Linux x86-64 服务器上时
```

`build.sh` 依次执行：同步 `cmd/plugin/manifest.json` → `go vet` → `go test` → `go build`（产出 `plugin.bin`）→ 前端 `npm ci` → `npm test`（vitest）→ `vite build`（单个 UMD 文件 `frontend/dist/plugin.umd.js`，样式内联）→ 组装 `.kpp` 并写入 integrity → `kimpo-plugin-sign lint`，产物在 `release/<插件ID>-<版本>-<GOOS>-<GOARCH>.kpp`。`plugin.bin` 必须与 Kimpo 实例运行的平台一致。只想跑后端单测：`make test`；前端开发在 `frontend/` 下用 `npm test`、`npm run typecheck`、`npm run build`。

包内结构：`manifest.json`、`plugin.bin`、`schema/config.schema.json`、`frontend/plugin.umd.js`、`frontend/locales/`、`capability-knowledge/`。

## 关于签名与插件 ID

- `com.kimposoft.*` / `com.kimpo.*` 是 Kimposoft 保留命名空间。**官方签名的安装包只由 Kimposoft 发布**，本仓库不含任何签名私钥。
- 用本仓库源码自行构建的包没有官方签名，宿主会按官方命名空间拦截安装；`kimpo-plugin-sign lint` 也会报 `reserved_plugin_namespace` 错误。
- 如需安装自己构建的版本，请把 `manifest.json` 的 `plugin_id`、`i18n.namespace` 和 `capability-knowledge/provider.json` 的 `provider` 改成你自己的插件 ID（如 `com.example.workflow`），并按需修改 `capabilities.frontend.global_name`、`frontend_global_name` 与 `frontend/vite.config.ts` 里的 UMD 全局名（三者必须一致），以第三方插件身份安装；签名用你自己的密钥（`KIMPO_PLUGIN_SIGNING_KEY_FILE=<私钥文件> bash build.sh`），流程见 SDK 文档 `docs/third-party/`（流程引擎方向见 `editor-workflow-designer.md`）。
- 流程宿主面 RPC（`kimpo.workflow.host.v1.*`）中的写类方法属于敏感级权限，第三方身份安装后需管理员在插件授权里补授。
- 流程设计器 surface（`workflow-designer`）依赖的 `domain:workflow-designer`、`domain:alice-v4`、`domain:expression` 宿主能力只对官方插件开放（lint `host_cap_official_only`），该挂载点也不支持第三方沙箱档（`surface_iframe_unsupported`）。以第三方身份构建时请去掉 manifest 里的 `entry.frontend`、`frontend_global_name` 与 `capabilities.frontend`，只装后端引擎（`internal/transport/grpc/conformance_test.go` 会按第三方口径校验 manifest，去掉前端后即可通过）。

## 许可证

[Apache License 2.0](LICENSE)，Copyright 2026 金宝量行（无锡）软件有限公司，附加声明见 [NOTICE](NOTICE)。Kimpo 名称与 logo 图形是金宝量行（无锡）软件有限公司的商标标识，Apache-2.0 不授予商标使用权。
