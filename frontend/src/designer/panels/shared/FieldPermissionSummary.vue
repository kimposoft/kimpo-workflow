<script setup lang="ts">
/**
 * designer/panels/shared/FieldPermissionSummary.vue —— 字段权限（『B』）摘要 + 设置入口（打开
 * dialogs/FieldPermissionDialog.vue）。
 *
 * i18n key：`workflow.designer.panel.fieldPermission.customized/inherited`（"已单独设置 N 项"/
 * "继承模板"），插值参数名统一用 `{n}`，不另起 `{count}`。
 *
 * readonlyOnly：审批 / 抄送节点属于『B-只看型』（这类节点不改内容，继承到模板"编辑"档时按只读
 * 生效），与发起 / 办理的『B-可编辑
 * 型』不是同一档位集合——传给对话框的 `readonlyOnly` 决定四档还是三档、批量区是否出现"设为可
 * 编辑"。
 *
 * 其它约定：
 *   - `disabled`（可选）：只读 / 已发布等场景传 true，按钮仍显示但置灰，对话框内不出现确定按钮
 *     （见 FieldPermissionDialog.vue `disabled` 语义）。
 *   - `update:modelValue` 事件：对话框确定后把新清单 emit 出去，由父面板负责落回文档。父层
 *     没有监听这个事件时本组件也不报错，只是确定后的改动不会落库。
 *   - 模板 id 不要求父层传入：本组件自己 inject(DESIGNER_STATE_KEY) 经 mainTemplateIdOf(doc)
 *     取"发起节点配置的目标表单"（同 ApprovePanel.vue 等既有面板的取法）——字段权限清单本就是
 *     按这份模板的字段设置的，父层没有再单独传一份 templateId 的必要。取不到（还没选目标表单）
 *     时按钮置灰，title 给业务话提示，不打开一个没有字段可选的空对话框。
 *
 *  WorkflowDocumentState 内部变更不天然驱动 Vue 响应式（同 ApprovePanel.vue/HandlePanel.vue 既定
 *  写法）：手动订阅 state.onChange 打一个 changeTick 驱动 templateId 重新求值——否则用户在发起
 *  节点换了目标表单后，本组件不会跟着更新。
 */
import { computed, inject, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { FieldPermission } from '../../../model';
import { DESIGNER_I18N_KEY, DESIGNER_STATE_KEY } from '../../host';
import { mainTemplateIdOf } from '../../expression/v4Scope';
import { gradeCounts } from '../dialogs/fieldPermission';
import FieldPermissionDialog from '../dialogs/FieldPermissionDialog.vue';

const props = defineProps<{ modelValue?: FieldPermission[]; readonlyOnly?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [perms: FieldPermission[]] }>();

const i18n = inject(DESIGNER_I18N_KEY) as PluginI18n;
const state = inject(DESIGNER_STATE_KEY);

// ── 目标模板 id：跟随发起节点配置，文档内部变更需手动打 tick 才能驱动重新求值 ───────────────
const changeTick = ref(0);
watch(
  () => state?.value,
  (s, _old, onCleanup) => {
    const unsubscribe = s?.onChange(() => {
      changeTick.value++;
    });
    onCleanup(() => unsubscribe?.());
  },
  { immediate: true }
);
const templateId = computed(() => {
  void changeTick.value;
  return mainTemplateIdOf(state?.value?.doc);
});

const count = computed(() => props.modelValue?.length ?? 0);
const counts = computed(() => gradeCounts(props.modelValue));

// ── 对话框显隐 + 确定回写 ──────────────────────────────────────────────────────────────
const dialogOpen = ref(false);
function openDialog(): void {
  if (!templateId.value) return;
  dialogOpen.value = true;
}
function onDialogConfirm(perms: FieldPermission[]): void {
  emit('update:modelValue', perms);
}
</script>

<template>
  <div class="wf-field-permission-summary">
    <!-- 摘要收进带边框的内嵌小卡，与下方「设置字段权限」按钮分成两块。 -->
    <div class="wf-field-permission-summary__box">
    <p class="wf-field-permission-summary__text">
      {{ count > 0 ? i18n.t('workflow.designer.panel.fieldPermission.customized', { n: count }) : i18n.t('workflow.designer.panel.fieldPermission.inherited') }}
    </p>
    <p v-if="count > 0" class="wf-field-permission-summary__breakdown">
      {{
        readonlyOnly
          ? i18n.t('workflow.designer.panel.fieldPermission.breakdownReadonlyOnly', { readonly: counts.readonly, hidden: counts.hidden })
          : i18n.t('workflow.designer.panel.fieldPermission.breakdown', { readonly: counts.readonly, hidden: counts.hidden, edit: counts.edit })
      }}
    </p>
    <p class="wf-field-permission-summary__hint">{{ i18n.t('workflow.designer.panel.fieldPermission.hint') }}</p>
    <p v-if="readonlyOnly" class="wf-field-permission-summary__hint">{{ i18n.t('workflow.designer.panel.fieldPermission.readonlyOnlyHint') }}</p>
    </div>

    <NButton
      size="small"
      class="wf-field-permission-summary__btn"
      data-testid="fp-summary-open"
      :disabled="!templateId"
      :title="!templateId ? i18n.t('workflow.designer.panel.field.noTemplate') : undefined"
      @click="openDialog"
    >
      {{ i18n.t('workflow.designer.panel.fieldPermission.openButton') }}
    </NButton>

    <FieldPermissionDialog
      :show="dialogOpen"
      :model-value="modelValue ?? []"
      :template-id="templateId"
      :readonly-only="readonlyOnly"
      :disabled="disabled"
      @update:show="dialogOpen = $event"
      @confirm="onDialogConfirm"
    />
  </div>
</template>

<style scoped>
.wf-field-permission-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wf-field-permission-summary__box {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-field-permission-summary__text {
  margin: 0;
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
}
.wf-field-permission-summary__breakdown {
  margin: 0;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 11px;
}
.wf-field-permission-summary__hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
.wf-field-permission-summary__btn {
  align-self: flex-start;
}
</style>
