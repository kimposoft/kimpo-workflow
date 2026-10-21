/**
 * designer/issues/useIssues.ts —— 发布期检查项清单组合式。
 *
 * 持有检查项状态（host.validate()/发布 409 回来的诊断列表，经 model/validate-map.ts
 * groupIssues() 分组）：本文件只持有"诊断数据"这一份状态——DesignerRoot 挂载新文档、发布成功时
 * 调用 clear()，发布拒绝时调用 setFromDiagnostics()。
 *
 * "选中哪个节点/连线 + 把画布平移过去"仍然是 DesignerRoot 的职责——画布引用（canvasRef）与选中态
 * （WorkflowDocumentState.setSelection）都在 DesignerRoot 范围内，本组合式不直接持有、也不 import
 * 任何画布/图相关模块；"定位"这一动作经 UseIssuesOptions.onFocus 回调注入，由 DesignerRoot 传入
 * 它已有的"选中 + centerOn 画布"逻辑。
 *
 * DESIGNER_ISSUES_KEY：DesignerRoot 用 provide() 把本组合式的实例整个交给子树，
 * shell/IssuesBadge.vue 与本目录下 IssuesBar.vue 经 inject() 直接拿到——同 host.ts 里
 * DESIGNER_HOST_KEY/DESIGNER_STATE_KEY/DESIGNER_I18N_KEY 的既定手法：检查项清单是跨越
 * TopBar→IssuesBadge→IssuesBar 三层的横切状态，逐层 props 转发只会让中间层被迫认识一份自己不
 * 关心的数据形状，provide/inject 更贴切（TopBar 本身完全不消费 issuesApi）。
 */
import { computed, ref, shallowRef, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { groupIssues, type GroupedIssues, type MappedIssue, type RawDiagnostic } from '../../model/validate-map';
import { cycleCursor, flattenGroupedIssues, issueCountOf, issueTargetOf } from './issuesLogic';

export interface UseIssuesOptions {
  /** 定位回调：条目关联了具体节点/连线时调用（issueTargetOf 返回非 undefined）；不挂任何目标的
   *  文档级问题不调用——DesignerRoot 传入时应保证"没有可定位目标就什么也不做"，不是本组合式的
   *  职责范围。
   *  tab（可选）：该问题在属性面板里对应的分区 key（见 model/validate-map.ts CODE_TAB），未能
   *  确定分区时不带该字段。只解构 nodeId/linkId 的调用方（如 DesignerRoot.vue 当前的 onFocus
   *  实现）可以忽略它，行为不变。 */
  onFocus?: (target: { nodeId?: string; linkId?: string; tab?: string }) => void;
}

export interface UseIssuesReturn {
  /** 展平后的问题清单（节点 → 连线 → 全局的稳定顺序，见 issuesLogic.ts flattenGroupedIssues）。 */
  issues: ComputedRef<MappedIssue[]>;
  /** 原始分组形态，供画布节点/连线角标消费（graph-bridge.ts toGraphNodes/toGraphEdges 的
   *  issuesByNode/issuesByLink 参数）。 */
  grouped: ComputedRef<GroupedIssues>;
  count: ComputedRef<number>;
  /** 当前聚焦到清单第几条（-1 = 尚未选中任何一条），供 IssuesBar.vue 高亮"当前项"。 */
  cursor: Ref<number>;
  /** 用 host.validate()/发布 409 回来的诊断列表替换当前问题清单，游标复位（内部经
   *  groupIssues(diags) 分组）。 */
  setFromDiagnostics(diags: RawDiagnostic[]): void;
  /** 清空问题清单（挂载新文档 / 发布成功后）。 */
  clear(): void;
  /** 节点/连线 id 关联的问题条数。 */
  countOf(id: string): number;
  /** 定位到某一条问题：更新游标 + （若有定位目标）调用 onFocus。 */
  focus(issue: MappedIssue): void;
  /** 按下标定位（IssuesBar.vue 点击具体某一条时用），下标越界忽略。 */
  focusAt(index: number): void;
  /** 定位到下一条（循环）；清单为空时不产生任何效果。 */
  next(): void;
  /** 定位到上一条（循环）；清单为空时不产生任何效果。 */
  prev(): void;
}

export function useIssues(options: UseIssuesOptions = {}): UseIssuesReturn {
  const raw = shallowRef<RawDiagnostic[]>([]);
  const cursor = ref(-1);

  const grouped = computed<GroupedIssues>(() => groupIssues(raw.value));
  const issues = computed<MappedIssue[]>(() => flattenGroupedIssues(grouped.value));
  const count = computed(() => issues.value.length);

  function setFromDiagnostics(diags: RawDiagnostic[]): void {
    raw.value = diags;
    cursor.value = -1;
  }

  function clear(): void {
    raw.value = [];
    cursor.value = -1;
  }

  function countOf(id: string): number {
    return issueCountOf(grouped.value, id);
  }

  function focus(issue: MappedIssue): void {
    const index = issues.value.indexOf(issue);
    if (index >= 0) cursor.value = index;
    const target = issueTargetOf(issue);
    if (target) options.onFocus?.(target);
  }

  function focusAt(index: number): void {
    const issue = issues.value[index];
    if (issue) focus(issue);
  }

  function next(): void {
    const nextIndex = cycleCursor(cursor.value, issues.value.length, 1);
    if (nextIndex >= 0) focusAt(nextIndex);
  }

  function prev(): void {
    const prevIndex = cycleCursor(cursor.value, issues.value.length, -1);
    if (prevIndex >= 0) focusAt(prevIndex);
  }

  return { issues, grouped, count, cursor, setFromDiagnostics, clear, countOf, focus, focusAt, next, prev };
}

/** provide/inject 注入键：DesignerRoot 挂载时同步 provide 一份 useIssues() 实例，
 *  shell/IssuesBadge.vue、本目录 IssuesBar.vue 经 inject(DESIGNER_ISSUES_KEY) 直接消费，
 *  不需要 DesignerRoot 逐层转发（同上方头注释）。 */
export const DESIGNER_ISSUES_KEY: InjectionKey<UseIssuesReturn> = Symbol('workflow-designer-issues');
