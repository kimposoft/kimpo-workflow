<script setup lang="ts">
/**
 * panels/HandlePanel.vue —— 办理节点（N2）属性面板。
 *
 * D/E 两段的百分比换算、回退方式勾选、回退清空字段的复合键编解码与按表分组选项构造，均是纯函数，
 * 抽在 ./shared/handleSections.ts（同 ApprovePanel.vue 顶部 <script> 块的既定手法：能在不挂载组件
 * 的前提下覆盖的逻辑单独抽出，供单测直接覆盖）。E2「回退时清空的字段」的目标字段目录经共享取数件
 * ./shared/templateFieldCatalog.ts 的 useTemplateFieldCatalog 取（主表 + 全部扩展表，已排除退役
 * 字段类型），本文件不自行调用宿主取表 / 取字段方法（见其文件头注释）。
 *
 * 字段权限用 panels/shared/FieldPermissionSummary.vue 渲染只读摘要 + 编辑入口。
 *
 * 分区卡片统一走 PanelSection（唯一权威组件，见其头注释），本文件不各自起 div。
 *
 * 面板按分区（tab）组织，节点名称由公共头部 PanelHeader.vue 就地改名。三个分区固定顺序
 * basic → handleRule → formAndHint：
 *   - basic：办理人来源 / 再缩小范围 / 步骤摘要；
 *   - handleRule：办理方式（D，含按比例数值框）/ 回退（E）/ 自动办理条件（F）；
 *   - formAndHint：字段权限 / 无路可走时的提示 / 通知。
 * host/i18n/state/changeTick 走 usePanelHost.ts。
 *
 * 通知开关是节点级的：formAndHint 分区末尾的『通知』卡（shared/NotifyCard.vue），办理节点认两个
 * 开关键：on_assigned（有新待办时通知处理人）、on_returned（被退回到这一步时通知处理人）。
 *
 * 『与上步处理人的关系』是独立过滤器而不是人员来源：basic 分区在『从哪里选人』卡之后、『步骤
 * 摘要』卡之前放『再缩小范围』卡（shared/RelationFilterCard.vue），写回 config.relation_filters，
 * 见其头注释与 model/document.ts HandleConfig.relation_filters 注释。
 */
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect } from 'naive-ui';
import type { HandleConfig, V4ExpressionDocumentEnvelope, WithdrawMethod, WorkflowNode } from '../../model';
import { mainTemplateIdOf } from '../expression/v4Scope';
import V4ExpressionField from '../expression/V4ExpressionField.vue';
import AssigneeSourceList from './shared/AssigneeSourceList.vue';
import FieldPermissionSummary from './shared/FieldPermissionSummary.vue';
import NotifyCard, { type NotifyCardSwitch } from './shared/NotifyCard.vue';
import RelationFilterCard from './shared/RelationFilterCard.vue';
import PanelHeader from './PanelHeader.vue';
import PanelTabs, { type PanelTabItem } from './PanelTabs.vue';
import { usePanelHost } from './usePanelHost';
import PanelSection from './PanelSection.vue';
import { useTemplateFieldCatalog } from './shared/templateFieldCatalog';
import {
  bpToPercent,
  buildWithdrawClearFieldOptions,
  clearFieldsToKeys,
  hasAnyWithdrawMethod,
  isWithdrawMethodChecked,
  keysToClearFields,
  percentToBp,
  toggleWithdrawMethod
} from './shared/handleSections';

const props = defineProps<{
  node: WorkflowNode;
  readOnly?: boolean;
}>();

// host 由子组件（AssigneeSourceList/V4ExpressionField）各自 inject，本文件不需要，usePanelHost
// 仍会一并注入（三者缺一即 throw），这里只解构用得上的三个。
const { i18n, state, changeTick } = usePanelHost();

/** 节点 config 理论上不该缺席（addNode 恒用 createDefaultConfig 兜底），这里只是给类型系统一个
 *  兜底占位，不代表业务上"缺配置"是合法态。 */
const EMPTY_HANDLE_CONFIG: HandleConfig = { assignees: [], complete_mode: { kind: 'any' }, no_route_hint: '' };

const templateId = computed(() => {
  void changeTick.value;
  return mainTemplateIdOf(state.value?.doc);
});

const config = computed<HandleConfig>(() => (props.node.config as HandleConfig | undefined) ?? EMPTY_HANDLE_CONFIG);

function patchConfig(patch: Partial<HandleConfig>): void {
  if (props.readOnly) return;
  state.value?.updateNodeConfig(props.node.id, patch as Record<string, unknown>);
}

// ── 办理人来源（同『A』） ───────────────────────────────────────────────────────────────
function onAssigneesUpdate(sources: HandleConfig['assignees']): void {
  patchConfig({ assignees: sources });
}

// ── 再缩小范围：与上步处理人的关系（过滤器而不是来源，见 shared/RelationFilterCard.vue 头注释） ──
function onRelationFiltersUpdate(value: HandleConfig['relation_filters']): void {
  patchConfig({ relation_filters: value });
}

// ── D 办理方式：任一人办理即可 / 全部完成 / 按比例（万分比 ⇄ 百分比换算见 ./shared/handleSections.ts。
// all 档语义等同按比例 100%，但落库形状恒为 { kind: 'all' }，不带
// percentage_bp，故与 percentage 档分开单独写一支，不能借用按比例那支再塞个 100） ────────────────
const percentValue = computed(() => bpToPercent(config.value.complete_mode?.percentage_bp));
function onCompleteModeKindChange(kind: string | number): void {
  if (props.readOnly) return;
  if (kind === 'percentage') {
    patchConfig({ complete_mode: { kind: 'percentage', percentage_bp: config.value.complete_mode?.percentage_bp ?? 10000 } });
  } else if (kind === 'all') {
    patchConfig({ complete_mode: { kind: 'all' } });
  } else {
    patchConfig({ complete_mode: { kind: 'any' } });
  }
}
function onPercentageChange(value: number | null): void {
  if (props.readOnly || value === null) return;
  patchConfig({ complete_mode: { kind: 'percentage', percentage_bp: percentToBp(value) } });
}

// ── E1 回退：三档固定顺序勾选 ────────────────────────────────────────────────────────────
function onToggleWithdrawMethod(method: WithdrawMethod): void {
  if (props.readOnly) return;
  patchConfig({ allowed_withdraw_methods: toggleWithdrawMethod(config.value.allowed_withdraw_methods, method) });
}
const hasAnyWithdraw = computed(() => hasAnyWithdrawMethod(config.value.allowed_withdraw_methods));

// ── E2 回退时清空的字段：目录经共享取数件 useTemplateFieldCatalog 取（不自行调 host.listTemplate*，
// 见文件头注释） ───────────────────────────────────────────────────────────────────────────
const {
  catalog: clearFieldCatalog,
  loading: clearFieldCatalogLoading,
  failed: clearFieldCatalogFailed,
  reload: reloadClearFieldCatalog
} = useTemplateFieldCatalog(() => templateId.value);

const clearFieldSelectValue = computed(() => clearFieldsToKeys(config.value.clear_on_withdraw));
const clearFieldSelectOptions = computed(() =>
  buildWithdrawClearFieldOptions(clearFieldCatalog.value, clearFieldSelectValue.value, i18n.t('workflow.designer.panel.handle.clearFieldMissingLabel'))
);
function onClearFieldsChange(value: (string | number)[] | null): void {
  if (props.readOnly) return;
  const keys = (value ?? []).map((v) => String(v));
  patchConfig({ clear_on_withdraw: keysToClearFields(keys) });
}

// ── F 自动办理条件（同『F』，V4 判断表达式，同引导线条件 EdgePanel.vue mode='condition'
// 的传法） ──────────────────────────────────────────────────────────────────────────────
function onAutoCompleteChange(value?: V4ExpressionDocumentEnvelope): void {
  patchConfig({ auto_complete_condition: value });
}

// ── 无路可走时的提示 ────────────────────────────────────────────────────────────────────
const hintDraft = ref(config.value.no_route_hint ?? '');
watch(
  () => config.value.no_route_hint,
  (next) => {
    hintDraft.value = next ?? '';
  }
);
function onHintInput(value: string): void {
  hintDraft.value = value;
  patchConfig({ no_route_hint: hintDraft.value });
}

// ── 步骤摘要（同『H』） ─────────────────────────────────────────────────────────────────
function onSummaryUpdate(doc: HandleConfig['summary_expr']): void {
  patchConfig({ summary_expr: doc });
}

// ── 通知：办理节点只认『有新待办时通知处理人 / 被退回到这一步
// 时通知处理人』两个开关键。 ────────────────────────────────────────────────────────────────
const notifySwitches = computed<NotifyCardSwitch[]>(() => [
  { key: 'on_assigned', label: i18n.t('workflow.designer.panel.handle.notifyOnAssigned') },
  { key: 'on_returned', label: i18n.t('workflow.designer.panel.handle.notifyOnReturned') }
]);
function onNotifyChange(value: HandleConfig['notify']): void {
  patchConfig({ notify: value });
}

// ── 分区：固定顺序 basic → handleRule → formAndHint；内容显隐用同一份常驻 DOM 树的 v-show
// （不是 v-if），切分区不重新挂载/丢内部状态
// （E2 字段目录的加载态、V4ExpressionField 内部草稿等不会因切 tab 而丢失）。
const activeTab = ref<'basic' | 'handleRule' | 'formAndHint'>('basic');
const tabs = computed<PanelTabItem[]>(() => [
  { key: 'basic', label: i18n.t('workflow.designer.panel.tabs.basic') },
  { key: 'handleRule', label: i18n.t('workflow.designer.panel.tabs.handleRule') },
  { key: 'formAndHint', label: i18n.t('workflow.designer.panel.tabs.formAndHint') }
]);
function onTabChange(key: string): void {
  activeTab.value = key as typeof activeTab.value;
}
</script>

<template>
  <div class="hp">
    <PanelHeader :node="node" :read-only="readOnly" />
    <PanelTabs :tabs="tabs" :active="activeTab" :read-only="readOnly" @update:active="onTabChange">
      <div v-show="activeTab === 'basic'" class="hp__pane">
        <PanelSection
          :title="i18n.t('workflow.designer.panel.section.assignees')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <AssigneeSourceList
            :model-value="config.assignees ?? []"
            :read-only="readOnly"
            :template-id="templateId"
            @update:model-value="onAssigneesUpdate"
          />
        </PanelSection>

        <RelationFilterCard :model-value="config.relation_filters" :read-only="readOnly" @update:model-value="onRelationFiltersUpdate" />

        <PanelSection :title="i18n.t('workflow.designer.panel.section.summary')">
          <V4ExpressionField
            :model-value="config.summary_expr"
            mode="value"
            :expression-id="`${node.id}:summary`"
            :template-id="templateId"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.panel.summaryPlaceholder')"
            @update:model-value="onSummaryUpdate"
          />
        </PanelSection>
      </div>

      <div v-show="activeTab === 'handleRule'" class="hp__pane">
        <PanelSection :title="i18n.t('workflow.designer.panel.handle.completeModeTitle')">
          <!-- 分段按钮，各档等宽撑满一行。 -->
          <NRadioGroup class="hp__mode-group" :value="config.complete_mode?.kind ?? 'any'" size="small" :disabled="readOnly" @update:value="onCompleteModeKindChange">
            <NRadioButton value="any" data-testid="handle-complete-mode-any">{{ i18n.t('workflow.designer.panel.handle.completeModeAny') }}</NRadioButton>
            <!-- 第三档「全部完成」固定排在「任意一人」与「按比例」之间。 -->
            <NRadioButton value="all" data-testid="handle-complete-mode-all">{{ i18n.t('workflow.designer.panel.handle.completeModeAll') }}</NRadioButton>
            <NRadioButton value="percentage" data-testid="handle-complete-mode-percentage">{{ i18n.t('workflow.designer.panel.handle.completeModePercentage') }}</NRadioButton>
          </NRadioGroup>
          <div v-if="config.complete_mode?.kind === 'percentage'" class="hp__percentage-row">
            <NInputNumber
              :value="percentValue"
              :min="1"
              :max="100"
              size="small"
              :show-button="false"
              :disabled="readOnly"
              data-testid="handle-complete-percentage"
              @update:value="onPercentageChange"
            />
            <span class="hp__percentage-suffix">%</span>
          </div>
          <!-- 当前选中这一档的白话解释（蓝底说明块），三态嵌套三元表达式。 -->
          <p class="hp__mode-note">{{ i18n.t(config.complete_mode?.kind === 'percentage' ? 'workflow.designer.panel.handle.completeModePercentageNote' : config.complete_mode?.kind === 'all' ? 'workflow.designer.panel.handle.completeModeAllNote' : 'workflow.designer.panel.handle.completeModeAnyNote') }}</p>
        </PanelSection>

        <PanelSection :title="i18n.t('workflow.designer.panel.section.withdraw')">
          <div class="hp__withdraw-checks">
            <NCheckbox
              :checked="isWithdrawMethodChecked(config.allowed_withdraw_methods, 'previous_step')"
              size="small"
              :disabled="readOnly"
              data-testid="handle-withdraw-previous_step"
              @update:checked="() => onToggleWithdrawMethod('previous_step')"
            >{{ i18n.t('workflow.designer.dialog.buttonSettings.action.withdrawPreviousStep') }}</NCheckbox>
            <NCheckbox
              :checked="isWithdrawMethodChecked(config.allowed_withdraw_methods, 'initiator')"
              size="small"
              :disabled="readOnly"
              data-testid="handle-withdraw-initiator"
              @update:checked="() => onToggleWithdrawMethod('initiator')"
            >{{ i18n.t('workflow.designer.dialog.buttonSettings.action.withdrawInitiator') }}</NCheckbox>
            <NCheckbox
              :checked="isWithdrawMethodChecked(config.allowed_withdraw_methods, 'specified_step')"
              size="small"
              :disabled="readOnly"
              data-testid="handle-withdraw-specified_step"
              @update:checked="() => onToggleWithdrawMethod('specified_step')"
            >{{ i18n.t('workflow.designer.dialog.buttonSettings.action.withdrawSpecifiedStep') }}</NCheckbox>
          </div>

          <div class="hp__clear-fields">
            <span class="hp__clear-fields-label">{{ i18n.t('workflow.designer.panel.approve.clearOnWithdrawTitle') }}</span>
            <NSelect
              multiple
              filterable
              size="small"
              :value="clearFieldSelectValue"
              :options="clearFieldSelectOptions"
              :disabled="readOnly || !hasAnyWithdraw || !templateId"
              :loading="clearFieldCatalogLoading"
              :placeholder="i18n.t('workflow.designer.panel.approve.clearOnWithdrawPlaceholder')"
              data-testid="handle-clear-on-withdraw"
              @update:value="onClearFieldsChange"
            />
            <p v-if="!hasAnyWithdraw" class="hp__hint">{{ i18n.t('workflow.designer.panel.handle.withdrawNoMethodHint') }}</p>
            <p v-else-if="!templateId" class="hp__hint">{{ i18n.t('workflow.designer.panel.field.noTemplate') }}</p>
            <p v-else-if="clearFieldCatalogLoading" class="hp__hint">{{ i18n.t('workflow.designer.panel.field.loading') }}</p>
            <template v-else-if="clearFieldCatalogFailed">
              <p class="hp__hint">{{ i18n.t('workflow.designer.panel.handle.clearFieldsLoadFailed') }}</p>
              <NButton text size="small" data-testid="handle-clear-fields-retry" @click="reloadClearFieldCatalog">{{ i18n.t('workflow.designer.root.retry') }}</NButton>
            </template>
            <p v-else-if="clearFieldSelectOptions.length === 0" class="hp__hint">{{ i18n.t('workflow.designer.panel.field.empty') }}</p>
            <p class="hp__hint">{{ i18n.t('workflow.designer.panel.approve.clearOnWithdrawInfo') }}</p>
          </div>
        </PanelSection>

        <PanelSection :title="i18n.t('workflow.designer.panel.section.autoComplete')">
          <V4ExpressionField
            :model-value="config.auto_complete_condition"
            mode="condition"
            :expression-id="`${node.id}:auto`"
            :template-id="templateId"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.panel.autoCompletePlaceholder')"
            :purpose="i18n.t('workflow.designer.panel.section.autoComplete')"
            @update:model-value="onAutoCompleteChange"
          />
          <p class="hp__hint">{{ i18n.t('workflow.designer.panel.handle.autoCompleteInfo') }}</p>
        </PanelSection>
      </div>

      <div v-show="activeTab === 'formAndHint'" class="hp__pane">
        <PanelSection :title="i18n.t('workflow.designer.panel.section.fieldPermission')">
          <!-- 办理节点是可编辑型（四档）；对话框确定后的清单在这里回写。 -->
          <FieldPermissionSummary :model-value="config.field_permissions" :disabled="readOnly" @update:model-value="(v) => patchConfig({ field_permissions: v })" />
        </PanelSection>

        <!-- 无路可走时的提示：选填——handle.go Validate 不产 NO_ROUTE_HINT_REQUIRED，发布期不拦；
             不填时由填报层落系统默认提示。 -->
        <PanelSection :title="i18n.t('workflow.designer.panel.section.noRouteHint')">
          <NInput
            :value="hintDraft"
            type="textarea"
            :autosize="{ minRows: 3 }"
            size="small"
            class="hp__textarea"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.panel.noRouteHintPlaceholder')"
            @update:value="onHintInput"
          />
          <p v-if="!hintDraft" class="hp__hint">{{ i18n.t('workflow.designer.panel.noRouteDefaultHint') }}</p>
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
.hp { display: flex; flex-direction: column; }
.hp__pane { display: flex; flex-direction: column; gap: 10px; }
.hp__mode-group { display: flex; width: 100%; }
.hp__mode-group :deep(.n-radio-button) { flex: 1 1 0; min-width: 0; padding: 0 4px; text-align: center; white-space: nowrap; }
/* 选中档实心主色底 + 白字，NRadioButton 默认只是描边高亮。白字写死是因为它压在主色
   底上，不随明暗主题变（同本目录"只做明亮模式"的既定口径）。 */
.hp__mode-group :deep(.n-radio-button--checked) { background: rgb(var(--primary-color, 10 106 214)); color: #fff; }
.hp__mode-note {
  margin: 0;
  padding: 7px 9px;
  border-radius: 4px;
  background: rgb(var(--primary-color, 10 106 214) / 8%);
  color: rgb(var(--primary-color, 10 106 214));
  font-size: 11px;
  line-height: 1.6;
}
.hp__textarea { width: 100%; }
.hp__percentage-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.hp__percentage-suffix { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.hp__withdraw-checks { display: flex; flex-direction: column; gap: 6px; }
.hp__clear-fields { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.hp__clear-fields-label { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.hp__hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
</style>
