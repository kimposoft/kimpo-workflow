/**
 * designer/nodes/cc —— 抄送节点的类型定义。
 * 默认配置字段对齐 ../../../model/document.ts CCConfig（进而对齐后端 model.CCConfig）。
 */
import type { CCConfig, WorkflowNode } from '../../../model';
import type { NodeSummary, SummarizeContext } from '../types';
import type { NodeTypeDefinitionWithPanel } from '../../host';
import { summarizeAssignees } from '../handle';
import CcPanel from '../../panels/CcPanel.vue';

/**
 * 抄送节点新建时的最小合法配置：收件人来源留空待补（同办理节点）、通知渠道默认只勾系统通知
 * 、通知标题/正文两条表达式（宿主查询服务 V4 表达式）留空待配置。
 *
 * 标题/正文两个槽在后端 model.CCConfig 里是 `json.RawMessage` 且没有 `omitempty`（json tag
 * `title_expr`/`content_expr` 必须出现在 JSON 里，但取值允许是字面量 null——发布期校验用的
 * isBlankExpr()（internal/node/cc.go）就是按"trim 后是空串或字面量 null"判定"没配"，不是按
 * "缺这个键"）：这里显式给 `null`，是"未配置"这件事在 wire 协议上唯一合法的落地方式，不能像
 * summary_expr 那类可选表达式槽一样直接省略键。 */
function createDefaultConfig(): Record<string, unknown> {
  return {
    recipients: [],
    channels: ['system'],
    title_expr: null,
    content_expr: null,
    field_permissions: []
  } satisfies CCConfig;
}

/** 抄送节点卡片摘要：复用办理节点同款『A 人员来源』摘要算法，作用对象是收件人清单（同办理/
 * 审批共用同一份"来源清单 → 代表名/计数"算法，见 ../handle/index.ts summarizeAssignees）。 */
function summarize(node: WorkflowNode, ctx?: SummarizeContext): NodeSummary | undefined {
  const config = node.config as CCConfig | undefined;
  return summarizeAssignees(config?.recipients, ctx);
}

/** 抄送节点类型定义：可删除、进形状面板、数量不限。panel 挂 CcPanel。 */
export const ccNodeType: NodeTypeDefinitionWithPanel = {
  kind: 'cc',
  labelKey: 'workflow.designer.node.cc',
  createDefaultConfig,
  canDelete: true,
  canAddFromStencil: true,
  isTerminal: false,
  summarize,
  panel: CcPanel
};
