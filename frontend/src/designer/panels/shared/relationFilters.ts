/**
 * panels/shared/relationFilters.ts —— 『与上步处理人的关系』过滤器的纯逻辑层。
 *
 * 关系五档存于节点 config 上独立的 relation_filters 字段（语义"先按来源算出人，再只留下与上步
 * 处理人满足关系的人"，见 model/document.ts HandleConfig.relation_filters 注释）。旧形状
 * AssigneeSource kind:'relation'（作为人员来源"再加一批人"）只保留读兼容，设计器不再产生；本文件
 * 是新形状唯一认的写入口，界面由 shared/RelationFilterCard.vue 独立成卡。
 *
 * normalizeRelationConfig 是"旧→新"迁移的唯一权威实现，供 model/defaults.ts
 * ensureDocumentShape 在文档打开时对办理/审批/抄送三类节点调用一次（见其调用点注释）——
 * 设计器打开旧草稿后内部只剩新形状，任何面板都不需要再认识 relation 来源。
 *
 * toggleRelationFilter / isRelationFilterChecked 是「再缩小范围」卡（RelationFilterCard.vue）的
 * 薄逻辑层，与 assigneeSource.ts 里各函数"纯函数与 Vue 层分离"同一分工（见其头注释）。
 *
 * RELATION_OPTIONS（五档固定顺序）不在本文件重新定义，直接复用 ./assigneeSource.ts 已有的
 * 常量并原样转出——两处认的是同一份五档定义，不应该有两份可能不同步的顺序定义。
 */
import type { AssigneeRelation, AssigneeSource } from '../../../model';
import { RELATION_OPTIONS } from './assigneeSource';

export { RELATION_OPTIONS };

/**
 * normalizeRelationConfig —— 把一份『来源 + 过滤器』的原始组合规范成新形状：来源清单里所有
 * kind==='relation' 的条目摘出，其 relation 值去重、按"首次出现顺序"（已有 filters 排在前、
 * 从来源里新摘出的排在后，两段各自保序，已存在的不重复加）并入 filters；来源清单删掉这些条目。
 *
 * 没有 relation 值的畸形来源条目（理论不应出现的脏数据）不静默丢弃——原样保留在来源清单里，
 * 同 assigneeSource.ts 其余函数"不静默改错行"的既定手法。
 *
 * 幂等：对已经是新形状的输入（来源里没有 relation 条目）重复调用，filters 内容不变、sources
 * 内容不变（值相同，返回新数组——本文件与 assigneeSource.ts 同一套"不改入参、返回新数组"的
 * 既定风格，调用方按值比较即可判断"有没有真的发生改写"）。
 *
 * 不改入参（sources/filters 两个数组都不做原地修改）。
 */
export function normalizeRelationConfig(
  sources: AssigneeSource[] | undefined,
  filters: AssigneeRelation[] | undefined
): { sources: AssigneeSource[]; filters: AssigneeRelation[] } {
  const nextSources: AssigneeSource[] = [];
  const extracted: AssigneeRelation[] = [];
  for (const source of sources ?? []) {
    if (source.kind === 'relation') {
      if (source.relation) {
        extracted.push(source.relation);
      } else {
        // 没有 relation 值的畸形条目：不静默丢弃，原样保留在来源清单里。
        nextSources.push(source);
      }
      continue;
    }
    nextSources.push(source);
  }
  const merged = [...(filters ?? [])];
  for (const relation of extracted) {
    if (!merged.includes(relation)) merged.push(relation);
  }
  return { sources: nextSources, filters: merged };
}

/** 勾选/取消勾选某一档关系（供 RelationFilterCard.vue 调用）：未勾选时追加到末尾，已勾选时移除
 *  该档，不改入参，返回新数组。 */
export function toggleRelationFilter(filters: AssigneeRelation[] | undefined, relation: AssigneeRelation): AssigneeRelation[] {
  const current = filters ?? [];
  return isRelationFilterChecked(current, relation) ? current.filter((r) => r !== relation) : [...current, relation];
}

/** 某一档关系当前是否已勾选（供胶囊回显）。 */
export function isRelationFilterChecked(filters: AssigneeRelation[] | undefined, relation: AssigneeRelation): boolean {
  return (filters ?? []).includes(relation);
}
