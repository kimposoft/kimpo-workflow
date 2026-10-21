/**
 * designer/nodes/approve —— 审批节点的类型定义。
 * 默认配置字段对齐 ../../../model/document.ts ApproveConfig（进而对齐后端 model.ApproveConfig）。
 */
import type { ApproveConfig, ApprovalButton, WorkflowNode } from '../../../model';
import type { NodeSummary, SummarizeContext, DefaultConfigI18n } from '../types';
import type { NodeTypeDefinitionWithPanel } from '../../host';
import { resolveDefaultText } from '../default-i18n-fallback';
import { summarizeAssignees } from '../handle';
import ApprovePanel from '../../panels/ApprovePanel.vue';

/**
 * 审批节点新建时的最小合法配置：审批人来源留空待补（同办理节点，至少一种来源，属性面板会
 * 提示待配置）、完成方式默认"一人同意即过"（同办理节点的"任一人"，两档叫法不同、判定算法相同）、默认两个
 * 审批按钮——「同意」动作为提交通过、「拒绝」动作为回退到指定步骤，
 * 名称与结果标识按设计者当前语言生成（i18n 缺席时退回 zh-CN 默认文案，见 resolveDefaultText）。
 *
 * 按钮 id 用固定字面量（'btn-agree'/'btn-reject'）：这里只生成这两个默认按钮，新增按钮时的
 * id 去重由按钮设置对话框负责。
 */
function createDefaultConfig(i18n?: DefaultConfigI18n): Record<string, unknown> {
  const buttons: ApprovalButton[] = [
    {
      id: 'btn-agree',
      name: resolveDefaultText(i18n, 'workflow.designer.node.approve.defaultButtonAgreeName'),
      color: 'primary',
      action: 'submit_approve',
      result_tag: resolveDefaultText(i18n, 'workflow.designer.node.approve.defaultButtonAgreeResultTag'),
      require_reason: false
    },
    {
      id: 'btn-reject',
      name: resolveDefaultText(i18n, 'workflow.designer.node.approve.defaultButtonRejectName'),
      color: 'danger',
      action: 'withdraw_specified_step',
      result_tag: resolveDefaultText(i18n, 'workflow.designer.node.approve.defaultButtonRejectResultTag'),
      require_reason: true
    }
  ];
  return {
    approvers: [],
    complete_mode: { kind: 'any' },
    field_permissions: [],
    buttons,
    result_field_id: '',
    reason_field_id: '',
    clear_on_withdraw: [],
    no_route_hint: ''
  } satisfies ApproveConfig;
}

/** 审批节点卡片摘要：复用办理节点同款『A 人员来源』摘要算法（见 ../handle/index.ts
 * summarizeAssignees 头注释——两类节点共用同一份"来源清单 → 代表名/计数"算法，不重写一份）。 */
function summarize(node: WorkflowNode, ctx?: SummarizeContext): NodeSummary | undefined {
  const config = node.config as ApproveConfig | undefined;
  return summarizeAssignees(config?.approvers, ctx);
}

/** 审批节点类型定义：可删除、进形状面板、数量不限。panel 挂 ApprovePanel。 */
export const approveNodeType: NodeTypeDefinitionWithPanel = {
  kind: 'approve',
  labelKey: 'workflow.designer.node.approve',
  createDefaultConfig,
  canDelete: true,
  canAddFromStencil: true,
  isTerminal: false,
  summarize,
  panel: ApprovePanel
};
