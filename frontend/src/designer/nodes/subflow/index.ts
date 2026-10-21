/**
 * designer/nodes/subflow —— 子流程节点的类型定义。
 * 默认配置字段对齐 ../../../model/document.ts SubflowConfig（进而对齐后端 model.SubflowConfig）。
 */
import type { SubflowConfig, WorkflowNode } from '../../../model';
import type { NodeSummary } from '../types';
import type { NodeTypeDefinitionWithPanel } from '../../host';
import SubflowPanel from '../../panels/SubflowPanel.vue';

/**
 * 子流程节点新建时的最小合法配置：目标流程留空待补、传递字段清单留空、默认"不等待"
 * （wait=false——"是否等待"必填但没有约定默认档，选不等待作为侵入性最小的默认：
 * 末级节点只能不等待；主线节点若要等待，设计者需要显式勾选，避免默认就把流程卡住）、
 * 处置默认"不管"（disposition='ignore'，仅 wait===false 时生效，与 wait 默认值配套）。
 */
function createDefaultConfig(): Record<string, unknown> {
  return {
    target_workflow_id: '',
    field_mappings: [],
    wait: false,
    disposition: 'ignore'
  } satisfies SubflowConfig;
}

/**
 * 子流程节点卡片摘要：只区分"配了目标流程 / 没配"两态，不展示目标流程的真实名字——本层
 * （designer/nodes/*）没有目标流程目录的名字解析器（同 handle 节点 summarize 对 main_field/
 * relation 两种来源"解不出名字就退化"的既定处理，见 ../handle/index.ts describeSource 注释）。
 */
function summarize(node: WorkflowNode): NodeSummary | undefined {
  const config = node.config as SubflowConfig | undefined;
  if (!config?.target_workflow_id) {
    return { key: 'workflow.designer.node.summary.subflow.unconfigured' };
  }
  return { key: 'workflow.designer.node.summary.subflow.configured' };
}

/** 子流程节点类型定义：可删除、进形状面板、数量不限。panel 挂 SubflowPanel。 */
export const subflowNodeType: NodeTypeDefinitionWithPanel = {
  kind: 'subflow',
  labelKey: 'workflow.designer.node.subflow',
  createDefaultConfig,
  canDelete: true,
  canAddFromStencil: true,
  isTerminal: false,
  summarize,
  panel: SubflowPanel
};
