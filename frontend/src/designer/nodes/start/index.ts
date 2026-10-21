/**
 * designer/nodes/start —— 发起节点的类型定义。
 * 默认配置字段对齐 ../../../model/document.ts StartConfig（进而对齐后端 model.StartConfig）。
 */
import type { StartConfig, WorkflowNode } from '../../../model';
import type { NodeSummary, NodeTypeDefinition, SummarizeContext } from '../types';
import StartPanel from '../../panels/StartPanel.vue';

/** 发起节点新建时的最小合法配置：目标模板/无路提示留空待设计者在属性面板补齐（均为必填字段，
 * 面板会提示待配置，同 stencil/index.ts 既有 createHandleNodeAt/createEndNodeAt 的处理手法）；
 * 发起权限留空表示"除超级管理员外无人可发起"，不是遗漏；允许人工发起默认开。 */
function createDefaultConfig(): Record<string, unknown> {
  return {
    target_template_id: '',
    allow_manual_start: true,
    no_route_hint: '',
    start_permission: {}
  } satisfies StartConfig;
}

/**
 * summarize —— 发起节点摘要：本层没有模板目录（那是 kimpo 宿主经 SDK 提供的数据，设计层
 * 模型不接入），因此不显示模板名，只显示"是否已选目标模板 / 是否关闭了人工发起"这两个不需要
 * 外部数据即可判断的配置态；模板名等更细的摘要可由持有模板目录的调用方按需扩展（届时可在 ctx 上加一个 resolveTemplateName 解析器，
 * 不需要改这里的返回形状）。
 */
function summarize(node: WorkflowNode, _ctx?: SummarizeContext): NodeSummary | undefined {
  const config = node.config as StartConfig | undefined;
  if (!config || !config.target_template_id) {
    return { key: 'workflow.designer.node.summary.start.unconfigured' };
  }
  if (config.allow_manual_start === false) {
    return { key: 'workflow.designer.node.summary.start.manualOff' };
  }
  return { key: 'workflow.designer.node.summary.start.configured' };
}

/** 发起节点类型定义：唯一入口、画布恒有且唯一、不可删、不进形状面板。
 * panel 字段（鸭子类型见 designer/host.ts NodeTypeDefinitionWithPanel）：属性面板按
 * shell/PropsPanel.vue 的动态分发机制读取。 */
export const startNodeType: NodeTypeDefinition & { panel: typeof StartPanel } = {
  kind: 'start',
  labelKey: 'workflow.designer.node.start',
  createDefaultConfig,
  canDelete: false,
  canAddFromStencil: false,
  maxCount: 1,
  isTerminal: false,
  summarize,
  panel: StartPanel
};
