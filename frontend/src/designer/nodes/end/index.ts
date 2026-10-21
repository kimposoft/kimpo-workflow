/**
 * designer/nodes/end —— 结束节点的类型定义。
 * 默认配置字段对齐 ../../../model/document.ts EndConfig（进而对齐后端 model.EndConfig）。
 */
import type { EndConfig, WorkflowNode } from '../../../model';
import type { NodeSummary, NodeTypeDefinition, SummarizeContext } from '../types';
import EndPanel from '../../panels/EndPanel.vue';

/** 结束节点新建时的最小合法配置：结束标识留空待用户在属性面板填写（必填字段）。与
 * stencil/index.ts 既有 createEndNodeAt 完全同值，现由该文件改读本处（见其注释）。 */
function createDefaultConfig(): Record<string, unknown> {
  return { end_flag: '' } satisfies EndConfig;
}

/**
 * summarize —— 结束节点摘要：结束标识（end_flag）是设计者自己写的一小段文本（如「已通过」），
 * 本身就是"数据"而不是需要翻译的业务术语，可以直接放进 params 当插值——不违反"摘要不直接拼
 * 中文"的约束（那条约束管的是本层写死中文措辞，不是转发用户自己填写的文本数据）。
 */
function summarize(node: WorkflowNode, _ctx?: SummarizeContext): NodeSummary | undefined {
  const config = node.config as EndConfig | undefined;
  if (!config?.end_flag) {
    return { key: 'workflow.designer.node.summary.end.unconfigured' };
  }
  return { key: 'workflow.designer.node.summary.end.configured', params: { flag: config.end_flag } };
}

/** 结束节点类型定义：可删除（一条流程可以画多个结束节点）、进形状
 * 面板、末级节点、数量不限。panel 字段挂属性面板组件（同 start/index.ts 的鸭子类型手法）。 */
export const endNodeType: NodeTypeDefinition & { panel: typeof EndPanel } = {
  kind: 'end',
  labelKey: 'workflow.designer.node.end',
  createDefaultConfig,
  canDelete: true,
  canAddFromStencil: true,
  isTerminal: true,
  summarize,
  panel: EndPanel
};
