/**
 * designer/nodes/types.ts —— 节点类型注册表（registry.ts）的公共类型。
 *
 * 独立成文件（而不是塞进 registry.ts）是为了打破循环 import：registry.ts 汇总各类型子目录
 * （start/handle/end/…）导出的定义对象，各子目录反过来需要 NodeTypeDefinition 这个类型来
 * 声明自己的定义——registry.ts 不能同时是"被 import 方"又"import 方"，类型单独放一层即可
 * 用 `import type` 打破这层循环（类型导入不产生运行时依赖边，TS 不会报循环）。
 */
import type { NodeKind, WorkflowNode } from '../../model';

/**
 * SummarizeContext —— summarize() 求值节点卡片摘要时可选的名字解析器。
 *
 * 设计器模型层不接入宿主 SDK/CandidateService，因此不持有真实的用户/角色/部门名字
 * 目录；解析函数由调用方（节点属性面板/画布壳）按需注入。三个解析器均可省略——
 * 省略或解析不到（返回 undefined）时，summarize() 统一退化为"已配置 N 项来源"这类纯计数文案
 * （不直接拼错误的名字，也不留空摘要），不是"没配置来源"的误判，见各 summarize 实现注释。
 */
export interface SummarizeContext {
  /** 按用户 id 解出展示名；查不到返回 undefined。 */
  resolveUserName?(userId: string): string | undefined;
  /** 按角色 id 解出展示名；查不到返回 undefined。 */
  resolveRoleName?(roleId: string): string | undefined;
  /** 按部门 id 解出展示名；查不到返回 undefined。 */
  resolveDepartmentName?(departmentId: string): string | undefined;
  /**
   * 『发起人』来源的展示名解析器：与上面三个不同，initiator 不依赖任何
   * host 数据（条目形状恒为 { kind: 'initiator' }，无 id 可解析）——它需要的只是"发起人"这三个
   * 字按当前语言的翻译。本层（designer/nodes/*）没有 i18n，因此仍按同一套"调用方注入解析器"
   * 的模式交给持有 i18n 的上层（如未来接线 DesignerRoot.vue 时用 `() => props.i18n.t(...)`），
   * 不在这里写死中文——与 resolveUserName 等同一分工，只是不需要参数。
   */
  resolveInitiatorLabel?(): string | undefined;
}

/**
 * NodeSummary —— 节点卡片副标题（画布第二行）的求值结果："四语键 + 参数"，不直接拼中文
 * （硬约束"文案面向业务设计者"的一部分：本层不认识调用方当前语言，翻译交给持有 i18n 的上层，
 * 见 designer/graph-bridge.ts toGraphNodes 对 summaries 的消费方式）。
 */
export interface NodeSummary {
  /** i18n key，格式统一为 workflow.designer.node.summary.<name>（见各节点目录 summarize 实现）。 */
  key: string;
  /** 文案插值参数（{name} 占位），可能包含从 SummarizeContext 解出的真实姓名/部门名等业务数据
   * （数据本身不需要翻译，只有周围的句式模板需要，因此允许出现在 params 里）。 */
  params?: Record<string, string | number>;
}

/**
 * DefaultConfigI18n —— createDefaultConfig() 可选注入的"按当前语言取一段文案"能力（审批
 * 节点默认两个按钮的名称/结果标识需要按设计者当前语言生成）。
 *
 * 只声明本层真正用到的一个方法（鸭子类型），不直接 import @kimposoft/plugin-sdk 的 PluginI18n——
 * 本文件与整条 designer/nodes/* 子目录被 model/document-state.ts 引用（见其 addNode 方法），
 * 而 document-state.ts 头注释明写"纯 TS，零 Vue/零 X6 依赖"，不应该因为这一处需求就让 model 层
 * 间接耦合 SDK 的具体 i18n 实现类型；真正的 PluginI18n（.t 签名是 `t(key, params?)`）结构上
 * 完全兼容本接口，调用方（designer/DesignerRoot.vue）直接把 props.i18n 传进来即可，无需转换。
 */
export interface DefaultConfigI18n {
  t(key: string): string;
}

/**
 * NodeTypeDefinition —— 单个节点类型（NodeKind 的一档）的完整行为描述，是"节点类型注册表"
 * 机制的最小单元。新增节点类型时，只需要在 designer/nodes/ 下
 * 新增一个同构的子目录并在 registry.ts 里追加进列表——不改动任何消费方的 switch/if-else
 * （画布/面板/stencil 一律经 registry.ts 的 getNodeTypeDefinition/list* 取数据），这正是
 * "可扩展、不改表不写 switch"的落地方式。
 */
export interface NodeTypeDefinition {
  /** 节点类型，同 WorkflowNode.kind。 */
  kind: NodeKind;
  /** 节点类型展示名的 i18n key（四语），画布/面板/形状面板统一从这里取"类型名"文案，不在
   * 本层写死中文（同 NodeSummary.key 的既定分工）。约定格式 workflow.designer.node.<kind>。 */
  labelKey: string;
  /**
   * 新建该类型节点时的默认 config（对齐后端 model.<Kind>Config 的最小合法占位，未填字段留给
   * 用户在属性面板补齐）。每次调用返回全新对象，调用方可以直接持有、修改，不会互相污染。
   *
   * 返回类型是 WorkflowNode.config 自身的宽类型 Record<string, unknown>，不是各类型专属的
   * StartConfig/HandleConfig/EndConfig——本接口要同时容纳全部节点类型的定义对象（见 registry.ts
   * ALL_NODE_TYPES 数组），TS 的具名 interface 不带隐式索引签名，没法既保留"每类专属的窄类型"
   * 又装进同一个数组（试过 `NodeTypeDefinition<TConfig>` 泛型方案，会在数组字面量的协变检查上
   * 报"Index signature for type 'string' is missing"）。各节点目录内部的 createDefaultConfig
   * 实现仍然按专属类型手写并用 `satisfies` 做内部校验（如 StartConfig），只是导出到本接口这一
   * 层收窄为宽类型，与 WorkflowNode.config 字段本身的类型完全对齐，调用方（document-state.ts/
   * defaults.ts/stencil/index.ts）本就是直接把返回值塞进 WorkflowNode.config，不需要再窄化。
   *
   * i18n 参数可选：绝大多数类型（start/handle/end）不需要它，默认配置里没有任何
   * 文案要按当前语言生成；只有 approve 会用它生成默认按钮的名称/结果标识。调用方没有 i18n 上下
   * 文时（如单测直接调用、或 model 层的 defaults.ts 构造空白文档）留空即可，approve 自己会退回
   * manifest 默认语言 zh-CN 的文案，不会崩、也不会拼出空字符串（见 nodes/default-i18n-fallback.ts）。
   */
  createDefaultConfig(i18n?: DefaultConfigI18n): Record<string, unknown>;
  /** 该类型节点是否允许被删除（发起节点是流程入口，恒不可删）。 */
  canDelete: boolean;
  /** 是否允许从形状面板拖拽/双击新建（发起节点恒由文档自带、面板不提供新建入口）。 */
  canAddFromStencil: boolean;
  /** 同一文档内该类型节点数量上限；undefined 表示不限（当前只有 start=1）。 */
  maxCount?: number;
  /** 是否末级节点类型（同 model/document.ts isTerminalNode 的权威判据，这里按类型登记一次，
   * 避免消费方各自维护一份"哪些 kind 算末级"的判断）。 */
  isTerminal: boolean;
  /**
   * 求值节点卡片副标题摘要（画布第二行"不点开面板也能读懂整条流程"）。ctx 缺省时（或字段内
   * 解析器缺省）统一走计数兜底文案，不是错误态——见 SummarizeContext 头注释。返回 undefined
   * 表示该节点当前没有值得摘要的配置（画布退化为单行居中，不留空行占位，同 GraphNodeView.summary
   * 注释）。
   */
  summarize(node: WorkflowNode, ctx?: SummarizeContext): NodeSummary | undefined;
}
