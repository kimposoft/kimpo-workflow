<script lang="ts">
/**
 * designer/panels/shared/MainFieldSelect.vue —— 主表字段下拉纯逻辑：
 * 与下方 <script setup> 的事件绑定/模板渲染分离，供单测直接覆盖"按 data_type 过滤"这条规则——
 * 同 ApprovePanel.vue/handleSections.ts 头注释的既定分工（NaiveUI 的 NSelect 下拉在 happy-dom
 * 环境下不会真的展开，唯有把"候选怎么算"抽成纯函数才能测，组件层挂载测试只覆盖"选中值回显对不
 * 对/禁用态对不对"）。
 */
import { fieldsOfType, mainTableOf, type CatalogFieldItem, type TemplateFieldCatalog } from './templateFieldCatalog';

/** 主表字段候选：dataType 缺省时列主表全部字段；给了 dataType 时只列主表内该类型的字段（如结果/
 *  标识写入字段只允许文本类，即发布期字段类型约束在设计态提前收窄）。取数源头是共享目录 catalog。 */
export function mainFieldOptionsOf(catalog: TemplateFieldCatalog | null, dataType?: string): CatalogFieldItem[] {
  if (dataType) return fieldsOfType(catalog, dataType, { mainOnly: true });
  return mainTableOf(catalog)?.fields ?? [];
}
</script>

<script setup lang="ts">
/**
 * 经共享取数件 ./templateFieldCatalog.ts 的 useTemplateFieldCatalog 取整份模板字段目录（主表 +
 * 全部扩展表，已滤掉退役字段类型），本组件只在其基础上按 mainFieldOptionsOf() 收窄到"主表 +
 * 可选 dataType"这一档——不再自行调用 host.listTemplateTables/listTemplateFields 各写一份（那是
 * 共享取数件内部已经做过的事，见其文件头注释），与办理节点「回退时清空字段」（同样消费
 * 该共享取数件）共用同一份目录/同一份模块级缓存，避免同一模板重复发两轮请求。
 *
 * 空态口径（只给业务话，不报错码）：
 *   - templateId 为空：还没有可用的目标表单，不发请求，直接给业务提示；
 *   - 取数失败/没有主表/字段列表为空：统一"取不到字段"文案，技术细节只进 console.error（由共享
 *     取数件负责打印，本组件不重复打）。
 */
import { computed, inject } from 'vue';
import { NSelect } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import { DESIGNER_I18N_KEY } from '../../host';
import { useTemplateFieldCatalog } from './templateFieldCatalog';

const props = defineProps<{
  templateId?: string;
  modelValue?: string;
  /** 只列这个 data_type 的字段（如 'text'）；缺省不过滤。 */
  dataType?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 下拉菜单按字段名长度撑开（不跟随触发框等宽），用于触发框较窄的行内场景，避免字段名被截成「单…」。 */
  menuAutoWidth?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string | undefined): void }>();

const i18n = inject(DESIGNER_I18N_KEY) as PluginI18n;

const { catalog, loading, failed } = useTemplateFieldCatalog(() => props.templateId);

const items = computed(() => mainFieldOptionsOf(catalog.value, props.dataType));
const options = computed(() => items.value.map((f) => ({ label: f.fieldName, value: f.fieldId })));

function onChange(value: string | number | null): void {
  emit('update:modelValue', value === null ? undefined : String(value));
}
</script>

<template>
  <div class="wf-main-field-select">
    <NSelect
      class="wf-main-field-select__control"
      size="small"
      filterable
      clearable
      :value="modelValue ?? null"
      :options="options"
      :consistent-menu-width="!menuAutoWidth"
      :menu-props="menuAutoWidth ? { style: 'min-width: 160px; max-width: 320px' } : undefined"
      :disabled="disabled || loading || !templateId"
      :placeholder="placeholder ?? i18n.t('workflow.designer.panel.field.placeholder')"
      @update:value="onChange"
    />
    <p v-if="!templateId" class="wf-main-field-select__hint">{{ i18n.t('workflow.designer.panel.field.noTemplate') }}</p>
    <p v-else-if="loading" class="wf-main-field-select__hint">{{ i18n.t('workflow.designer.panel.field.loading') }}</p>
    <p v-else-if="failed || items.length === 0" class="wf-main-field-select__hint">{{ i18n.t('workflow.designer.panel.field.empty') }}</p>
  </div>
</template>

<style scoped>
.wf-main-field-select {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wf-main-field-select__control {
  width: 100%;
}
.wf-main-field-select__hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
</style>
