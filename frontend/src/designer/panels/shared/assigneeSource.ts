/**
 * panels/shared/assigneeSource.ts —— AssigneeSourceList.vue 的纯逻辑层：各种来源的增删改与
 * 展示文案的求值，与 Vue 组件（事件绑定/模板）分离，供单测直接
 * 覆盖，不依赖挂载真实组件（本插件前端未装 @vue/test-utils，纯函数是能被真正单测覆盖的唯一
 * 路径——同 model/document-state.ts「纯 TS，零 Vue 依赖」的既定分工）。
 *
 * 所有函数都不改入参，返回新数组（同 document-state.ts 的既定风格），调用方（AssigneeSourceList.vue）
 * 拿到新数组后经 update:modelValue 上抛。
 *
 * 『与上步处理人的关系』不是人员来源，而是节点 config 上独立的 relation_filters 字段，增删逻辑
 * 见 ./relationFilters.ts；RELATION_OPTIONS（五档固定顺序）定义在本文件，由该文件原样转出复用。
 * describeSource 的 relation 分支保留——万一遇到没有经过 model/defaults.ts ensureDocumentShape
 * 整形的旧数据（理论不应发生），来源行至少还能显示出关系名，不留空白。
 */
import type { AssigneeMatchBy, AssigneeRelation, AssigneeSource } from '../../../model';

/** 『与上步处理人的关系』五档，固定顺序。 */
export const RELATION_OPTIONS: readonly AssigneeRelation[] = [
  'same_department',
  'parent_department',
  'child_department',
  'department_manager',
  'parent_department_manager'
];

/** 追加一条用户/角色/部门来源（宿主三维选择器确认后调用）；ids 为空时不产生变更（调用方也应
 *  在 ids 为空时不调用本函数，这里再兜底一次，双重保险，不依赖调用方记得判断）。 */
export function addPickedSource(sources: AssigneeSource[], kind: 'user' | 'role' | 'department', ids: string[]): AssigneeSource[] {
  if (ids.length === 0) return sources;
  const next: AssigneeSource =
    kind === 'user' ? { kind: 'user', user_ids: ids } : kind === 'role' ? { kind: 'role', role_ids: ids } : { kind: 'department', department_ids: ids };
  return [...sources, next];
}

/** 追加一条『主表字段』草稿来源：字段留空待设计者在行内选择（A1 允许「已配置来源但值未填」这
 *  一过渡态，发布期检查已有 issue.a1_source_empty 覆盖，本层不做校验）。 */
export function addMainFieldSource(sources: AssigneeSource[]): AssigneeSource[] {
  return [...sources, { kind: 'main_field', main_field_id: '', match_by: 'display_name' }];
}

/** 修改第 index 条来源的 main_field_id；index 越界或该行不是 main_field 时原样返回，不静默改错行。 */
export function updateMainFieldId(sources: AssigneeSource[], index: number, fieldId: string): AssigneeSource[] {
  const target = sources[index];
  if (!target || target.kind !== 'main_field') return sources;
  const next = [...sources];
  next[index] = { ...target, main_field_id: fieldId };
  return next;
}

/** 修改第 index 条来源的 match_by（按用户名/登录名）；同上，只对 main_field 行生效。 */
export function updateMatchBy(sources: AssigneeSource[], index: number, matchBy: AssigneeMatchBy): AssigneeSource[] {
  const target = sources[index];
  if (!target || target.kind !== 'main_field') return sources;
  const next = [...sources];
  next[index] = { ...target, match_by: matchBy };
  return next;
}

/** 追加一条『发起人』来源（运行时取实例发起人，条目形状恒为
 *  { kind: 'initiator' }，无任何参数）；同一节点最多一条——已存在时原样返回，不产生重复行（不同
 *  于 main_field 允许多条草稿行）。 */
export function addInitiatorSource(sources: AssigneeSource[]): AssigneeSource[] {
  if (sources.some((s) => s.kind === 'initiator')) return sources;
  return [...sources, { kind: 'initiator' }];
}

/** 删除第 index 条来源；index 越界时原样返回。 */
export function removeSourceAt(sources: AssigneeSource[], index: number): AssigneeSource[] {
  if (index < 0 || index >= sources.length) return sources;
  const next = [...sources];
  next.splice(index, 1);
  return next;
}

/** 单个来源展示名缓存：user/role/department 三档各自一份 id→展示名映射（本会话内拾取过才有，
 *  见 AssigneeSourceList.vue nameCache 头注释——重开设计器只剩 id，缓存天然为空）。 */
export interface AssigneeNameCache {
  user: Record<string, string>;
  role: Record<string, string>;
  department: Record<string, string>;
}

/** 求值一条来源的展示文案描述（不拼中文，返回 i18n key + params，由 Vue 层求值——同
 *  nodes/handle/index.ts NodeSummary 的既定分工）。main_field/relation 两档不需要名字缓存，
 *  main_field 由 Vue 层直接渲染下拉（不走本函数），relation 直接映射固定 key。 */
export interface AssigneeSourceLabel {
  key: string;
  params?: Record<string, string | number>;
}

export function describeSource(source: AssigneeSource, nameCache: AssigneeNameCache): AssigneeSourceLabel | undefined {
  if (source.kind === 'user') {
    const names = (source.user_ids ?? []).map((id) => nameCache.user[id]).filter((n): n is string => !!n);
    return names.length
      ? { key: 'workflow.designer.assignee.label.user', params: { names: names.join('、') } }
      : { key: 'workflow.designer.assignee.label.userCount', params: { count: source.user_ids?.length ?? 0 } };
  }
  if (source.kind === 'role') {
    const names = (source.role_ids ?? []).map((id) => nameCache.role[id]).filter((n): n is string => !!n);
    return names.length
      ? { key: 'workflow.designer.assignee.label.role', params: { names: names.join('、') } }
      : { key: 'workflow.designer.assignee.label.roleCount', params: { count: source.role_ids?.length ?? 0 } };
  }
  if (source.kind === 'department') {
    const names = (source.department_ids ?? []).map((id) => nameCache.department[id]).filter((n): n is string => !!n);
    return names.length
      ? { key: 'workflow.designer.assignee.label.department', params: { names: names.join('、') } }
      : { key: 'workflow.designer.assignee.label.departmentCount', params: { count: source.department_ids?.length ?? 0 } };
  }
  if (source.kind === 'relation') {
    return { key: `workflow.designer.assignee.relation.${source.relation ?? 'same_department'}` };
  }
  if (source.kind === 'initiator') {
    // 发起人：固定业务术语，不依赖任何 id 解析，直接映射固定 key（同 relation 分支的既定手法）。
    return { key: 'workflow.designer.assignee.label.initiator' };
  }
  // main_field：Vue 层直接渲染下拉展示当前选中字段名，不经本函数。
  return undefined;
}
