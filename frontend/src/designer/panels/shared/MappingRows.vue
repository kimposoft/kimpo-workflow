<script setup lang="ts">
/**
 * designer/panels/shared/MappingRows.vue —— 子流程节点『传递字段』清单编辑控件：
 * 一行一条「来源字段 → 目标字段 ✕」，「＋ 添加传递字段」新增一条
 * 空白行待设计者在行内选择来源/目标。
 *
 * 只做"画出来 + 接线"，具体口径（写回格式、类型兼容、同表约束、字段反查）全部经 ./subflowMapping.ts
 * 纯函数完成，本组件不重复实现——同 ../shared/AssigneeSourceList.vue 与 ../ApprovePanel.vue
 * 的既定分工（本插件前端未装 @vue/test-utils，能测的逻辑一律先抽成纯函数）。
 *
 * loading/failed 由调用方（SubflowPanel.vue）合并两份目录（本模板来源目录 + 目标流程模板目录）
 * 的状态后传入——本组件不关心"是哪份目录"没加载好，统一按一套失败态渲染 + reload 事件转发。
 */
import { computed, inject } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import { DESIGNER_I18N_KEY } from '../../host';
import type { SubflowFieldMapping } from '../../../model';
import {
  compatibleTargets,
  decodeSourceOptionValue,
  detailTableConflicts,
  encodeSourceOptionValue,
  mappingFromSourceKey,
  resolveSourceField,
  resolveTargetField
} from './subflowMapping';
import { mainTableOf, detailTablesOf, type CatalogFieldItem, type TemplateFieldCatalog } from './templateFieldCatalog';

const props = defineProps<{
  modelValue: SubflowFieldMapping[];
  /** 当前流程目标模板（本模板）的字段目录：传递字段『来源』的候选池（主表 + 全部扩展表）。 */
  sourceCatalog: TemplateFieldCatalog | null;
  /** 目标流程所绑模板的字段目录：传递字段『目标』只认它的主表字段。 */
  targetCatalog: TemplateFieldCatalog | null;
  loading?: boolean;
  failed?: boolean;
  readOnly?: boolean;
  /** 未选目标流程时置灰"＋ 添加传递字段"。 */
  addDisabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [mappings: SubflowFieldMapping[]];
  reload: [];
}>();

const i18n = inject(DESIGNER_I18N_KEY) as PluginI18n;

function commit(next: SubflowFieldMapping[]): void {
  emit('update:modelValue', next);
}

// ── 来源字段：主表 + 全部扩展表，按表分组（主表恒排第一，见 templateFieldCatalog.ts） ─────────
const sourceOptions = computed(() => {
  const catalog = props.sourceCatalog;
  if (!catalog) return [];
  const main = mainTableOf(catalog);
  const details = detailTablesOf(catalog);
  const groups: { type: 'group'; key: string; label: string; children: { label: string; value: string }[] }[] = [];
  if (main) {
    groups.push({
      type: 'group',
      key: main.tableId,
      label: main.tableName,
      children: main.fields.map((f) => ({ label: f.fieldName, value: encodeSourceOptionValue(f) }))
    });
  }
  for (const table of details) {
    groups.push({
      type: 'group',
      key: table.tableId,
      label: table.tableName,
      children: table.fields.map((f) => ({ label: f.fieldName, value: encodeSourceOptionValue(f) }))
    });
  }
  return groups;
});

// ── 目标字段：目标模板的主表字段（按来源类型过滤，见 compatibleTargets） ─────────────────────
const targetMainFields = computed<CatalogFieldItem[]>(() => mainTableOf(props.targetCatalog)?.fields ?? []);

function resolvedSource(mapping: SubflowFieldMapping): CatalogFieldItem | undefined {
  return resolveSourceField(mapping, props.sourceCatalog);
}
/** 来源字段"曾经配过但目录里已经找不到"（非空 draft）——区分"新增待选"的空白行，避免新增行
 *  一出来就被误判成"字段已不存在"。 */
function sourceMissing(mapping: SubflowFieldMapping): boolean {
  return Boolean(mapping.source_field_id) && !resolvedSource(mapping);
}
function targetMissing(mapping: SubflowFieldMapping): boolean {
  return Boolean(mapping.target_field_id) && Boolean(props.targetCatalog) && !resolveTargetField(mapping, targetMainFields.value);
}
function targetOptionsFor(mapping: SubflowFieldMapping): { label: string; value: string }[] {
  return compatibleTargets(resolvedSource(mapping), targetMainFields.value).map((f) => ({ label: f.fieldName, value: f.fieldId }));
}

const conflictIndexes = computed(() => new Set(detailTableConflicts(props.modelValue)));
const hasConflicts = computed(() => conflictIndexes.value.size > 0);

// ── 行编辑 ──────────────────────────────────────────────────────────────────────────────
function addRow(): void {
  if (props.readOnly || props.addDisabled) return;
  commit([...props.modelValue, mappingFromSourceKey('', '', '')]);
}
function removeAt(index: number): void {
  if (props.readOnly) return;
  commit(props.modelValue.filter((_, i) => i !== index));
}
/** 换来源字段：连带清空目标字段（新来源的类型兼容集合已变化，旧目标可能不再兼容，交给设计者
 *  重新选择，不静默保留一个可能已经类型不匹配的目标）。 */
function onSourceChange(index: number, value: string | null): void {
  if (props.readOnly || !value) return;
  const decoded = decodeSourceOptionValue(value);
  if (!decoded) return;
  const next = props.modelValue.map((m, i) => (i === index ? mappingFromSourceKey(decoded.sourceTableId, decoded.fieldId, '') : m));
  commit(next);
}
function onTargetChange(index: number, value: string | null): void {
  if (props.readOnly) return;
  const next = props.modelValue.map((m, i) => (i === index ? { ...m, target_field_id: value ?? '' } : m));
  commit(next);
}
</script>

<template>
  <div class="wf-mapping-rows">
    <p v-if="loading" class="wf-mapping-rows__hint">{{ i18n.t('workflow.designer.panel.field.loading') }}</p>
    <template v-else-if="failed">
      <p class="wf-mapping-rows__hint wf-mapping-rows__hint--warn">{{ i18n.t('workflow.designer.subflow.mapping.loadFailedHint') }}</p>
      <NButton size="small" data-testid="subflow-map-reload" @click="emit('reload')">{{ i18n.t('workflow.designer.root.retry') }}</NButton>
    </template>
    <template v-else>
      <p v-if="modelValue.length === 0" class="wf-mapping-rows__empty">{{ i18n.t('workflow.designer.subflow.mapping.empty') }}</p>

      <ul v-else class="wf-mapping-rows__list">
        <li
          v-for="(mapping, index) in modelValue"
          :key="index"
          class="wf-mapping-rows__row"
          :class="{ 'wf-mapping-rows__row--warn': conflictIndexes.has(index) }"
          :data-testid="`subflow-map-row-${index}`"
        >
          <span v-if="sourceMissing(mapping)" class="wf-mapping-rows__missing" :data-testid="`subflow-map-source-${index}`">
            {{ i18n.t('workflow.designer.subflow.mapping.fieldMissing') }}
          </span>
          <NSelect
            v-else
            class="wf-mapping-rows__select"
            size="small"
            filterable
            :data-testid="`subflow-map-source-${index}`"
            :value="resolvedSource(mapping) ? encodeSourceOptionValue(resolvedSource(mapping)!) : null"
            :options="sourceOptions"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.subflow.mapping.sourcePlaceholder')"
            @update:value="(v) => onSourceChange(index, v)"
          />

          <span class="wf-mapping-rows__arrow">→</span>

          <span v-if="targetMissing(mapping)" class="wf-mapping-rows__missing" :data-testid="`subflow-map-target-${index}`">
            {{ i18n.t('workflow.designer.subflow.mapping.fieldMissing') }}
          </span>
          <NSelect
            v-else
            class="wf-mapping-rows__select"
            size="small"
            filterable
            :data-testid="`subflow-map-target-${index}`"
            :value="mapping.target_field_id || null"
            :options="targetOptionsFor(mapping)"
            :disabled="readOnly || !resolvedSource(mapping)"
            :placeholder="i18n.t('workflow.designer.subflow.mapping.targetPlaceholder')"
            @update:value="(v) => onTargetChange(index, v)"
          />

          <NButton
            quaternary
            circle
            size="small"
            class="wf-mapping-rows__remove"
            :data-testid="`subflow-map-remove-${index}`"
            :disabled="readOnly"
            :title="i18n.t('workflow.designer.assignee.remove')"
            :aria-label="i18n.t('workflow.designer.assignee.remove')"
            @click="removeAt(index)"
          >✕</NButton>
        </li>
      </ul>

      <p v-if="hasConflicts" class="wf-mapping-rows__hint wf-mapping-rows__hint--warn">{{ i18n.t('workflow.designer.subflow.mapping.detailTableConflict') }}</p>

      <NButton
        dashed
        type="primary"
        size="small"
        data-testid="subflow-map-add"
        :disabled="readOnly || addDisabled"
        @click="addRow"
      >{{ i18n.t('workflow.designer.subflow.mapping.add') }}</NButton>
    </template>
  </div>
</template>

<style scoped>
.wf-mapping-rows { display: flex; flex-direction: column; gap: 8px; }
.wf-mapping-rows__empty { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 12px; }
.wf-mapping-rows__list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.wf-mapping-rows__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-mapping-rows__row--warn {
  border-color: rgb(var(--warning-color, 240 160 32) / 60%);
  background: rgb(var(--warning-color, 240 160 32) / 6%);
}
.wf-mapping-rows__select { flex: 1; min-width: 0; }
.wf-mapping-rows__missing {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--warning-color, 240 160 32));
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.wf-mapping-rows__arrow { flex: 0 0 auto; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 12px; }
.wf-mapping-rows__remove { flex: 0 0 auto; color: rgb(var(--text-hint-color, 153 153 153)); }
.wf-mapping-rows__hint { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
.wf-mapping-rows__hint--warn { color: rgb(var(--warning-color, 240 160 32)); }
</style>
