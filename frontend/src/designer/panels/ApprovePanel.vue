<script lang="ts">
/**
 * panels/ApprovePanel.vue —— 审批节点（N3）属性面板。
 *
 * 本文件拆两个 <script> 块：这一段是普通（非 setup）脚本，只导出**纯函数**（办理方式百分比的
 * 「万分比 ⇄ 1~100 整数」互转），与下方 <script setup> 负责的"把数据画出来、接宿主取字段目录"
 * 解耦——这是这段逻辑能在 happy-dom 环境下被单测直接覆盖的唯一方式（同 designer/canvas/
 * CanvasRulers.vue 头注释的既定手法：NaiveUI 的 NSelect 下拉在 happy-dom 里不会真的弹出/可点选，
 * 唯有把"值怎么编码/解码"这件事抽成纯函数才能测——组件层面的挂载测试只覆盖"选项/标签渲染对不
 * 对"，不覆盖"点了下拉第几项"）。Vue SFC 允许 <script> 与 <script setup> 共存，前者的具名导出
 * 会随编译后的组件模块一并导出，测试文件可以 `import { ... } from './ApprovePanel.vue'` 直接拿到。
 *
 * 『回退时清空』用共享取数件 ./shared/templateFieldCatalog.ts 的 useTemplateFieldCatalog 与
 * ./shared/handleSections.ts 里的 clearFieldsToKeys/keysToClearFields/buildWithdrawClearFieldOptions，
 * 与 HandlePanel.vue『E2 回退时清空的字段』同一套实现（含"目录里已不存在的字段保留占位"），
 * 相关单测在 handleSections.test.ts。
 *
 * bpToPercent/percentToBp 与 HandlePanel.vue/handleSections.ts 里同名函数逻辑一致，两处各自
 * 维护一份：重复这几行胜过再开一个共享文件（见 handleSections.ts 头注释同一说明）。
 */

/** 『D 办理方式』百分比换算：ApproveConfig.complete_mode.percentage_bp 是万分比（10000=100%），
 *  NInputNumber 只认 1~100 的整数百分比——未配置时按"百分比默认 100%"展示 100，边界钳到
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
</script>

<script setup lang="ts">
/**
 * 由 shell/PropsPanel.vue 按节点类型注册表（designer/nodes/approve/index.ts 的 panel 字段）分发，
 * 恰好选中一个 kind==='approve' 的节点时渲染，接收 `node`/`readOnly` 两个 prop。
 *
 * 面板按分区（tab）组织，节点名称由头部 PanelHeader 就地改名。三个分区固定：基本（basic：
 * 审批人来源、再缩小范围、步骤摘要）/ 审批规则（approveRule：办理方式、审批按钮、结果与理由、
 * 回退时清空、自动办理条件）/ 表单与提示（formAndHint：字段权限、无路可走时的提示、通知）——
 * 分区文案键见 PanelTabs.vue 头注释。
 *
 * 通知开关是节点级的：formAndHint 分区末尾的『通知』卡（shared/NotifyCard.vue），审批节点只认
 * on_assigned（有新待办时通知审批人）、on_returned（被退回到这一步时通知审批人）两个开关键——
 * 与办理节点同一套语义，文案按"审批人"改写。
 *
 * 『与上步处理人的关系』是独立过滤器而不是人员来源：basic 分区在『从哪里选人』卡之后、『步骤
 * 摘要』卡之前放『再缩小范围』卡（shared/RelationFilterCard.vue，与 HandlePanel.vue 同一套接线），
 * 写回 config.relation_filters。
 *
 * 目标表单 id 的取法同 HandlePanel.vue：经 usePanelHost() 拿文档状态与 changeTick，驱动
 * mainTemplateIdOf 重新求值（WorkflowDocumentState 内部变更不天然驱动 Vue 响应式）。
 *
 * 全部控件使用 NaiveUI 组件，不用原生 HTML 控件。naive-ui
 * 经 vite.config.ts 的 external 配置在生产构建里映射到宿主注入的 window.naive 全局（同
 * kimpo-action-designer/kimpo-records-view 两个插件的既定用法：直接 `import { NSelect } from
 * 'naive-ui'`，构建时被 rollup 改写为对 window.naive 的属性访问，不需要在源码里手写
 * `(window as any).naive`），vitest 环境下 naive-ui 是真实安装的 devDependency，两侧都不需要
 * 额外的模块别名/stub。
 */
import { computed, ref, watch } from 'vue';
import { NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect } from 'naive-ui';
import type { ApprovalButton, ApproveConfig, V4ExpressionDocumentEnvelope, WorkflowNode } from '../../model';
import { mainTemplateIdOf } from '../expression/v4Scope';
import V4ExpressionField from '../expression/V4ExpressionField.vue';
import AssigneeSourceList from './shared/AssigneeSourceList.vue';
import FieldPermissionSummary from './shared/FieldPermissionSummary.vue';
import MainFieldSelect from './shared/MainFieldSelect.vue';
import NotifyCard, { type NotifyCardSwitch } from './shared/NotifyCard.vue';
import RelationFilterCard from './shared/RelationFilterCard.vue';
import PanelHeader from './PanelHeader.vue';
import PanelSection from './PanelSection.vue';
import PanelTabs, { type PanelTabItem } from './PanelTabs.vue';
import { usePanelHost } from './usePanelHost';
import ApprovalButtonList from './shared/ApprovalButtonList.vue';
import { useTemplateFieldCatalog } from './shared/templateFieldCatalog';
import { listEndNodeOptions } from './shared/approvalButtons';
import { buildWithdrawClearFieldOptions, clearFieldsToKeys, keysToClearFields } from './shared/handleSections';
// bpToPercent/percentToBp 来自本文件上方的普通 <script> 块——同一份编译后的模块作用域，不需要
// （也不能）从自身再 import 一遍，见本文件头注释与 designer/canvas/CanvasRulers.vue 的既定手法。

const props = defineProps<{
  node: WorkflowNode;
  readOnly?: boolean;
}>();

// inject host/i18n/state + 订阅 changeTick 统一由 usePanelHost() 提供（见其头注释）。本文件不直接
// 调用 host 的任何方法，取字段目录收口在 useTemplateFieldCatalog，由其自行 inject 宿主。
const { i18n, state, changeTick } = usePanelHost();

/** 节点 config 理论上不该缺席（addNode 恒用 createDefaultConfig 兜底），这里只是给类型系统一个
 *  兜底占位，不代表业务上"缺配置"是合法态（同 HandlePanel.vue EMPTY_HANDLE_CONFIG 既定手法）。 */
const EMPTY_APPROVE_CONFIG: ApproveConfig = {
  approvers: [],
  complete_mode: { kind: 'any' },
  field_permissions: [],
  buttons: [],
  clear_on_withdraw: [],
  no_route_hint: ''
};

const templateId = computed(() => {
  void changeTick.value;
  return mainTemplateIdOf(state.value?.doc);
});

// 「不通过并结束流程」按钮的「结束到」候选 = 当前流程全部结束节点。随 changeTick 重算，
// 画布上新增/删除/改名结束节点、改结束标识后下拉即时跟着变（changeTick 由 usePanelHost 订阅文档
// 变更驱动，同上方 templateId 的既定手法）。
const endNodeOptions = computed(() => {
  void changeTick.value;
  return listEndNodeOptions(state.value?.doc.nodes, i18n);
});

const config = computed<ApproveConfig>(() => (props.node.config as ApproveConfig | undefined) ?? EMPTY_APPROVE_CONFIG);

function patchConfig(patch: Partial<ApproveConfig>): void {
  if (props.readOnly) return;
  state.value?.updateNodeConfig(props.node.id, patch as Record<string, unknown>);
}

// ── 分区（tab） ─────────────────────────────────────────────────────────────────────────
// 三个分区固定 key（与 PanelTabs.vue 约定的文案键一致，见文件头注释）；
// 切换到另一个审批节点时重置回「基本」，不残留上一个节点停留的分区（同 PanelHeader.vue
// 「选中项从一个节点切到另一个节点时不能让上一个节点的编辑态残留」同一理由）。
const activeTab = ref('basic');
watch(
  () => props.node.id,
  () => {
    activeTab.value = 'basic';
  }
);
const tabs = computed<PanelTabItem[]>(() => [
  { key: 'basic', label: i18n.t('workflow.designer.panel.tabs.basic') },
  { key: 'approveRule', label: i18n.t('workflow.designer.panel.tabs.approveRule') },
  { key: 'formAndHint', label: i18n.t('workflow.designer.panel.tabs.formAndHint') }
]);

// ── 审批人来源（同『A』） ───────────────────────────────────────────────────────────────
function onApproversUpdate(sources: ApproveConfig['approvers']): void {
  patchConfig({ approvers: sources });
}

// ── 再缩小范围：与上步处理人的关系（过滤器而不是来源，同 HandlePanel.vue 同名函数接线） ───────
function onRelationFiltersUpdate(value: ApproveConfig['relation_filters']): void {
  patchConfig({ relation_filters: value });
}

// ── 办理方式（同『D』，审批节点叫法"或签 / 会签 / 按比例"。all 档语义
// 等同按比例 100%，落库形状恒为 { kind: 'all' }，不带 percentage_bp，与 percentage 档分开单独写
// 一支，同 HandlePanel.vue 同名函数既定处理） ───────────────────────────────────────────────
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

// ── 审批按钮（面板内就地编辑，即改即存，反悔靠画布撤销）。增删改排渲染全部收在
// shared/ApprovalButtonList.vue，本文件只透传 config.buttons 与写回。
function onButtonsUpdate(buttons: ApprovalButton[]): void {
  patchConfig({ buttons });
}

// ── 结果绑定字段 / 理由绑定字段（本表主表文本字段） ────────────────────────────────────
function onResultFieldChange(value: string | undefined): void {
  patchConfig({ result_field_id: value });
}
function onReasonFieldChange(value: string | undefined): void {
  patchConfig({ reason_field_id: value });
}

// ── 回退时清空（同『E2』，主表 + 明细表全字段目录，NaiveUI NSelect multiple）：走共享取数件
// useTemplateFieldCatalog + handleSections.ts 纯函数，与 HandlePanel.vue 同一套实现（见本文件
// 头注释）。 ───────────────────────────────────────────────────────────────────────────
const {
  catalog: clearFieldCatalog,
  loading: clearFieldLoading,
  failed: clearFieldLoadFailed
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

// ── 无路可走时的提示 ────────────────────────────────────────────────────────────────────
function onNoRouteHintInput(value: string): void {
  patchConfig({ no_route_hint: value });
}

// ── 自动办理条件（同『F』） ─────────────────────────────────────────────────────────────
function onAutoCompleteChange(value?: V4ExpressionDocumentEnvelope): void {
  patchConfig({ auto_complete_condition: value });
}

// ── 步骤摘要（同『H』） ─────────────────────────────────────────────────────────────────
function onSummaryUpdate(value?: V4ExpressionDocumentEnvelope): void {
  patchConfig({ summary_expr: value });
}

// ── 字段权限（『B3 只看型』）：审批节点不改单据内容，对话框只出 跟随
// 表单/只读/隐藏 三档（readonlyOnly=true），确定后经 update:model-value 写回 field_permissions。
function onFieldPermissionsChange(value: ApproveConfig['field_permissions']): void {
  patchConfig({ field_permissions: value });
}

// ── 通知：审批节点只认『有新待办时通知审批人 / 被退回到这一步
// 时通知审批人』两个开关键。 ────────────────────────────────────────────────────────────────
const notifySwitches = computed<NotifyCardSwitch[]>(() => [
  { key: 'on_assigned', label: i18n.t('workflow.designer.panel.approve.notifyOnAssigned') },
  { key: 'on_returned', label: i18n.t('workflow.designer.panel.approve.notifyOnReturned') }
]);
function onNotifyChange(value: ApproveConfig['notify']): void {
  patchConfig({ notify: value });
}
</script>

<template>
  <div class="ap">
    <PanelHeader :node="node" :read-only="readOnly" />

    <PanelTabs :tabs="tabs" :active="activeTab" :read-only="readOnly" @update:active="activeTab = $event">
      <!-- 分区『基本』：审批人来源、再缩小范围、步骤摘要 -->
      <div v-show="activeTab === 'basic'" class="ap__tab-pane" data-testid="approve-tab-basic">
        <PanelSection
          :title="i18n.t('workflow.designer.panel.approve.approversTitle')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <AssigneeSourceList
            :model-value="config.approvers ?? []"
            :read-only="readOnly"
            :template-id="templateId"
            @update:model-value="onApproversUpdate"
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

      <!-- 分区『审批规则』：办理方式、审批按钮、结果与理由、回退时清空、自动办理条件 -->
      <div v-show="activeTab === 'approveRule'" class="ap__tab-pane" data-testid="approve-tab-approveRule">
        <PanelSection :title="i18n.t('workflow.designer.panel.approve.completeModeTitle')">
          <!-- 🔴 class="ap__radio" 必须保留：e2e/helpers/panels.ts setApproveCompleteModePercentage
               用 `.ap__radio input[type="radio"]` 定位；分段按钮 NRadioButton 的根节点仍渲染真实
               <input type="radio">，class 原样透传，选择器不受影响。 -->
          <NRadioGroup class="ap__mode-group" :value="config.complete_mode?.kind ?? 'any'" size="small" :disabled="readOnly" @update:value="onCompleteModeKindChange">
            <NRadioButton value="any" class="ap__radio" data-testid="approve-complete-mode-any">{{ i18n.t('workflow.designer.panel.approve.completeModeAny') }}</NRadioButton>
            <!-- 第三档「会签」固定排在「或签」与「按比例」之间。 -->
            <NRadioButton value="all" class="ap__radio" data-testid="approve-complete-mode-all">{{ i18n.t('workflow.designer.panel.approve.completeModeAll') }}</NRadioButton>
            <NRadioButton value="percentage" class="ap__radio" data-testid="approve-complete-mode-percentage">{{ i18n.t('workflow.designer.panel.approve.completeModePercentage') }}</NRadioButton>
          </NRadioGroup>
          <div v-if="config.complete_mode?.kind === 'percentage'" class="ap__percentage-row">
            <NInputNumber
              :value="percentValue"
              :min="1"
              :max="100"
              size="small"
              :disabled="readOnly"
              :show-button="false"
              data-testid="approve-complete-percentage"
              @update:value="onPercentageChange"
            />
            <span class="ap__percentage-suffix">%</span>
          </div>
          <!-- 当前选中这一档的白话解释（蓝底说明块），三态嵌套三元表达式。 -->
          <p class="ap__mode-note">{{ i18n.t(config.complete_mode?.kind === 'percentage' ? 'workflow.designer.panel.approve.completeModePercentageNote' : config.complete_mode?.kind === 'all' ? 'workflow.designer.panel.approve.completeModeAllNote' : 'workflow.designer.panel.approve.completeModeAnyNote') }}</p>
        </PanelSection>

        <!-- 审批按钮：approve.go Validate 里 len(cfg.Buttons) == 0 即 N3_BUTTON_REQUIRED 拒绝
             发布，故标必填。面板内就地编辑（每按钮一行可展开卡片），渲染/交互全部在
             shared/ApprovalButtonList.vue，见该文件头注释。 -->
        <PanelSection
          :title="i18n.t('workflow.designer.panel.approve.buttonsTitle')"
          :info="i18n.t('workflow.designer.panel.approve.buttonsInfo')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <ApprovalButtonList
            :model-value="config.buttons ?? []"
            :read-only="readOnly"
            :node-id="node.id"
            :end-node-options="endNodeOptions"
            @update:model-value="onButtonsUpdate"
          />
        </PanelSection>

        <PanelSection :title="i18n.t('workflow.designer.panel.approve.resultReasonTitle')">
          <div class="ap__field-row">
            <span class="ap__field-row-label">{{ i18n.t('workflow.designer.panel.approve.resultFieldLabel') }}</span>
            <MainFieldSelect
              data-testid="approve-result-field"
              :template-id="templateId"
              :model-value="config.result_field_id"
              data-type="text"
              :disabled="readOnly"
              @update:model-value="onResultFieldChange"
            />
          </div>
          <p class="ap__hint">{{ i18n.t('workflow.designer.panel.approve.resultFieldInfo') }}</p>
          <div class="ap__field-row">
            <span class="ap__field-row-label">{{ i18n.t('workflow.designer.panel.approve.reasonFieldLabel') }}</span>
            <MainFieldSelect
              data-testid="approve-reason-field"
              :template-id="templateId"
              :model-value="config.reason_field_id"
              data-type="text"
              :disabled="readOnly"
              @update:model-value="onReasonFieldChange"
            />
          </div>
          <p class="ap__hint">{{ i18n.t('workflow.designer.panel.approve.reasonFieldInfo') }}</p>
        </PanelSection>

        <PanelSection
          :title="i18n.t('workflow.designer.panel.approve.clearOnWithdrawTitle')"
          :info="i18n.t('workflow.designer.panel.approve.clearOnWithdrawInfo')"
        >
          <NSelect
            multiple
            filterable
            size="small"
            :value="clearFieldSelectValue"
            :options="clearFieldSelectOptions"
            :disabled="readOnly || !templateId"
            :loading="clearFieldLoading"
            :placeholder="i18n.t('workflow.designer.panel.approve.clearOnWithdrawPlaceholder')"
            data-testid="approve-clear-on-withdraw"
            @update:value="onClearFieldsChange"
          />
          <p v-if="!templateId" class="ap__hint">{{ i18n.t('workflow.designer.panel.field.noTemplate') }}</p>
          <p v-else-if="clearFieldLoading" class="ap__hint">{{ i18n.t('workflow.designer.panel.field.loading') }}</p>
          <p v-else-if="clearFieldLoadFailed || clearFieldSelectOptions.length === 0" class="ap__hint">{{ i18n.t('workflow.designer.panel.field.empty') }}</p>
        </PanelSection>

        <PanelSection :title="i18n.t('workflow.designer.panel.section.autoComplete')">
          <V4ExpressionField
            :model-value="config.auto_complete_condition"
            mode="condition"
            :expression-id="`${node.id}:auto`"
            :template-id="templateId"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.panel.autoCompletePlaceholder')"
            @update:model-value="onAutoCompleteChange"
          />
        </PanelSection>
      </div>

      <!-- 分区『表单与提示』：字段权限、无路可走时的提示、通知 -->
      <div v-show="activeTab === 'formAndHint'" class="ap__tab-pane" data-testid="approve-tab-formAndHint">
        <PanelSection :title="i18n.t('workflow.designer.panel.section.fieldPermission')">
          <FieldPermissionSummary
            :model-value="config.field_permissions"
            :readonly-only="true"
            :disabled="readOnly"
            @update:model-value="onFieldPermissionsChange"
          />
        </PanelSection>

        <!-- 无路可走时的提示：选填——approve.go Validate 不产 NO_ROUTE_HINT_REQUIRED，发布期不拦；
             不填时由填报层落系统默认提示。 -->
        <PanelSection :title="i18n.t('workflow.designer.panel.section.noRouteHint')">
          <NInput
            type="textarea"
            :autosize="{ minRows: 3 }"
            size="small"
            class="ap__textarea"
            :value="config.no_route_hint"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.panel.noRouteHintPlaceholder')"
            @update:value="onNoRouteHintInput"
          />
          <p v-if="!config.no_route_hint" class="ap__hint">{{ i18n.t('workflow.designer.panel.noRouteDefaultHint') }}</p>
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
/* 根容器不留 gap：身份头与分区标签条要连成一块白底，六个面板保持一致。 */
.ap { display: flex; flex-direction: column; }
.ap__mode-group { display: flex; width: 100%; }
.ap__mode-group :deep(.n-radio-button) { flex: 1 1 0; min-width: 0; padding: 0 4px; text-align: center; white-space: nowrap; }
/* 选中档实心主色底 + 白字，NRadioButton 默认只是描边高亮。白字写死是因为它压在主色
   底上，不随明暗主题变（同本目录"只做明亮模式"的既定口径）。 */
.ap__mode-group :deep(.n-radio-button--checked) { background: rgb(var(--primary-color, 10 106 214)); color: #fff; }
.ap__mode-note {
  margin: 0;
  padding: 7px 9px;
  border-radius: 4px;
  background: rgb(var(--primary-color, 10 106 214) / 8%);
  color: rgb(var(--primary-color, 10 106 214));
  font-size: 11px;
  line-height: 1.6;
}
.ap__tab-pane { display: flex; flex-direction: column; gap: 10px; }
.ap__textarea { width: 100%; }
.ap__percentage-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.ap__percentage-suffix { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.ap__hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
/* 审批按钮卡内容的样式在 shared/ApprovalButtonList.vue 自己的 scoped style 里。 */
/* 结果/理由绑定字段：标签在上、下拉通栏，避免下拉被标签挤窄。 */
.ap__field-row { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
.ap__field-row-label { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
</style>
