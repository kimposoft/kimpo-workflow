/**
 * designer/host.ts —— 把宿主经 hostBridge 注入的各项能力收成一个类型化的 DesignerHost 对象
 * （设计器承载页/壳）。
 *
 * surfaces/index.ts 的 createSurface 分发处从 hostBridge 上逐项取出（domain:workflow-designer /
 * interactiveSession / domain:alice-v4 / domain:expression / ui），本文件只负责"把这几项收成一个
 * 好用的对象 + 供 provide/inject 用的注入键"，不做任何取用/裁剪逻辑（那是 surfaces/index.ts 的
 * 职责，见其头注释）。
 *
 * ── wire 类型来源（SDK 公开契约） ─────────────────────────────────────────────────────────
 * 下面这组 wire 类型直接 import SDK `@kimposoft/plugin-sdk/workflow-designer`（1.1.0-tp.12 起含
 * getEngineInfo）的公开契约，宿主实现同样以编译期断言绑定它（下方别名只为保留插件内既有名字）。
 * WorkflowDesignerHostApi 仍逐方法列出，便于宿主侧按方法清单做静态对拍；与 SDK 接口的结构等价由
 * 文件末尾的双向赋值断言在编译期守护，SDK 改签名时 vue-tsc 直接报错，不靠人工同步。
 * RawDiagnostic 复用 ../model/validate-map.ts 的既有类型（与 SDK WorkflowDiagnostic 字段逐一相同，同受上述断言守护）。
 */
import type { Component, InjectionKey, Ref } from 'vue';
import type { AliceV4Host, ExpressionHost } from '@kimposoft/expression-editor';
import type { HostUi, InteractiveSessionHandle, PluginI18n } from '@kimposoft/plugin-sdk';
import type {
  HostResult,
  WorkflowDefinitionPublishResult,
  WorkflowDefinitionWire as SdkWorkflowDefinitionWire,
  WorkflowDefinitionWithVersions,
  WorkflowDesignerFieldRestriction as SdkWorkflowDesignerFieldRestriction,
  WorkflowDesignerHostApi as SdkWorkflowDesignerHostApi,
  WorkflowDesignerPublishedDefinition as SdkWorkflowDesignerPublishedDefinition,
  WorkflowDesignerTemplateBrief as SdkWorkflowDesignerTemplateBrief,
  WorkflowDesignerTemplateDetail as SdkWorkflowDesignerTemplateDetail,
  WorkflowDesignerTemplateField as SdkWorkflowDesignerTemplateField,
  WorkflowDesignerTemplateTable as SdkWorkflowDesignerTemplateTable,
  WorkflowEngineInfo,
  WorkflowNotifyChannelCapability,
  WorkflowNotifyChannelKey
} from '@kimposoft/plugin-sdk/workflow-designer';
import type { RawDiagnostic } from '../model/validate-map';
import type { WorkflowDocument } from '../model';
import type { WorkflowDocumentState } from '../model/document-state';
import type { NodeTypeDefinition } from './nodes/registry';

export type { WorkflowEngineInfo, WorkflowEngineFeature, WorkflowEngineNodeKind } from '@kimposoft/plugin-sdk/workflow-designer';

// ── 通用响应信封（SDK HostResult：{ data, error } flat 响应形状） ─────────────────────────────
export type HostApiResult<T> = HostResult<T>;
export type HostApiError = NonNullable<HostResult<unknown>['error']>;

/** 流程定义头。 */
export type WorkflowDefinitionWire = SdkWorkflowDefinitionWire;
/** {definition, versions} 是宿主设计面端点的公共响应形状。 */
export type WorkflowDefinitionWithVersionsWire = WorkflowDefinitionWithVersions;
/** 发布成功回执；definition_version_no 缺省（老宿主）时 DesignerRoot 保持原 expectedVersionNo。 */
export type WorkflowDefinitionPublishResultWire = WorkflowDefinitionPublishResult;
export type WorkflowDesignerTemplateBrief = SdkWorkflowDesignerTemplateBrief;
/** 含发布状态的模板详情——createAliceV4Host 是否可用即看 has_active_bundle。 */
export type WorkflowDesignerTemplateDetail = SdkWorkflowDesignerTemplateDetail;
export type WorkflowDesignerTemplateTable = SdkWorkflowDesignerTemplateTable;
export type WorkflowDesignerTemplateField = SdkWorkflowDesignerTemplateField;
/** 单个字段在"该模板挂着的全部授权项"里是否被设过隐藏/只读/禁止导出（任一命中即 true）。 */
export type WorkflowDesignerFieldRestriction = SdkWorkflowDesignerFieldRestriction;
/** 流程三档通知渠道，与 internal/model/node.go NotifyChannel 三档取值对齐。 */
export type WorkflowDesignerNotifyChannelKey = WorkflowNotifyChannelKey;
export type WorkflowDesignerNotifyChannelCapability = WorkflowNotifyChannelCapability;
/** 子流程节点"目标流程"下拉候选（宿主已按 latest_version_no > 0 过滤，只回已发布）。 */
export type WorkflowDesignerPublishedDefinition = SdkWorkflowDesignerPublishedDefinition;

/**
 * WorkflowDesignerHostApi —— hostBridge['domain:workflow-designer'] 的设计面方法（SDK 公开契约，逐方法列出供宿主侧
 * 方法名对拍；createAliceV4Host/createExpressionHost 两项不在这里——它们在宿主侧被单独拆成
 * hostBridge['domain:alice-v4']/['domain:expression'] 两个裸函数键，见 DesignerHost.aliceV4/expression 两个字段与
 * surfaces/index.ts 的取用处）。
 */
export interface WorkflowDesignerHostApi {
  getDefinition(): Promise<HostApiResult<WorkflowDefinitionWithVersionsWire>>;
  saveDraft(draft: WorkflowDocument, expectedVersionNo: number): Promise<HostApiResult<WorkflowDefinitionWithVersionsWire>>;
  validate(draft: WorkflowDocument): Promise<HostApiResult<{ ok: boolean; diagnostics: RawDiagnostic[] }>>;
  /** 发布：diagnostics 与 error/data 同级（宿主发布 409 PUBLISH_REJECTED 时随响应体附带诊断，
   * 见宿主 publishWorkflowDefinition 注释），因此不是 HostApiResult 内部字段而是叠加在结果上。 */
  publish(expectedVersionNo: number): Promise<HostApiResult<WorkflowDefinitionPublishResultWire> & { diagnostics?: RawDiagnostic[] }>;
  setEnabled(enabled: boolean): Promise<HostApiResult<WorkflowDefinitionWithVersionsWire>>;
  listAppTemplates(keyword?: string): Promise<HostApiResult<{ items: WorkflowDesignerTemplateBrief[] }>>;
  getTemplate(templateId: string): Promise<HostApiResult<WorkflowDesignerTemplateDetail>>;
  listTemplateTables(templateId: string): Promise<HostApiResult<{ items: WorkflowDesignerTemplateTable[] }>>;
  listTemplateFields(templateId: string, dataTableId: string): Promise<HostApiResult<{ items: WorkflowDesignerTemplateField[] }>>;
  /** 按模板汇总字段级限制对照（字段权限对话框"模板限制对照列"用）。 */
  templateFieldRestrictions(templateId: string): Promise<HostApiResult<{ fields: WorkflowDesignerFieldRestriction[] }>>;
  /** 本应用下已发布的流程定义清单（子流程节点"目标流程"下拉用）。 */
  listAppWorkflows(): Promise<HostApiResult<{ definitions: WorkflowDesignerPublishedDefinition[] }>>;
  /** 流程三档通知渠道各自是否可用（抄送节点面板渠道置灰用）。 */
  channelCapabilities(): Promise<HostApiResult<{ channels: WorkflowDesignerNotifyChannelCapability[] }>>;
  /**
   * 当前定义绑定引擎的能力（SDK 可选方法，旧宿主没有）。DesignerRoot 据此禁用引擎不支持的
   * 节点、引擎不可用时只读；方法不存在或取不到时按「不限制」处理（见 engine-capabilities.ts）。
   */
  getEngineInfo?(): Promise<HostApiResult<WorkflowEngineInfo>>;
}

/**
 * DesignerHost —— 供 DesignerRoot 与各节点属性面板消费的统一宿主能力面：设计面方法
 * （WorkflowDesignerHostApi 全部方法）+ ui（宿主 UI 服务总线，createHostUi(hostBridge) 的产出）+
 * interactiveSession（Host 交互会话 handle，dirty 上报走它）+ aliceV4/expression 两个按模板 id
 * 现场取宿主桥的工厂（对应 hostBridge['domain:alice-v4']/['domain:expression']，见
 * surfaces/index.ts 取用处的注释）。
 */
export interface DesignerHost extends WorkflowDesignerHostApi {
  /** 当前应用 id（来自宿主 hostContext）：宿主的模板选择与三维选人弹窗都按应用收窄候选。 */
  appId: string;
  /**
   * 当前正在设计的这条流程定义自己的 id（来自宿主 hostContext.definitionId）：子流程节点面板
   * 据此从『目标流程』候选里排除自己，避免设计中的流程把自己设为子流程目标、造成自环（见
   * ../panels/SubflowPanel.vue 消费处）。可选字段——面板单测（designer/panels/panel-test-helpers.ts）
   * 的假 DesignerHost 不含这个字段，老宿主的 hostContext 也可能不带这个键（见 surfaces/index.ts
   * 取用处），因此消费方一律按 `host.definitionId ?? ''` 读取，不假设它总是存在。
   */
  definitionId?: string;
  /** 当前定义绑定的流程引擎插件 ID（宿主 hostContext.enginePluginId；旧宿主不传）。 */
  enginePluginId?: string;
  ui: HostUi;
  interactiveSession: InteractiveSessionHandle;
  /** 按模板 id 取宿主查询服务桥（AliceV4Host）；模板未发布（无可用发布版本）时宿主返回 null，见宿主
   * createAliceV4Host 方法注释。 */
  aliceV4(templateId: string): Promise<AliceV4Host | null>;
  /** 按模板 id 取表达式编辑器宿主桥；宿主侧同步返回，不是 Promise（对齐
   * createWebExpressionHost 的既有签名）。 */
  expression(templateId: string): ExpressionHost;
}

export interface CreateDesignerHostInput {
  hostApi: WorkflowDesignerHostApi;
  /** 当前应用 id，见 DesignerHost.appId。 */
  appId: string;
  /** 当前流程定义 id，见 DesignerHost.definitionId 注释；可选——组装时不传时 DesignerHost.
   *  definitionId 落 undefined，与直接调用方（surfaces/index.ts）不传的效果一致，不强行落空串
   *  （空串会被 SubflowPanel 的 excludeSelf 当成"要排除的 id"参与比较，undefined 才是真正的
   *  "不做任何排除"）。 */
  definitionId?: string;
  /** 当前定义绑定的流程引擎插件 ID，见 DesignerHost.enginePluginId。 */
  enginePluginId?: string;
  ui: HostUi;
  interactiveSession: InteractiveSessionHandle;
  aliceV4(templateId: string): Promise<AliceV4Host | null>;
  expression(templateId: string): ExpressionHost;
}

/** 组装 DesignerHost——单纯的对象拼装，不做任何裁剪/取用判断（那些已经在调用方
 * surfaces/index.ts 完成，见其头注释"缺必需项抛明确错误"）。 */
export function createDesignerHost(input: CreateDesignerHostInput): DesignerHost {
  return {
    ...input.hostApi,
    appId: input.appId,
    definitionId: input.definitionId,
    enginePluginId: input.enginePluginId,
    ui: input.ui,
    interactiveSession: input.interactiveSession,
    aliceV4: input.aliceV4,
    expression: input.expression
  };
}

// ── provide/inject 注入键（DesignerRoot.vue 提供，各节点属性面板消费） ─────────────────

/** 整份 DesignerHost；DesignerRoot 挂载时 props.host 一次性到手，同步 provide，不需要 Ref 包装。 */
export const DESIGNER_HOST_KEY: InjectionKey<DesignerHost> = Symbol('workflow-designer-host');

/**
 * 当前文档状态机；DesignerRoot 要先 await host.getDefinition() 才能造出 WorkflowDocumentState
 * 实例（异步），而 Vue 的 provide() 必须在 setup() 同步阶段调用——因此这里 provide 的是一个
 * `Ref<WorkflowDocumentState | undefined>`（DesignerRoot 在 setup 阶段就同步 provide 这个 ref
 * 本身，稍后数据到手时再给 ref.value 赋值），未加载完成/加载失败时消费方应读到 undefined 并
 * 自行降级（如不渲染任何配置项），不是访问即抛。
 */
export const DESIGNER_STATE_KEY: InjectionKey<Ref<WorkflowDocumentState | undefined>> = Symbol('workflow-designer-state');

/** 插件 i18n 实例（createDesignerI18n 的产出）；DesignerRoot props.i18n 同步到手，直接 provide。 */
export const DESIGNER_I18N_KEY: InjectionKey<PluginI18n> = Symbol('workflow-designer-i18n');

/**
 * NodeTypeDefinition 的前向兼容鸭子类型：节点类型注册表（designer/nodes/<kind>）可带一个可选的
 * `panel` 字段（该节点类型对应的属性面板 Vue 组件），designer/nodes/types.ts 本身不声明它，
 * 故这里单独声明一个叠加类型，shell/PropsPanel.vue 按此类型做鸭子类型读取——注册表侧补上字段
 * 即自动生效，不需要改 PropsPanel.vue。
 */
export type NodeTypeDefinitionWithPanel = NodeTypeDefinition & { panel?: Component };

// ── 编译期双向结构断言：本文件的 WorkflowDesignerHostApi 与 SDK 公开契约等价 ─────────────────────
// 任何一侧改了方法签名（含新增必填方法），vue-tsc 在这两行报错；导出只为避免「声明未使用」。
type AssertAssignable<Target, Source extends Target> = Source;
export type PluginHostApiMatchesSdk = AssertAssignable<SdkWorkflowDesignerHostApi, WorkflowDesignerHostApi>;
export type SdkHostApiMatchesPlugin = AssertAssignable<WorkflowDesignerHostApi, SdkWorkflowDesignerHostApi>;
