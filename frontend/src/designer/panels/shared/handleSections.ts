/**
 * panels/shared/handleSections.ts —— 办理节点属性面板『D 办理方式』『E 回退』『F 自动办理
 * 条件』三段的纯逻辑层：与 HandlePanel.vue 的事件绑定/模板
 * 渲染分离，供单测直接覆盖——同 assigneeSource.ts 头注释的既定分工（本插件前端未装
 * @vue/test-utils，纯函数是能被真正单测覆盖的唯一路径）。
 *
 * 『D 办理方式』的万分比换算与 ApprovePanel.vue 顶部 <script> 块里同名的 bpToPercent/percentToBp
 * 逻辑一致（两处审批/办理节点各自维护一份，不抽共享文件——同 ApprovePanel.vue 头注释里
 * buttonActionLabel 一处的既定取舍："重复这几行胜过再开一个共享文件的改动面"）。
 *
 * 所有函数都不改入参，返回新值/新数组（同 assigneeSource.ts 既定风格）。
 */
import type { ClearOnWithdrawField, WithdrawMethod } from '../../../model';
import type { CatalogTable, TemplateFieldCatalog } from './templateFieldCatalog';

// ── D 办理方式：万分比 ⇄ 1~100 整数百分比 ──────────────────────────────────────────────────

/** ApproveConfig/HandleConfig 的 complete_mode.percentage_bp 是万分比（10000=100%），
 *  NInputNumber 只认 1~100 的整数百分比——未配置时按默认 100% 展示，边界钳到
 *  [1,100] 防止历史脏数据（如 0 或 >100）把控件顶穿。 */
export function bpToPercent(bp: number | undefined): number {
  const raw = Math.round((bp ?? 10000) / 100);
  return Math.min(100, Math.max(1, raw));
}

/** 百分比整数 → 万分比，写回前同样钳到 [1,100] 再乘 100。 */
export function percentToBp(percent: number): number {
  const clamped = Math.min(100, Math.max(1, Math.round(percent)));
  return clamped * 100;
}

// ── E 回退：三档固定顺序的勾选/取消 ────────────────────────────────────────────────────────

/** 回退方式三档的固定展示顺序：回退到上一步 → 回退到发起人 → 回退到指定
 *  步骤。toggleWithdrawMethod 恒按这个顺序重排结果，不管调用方勾选的先后次序，保证写回文档的
 *  数组顺序是稳定的（同一组已勾选项，无论勾选操作的先后顺序，落库结果恒一致）。 */
export const WITHDRAW_METHOD_ORDER: readonly WithdrawMethod[] = ['previous_step', 'initiator', 'specified_step'];

/** 某一档回退方式当前是否已勾选。 */
export function isWithdrawMethodChecked(methods: WithdrawMethod[] | undefined, method: WithdrawMethod): boolean {
  return !!methods?.includes(method);
}

/** 勾选/取消勾选某一档回退方式：已勾选则移除，未勾选则加入，结果按 WITHDRAW_METHOD_ORDER 重排
 *  （幂等：对同一档连续 toggle 两次，或不同调用顺序达到同一勾选集合，结果数组恒相同）。 */
export function toggleWithdrawMethod(methods: WithdrawMethod[] | undefined, method: WithdrawMethod): WithdrawMethod[] {
  const current = methods ?? [];
  const next = current.includes(method) ? current.filter((m) => m !== method) : [...current, method];
  return WITHDRAW_METHOD_ORDER.filter((m) => next.includes(m));
}

/** 回退方式三档是否至少勾了一种——「回退时清空的字段」只在此为真时才可配置（三种回退都没勾时
 *  置灰）。 */
export function hasAnyWithdrawMethod(methods: WithdrawMethod[] | undefined): boolean {
  return !!methods && methods.length > 0;
}

// ── 回退时清空字段：NSelect 复合键 ⇄ ClearOnWithdrawField[] ──────────────────────────────────

const CLEAR_FIELD_KEY_SEP = '::';

/** table_id/field_id → NSelect 单个选项 value 的编码（分隔符用两个冒号——data_table_id/field_id
 *  是宿主生成的 id，不含冒号，不会与分隔符本身冲突；同 ApprovePanel.vue 的 encodeClearFieldKey
 *  编码口径，两处独立维护，见文件头注释）。 */
export function encodeClearFieldKey(tableId: string, fieldId: string): string {
  return `${tableId}${CLEAR_FIELD_KEY_SEP}${fieldId}`;
}

/** 编码反解；解不出（不含分隔符的野值）返回 undefined，调用方按"这一条丢弃"处理，不抛错。 */
export function decodeClearFieldKey(key: string): { tableId: string; fieldId: string } | undefined {
  const idx = key.indexOf(CLEAR_FIELD_KEY_SEP);
  if (idx < 0) return undefined;
  return { tableId: key.slice(0, idx), fieldId: key.slice(idx + CLEAR_FIELD_KEY_SEP.length) };
}

/** HandleConfig.clear_on_withdraw → NSelect 的 value（string[]）。 */
export function clearFieldsToKeys(fields: ClearOnWithdrawField[] | undefined): string[] {
  return (fields ?? []).map((f) => encodeClearFieldKey(f.table_id, f.field_id));
}

/** NSelect 选中的 value（string[]，multiple 模式）→ HandleConfig.clear_on_withdraw；解不出的
 *  野值直接丢弃（不应该发生——value 恒来自 encodeClearFieldKey 生成的选项，防御性处理）。 */
export function keysToClearFields(keys: string[]): ClearOnWithdrawField[] {
  const result: ClearOnWithdrawField[] = [];
  for (const key of keys) {
    const decoded = decodeClearFieldKey(key);
    if (decoded) result.push({ table_id: decoded.tableId, field_id: decoded.fieldId });
  }
  return result;
}

// ── 回退时清空字段：NSelect 分组选项构造（按 templateFieldCatalog.ts 共享目录） ───────────────

/** NSelect 单个选项的形状（自行声明，不依赖 naive-ui 的具体类型名——同 ApprovePanel.vue
 *  ClearFieldSelectOption 头注释同一理由：结构上兼容 naive-ui SelectOption 即可直接喂
 *  NSelect 的 options prop）。 */
export interface WithdrawClearFieldOption {
  label: string;
  value: string;
  [k: string]: unknown;
}

/** NSelect 分组选项的形状。 */
export interface WithdrawClearFieldGroup {
  type: 'group';
  key: string;
  label: string;
  children: WithdrawClearFieldOption[];
  [k: string]: unknown;
}

/** 混合数组：按表分组的正常选项 + （若有）"已不存在的字段"占位选项（不分组，直接追加在末尾）。 */
export type WithdrawClearFieldSelectItem = WithdrawClearFieldGroup | WithdrawClearFieldOption;

/** 按表分组构建 NSelect 选项：主表排第一（沿用 catalog.tables 已排好的顺序，见
 *  templateFieldCatalog.ts loadTemplateFieldCatalog 头注释），字段为空的表不出现在分组里（避免
 *  选项列表里出现一个永远展不开内容的空分组）。
 *
 *  selectedKeys 是当前 HandleConfig.clear_on_withdraw 换算出的复合键：其中若有目录里已经找不到
 *  的字段（历史配置指向的字段被删除/改类型退出目录），不静默丢——追加一份占位选项（label 为
 *  missingFieldLabel 业务话文案），保证 NSelect 回显不出现"选中了但列表里凭空消失一个 tag"的
 *  观感，同时那条历史配置本身仍原样保留在 clear_on_withdraw 里（本函数只管选项展示，不改配置本
 *  身——去留由设计者在界面上手动决定）。 */
export function buildWithdrawClearFieldOptions(
  catalog: TemplateFieldCatalog | null,
  selectedKeys: string[],
  missingFieldLabel: string
): WithdrawClearFieldSelectItem[] {
  const tables: CatalogTable[] = catalog?.tables ?? [];
  const groups: WithdrawClearFieldGroup[] = tables
    .filter((t) => t.fields.length > 0)
    .map((t) => ({
      type: 'group',
      key: t.tableId,
      label: t.tableName,
      children: t.fields.map((f) => ({ label: f.fieldName, value: encodeClearFieldKey(t.tableId, f.fieldId) }))
    }));

  const knownKeys = new Set(groups.flatMap((g) => g.children.map((c) => c.value)));
  const missingOptions: WithdrawClearFieldOption[] = selectedKeys
    .filter((key) => !knownKeys.has(key))
    .map((key) => ({ label: missingFieldLabel, value: key }));

  return missingOptions.length > 0 ? [...groups, ...missingOptions] : groups;
}
