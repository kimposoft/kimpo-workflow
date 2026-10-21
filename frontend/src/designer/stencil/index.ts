/**
 * designer/stencil —— 节点模板入口，条目生成由"节点类型注册表"驱动，覆盖 V2 六类节点
 * （NodeKind，见 ../../model/document.ts）。
 *
 * STENCIL_ITEMS 由 ../nodes/registry.ts 的"节点类型注册表"派生（只列 canAddFromStencil===true
 * 的类型），只需要在 registry.ts 里追加登记，本文件的 STENCIL_ITEMS/NODE_TYPE_LABELS 自动跟着
 * 长出新条目，不需要再手工加数组项（本文件仍要在 STENCIL_GROUP_META 里补一条分组/展示态信息，
 * 见其注释）。
 *
 * group/labelZh/descriptionZh 三项是"形状面板怎么摆放/怎么兜底显示"这层展示态信息，不属于
 * 节点类型注册表的职责（registry.ts 只管"这个类型能不能删/能不能拖入面板/默认配置长什么样"
 * 这类跨面板通用的行为语义，见其头注释"唯一入口"）——面板分组本身是纯粹的 UI 归类，与节点
 * 类型定义正交，因此继续留在本文件按 kind 单独维护一份小映射，不塞进 registry.ts。
 *
 * 本文件不依赖 Vue：目录数据 + 节点工厂函数是纯 TS，供工具条按钮/拖拽面板直接调用。
 */
import { type NodeKind, type WorkflowNode } from '../../model';
import { getNodeTypeDefinition, listStencilNodeTypeDefinitions } from '../nodes/registry';
import { createEntityId, type NodePosition } from '../../model/store';

/** 形状面板分组——分组本身走 i18n（i18n key 前缀为
 * workflow.designer.stencil.group.<group>），这里只固定分组的排列顺序与成员。
 *   - human：人工节点，需要真人在任务中心处理；
 *   - aux：辅助节点——抄送、子流程都属于辅助节点，可穿插在主线里，也可作为末级节点，与 human 组"需要真人处理待办"的语义不同
 *     （抄送不产生待办、子流程是发起另一条流程），单独成组不与 human 混放；
 *   - control：流程控制，决定路由/生命周期而非处理业务。
 * 'start' 不在任何分组里——画布上恒有且唯一一个开始节点，面板不提供"新增开始节点"的入口，
 * 避免用户拖出第二个开始节点。
 * 只保留有成员的三档，不留恒为空的分组占位。 */
export type StencilGroup = 'human' | 'aux' | 'control';
export const STENCIL_GROUPS: StencilGroup[] = ['human', 'aux', 'control'];

/** 画布上可插入的节点模板目录条目。key 就是 NodeKind 本身（没有分支结构块之类的伪键）。 */
export interface StencilItem {
  key: NodeKind;
  group: StencilGroup;
  labelZh: string;
  descriptionZh: string;
  /** 暂时不对设计者开放的条目（预留：若某类型先登记了目录条目但配置面板还没做完，可用本字段
   * 隐藏新建入口而不影响 NODE_TYPE_LABELS 兜底展示，见 StencilPanel.vue 该字段消费处注释）。 */
  hidden?: boolean;
}

/** 'start' 不在 STENCIL_ITEMS 目录里（面板恒不提供新增开始节点的入口），但画布节点的兜底显示名
 * （NODE_TYPE_LABELS，见下）仍需要覆盖它，因此单独固化一份中文标签。 */
const START_LABEL_ZH = '开始';

/** 按 kind 维护的面板展示态信息（分组 + 兜底中文标签/描述），键集合与 registry.ts 当前登记的
 * canAddFromStencil 类型保持同步——新登记一个可拖入面板的类型时，这里也要补一条，否则该条目
 * 在 STENCIL_GROUP_META 缺失时会被下方 STENCIL_ITEMS 生成逻辑跳过（宁可"接线没配完整时不显示
 * 该条目"，也不要面板渲染出一个没有分组的条目——见下方过滤逻辑注释）。 */
const STENCIL_GROUP_META: Partial<Record<NodeKind, { group: StencilGroup; labelZh: string; descriptionZh: string }>> = {
  // 人工节点：需要真人在任务中心处理。
  handle: { group: 'human', labelZh: '办理', descriptionZh: '复杂业务数据的填写/提交节点' },
  approve: { group: 'human', labelZh: '审批', descriptionZh: '对单据审批同意或退回，不修改单据内容' },
  // 辅助节点：不产生待办任务，可穿插主线也可作末级节点。
  cc: { group: 'aux', labelZh: '抄送', descriptionZh: '把单据知会给一批人，不产生待办任务' },
  subflow: { group: 'aux', labelZh: '子流程', descriptionZh: '用当前单据的数据发起另一条流程' },
  // 流程控制：决定路由/生命周期，不处理业务数据本身。
  end: { group: 'control', labelZh: '结束', descriptionZh: '流程结束节点' }
};

/** 形状面板条目目录：由 ../nodes/registry.ts 的"节点类型注册表"派生（只列 canAddFromStencil
 * 的类型），不再手工穷举——见文件头注释。某个已登记类型若暂时没有对应的 STENCIL_GROUP_META
 * （理论不应发生，防御性处理：新类型接线时若漏配分组元数据，该条目静默不出现在面板里，而不是
 * 渲染出一个分组缺失的坏条目）。 */
export const STENCIL_ITEMS: StencilItem[] = listStencilNodeTypeDefinitions()
  .map((def) => {
    const meta = STENCIL_GROUP_META[def.kind];
    return meta ? { key: def.kind, group: meta.group, labelZh: meta.labelZh, descriptionZh: meta.descriptionZh } : undefined;
  })
  .filter((item): item is StencilItem => item !== undefined);

/** 画布节点兜底显示名的唯一来源，覆盖全部 NodeKind：start 走 START_LABEL_ZH；其余五类
 * （随 registry.ts 登记、在 STENCIL_GROUP_META 配了展示态信息）全部从 STENCIL_ITEMS 派生，不再逐个手写——同 START_LABEL_ZH 的既定处理，兜底显示名与
 * "能否新建"两件事正交。 */
export const NODE_TYPE_LABELS: Record<NodeKind, string> = {
  start: START_LABEL_ZH,
  ...Object.fromEntries(STENCIL_ITEMS.map((item) => [item.key, item.labelZh]))
} as Record<NodeKind, string>;

export { default as StencilPanel } from './StencilPanel.vue';
// 浮动外壳：DesignerRoot.vue 挂这一个，不直接挂 StencilPanel——拖动/收起/本地记忆等壳层行为
// 全在这一层，条目本身的行为见 StencilPanel.vue。
export { default as FloatingStencilPanel } from './FloatingStencilPanel.vue';

/**
 * 新增一个办理节点（工具条"添加办理节点"按钮用）：默认配置读 ../nodes/registry.ts 的
 * handleNodeType.createDefaultConfig()（唯一来源，不会漂移）。位置策略为"现有节点数 * 偏移量，
 * 不做碰撞检测"。
 */
export function createHandleNodeAt(index: number): { node: WorkflowNode; position: NodePosition } {
  const node: WorkflowNode = {
    id: createEntityId('handle'),
    kind: 'handle',
    name: undefined,
    config: getNodeTypeDefinition('handle')!.createDefaultConfig()
  };
  const position: NodePosition = { x: 340, y: 380 + index * 100 };
  return { node, position };
}

/**
 * 新增一个结束节点：end_flag（结束标识）留空待用户在后续 EndPanel 里填写。位置策略同
 * createHandleNodeAt。
 */
export function createEndNodeAt(index: number): { node: WorkflowNode; position: NodePosition } {
  const node: WorkflowNode = {
    id: createEntityId('end'),
    kind: 'end',
    name: undefined,
    config: getNodeTypeDefinition('end')!.createDefaultConfig()
  };
  const position: NodePosition = { x: 340, y: 380 + index * 100 };
  return { node, position };
}
