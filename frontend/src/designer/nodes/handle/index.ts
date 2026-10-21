/**
 * designer/nodes/handle —— 办理节点的类型定义。
 * 默认配置字段对齐 ../../../model/document.ts HandleConfig（进而对齐后端 model.HandleConfig）。
 */
import type { AssigneeSource, HandleConfig, WorkflowNode } from '../../../model';
import type { NodeSummary, SummarizeContext } from '../types';
import type { NodeTypeDefinitionWithPanel } from '../../host';
import HandlePanel from '../../panels/HandlePanel.vue';

/** 办理节点新建时的最小合法配置：办理人来源留空待补（至少一种来源，属性面板会提示待配置）、
 * 完成方式默认"任一人办完即过"、无路提示留空待填。
 * 与 stencil/index.ts 既有 createHandleNodeAt 完全同值，现由该文件改读本处（见其注释）。 */
function createDefaultConfig(): Record<string, unknown> {
  return {
    assignees: [],
    complete_mode: { kind: 'any' },
    no_route_hint: ''
  } satisfies HandleConfig;
}

/**
 * describeSource —— 把一条『A 人员来源』解成一个人类可读的"代表名"，解不出时返回 undefined
 * （调用方据此判断是否要退化为纯计数摘要，见 summarizeAssignees）。
 *
 * 只有 user/role/department 三种来源在能拿到解析器时才产出名字：main_field（按字段匹配）与
 * relation（与上一步的关系，如"同部门"）本身是需要翻译的业务术语而不是一条具体数据，本层
 * 没有 i18n 无法把它们安全地拼进 params 里当作"数据"（拼进去就会变成写死的中文，违反"摘要
 * 不直接拼中文"的硬约束）——这两种来源统一交给数量兜底文案覆盖，不是遗漏。
 *
 * initiator（发起人）走的是同一套"没有 i18n、靠 ctx 注入"的思路，但它
 * 不像 relation 那样退化成数量兜底——它是固定业务术语（恒为"发起人"，不依赖任何 host 数据），
 * 只要调用方注入了 ctx.resolveInitiatorLabel 就总能产出一个确定的代表名，不需要像 user/role/
 * department 那样先判断 id 是否存在（initiator 条目本就没有 id）。ctx 缺省（当前 DesignerRoot.vue
 * 尚未接线任何解析器，见其 computeSummaries）时仍安全退化为 undefined → 调用方计数兜底，不写死
 * 中文。
 */
function describeSource(source: AssigneeSource, ctx: SummarizeContext | undefined): string | undefined {
  switch (source.kind) {
    case 'user':
      return source.user_ids?.[0] ? ctx?.resolveUserName?.(source.user_ids[0]) : undefined;
    case 'role':
      return source.role_ids?.[0] ? ctx?.resolveRoleName?.(source.role_ids[0]) : undefined;
    case 'department':
      return source.department_ids?.[0] ? ctx?.resolveDepartmentName?.(source.department_ids[0]) : undefined;
    case 'initiator':
      return ctx?.resolveInitiatorLabel?.();
    default:
      return undefined;
  }
}

/**
 * summarizeAssignees —— 『A 人员来源』清单的共用摘要算法（办理/审批/抄送三类节点共用，
 * 不必各写一份）：取前两条能解出名字的来源拼成"张三、采购部"，
 * 末尾恒附总来源条数"等 N 项来源"——总数用真实来源条数，不是"能解出名字的条数"，即使一条名字
 * 都解不出也照样报数量（数量兜底 sourceCount 分支），保证"来源非空但暂时不知道具体是谁"时摘要
 * 依然存在（不是"待配置"的误判，那是留给 A1_SOURCE_REQUIRED 发布期检查报的问题）。
 *
 * 『与上步处理人的关系』（kind==='relation'）不是『A 人员来源』，而是节点 config 上独立的
 * relation_filters 字段（见 model/document.ts
 * HandleConfig.relation_filters 注释）——正常链路下 sources 经
 * model/defaults.ts ensureDocumentShape 整形后不会再带这种条目，但本函数仍显式过滤一道：防
 * "未经整形入口的数据"（测试直接构造、或理论不应出现的历史脏数据）把它算进来源数——
 * relation 不是候选来源，不该计入"等 N 项来源"；来源为空但过滤器非空的
 * 节点，走下面 sources.length === 0 分支显示"尚未指定"空态文案。
 */
export function summarizeAssignees(sources: AssigneeSource[] | undefined, ctx?: SummarizeContext): NodeSummary | undefined {
  const effectiveSources = (sources ?? []).filter((s) => s.kind !== 'relation');
  if (effectiveSources.length === 0) {
    return { key: 'workflow.designer.node.summary.assignee.empty' };
  }
  const names: string[] = [];
  for (const source of effectiveSources) {
    const name = describeSource(source, ctx);
    if (name) names.push(name);
    if (names.length >= 2) break;
  }
  if (names.length === 0) {
    return { key: 'workflow.designer.node.summary.assignee.count', params: { count: effectiveSources.length } };
  }
  return {
    key: 'workflow.designer.node.summary.assignee.named',
    params: { names: names.join('、'), count: effectiveSources.length }
  };
}

function summarize(node: WorkflowNode, ctx?: SummarizeContext): NodeSummary | undefined {
  const config = node.config as HandleConfig | undefined;
  return summarizeAssignees(config?.assignees, ctx);
}

/** 办理节点类型定义：可删除、进形状面板、数量不限。panel 字段挂属性
 *  面板组件——类型标注为 NodeTypeDefinitionWithPanel（NodeTypeDefinition 的前向兼容鸭子类型，
 *  见 ../../host.ts 头注释），PropsPanel.vue 按该类型读取，不需要再改一次分发逻辑。 */
export const handleNodeType: NodeTypeDefinitionWithPanel = {
  kind: 'handle',
  labelKey: 'workflow.designer.node.handle',
  createDefaultConfig,
  canDelete: true,
  canAddFromStencil: true,
  isTerminal: false,
  summarize,
  panel: HandlePanel
};
