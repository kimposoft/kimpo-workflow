/**
 * designer/issues/issuesLogic.ts —— 发布期检查项清单的纯逻辑（分组展平 / 计数 / 循环游标），
 * 不依赖 Vue。承接 model/validate-map.ts 的 GroupedIssues/MappedIssue，
 * 本文件只做"整理"（怎么摆放、怎么数、怎么循环翻页），不做"求值文案"——i18n 求值仍在消费方
 * （designer/issues/IssuesBar.vue），同 model/validate-map.ts 头注释"{node} 占位由持有文档 + i18n
 * 的调用方在最终求值时自行补上"的既定分工。抽成纯函数是本插件既定手法（本插件前端未装
 * @vue/test-utils，纯逻辑单独抽出才能不挂载组件直接单测，见 designer/panels/shared/
 * subflowMapping.ts 头注释同样的取舍）。
 */
import type { GroupedIssues, MappedIssue } from '../../model/validate-map';

/**
 * 把分组结果展平成一份稳定顺序的清单：先节点分组（按 Object.entries 的既有插入顺序——与
 * groupIssues() 遍历诊断列表时先遇到的节点先建组一致）、再连线分组、最后是不挂任何目标的全局
 * 问题。抽成纯函数供 useIssues 组合式与其他消费方复用。
 */
export function flattenGroupedIssues(grouped: GroupedIssues): MappedIssue[] {
  const list: MappedIssue[] = [];
  for (const group of Object.values(grouped.byNode)) list.push(...group);
  for (const group of Object.values(grouped.byLink)) list.push(...group);
  list.push(...grouped.global);
  return list;
}

/** 节点/连线 id 关联的问题条数（画布角标只消费"有没有"，这里额外给出具体条数，供需要
 *  计数展示的场景使用，不改变既有 graph-bridge.ts toGraphNodes/toGraphEdges 的取用方式）。 */
export function issueCountOf(grouped: GroupedIssues, id: string): number {
  return (grouped.byNode[id]?.length ?? 0) + (grouped.byLink[id]?.length ?? 0);
}

/** 单条问题关联的定位目标：节点优先（一条诊断不会同时挂节点又挂连线，见 groupIssues() 头注释），
 *  其次连线；两者皆无——不挂任何目标的文档级问题（如"缺少结束节点"）——返回 undefined，调用方
 *  据此不触发画布定位，只把这条问题在清单里显示出来。
 *  tab：只在挂节点的分支透传——"分区"是属性面板按 tab 组织后的
 *  概念，只对"选中了某个节点、打开它的属性面板"这个场景有意义；连线没有属性面板分区，因此挂
 *  连线的分支不带 tab（MappedIssue.tab 未登记时本就是 undefined，这里显式不透传，语义更直接）。
 *  这是可选属性，调用方（useIssues.ts UseIssuesOptions.onFocus）不读它完全不受影响。 */
export function issueTargetOf(issue: MappedIssue): { nodeId?: string; linkId?: string; tab?: string } | undefined {
  if (issue.nodeId) return { nodeId: issue.nodeId, tab: issue.tab };
  if (issue.linkId) return { linkId: issue.linkId };
  return undefined;
}

/**
 * 循环游标：在 [0, length) 范围内按 delta（+1 下一条 / -1 上一条）步进，越界回卷到另一端。
 *   - length<=0（清单为空）恒返回 -1（没有可循环的条目）；
 *   - current 当前不在合法范围内（初始态 -1，或清单在两次调用之间缩短导致越界）时，视为"还没有
 *     选中任何一条"：next 从第 0 条开始，prev 从最后一条开始（不是简单地把 current 钳到端点再走
 *     一步，那样会在"从未选中"时把第一次 next 吞掉一条）。
 */
export function cycleCursor(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}
