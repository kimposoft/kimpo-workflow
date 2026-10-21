<script setup lang="ts">
/**
 * panels/dialogs/FieldPermissionDialog.vue —— 字段权限设置弹窗（可编辑型四档 / 只看型
 * 三档）。
 *
 * 壳：用 `@kimposoft/ui-kit` 的 KDialog（standard 档，固定 640×560，不可缩放 / 最大化 / 拖动）+
 * KDialogFooter（取消在左、确认在右、小档 28px），与 ../../expression/V4ExpressionEditDialog.vue 同款。
 * 点遮罩无动作；Esc = 取消；标题用 KDialog 统一样式；窗口高度固定 560（字段多时内容区内滚动，字段少时
 * 留白）；footer 按钮由 `data-kdlf="confirm|cancel"` 定位。
 * 与该文件不同的一点：本组件不是"父层用 v-if 控制挂载/卸载"，而是自带 `show` prop——父层
 * （FieldPermissionSummary.vue）恒挂载本组件，靠 show 切换显隐（见下方"为什么恒挂载"一段）。
 *
 * 「怎么编解码」全部收在同目录 fieldPermission.ts 纯函数里（gradesFor/toGradeMap/fromGradeMap/
 * normalizeForReadonlyOnly/effectiveHint/applyBulk/matchKeyword），本文件只负责：接宿主取字段
 * 目录（useTemplateFieldCatalog）与模板限制对照（host.templateFieldRestrictions）、把草稿画出来、
 * 响应用户交互调用上述纯函数产出下一份草稿。确定才 emit('confirm', ...) 写回，取消/遮罩/Esc 丢弃
 * 草稿——同 V4ExpressionEditDialog.vue confirm/cancel 两事件的既定语义一致。
 *
 * 为什么恒挂载（`show` prop 而不是父层 v-if）：模板字段目录经 useTemplateFieldCatalog 按 templateId
 * 反应式获取，把 templateId 来源写成 `() => (props.show ? props.templateId : undefined)`——show
 * 变 true 时才真正发起取数（打开时才取数），show 变 false 时该 composable 的既定
 * 行为是把内部 catalog 状态清空（不是取消请求，只是不再展示陈旧数据），但模块级缓存
 * （templateFieldCatalog.ts catalogCache）仍在，下次打开同一模板不会重新打网络请求。这个写法比
 * "父层 v-if 控制挂载"更省一次组件树重建，且让 useTemplateFieldCatalog 的既有响应式语义原样复用，
 * 不需要另写一套"打开时手动 fetch"的逻辑。
 *
 * 表格分组的默认展开：NCollapse 的内容默认按需渲染（CollapseItemContent 用
 * useFalseUntilTruthy(show) 门控，哪怕 displayDirective='show' 也要求"至少展开过一次"才会挂进
 * DOM），因此"主表默认展开"如果只展开主表，扩展表分组在用户手动点开前，其内部的行不会出现在
 * DOM 里——这与"批量确认前逐行可见可操作"的期望不符。本组件因此把全部表分组的默认展开
 * 名单设成"目录里全部表 id"（主表默认展开的一个超集），换取"打开弹窗即可看到/
 * 操作全部字段"，用户仍可随手收起不关心的分组。
 */
import { computed, inject, ref, watch } from 'vue';
import { NButton, NCheckbox, NCollapse, NCollapseItem, NInput, NRadioButton, NRadioGroup, NTag } from 'naive-ui';
// 窗口外壳与页脚统一用 @kimposoft/ui-kit（运行时取宿主注入的 KimpoUi，构建时外部化）
import { KDialog, KDialogFooter } from '@kimposoft/ui-kit';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { FieldGrade, FieldPermission } from '../../../model';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY, type WorkflowDesignerFieldRestriction } from '../../host';
import { useTemplateFieldCatalog, type CatalogFieldItem, type CatalogTable } from '../shared/templateFieldCatalog';
import {
  applyBulk,
  effectiveHint,
  fromGradeMap,
  gradesFor,
  matchKeyword,
  normalizeForReadonlyOnly,
  toGradeMap,
  type FieldGradeMap
} from './fieldPermission';

const props = defineProps<{
  show: boolean;
  modelValue: FieldPermission[];
  templateId: string;
  readonlyOnly?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  confirm: [perms: FieldPermission[]];
}>();

const host = inject(DESIGNER_HOST_KEY);
const i18n = inject(DESIGNER_I18N_KEY) as PluginI18n;

// ── 模板字段目录：打开时才真正取数，见头注释"为什么恒挂载" ─────────────────────────────────
const { catalog, loading, failed, reload } = useTemplateFieldCatalog(() => (props.show ? props.templateId : undefined));

// ── 模板限制对照（打开时单独取一次，不走共享缓存——同一模板哪怕多次打开也刷新，保证对照的是
//    模板最新的授权配置，不是弹窗打开那一刻之前的陈旧结果）。 ───────────────────────────────
const restrictions = ref<Map<string, WorkflowDesignerFieldRestriction> | undefined>(undefined);
const restrictionsFailed = ref(false);

async function loadRestrictions(templateId: string): Promise<void> {
  restrictions.value = undefined;
  restrictionsFailed.value = false;
  if (!host || !templateId.trim()) return;
  try {
    const result = await host.templateFieldRestrictions(templateId);
    if (result.error || !result.data) {
      restrictionsFailed.value = true;
      return;
    }
    const map = new Map<string, WorkflowDesignerFieldRestriction>();
    for (const item of result.data.fields) map.set(item.field_id, item);
    restrictions.value = map;
  } catch (err) {
    // 技术细节只进控制台（硬约束：业务界面不出错误码/JSON 结构）；对照列整列改说"暂时取不到"，
    // 不拦对话框本身的使用（限制对照是辅助信息，不是必需前置条件）。
    console.error('[kimpo-workflow] FieldPermissionDialog 取模板字段限制对照失败', err);
    restrictionsFailed.value = true;
  }
}

// ── 草稿态：打开时从 modelValue 初始化，取消/关闭丢弃 ─────────────────────────────────────
const draft = ref<FieldGradeMap>(new Map());
const keyword = ref('');
const checkedFieldIds = ref<Set<string>>(new Set());

watch(
  () => props.show,
  (isShow) => {
    if (!isShow) return;
    let map = toGradeMap(props.modelValue);
    if (props.readonlyOnly) map = normalizeForReadonlyOnly(map);
    draft.value = map;
    keyword.value = '';
    checkedFieldIds.value = new Set();
    void loadRestrictions(props.templateId);
  },
  { immediate: true }
);

const gradeOptions = computed(() => gradesFor(props.readonlyOnly ?? false));
const allTableNames = computed(() => catalog.value?.tables.map((t) => t.tableId) ?? []);

// ── 逐字段取值/回填 ────────────────────────────────────────────────────────────────────
function gradeOf(fieldId: string): FieldGrade {
  return draft.value.get(fieldId)?.grade ?? 'inherit';
}
function setGrade(field: CatalogFieldItem, grade: FieldGrade): void {
  if (props.disabled) return;
  const next = new Map(draft.value);
  if (grade === 'inherit') {
    next.delete(field.fieldId);
  } else {
    next.set(field.fieldId, { tableId: field.tableId, grade });
  }
  draft.value = next;
}

function visibleFieldsOf(table: CatalogTable): CatalogFieldItem[] {
  return table.fields.filter((f) => matchKeyword(f, keyword.value));
}
/** 表头「已单独设置 N 项」计数：草稿只存偏离继承的记录，直接按 draft.has() 计数即可。 */
function customizedCountOf(table: CatalogTable): number {
  return table.fields.filter((f) => draft.value.has(f.fieldId)).length;
}

// ── 模板限制对照 / 冲突提示 ────────────────────────────────────────────────────────────
function restrictionOf(fieldId: string): WorkflowDesignerFieldRestriction | undefined {
  return restrictions.value?.get(fieldId);
}
function restrictionKindOf(fieldId: string): 'none' | 'templateHidden' | 'templateReadonly' {
  return effectiveHint(gradeOf(fieldId), restrictionOf(fieldId)).kind;
}
function hasConflict(fieldId: string): boolean {
  return effectiveHint(gradeOf(fieldId), restrictionOf(fieldId)).warn;
}
function restrictionLabel(fieldId: string): string {
  const kind = restrictionKindOf(fieldId);
  return kind === 'templateHidden'
    ? i18n.t('workflow.designer.dialog.fieldPermission.restrictionHidden')
    : i18n.t('workflow.designer.dialog.fieldPermission.restrictionReadonly');
}

// ── 档位文案（业务话，不出内部枚举值字面量） ───────────────────────────────────────────────
function gradeLabel(grade: FieldGrade): string {
  switch (grade) {
    case 'inherit':
      return i18n.t('workflow.designer.dialog.fieldPermission.grade.inherit');
    case 'edit':
      return i18n.t('workflow.designer.dialog.fieldPermission.grade.edit');
    case 'readonly':
      return i18n.t('workflow.designer.dialog.fieldPermission.grade.readonly');
    default:
      return i18n.t('workflow.designer.dialog.fieldPermission.grade.hidden');
  }
}

// ── 勾选 + 批量 ────────────────────────────────────────────────────────────────────────
function toggleCheck(fieldId: string, checked: boolean): void {
  const next = new Set(checkedFieldIds.value);
  if (checked) next.add(fieldId);
  else next.delete(fieldId);
  checkedFieldIds.value = next;
}
function bulkApply(grade: FieldGrade): void {
  if (props.disabled || checkedFieldIds.value.size === 0) return;
  draft.value = applyBulk(draft.value, Array.from(checkedFieldIds.value), grade, (fieldId) => catalog.value?.byFieldId.get(fieldId)?.tableId);
}

// ── 目录里已不存在的字段：单独一组展示，供设计者删除 ───────────────────────────────────────
interface OrphanEntry {
  fieldId: string;
  tableId: string;
  grade: FieldGrade;
}
const orphanEntries = computed<OrphanEntry[]>(() => {
  if (!catalog.value) return [];
  const result: OrphanEntry[] = [];
  for (const [fieldId, entry] of draft.value) {
    if (!catalog.value.byFieldId.has(fieldId)) result.push({ fieldId, tableId: entry.tableId, grade: entry.grade });
  }
  return result;
});
function removeOrphan(fieldId: string): void {
  if (props.disabled) return;
  const next = new Map(draft.value);
  next.delete(fieldId);
  draft.value = next;
}

// ── 确定 / 取消 ────────────────────────────────────────────────────────────────────────
function onConfirm(): void {
  if (props.disabled) return;
  emit('confirm', fromGradeMap(draft.value, catalog.value));
  emit('update:show', false);
}
function onCancel(): void {
  emit('update:show', false);
}
</script>

<template>
  <!-- 关闭（右上角 ✕ / Esc）= 取消：丢弃草稿，不 emit confirm；只读态（disabled）本就无草稿可丢，同样直接关。
       data-testid="fpd-root" 经 KDialog 透传到窗口外壳元素上。 -->
  <KDialog
    size-preset="M"
    :show="show"
    density="standard"
    :title="i18n.t('workflow.designer.dialog.fieldPermission.title')"
    :maximizable="false"
    :resizable="false"
    :draggable="false"
    flush
    :default-size="{ width: 640, height: 560 }"
    data-testid="fpd-root"
    @close="onCancel"
  >
    <p class="fpd-subtitle">
      {{ readonlyOnly ? i18n.t('workflow.designer.dialog.fieldPermission.subtitleReadonlyOnly') : i18n.t('workflow.designer.dialog.fieldPermission.subtitle') }}
    </p>

    <div class="fpd-toolbar">
      <NInput
        v-model:value="keyword"
        clearable
        size="small"
        class="fpd-search"
        data-testid="fpd-search"
        :placeholder="i18n.t('workflow.designer.dialog.fieldPermission.searchPlaceholder')"
      />
      <div class="fpd-bulk">
        <span class="fpd-bulk__label">{{ i18n.t('workflow.designer.dialog.fieldPermission.bulkLabel', { n: checkedFieldIds.size }) }}</span>
        <NButton size="small" :disabled="disabled || checkedFieldIds.size === 0" data-testid="fpd-bulk-inherit" @click="bulkApply('inherit')">
          {{ i18n.t('workflow.designer.dialog.fieldPermission.bulkInherit') }}
        </NButton>
        <NButton
          v-if="!readonlyOnly"
          size="small"
          :disabled="disabled || checkedFieldIds.size === 0"
          data-testid="fpd-bulk-edit"
          @click="bulkApply('edit')"
        >{{ i18n.t('workflow.designer.dialog.fieldPermission.bulkEdit') }}</NButton>
        <NButton size="small" :disabled="disabled || checkedFieldIds.size === 0" data-testid="fpd-bulk-readonly" @click="bulkApply('readonly')">
          {{ i18n.t('workflow.designer.dialog.fieldPermission.bulkReadonly') }}
        </NButton>
        <NButton size="small" :disabled="disabled || checkedFieldIds.size === 0" data-testid="fpd-bulk-hidden" @click="bulkApply('hidden')">
          {{ i18n.t('workflow.designer.dialog.fieldPermission.bulkHidden') }}
        </NButton>
      </div>
    </div>

    <div class="fpd-body">
      <p v-if="loading" class="fpd-hint">{{ i18n.t('workflow.designer.panel.field.loading') }}</p>
      <div v-else-if="failed" class="fpd-hint-row">
        <span class="fpd-hint">{{ i18n.t('workflow.designer.dialog.fieldPermission.catalogFailed') }}</span>
        <NButton size="small" text data-testid="fpd-retry" @click="reload">{{ i18n.t('workflow.designer.root.retry') }}</NButton>
      </div>
      <template v-else>
        <p v-if="restrictionsFailed" class="fpd-hint">{{ i18n.t('workflow.designer.dialog.fieldPermission.restrictionUnavailable') }}</p>

        <NCollapse :default-expanded-names="allTableNames">
          <NCollapseItem
            v-for="table in catalog?.tables ?? []"
            :key="table.tableId"
            :name="table.tableId"
            :title="table.tableName"
            :data-testid="`fpd-table-${table.tableId}`"
          >
            <template #header-extra>
              <span v-if="customizedCountOf(table) > 0" class="fpd-table-count">
                {{ i18n.t('workflow.designer.panel.fieldPermission.customized', { n: customizedCountOf(table) }) }}
              </span>
            </template>

            <div v-for="field in visibleFieldsOf(table)" :key="field.fieldId" class="fpd-row" :data-testid="`fpd-row-${field.fieldId}`">
              <NCheckbox
                size="medium"
                :checked="checkedFieldIds.has(field.fieldId)"
                :data-testid="`fpd-check-${field.fieldId}`"
                @update:checked="(v) => toggleCheck(field.fieldId, v as boolean)"
              />
              <span class="fpd-row__name">{{ field.fieldName }}</span>
              <NRadioGroup
                :value="gradeOf(field.fieldId)"
                :disabled="disabled"
                size="small"
                @update:value="(v) => setGrade(field, v as FieldGrade)"
              >
                <NRadioButton v-for="grade in gradeOptions" :key="grade" :value="grade" :data-testid="`fpd-grade-${field.fieldId}-${grade}`">
                  {{ gradeLabel(grade) }}
                </NRadioButton>
              </NRadioGroup>
              <span class="fpd-row__restriction">
                <NTag v-if="restrictionKindOf(field.fieldId) !== 'none'" size="small" :type="restrictionKindOf(field.fieldId) === 'templateHidden' ? 'warning' : 'default'">
                  {{ restrictionLabel(field.fieldId) }}
                </NTag>
                <span
                  v-if="hasConflict(field.fieldId)"
                  class="fpd-warn"
                  data-testid="fpd-conflict-warn"
                  :title="i18n.t('workflow.designer.dialog.fieldPermission.conflictHint')"
                >⚠</span>
              </span>
            </div>
            <p v-if="visibleFieldsOf(table).length === 0" class="fpd-hint">{{ i18n.t('workflow.designer.panel.field.empty') }}</p>
          </NCollapseItem>
        </NCollapse>

        <div v-if="orphanEntries.length > 0" class="fpd-orphan">
          <p class="fpd-orphan__title">{{ i18n.t('workflow.designer.dialog.fieldPermission.orphanTitle') }}</p>
          <div v-for="entry in orphanEntries" :key="entry.fieldId" class="fpd-row" :data-testid="`fpd-row-${entry.fieldId}`">
            <span class="fpd-row__name">{{ entry.fieldId }}</span>
            <span class="fpd-row__grade">{{ gradeLabel(entry.grade) }}</span>
            <NButton size="small" :disabled="disabled" :data-testid="`fpd-orphan-remove-${entry.fieldId}`" @click="removeOrphan(entry.fieldId)">
              {{ i18n.t('workflow.designer.dialog.fieldPermission.orphanRemove') }}
            </NButton>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <!-- 页脚统一用 KDialogFooter：只读态（disabled）经 hide-confirm 整体不渲染确认按钮
           （可看不可改，不留一个点了也没用的按钮），只留取消。 -->
      <KDialogFooter
        :hide-confirm="disabled"
        :confirm-text="i18n.t('workflow.designer.dialog.fieldPermission.confirm')"
        :cancel-text="i18n.t('workflow.designer.dialog.fieldPermission.cancel')"
        @confirm="onConfirm"
        @cancel="onCancel"
      />
    </template>
  </KDialog>
</template>

<style scoped>
.fpd-subtitle {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 16px 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 12px;
  line-height: 1.5;
}
.fpd-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  flex-wrap: wrap;
}
.fpd-search { width: 200px; flex: 0 0 auto; }
.fpd-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.fpd-bulk__label { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; margin-right: 2px; }
.fpd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fpd-hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 12px;
  line-height: 1.5;
}
.fpd-hint-row { display: flex; align-items: center; gap: 8px; }
.fpd-table-count {
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  margin-right: 8px;
}
.fpd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid rgb(var(--border-lighter-color, 235 238 245));
}
.fpd-row:last-child { border-bottom: none; }
.fpd-row__name {
  flex: 0 0 auto;
  min-width: 90px;
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
}
.fpd-row__grade { flex: 0 0 auto; color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.fpd-row__restriction { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.fpd-warn { color: rgb(var(--warning-color, 217 141 0)); font-size: 12px; cursor: help; }
.fpd-orphan {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgb(var(--border-light-color, 228 231 237));
}
.fpd-orphan__title {
  margin: 0 0 4px;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 12px;
}
</style>
