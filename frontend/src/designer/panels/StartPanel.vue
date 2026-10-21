<script setup lang="ts">
/**
 * designer/panels/StartPanel.vue —— 发起节点（N1）属性面板。
 * 由 shell/PropsPanel.vue 按节点类型注册表（designer/nodes/start/index.ts 的 panel 字段）分发，
 * 恰好选中唯一的 kind==='start' 节点时渲染，接收 `node`/`readOnly` 两个 prop。
 *
 * 目标表单选择调宿主通用弹窗 `host.ui.openTemplatePicker({appId, selectedTemplateId})`——appId
 * 现由 DesignerHost.appId 提供（宿主 hostContext.appId 经 surfaces/index.ts 转入
 * createDesignerHost，见 ../host.ts DesignerHost.appId 与 CreateDesignerHostInput.appId 注释），
 * 插件侧不另做搜索下拉。
 *
 * 「发起权限」经 OrgTriLine 调 host.ui.openOrgTriPicker，同样带上 host.appId（角色页签"本应用
 * 角色"分组按它收窄）。
 *
 * 面板骨架按分区（tab）组织，节点改名由公共头部 PanelHeader.vue 就地完成，本面板不另设「节点
 * 名称」分区。三个分区固定顺序 basic → initiator → formAndHint：
 *   - basic：目标表单 / 发起条件 / 允许人工发起 / 步骤摘要；
 *   - initiator：发起权限；
 *   - formAndHint：字段权限 / 无路可走时的提示 / 通知。
 * host/i18n/state 三个注入统一经 usePanelHost.ts 取得。
 *
 * 通知开关是节点级配置，放在 formAndHint 分区末尾（shared/NotifyCard.vue）。发起节点认三个开关键：
 * on_returned（被退回到发起人）、on_withdrawn（提交被撤销）、on_terminated（实例被管理员终止）
 * ——发起节点没有 on_assigned/on_ended（发起本身不是"收到任务"，也不是"流程结束"）。
 *
 * 『发起条件』卡：一条 V4 判断表达式 + 「不满足时的提示」（配了条件才出现，草稿+失焦提交，见下方
 * 脚本区注释）。initiator 分区「谁能发起」支持第四档来源『主表字段』，经 OrgTriLine 的 `templateId`
 * prop 传入目标模板 id 供其列字段。换目标模板时
 * （pickTemplate）start_condition 与 start_permission.main_field_id/match_by 随 summary_expr/
 * field_permissions 一并清空（都是引用旧模板字段/表达式作用域的内容）。
 */
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import type { TemplatePickerResultTemplate } from '@kimposoft/plugin-sdk';
import type { StartConfig, V4ExpressionDocumentEnvelope, WorkflowNode } from '../../model';
import type { WorkflowDesignerTemplateDetail } from '../host';
// 步骤摘要与发起条件共用 V4 表达式输入组件。
import V4ExpressionField from '../expression/V4ExpressionField.vue';
import PanelHeader from './PanelHeader.vue';
import PanelTabs, { type PanelTabItem } from './PanelTabs.vue';
import { usePanelHost } from './usePanelHost';
import PanelSection from './PanelSection.vue';
import FieldPermissionSummary from './shared/FieldPermissionSummary.vue';
import OrgTriLine from './shared/OrgTriLine.vue';
import NotifyCard, { type NotifyCardSwitch } from './shared/NotifyCard.vue';

const props = defineProps<{ node: WorkflowNode; readOnly?: boolean }>();

// usePanelHost 缺少任一注入时已经 throw，因此 host 恒非空，无需再判空。
const { host, i18n, state } = usePanelHost();

const config = computed<StartConfig>(
  () =>
    (props.node.config as StartConfig | undefined) ?? {
      target_template_id: '',
      allow_manual_start: true,
      no_route_hint: '',
      start_permission: {}
    }
);

function patchConfig(patch: Partial<StartConfig>): void {
  if (props.readOnly) return;
  state.value?.updateNodeConfig(props.node.id, patch as Record<string, unknown>);
}

// ── 目标表单：展示态 ────────────────────────────────────────────────────────────────────
const templateDetail = ref<WorkflowDesignerTemplateDetail | undefined>();
const templateLoadFailed = ref(false);

watch(
  () => config.value.target_template_id,
  async (templateId) => {
    templateDetail.value = undefined;
    templateLoadFailed.value = false;
    if (!templateId?.trim()) return;
    try {
      const result = await host.getTemplate(templateId);
      if (result.error || !result.data) {
        templateLoadFailed.value = true;
        return;
      }
      templateDetail.value = result.data;
    } catch (err) {
      console.error('[kimpo-workflow] 取目标表单详情失败', err);
      templateLoadFailed.value = true;
    }
  },
  { immediate: true }
);

const templateDisplayName = computed(() => {
  if (!config.value.target_template_id) return i18n.t('workflow.designer.panel.start.templateUnset');
  if (templateDetail.value) return templateDetail.value.template_name;
  return templateLoadFailed.value ? i18n.t('workflow.designer.panel.start.templateLoadFailed') : i18n.t('workflow.designer.panel.start.templateLoading');
});
const templateUnpublished = computed(() => Boolean(config.value.target_template_id) && templateDetail.value?.has_active_bundle === false);

// ── 目标表单：选择（宿主通用模板选择弹窗） ─────────────────────────────────────────────────

/** 打开宿主通用模板选择弹窗；appId 来自 DesignerHost.appId，selectedTemplateId 回显当前已选
 * （未选时传 undefined，不传空串——弹窗按"没有预选"处理）。弹窗本身的取消/关闭在
 * result.confirmed===false 时已经是"什么都不做"，不需要本层再额外判断。 */
async function openPicker(): Promise<void> {
  if (props.readOnly) return;
  try {
    const result = await host.ui.openTemplatePicker({
      appId: host.appId,
      title: i18n.t('workflow.designer.panel.start.templatePick'),
      selectedTemplateId: config.value.target_template_id || undefined
    });
    if (!result.confirmed || !result.template) return;
    await pickTemplate(result.template);
  } catch (err) {
    // 技术细节只进控制台（硬约束：业务界面不出错误码/JSON 结构）。
    console.error('[kimpo-workflow] 打开表单选择弹窗失败', err);
    window.$message?.error?.(i18n.t('workflow.designer.panel.start.templatePickFailed'));
  }
}

/** 选中一个模板：换成"另一个"已有选择时二次确认并清空 summary_expr/field_permissions/
 * start_condition 以及 start_permission 里的 main_field_id/match_by
 * ——这些都是引用旧模板字段/表达式作用域的内容，换模板后失去意义，一并清空（文案说明换表单会
 * 清空哪些内容）；首次选择（此前未选过）不需要确认。 */
async function pickTemplate(item: TemplatePickerResultTemplate): Promise<void> {
  if (props.readOnly) return;
  const current = config.value.target_template_id;
  if (current && current !== item.template_id) {
    // 走宿主确认框服务；取不到服务（ui 未接线 reject）时按取消处理，不回退原生 confirm。
    let confirmed = false;
    try {
      ({ confirmed } = await host.ui.openConfirm({
        content: i18n.t('workflow.designer.panel.start.templateChangeConfirm')
      }));
    } catch (err) {
      console.warn('[kimpo-workflow] 换表单确认框不可用，按取消处理', err);
    }
    if (!confirmed) return;
  }
  state.value?.updateNodeConfig(props.node.id, (cfg) => {
    const prev = (cfg ?? {}) as Partial<StartConfig>;
    // 发起权限里的主表字段来源引用旧模板的字段 id，随换模板一并清空；用户/角色/部门三组来源与
    // 模板无关，原样保留（同 destructure 剔除 main_field_id/match_by 后剩下的部分）。
    const { main_field_id: _droppedMainFieldId, match_by: _droppedMatchBy, ...restPermission } = prev.start_permission ?? {};
    void _droppedMainFieldId;
    void _droppedMatchBy;
    return {
      ...prev,
      target_template_id: item.template_id,
      summary_expr: undefined,
      field_permissions: undefined,
      start_condition: undefined,
      start_permission: restPermission
    };
  });
}

// ── 发起权限 ────────────────────────────────────────────────────────────────────────────
function onStartPermissionChange(value: StartConfig['start_permission']): void {
  patchConfig({ start_permission: value });
}

// ── 允许人工发起 ────────────────────────────────────────────────────────────────────────
function onAllowManualStartChange(checked: boolean): void {
  patchConfig({ allow_manual_start: checked });
}

// ── 无路可走时的提示 ────────────────────────────────────────────────────────────────────
function onNoRouteHintInput(value: string): void {
  patchConfig({ no_route_hint: value });
}

// ── 步骤摘要（V4 取值表达式，模板未发布时禁用并给提示） ────────────────────────────
const summaryExpressionId = computed(() => `${props.node.id}:summary`);
function onSummaryExprChange(value?: V4ExpressionDocumentEnvelope): void {
  patchConfig({ summary_expr: value });
}

// ── 发起条件：一条 V4 判断表达式，真正发起前
// 求值一次，为假则不发起、向发起人显示下面的「不满足时的提示」；只是闸门，不参与选流程。 ─────
const startConditionExpressionId = computed(() => `${props.node.id}:start_cond`);
function onStartConditionChange(value?: V4ExpressionDocumentEnvelope): void {
  // 清空条件写 undefined（序列化后键消失，同 summary_expr 既定口径）；提示文本（下面的
  // conditionHintDraft/start_condition_hint）不在这里联动清空：设计者可能只是临时拿掉条件。
  patchConfig({ start_condition: value });
}

// 「不满足时的提示」：草稿 + 失焦提交（照抄 EdgePanel.vue 连线名称输入的既定手法，不逐字符进
// 撤销栈）。两个 watch 分工同 EdgePanel.vue 头注释：节点切换时重置草稿（本面板恒对应同一个
// 发起节点单例，理论上不会真的切换，但沿用既定写法保持一致、也覆盖测试直接换 node prop 的场景）；
// 值被外部改动（撤销/重做）时同步草稿。
const conditionHintDraft = ref(config.value.start_condition_hint ?? '');
watch(
  () => props.node.id,
  () => {
    conditionHintDraft.value = config.value.start_condition_hint ?? '';
  }
);
watch(
  () => config.value.start_condition_hint,
  (next) => {
    conditionHintDraft.value = next ?? '';
  }
);
function onConditionHintDraftInput(value: string): void {
  conditionHintDraft.value = value;
}
function commitConditionHint(): void {
  if (props.readOnly) return;
  patchConfig({ start_condition_hint: conditionHintDraft.value });
}

// ── 字段权限（可编辑型）：FieldPermissionSummary 自带对话框，
// 确定后经 update:model-value 把新清单写回 field_permissions；只读态透传 readOnly 给 disabled，
// 对话框内可看不可改（不出确定按钮）。
function onFieldPermissionsChange(value: StartConfig['field_permissions']): void {
  patchConfig({ field_permissions: value });
}

// ── 通知：发起节点只认『被退回到发起人 / 提交被撤销 / 实例被
// 管理员终止』三个开关键，文案在本文件按当前语言翻译好传给 NotifyCard（该组件本身不持有业务
// i18n key，见其头注释）。 ─────────────────────────────────────────────────────────────────
const notifySwitches = computed<NotifyCardSwitch[]>(() => [
  { key: 'on_returned', label: i18n.t('workflow.designer.panel.start.notifyOnReturned') },
  { key: 'on_withdrawn', label: i18n.t('workflow.designer.panel.start.notifyOnWithdrawn') },
  { key: 'on_terminated', label: i18n.t('workflow.designer.panel.start.notifyOnTerminated') }
]);
function onNotifyChange(value: StartConfig['notify']): void {
  patchConfig({ notify: value });
}

// ── 分区：固定顺序 basic → initiator → formAndHint；内容显隐用同一份常驻 DOM 树的 v-show（不是 v-if），切分区不重新挂载/丢内部状态。
const activeTab = ref<'basic' | 'initiator' | 'formAndHint'>('basic');
const tabs = computed<PanelTabItem[]>(() => [
  { key: 'basic', label: i18n.t('workflow.designer.panel.tabs.basic') },
  { key: 'initiator', label: i18n.t('workflow.designer.panel.tabs.initiator') },
  { key: 'formAndHint', label: i18n.t('workflow.designer.panel.tabs.formAndHint') }
]);
function onTabChange(key: string): void {
  activeTab.value = key as typeof activeTab.value;
}
</script>

<template>
  <div class="wf-start-panel">
    <PanelHeader :node="node" :read-only="readOnly" />
    <PanelTabs :tabs="tabs" :active="activeTab" :read-only="readOnly" @update:active="onTabChange">
      <div v-show="activeTab === 'basic'" class="wf-start-panel__pane">
        <PanelSection
          :title="i18n.t('workflow.designer.panel.start.templateTitle')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <!-- 只读框 + 「选择模板」同一行。 -->
          <div class="wf-start-panel__template-row">
            <span class="wf-start-panel__template-box">
            <span class="wf-start-panel__template-name">{{ templateDisplayName }}</span>
            <span v-if="templateUnpublished" class="wf-start-panel__badge">{{ i18n.t('workflow.designer.panel.start.templateUnpublished') }}</span>
            <span v-if="templateUnpublished" class="wf-start-panel__info" :title="i18n.t('workflow.designer.panel.start.templateUnpublishedInfo')">ⓘ</span>
            </span>
          <div class="wf-start-panel__template-actions">
            <NButton size="small" :disabled="readOnly" @click="openPicker">
              {{ i18n.t('workflow.designer.panel.start.templatePick') }}
            </NButton>
          </div>
          </div>
        </PanelSection>

        <!-- 发起条件：不填即不限，本身可空，不标
             必填红星。配了条件才出现下方「不满足时的提示」输入——见脚本区 conditionHintDraft
             注释（草稿 + 失焦提交）。 -->
        <PanelSection :title="i18n.t('workflow.designer.panel.section.startCondition')">
          <V4ExpressionField
            :model-value="config.start_condition"
            mode="condition"
            :expression-id="startConditionExpressionId"
            :template-id="config.target_template_id"
            :disabled="readOnly || templateUnpublished"
            :disabled-hint="templateUnpublished ? i18n.t('workflow.designer.panel.start.summaryNeedsPublish') : undefined"
            :placeholder="i18n.t('workflow.designer.panel.start.conditionPlaceholder')"
            :purpose="i18n.t('workflow.designer.panel.section.startCondition')"
            @update:model-value="onStartConditionChange"
          />
          <p class="wf-start-panel__hint">{{ i18n.t('workflow.designer.panel.start.conditionHelp') }}</p>
          <template v-if="config.start_condition">
            <span class="wf-start-panel__field-label">{{ i18n.t('workflow.designer.panel.start.conditionHintLabel') }}</span>
            <NInput
              class="wf-start-panel__textarea"
              type="textarea"
              size="small"
              :autosize="{ minRows: 2 }"
              :value="conditionHintDraft"
              :disabled="readOnly"
              data-testid="start-condition-hint"
              :placeholder="i18n.t('workflow.designer.panel.start.conditionHintPlaceholder')"
              @update:value="onConditionHintDraftInput"
              @blur="commitConditionHint"
            />
            <p v-if="!config.start_condition_hint" class="wf-start-panel__hint wf-start-panel__hint--warn">
              {{ i18n.t('workflow.designer.panel.start.conditionHintRequiredHint') }}
            </p>
          </template>
        </PanelSection>

        <PanelSection :title="i18n.t('workflow.designer.panel.start.manualTitle')" :info="i18n.t('workflow.designer.panel.start.manualInfo')">
          <template #aside>
            <NCheckbox size="medium" class="wf-start-panel__switch" :checked="config.allow_manual_start" :disabled="readOnly" @update:checked="onAllowManualStartChange" />
          </template>
        </PanelSection>

        <PanelSection :title="i18n.t('workflow.designer.panel.section.summary')">
          <V4ExpressionField
            :model-value="config.summary_expr"
            mode="value"
            :expression-id="summaryExpressionId"
            :template-id="config.target_template_id"
            :disabled="readOnly || templateUnpublished"
            :disabled-hint="templateUnpublished ? i18n.t('workflow.designer.panel.start.summaryNeedsPublish') : undefined"
            :placeholder="i18n.t('workflow.designer.panel.summaryPlaceholder')"
            @update:model-value="onSummaryExprChange"
          />
        </PanelSection>
      </div>

      <div v-show="activeTab === 'initiator'" class="wf-start-panel__pane">
        <PanelSection :title="i18n.t('workflow.designer.panel.start.permissionTitle')" :info="i18n.t('workflow.designer.panel.start.permissionInfo')">
          <OrgTriLine
            :model-value="config.start_permission ?? {}"
            :disabled="readOnly"
            :template-id="config.target_template_id"
            @update:model-value="onStartPermissionChange"
          />
          <!-- 帮助语：四种来源取并集的整体口径 + 主表字段的
               运行期判定口径，放在正文末尾（不是标题旁 ⓘ 气泡）。 -->
          <p class="wf-start-panel__hint">{{ i18n.t('workflow.designer.panel.start.permissionHelp') }}</p>
        </PanelSection>
      </div>

      <div v-show="activeTab === 'formAndHint'" class="wf-start-panel__pane">
        <PanelSection :title="i18n.t('workflow.designer.panel.section.fieldPermission')">
          <FieldPermissionSummary :model-value="config.field_permissions" :disabled="readOnly" @update:model-value="onFieldPermissionsChange" />
        </PanelSection>

        <!-- 无路可走时的提示：选填，发布期不拦。不填时由填报层落系统默认提示，这里用灰字把默认
             文案告诉设计者，免得以为「没填＝提交人什么都看不到」。 -->
        <PanelSection :title="i18n.t('workflow.designer.panel.section.noRouteHint')">
          <NInput
            class="wf-start-panel__textarea"
            type="textarea"
            :autosize="{ minRows: 3 }"
            size="small"
            :value="config.no_route_hint"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.panel.noRouteHintPlaceholder')"
            @update:value="onNoRouteHintInput"
          />
          <p v-if="!config.no_route_hint" class="wf-start-panel__hint">{{ i18n.t('workflow.designer.panel.noRouteDefaultHint') }}</p>
        </PanelSection>

        <!-- 通知：固定放在本分区最后一张卡。 -->
        <PanelSection :title="i18n.t('workflow.designer.panel.section.notify')">
          <NotifyCard :model-value="config.notify" :switches="notifySwitches" :read-only="readOnly" @update:model-value="onNotifyChange" />
        </PanelSection>
      </div>
    </PanelTabs>
  </div>
</template>

<style scoped>
.wf-start-panel {
  display: flex;
  flex-direction: column;
}
.wf-start-panel__pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wf-start-panel__template-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-start-panel__template-box {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-start-panel__template-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.wf-start-panel__badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(var(--warning-fill-color, 255 244 230));
  color: rgb(var(--warning-color, 217 141 0));
  font-size: 11px;
  white-space: nowrap;
}
.wf-start-panel__info {
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 12px;
  cursor: help;
}
.wf-start-panel__template-actions { flex: 0 0 auto; }
.wf-start-panel__textarea { width: 100%; }
.wf-start-panel__hint {
  margin: 4px 0 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
/* 「不满足条件时的提示」为空时的警示小字：与 CcPanel.vue 的 .wf-cc-panel__hint--warn 同用
   --warning-color token，不新写死色值。 */
.wf-start-panel__hint--warn { color: rgb(var(--warning-color, 240 160 32)); }
/* 卡片内「子字段」标签（如「发起条件」卡里「不满足时的提示」这个次级输入的说明文字），比分区
   标题更轻一档，走既有次要文字色 token（同 OrgTriLine.vue .wf-org-tri-line__label-tag 惯例）。 */
.wf-start-panel__field-label {
  display: block;
  margin: 0;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  line-height: 1.5;
}
</style>
