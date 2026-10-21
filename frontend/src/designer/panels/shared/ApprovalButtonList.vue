<script setup lang="ts">
/**
 * panels/shared/ApprovalButtonList.vue —— 审批节点『审批按钮』面板内就地编辑清单：即改即存，
 * 反悔靠画布撤销。
 *
 * 每个按钮一行可展开的卡片，收起态是摘要行（把手 + 色点 + 名称 + 动作·结果标识 + 需填理由标签 +
 * 展开箭头），点这一行（把手以外区域）切换展开，同一时刻至多展开一个；展开态就地出现编辑区。
 * 除两个文本框（名称/结果标识）走"草稿 + 失焦/回车提交"外，其余控件（动作下拉/需填
 * 理由开关/颜色/上移/下移/删除/新增）都是一次操作直接写回——本组件不持有"业务数据"，只把
 * update:modelValue 上抛给父层 ApprovePanel.vue 的 patchConfig({ buttons })，由文档 state 落库、
 * 进撤销栈——本组件不直接碰文档 state。
 *
 * 增删改排四类纯逻辑（新增默认值/上移下移/按下标移动/删除/最少一个）全部收在同目录
 * ./approvalButtons.ts（见其头注释），
 * 本文件只做"事件绑定 + 模板渲染 + 拖拽手势"，与 AssigneeSourceList.vue/assigneeSource.ts 的既定
 * 分工一致。
 *
 * 拖动排序实现方式：pointer 事件 + setPointerCapture，照抄 designer/shell/FloatingPropsPanel.vue
 * 「拖动：pointer 事件 + setPointerCapture」既定手法（该文件头注释），只在把手元素（.abl__handle）
 * 上起拖，不在整行上捕获指针——可拖动容器若在 pointerdown 时无差别捕获指针，会吞掉行内其余控件
 * （本行展开/收起、行内按钮）的
 * 点击且不报错，因此本组件把 pointerdown/pointermove/pointerup 三个监听全部只挂在把手 span 上，
 * 行本身只挂一个纯 click 切展开。拖拽过程中维护一份本地预览顺序（dragOrder），只在松手
 * （pointerup）那一刻才经 update:modelValue 写回一次——若每次跨越一行都直接写回，会在撤销栈里
 * 留下一整串中间态，不是"一次拖拽一次撤销"。
 * happy-dom 环境下 document.elementFromPoint 不可用/返回值不可靠，本组件的拖拽手势因此没有
 * 组件级挂载测试覆盖真实拖拽交互；真正需要单测覆盖的"给定 from/to 下标算出新数组"已抽成纯函数
 * moveButtonTo（见 ./approvalButtons.ts 与 approvalButtons.test.ts），「上移」「下移」两个按钮
 * 作为拖拽的无障碍等价入口，任何时候都可用（不依赖指针拖拽是否可用）。
 *
 * 点击动作第五档 end_flow「不通过并结束流程」：选中后展开态在「点击后」下方多出「结束到」下拉
 * （候选 = 父层经 endNodeOptions 传入的当前流程全部结束节点，本组件不自己读文档，保持"只上抛
 * update:modelValue"的分工）；收起摘要行显示「不通过并结束 → 节点名」。
 * 目标缺失（end_node_id 为空）与目标失效（有值但已不在候选里，如结束节点被删/改成了别的类型）
 * 两种态在摘要与下拉处分别给出红字提示，发布期后端另有 N3_BUTTON_END_TARGET_* 兜底。
 *
 * 只读态：可以展开查看（点行仍能切换展开态，纯本地 UI 状态，不产生写操作），但把手不可拖、不出
 * 「添加按钮」、编辑区所有控件禁用。
 */
import { computed, h, inject, ref, watch } from 'vue';
import { NButton, NInput, NRadio, NRadioGroup, NSelect, NSwitch } from 'naive-ui';
import type { ApprovalButton, ButtonAction } from '../../../model';
import { BUTTON_DOT_COLORS } from '../../../model/design-tokens';
import { DESIGNER_I18N_KEY } from '../../host';
import {
  addButton,
  canRemoveButton,
  moveButtonDown,
  moveButtonUp,
  removeButtonAt,
  sameButtonOrder,
  updateButtonField,
  moveButtonTo,
  type EndNodeOption
} from './approvalButtons';

const props = defineProps<{
  modelValue: ApprovalButton[];
  readOnly?: boolean;
  /** 所属节点 id：仅用于"切换到另一个审批节点时重置展开态/草稿"这一件事（见下方 watch），本组件
   *  不凭此取任何业务数据——同 EdgePanel.vue watch(() => props.link.id, ...) 的既定手法，换成节点
   *  维度。 */
  nodeId: string;
  /** 「不通过并结束流程」的「结束到」候选（当前流程全部结束节点，由 ApprovePanel.vue 随文档变更
   *  重新计算后传入）；缺省视为流程里还没有结束节点。 */
  endNodeOptions?: EndNodeOption[];
}>();

const emit = defineEmits<{ 'update:modelValue': [buttons: ApprovalButton[]] }>();

const injectedI18n = inject(DESIGNER_I18N_KEY);
if (!injectedI18n) {
  throw new Error('[ApprovalButtonList] 缺少 DESIGNER_I18N_KEY 注入，请确认挂载在设计器根组件之下');
}
// 见 ../../expression/V4ExpressionField.vue / shared/AssigneeSourceList.vue 同处注释：重新声明为
// 非空局部绑定，避免下面嵌套函数（colorLabel/actionLabel 等）里 TS 控制流窄化失效报"可能是
// undefined"。
const i18n = injectedI18n;

function commit(next: ApprovalButton[]): void {
  emit('update:modelValue', next);
}

// ── 按钮颜色 / 点击动作的取值域与文案 key。 ───────────────────────────────────────────────────
const COLOR_OPTIONS: ApprovalButton['color'][] = ['primary', 'success', 'danger', 'warning', 'neutral'];
function colorHex(color: string): string {
  return BUTTON_DOT_COLORS[color as keyof typeof BUTTON_DOT_COLORS] ?? BUTTON_DOT_COLORS.neutral;
}
function colorLabel(color: string): string {
  switch (color) {
    case 'primary':
      return i18n.t('workflow.designer.dialog.buttonSettings.color.primary');
    case 'success':
      return i18n.t('workflow.designer.dialog.buttonSettings.color.success');
    case 'danger':
      return i18n.t('workflow.designer.dialog.buttonSettings.color.danger');
    case 'warning':
      return i18n.t('workflow.designer.dialog.buttonSettings.color.warning');
    default:
      return i18n.t('workflow.designer.dialog.buttonSettings.color.neutral');
  }
}
const ACTION_OPTIONS: ButtonAction[] = ['submit_approve', 'withdraw_previous_step', 'withdraw_initiator', 'withdraw_specified_step', 'end_flow'];
function actionLabel(action: string): string {
  switch (action) {
    case 'submit_approve':
      return i18n.t('workflow.designer.dialog.buttonSettings.action.submitApprove');
    case 'withdraw_previous_step':
      return i18n.t('workflow.designer.dialog.buttonSettings.action.withdrawPreviousStep');
    case 'withdraw_initiator':
      return i18n.t('workflow.designer.dialog.buttonSettings.action.withdrawInitiator');
    case 'end_flow':
      return i18n.t('workflow.designer.dialog.buttonSettings.action.endFlow');
    default:
      return i18n.t('workflow.designer.dialog.buttonSettings.action.withdrawSpecifiedStep');
  }
}
const actionSelectOptions = computed(() => ACTION_OPTIONS.map((action) => ({ label: actionLabel(action), value: action })));

// ── 「结束到」：候选、目标状态、下拉渲染。 ─────────────────────────────────────────────────
const endOptions = computed<EndNodeOption[]>(() => props.endNodeOptions ?? []);
/** NSelect 的选项：value=结束节点 id；label 仅用于已选值回显的兜底，下拉里的双行样式走 renderLabel。 */
const endSelectOptions = computed(() => endOptions.value.map((o) => ({ label: o.label, value: o.id, flag: o.flag })));
/** 按钮当前指向的结束节点；end_node_id 为空或已不在候选里（节点被删/不再是结束节点）返回 undefined。 */
function endTargetOf(btn: ApprovalButton): EndNodeOption | undefined {
  return btn.end_node_id ? endOptions.value.find((o) => o.id === btn.end_node_id) : undefined;
}
/** 目标已失效：end_node_id 有值，但候选里找不到。 */
function isEndTargetMissing(btn: ApprovalButton): boolean {
  return Boolean(btn.end_node_id) && !endTargetOf(btn);
}
/** 下拉每一项：节点名 + 右侧灰色小字结束标识（未填时灰字「未填结束标识」）。 */
function renderEndOptionLabel(option: { label?: unknown; flag?: unknown }) {
  const flag = typeof option.flag === 'string' && option.flag ? option.flag : i18n.t('workflow.designer.dialog.buttonSettings.endNodeFlagEmpty');
  return h('div', { class: 'abl__end-opt' }, [
    h('span', { class: 'abl__end-opt-name' }, String(option.label ?? '')),
    h('span', { class: 'abl__end-opt-flag' }, flag)
  ]);
}
/** 已选值回显只显示节点名（结束标识只在展开的下拉列表里给出）。 */
function renderEndTag({ option }: { option: { label?: unknown } }) {
  return String(option.label ?? '');
}

// ── 展开态：至多一个（同一时刻），按 id 记（不是下标，下标会因拖拽/删除漂移）。切换节点时重置。
const expandedId = ref<string | null>(null);
function isExpanded(id: string): boolean {
  return expandedId.value === id;
}
function toggleExpand(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
}

// ── 名称 / 结果标识两个文本框：草稿值 + 失焦/回车才提交（同 PanelHeader.vue/EdgePanel.vue 既定
// 手法，见文件头注释），不逐字符进撤销栈。切到另一行展开时按该行当前值重置草稿。 ──────────────
const nameDraft = ref('');
const resultTagDraft = ref('');

function findButton(id: string): ApprovalButton | undefined {
  return props.modelValue.find((b) => b.id === id);
}

watch(expandedId, (id) => {
  const btn = id ? findButton(id) : undefined;
  nameDraft.value = btn?.name ?? '';
  resultTagDraft.value = btn?.result_tag ?? '';
});

/** 结果标识是否被用户手动改过（同一个按钮改名字时，只在结果标识"从未被手动动过"的前提下才跟着
 *  联动）：已有明确取值的
 *  按钮（如默认两个按钮的"已通过/已拒绝"）不应被改名字误连带覆盖；新增按钮结果标识起始为空，
 *  跟随名称直到用户自己编辑过结果标识框。切换节点时按新节点当前的按钮清单重新初始化。 */
const touchedResultTagIds = ref<Set<string>>(new Set(props.modelValue.filter((b) => b.result_tag).map((b) => b.id)));

watch(
  () => props.nodeId,
  () => {
    expandedId.value = null;
    touchedResultTagIds.value = new Set(props.modelValue.filter((b) => b.result_tag).map((b) => b.id));
  }
);

function commitName(id: string): void {
  if (props.readOnly) return;
  const btn = findButton(id);
  if (!btn || nameDraft.value === btn.name) return; // 无变化不写回，不产生多余撤销条目
  const index = props.modelValue.findIndex((b) => b.id === id);
  const patch: Partial<ApprovalButton> = { name: nameDraft.value };
  if (!touchedResultTagIds.value.has(id)) patch.result_tag = nameDraft.value;
  commit(updateButtonField(props.modelValue, index, patch));
}
function onNameKeydown(event: KeyboardEvent, id: string): void {
  if (event.key === 'Enter') commitName(id);
}

function commitResultTag(id: string): void {
  if (props.readOnly) return;
  const btn = findButton(id);
  if (!btn || resultTagDraft.value === btn.result_tag) return;
  touchedResultTagIds.value.add(id);
  const index = props.modelValue.findIndex((b) => b.id === id);
  commit(updateButtonField(props.modelValue, index, { result_tag: resultTagDraft.value }));
}
function onResultTagKeydown(event: KeyboardEvent, id: string): void {
  if (event.key === 'Enter') commitResultTag(id);
}

// ── 一次操作一次写回：动作 / 颜色 / 需填理由 / 上移 / 下移 / 删除 / 新增。 ─────────────────────
function onActionChange(id: string, value: string | number): void {
  if (props.readOnly) return;
  const index = props.modelValue.findIndex((b) => b.id === id);
  commit(updateButtonField(props.modelValue, index, { action: value as ButtonAction }));
}
function onEndNodeChange(id: string, value: string | number | null): void {
  if (props.readOnly) return;
  const index = props.modelValue.findIndex((b) => b.id === id);
  commit(updateButtonField(props.modelValue, index, { end_node_id: value == null ? undefined : String(value) }));
}
function onColorPick(id: string, color: ApprovalButton['color']): void {
  if (props.readOnly) return;
  const index = props.modelValue.findIndex((b) => b.id === id);
  commit(updateButtonField(props.modelValue, index, { color }));
}
function onRequireReasonChange(id: string, value: boolean): void {
  if (props.readOnly) return;
  const index = props.modelValue.findIndex((b) => b.id === id);
  commit(updateButtonField(props.modelValue, index, { require_reason: value }));
}
function onMoveUp(index: number): void {
  if (props.readOnly) return;
  commit(moveButtonUp(props.modelValue, index));
}
function onMoveDown(index: number): void {
  if (props.readOnly) return;
  commit(moveButtonDown(props.modelValue, index));
}
function onRemove(index: number): void {
  if (props.readOnly || !canRemoveButton(props.modelValue)) return;
  const removed = props.modelValue[index];
  commit(removeButtonAt(props.modelValue, index));
  if (removed) touchedResultTagIds.value.delete(removed.id);
}
function onAdd(): void {
  if (props.readOnly) return;
  const next = addButton(props.modelValue);
  commit(next);
  // 新增后自动展开它。
  expandedId.value = next[next.length - 1].id;
}

// ── 拖动排序（见文件头注释）：只在把手上起拖，本地维护一份预览顺序，松手才写回一次。 ──────────
const dragOrder = ref<ApprovalButton[] | null>(null);
const dragFromId = ref<string | null>(null);
let dragPointerId: number | null = null;

/** 渲染用的清单：拖拽中显示本地预览顺序，否则就是 modelValue 本身——两者在"未拖拽"这个占绝大
 *  多数时间的常态下是同一份引用，不额外产生开销。 */
const displayButtons = computed(() => dragOrder.value ?? props.modelValue);

function rowIdAtPoint(clientX: number, clientY: number): string | null {
  // happy-dom（单测环境）未完整实现 elementFromPoint，这里整体防御性 try/catch——拖拽手势本就
  // 不在组件挂载测试里覆盖真实交互（见文件头注释），这里只保证测试环境下调用不报错。
  try {
    const el = document.elementFromPoint(clientX, clientY);
    const row = el?.closest?.('[data-testid="approve-button-row"]') as HTMLElement | null;
    return row?.dataset.buttonId ?? null;
  } catch {
    return null;
  }
}

function onHandlePointerDown(event: PointerEvent, id: string): void {
  if (props.readOnly) return;
  if (dragPointerId !== null) return;
  dragPointerId = event.pointerId;
  dragFromId.value = id;
  dragOrder.value = [...props.modelValue];
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
}
function onHandlePointerMove(event: PointerEvent): void {
  if (dragPointerId === null || event.pointerId !== dragPointerId || !dragOrder.value || !dragFromId.value) return;
  const targetId = rowIdAtPoint(event.clientX, event.clientY);
  if (!targetId || targetId === dragFromId.value) return;
  const fromIndex = dragOrder.value.findIndex((b) => b.id === dragFromId.value);
  const toIndex = dragOrder.value.findIndex((b) => b.id === targetId);
  if (fromIndex < 0 || toIndex < 0) return;
  dragOrder.value = moveButtonTo(dragOrder.value, fromIndex, toIndex);
}
function endDrag(event: PointerEvent, shouldCommit: boolean): void {
  if (dragPointerId === null || event.pointerId !== dragPointerId) return;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  dragPointerId = null;
  const finalOrder = dragOrder.value;
  dragFromId.value = null;
  dragOrder.value = null;
  if (shouldCommit && finalOrder && !sameButtonOrder(finalOrder, props.modelValue)) {
    commit(finalOrder);
  }
}
function onHandlePointerUp(event: PointerEvent): void {
  endDrag(event, true);
}
function onHandlePointerCancel(event: PointerEvent): void {
  endDrag(event, false);
}
</script>

<template>
  <div class="abl">
    <p v-if="displayButtons.length === 0" class="abl__empty">{{ i18n.t('workflow.designer.panel.approve.buttonsEmpty') }}</p>

    <div
      v-for="(btn, index) in displayButtons"
      :key="btn.id"
      class="abl__card"
      :class="{ 'is-expanded': isExpanded(btn.id) }"
    >
      <!-- 收起态摘要行：把手 + 色点 + 名称 + 「动作 · 结果标识」+ 需填理由标签 + 展开箭头。点这
           一行（把手以外区域）切展开，同一时刻至多展开一个。 -->
      <div
        class="abl__row"
        data-testid="approve-button-row"
        :data-button-id="btn.id"
        role="button"
        tabindex="0"
        :aria-expanded="isExpanded(btn.id)"
        @click="toggleExpand(btn.id)"
        @keydown.enter="toggleExpand(btn.id)"
      >
        <!-- 拖动把手：readOnly 态不可拖（不挂 pointerdown 三件套），仅装饰性展示。@click.stop
             防止点把手（不拖动、纯点击）连带触发行展开——见文件头注释"只在把手元素上起拖"一段。 -->
        <span
          class="abl__handle"
          :class="{ 'is-disabled': readOnly }"
          data-testid="approve-button-handle"
          :title="readOnly ? undefined : i18n.t('workflow.designer.panel.approve.buttonHandleTitle')"
          @click.stop
          @pointerdown="onHandlePointerDown($event, btn.id)"
          @pointermove="onHandlePointerMove($event)"
          @pointerup="onHandlePointerUp($event)"
          @pointercancel="onHandlePointerCancel($event)"
        >
          <svg viewBox="0 0 16 16" class="abl__handle-icon" aria-hidden="true">
            <circle cx="5" cy="3.5" r="1.1" />
            <circle cx="11" cy="3.5" r="1.1" />
            <circle cx="5" cy="8" r="1.1" />
            <circle cx="11" cy="8" r="1.1" />
            <circle cx="5" cy="12.5" r="1.1" />
            <circle cx="11" cy="12.5" r="1.1" />
          </svg>
        </span>
        <span class="abl__dot" :style="{ background: colorHex(btn.color) }" />
        <span class="abl__name">{{ btn.name || i18n.t('workflow.designer.dialog.buttonSettings.namePlaceholder') }}</span>
        <!-- 「不通过并结束流程」的摘要：不通过并结束 → 节点名（危险色）；未选/目标失效时红字「未选择结束节点」。 -->
        <span v-if="btn.action === 'end_flow'" class="abl__summary" data-testid="approve-button-end-summary">
          {{ i18n.t('workflow.designer.dialog.buttonSettings.endFlowSummary') }}
          <template v-if="endTargetOf(btn)"> → <span class="abl__danger">{{ endTargetOf(btn)!.label }}</span></template>
          <template v-else> → <span class="abl__danger">{{ i18n.t('workflow.designer.dialog.buttonSettings.endNodeSummaryMissing') }}</span></template>
        </span>
        <span v-else class="abl__summary">{{ actionLabel(btn.action) }}<template v-if="btn.result_tag"> · {{ btn.result_tag }}</template></span>
        <span v-if="btn.require_reason" class="abl__badge">{{ i18n.t('workflow.designer.panel.approve.buttonRequireReasonBadge') }}</span>
        <span
          class="abl__arrow"
          :class="{ 'is-open': isExpanded(btn.id) }"
          role="img"
          :aria-label="i18n.t(isExpanded(btn.id) ? 'workflow.designer.panel.approve.buttonRowCollapse' : 'workflow.designer.panel.approve.buttonRowExpand')"
        >⌄</span>
      </div>

      <!-- 展开态编辑区：标签在上、控件通栏（面板宽 312、卡片正文内边距 10，这里排单列刚好排得下）。 -->
      <!-- 编辑区是 .abl__card 的另一个子节点（与 .abl__row 平级，不是嵌套在其内部），点击editor
           内部不会经 DOM 冒泡触发 .abl__row 的展开/收起点击处理，不需要额外 stopPropagation。 -->
      <div v-if="isExpanded(btn.id)" class="abl__editor" data-testid="approve-button-editor">
        <div class="abl__field">
          <span class="abl__field-label">{{ i18n.t('workflow.designer.dialog.buttonSettings.nameLabel') }}</span>
          <NInput
            v-model:value="nameDraft"
            size="small"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.dialog.buttonSettings.namePlaceholder')"
            data-testid="approve-button-name-input"
            @blur="commitName(btn.id)"
            @keydown="onNameKeydown($event, btn.id)"
          />
        </div>

        <div class="abl__field">
          <span class="abl__field-label">{{ i18n.t('workflow.designer.dialog.buttonSettings.actionLabel') }}</span>
          <NSelect
            size="small"
            :value="btn.action"
            :options="actionSelectOptions"
            :disabled="readOnly"
            data-testid="approve-button-action-select"
            @update:value="(v) => onActionChange(btn.id, v)"
          />
        </div>

        <!-- 「结束到」：仅 end_flow 出现，紧跟「点击后」。 -->
        <div v-if="btn.action === 'end_flow'" class="abl__field" data-testid="approve-button-end-field">
          <span class="abl__field-label">{{ i18n.t('workflow.designer.dialog.buttonSettings.endNodeLabel') }}</span>
          <NSelect
            size="small"
            :value="endTargetOf(btn)?.id ?? null"
            :options="endSelectOptions"
            :disabled="readOnly"
            :status="isEndTargetMissing(btn) ? 'error' : undefined"
            :placeholder="i18n.t('workflow.designer.dialog.buttonSettings.endNodePlaceholder')"
            :render-label="renderEndOptionLabel"
            :render-tag="renderEndTag"
            data-testid="approve-button-end-select"
            @update:value="(v) => onEndNodeChange(btn.id, v)"
          />
          <p v-if="isEndTargetMissing(btn)" class="abl__hint abl__hint--error" data-testid="approve-button-end-missing">
            {{ i18n.t('workflow.designer.dialog.buttonSettings.endNodeMissing') }}
          </p>
          <p v-else-if="endOptions.length === 0" class="abl__hint" data-testid="approve-button-end-empty">
            {{ i18n.t('workflow.designer.dialog.buttonSettings.endNodeEmpty') }}
          </p>
          <p v-else class="abl__hint">{{ i18n.t('workflow.designer.dialog.buttonSettings.endNodeHelp') }}</p>
        </div>

        <div class="abl__field">
          <span class="abl__field-label">{{ i18n.t('workflow.designer.dialog.buttonSettings.resultTagLabel') }}</span>
          <NInput
            v-model:value="resultTagDraft"
            size="small"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.dialog.buttonSettings.resultTagPlaceholder')"
            data-testid="approve-button-result-tag-input"
            @blur="commitResultTag(btn.id)"
            @keydown="onResultTagKeydown($event, btn.id)"
          />
        </div>

        <div class="abl__field abl__field--row">
          <span class="abl__field-label">{{ i18n.t('workflow.designer.dialog.buttonSettings.requireReasonLabel') }}</span>
          <NSwitch
            size="small"
            :value="btn.require_reason"
            :disabled="readOnly"
            data-testid="approve-button-require-reason"
            @update:value="(v) => onRequireReasonChange(btn.id, v)"
          />
        </div>

        <div class="abl__field">
          <span class="abl__field-label">{{ i18n.t('workflow.designer.dialog.buttonSettings.colorLabel') }}</span>
          <!-- 五色单选：NRadioGroup 取值语义（value=颜色字面量），隐藏 NRadio 自带圆点指示器，只
               保留自绘色点 + 选中态描边。 -->
          <NRadioGroup
            class="abl__colors"
            size="small"
            :value="btn.color"
            :disabled="readOnly"
            @update:value="(v) => onColorPick(btn.id, v as ApprovalButton['color'])"
          >
            <NRadio v-for="color in COLOR_OPTIONS" :key="color" class="abl__color-radio" :value="color" :data-testid="`approve-button-color-${color}`">
              <span class="abl__color-dot" :style="{ background: colorHex(color) }" :title="colorLabel(color)" />
            </NRadio>
          </NRadioGroup>
        </div>

        <div class="abl__actions">
          <NButton size="small" quaternary :disabled="readOnly || index === 0" data-testid="approve-button-move-up" @click="onMoveUp(index)">
            {{ i18n.t('workflow.designer.dialog.buttonSettings.moveUp') }}
          </NButton>
          <NButton size="small" quaternary :disabled="readOnly || index === displayButtons.length - 1" data-testid="approve-button-move-down" @click="onMoveDown(index)">
            {{ i18n.t('workflow.designer.dialog.buttonSettings.moveDown') }}
          </NButton>
          <NButton
            size="small"
            quaternary
            class="abl__remove"
            :disabled="readOnly || !canRemoveButton(modelValue)"
            :title="canRemoveButton(modelValue) ? undefined : i18n.t('workflow.designer.dialog.buttonSettings.minCountHint')"
            data-testid="approve-button-remove"
            @click="onRemove(index)"
          >{{ i18n.t('workflow.designer.dialog.buttonSettings.removeButton') }}</NButton>
        </div>
      </div>
    </div>

    <NButton v-if="!readOnly" dashed type="primary" size="small" class="abl__add" data-testid="approve-button-add" @click="onAdd">
      {{ i18n.t('workflow.designer.panel.approve.buttonAdd') }}
    </NButton>
  </div>
</template>

<style scoped>
.abl { display: flex; flex-direction: column; gap: 6px; }
.abl__empty { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
.abl__card {
  border: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  border-radius: 4px;
  overflow: hidden;
}
/* 展开态：卡片边框改用更醒目一档、与收起行连成一体。 */
.abl__card.is-expanded { border-color: rgb(var(--border-light-color, 228 231 237)); }
.abl__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 6px;
  cursor: pointer;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.abl__row:hover { background: rgb(var(--fill-lightest-color, 250 251 252)); }
.abl__handle {
  display: inline-flex;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  color: rgb(var(--text-hint-color, 153 153 153));
  cursor: grab;
  touch-action: none; /* 拖拽期间禁止浏览器自身的触摸滚动/手势接管指针事件 */
}
.abl__handle.is-disabled { cursor: default; opacity: 0.4; }
.abl__handle-icon { width: 12px; height: 12px; fill: currentColor; }
.abl__dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; }
.abl__name { flex: 0 0 auto; max-width: 96px; overflow: hidden; color: rgb(var(--base-text-color, 31 31 31)); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.abl__summary { flex: 1; min-width: 0; overflow: hidden; color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.abl__badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(var(--primary-color, 10 106 214) / 10%);
  color: rgb(var(--primary-color, 10 106 214));
  font-size: 11px;
}
.abl__arrow {
  flex: 0 0 auto;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  transition: transform 0.15s ease;
}
.abl__arrow.is-open { transform: rotate(180deg); }
.abl__editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  background: rgb(var(--fill-lightest-color, 250 251 252));
  cursor: default;
}
.abl__field { display: flex; flex-direction: column; gap: 4px; }
/* 「需要填写理由才能确认」：左文字右开关，与其余"标签在上"的字段不同布局，单独一档。 */
.abl__field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.abl__field-label { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.abl__colors { display: inline-flex; gap: 8px; }
.abl__colors :deep(.n-radio__dot-wrapper) { display: none; }
.abl__colors :deep(.n-radio__label) { padding: 0; }
.abl__color-dot { display: inline-block; width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.abl__color-radio.n-radio--checked .abl__color-dot { border-color: rgb(var(--base-text-color, 31 31 31)); }
.abl__actions { display: flex; gap: 6px; justify-content: flex-end; }
.abl__remove { color: rgb(var(--danger-color, 224 78 65)); }
.abl__add { width: 100%; }
/* 「结束到」：说明/提示灰字，失效态红字；摘要里的节点名取危险色。均走既有 CSS 变量。 */
.abl__hint { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
.abl__hint--error { color: rgb(var(--danger-color, 224 78 65)); }
.abl__danger { color: rgb(var(--danger-color, 224 78 65)); }
</style>

<!-- 下拉选项经 NSelect 的 render-label 在其弹层（teleport）里渲染，拿不到本组件的 scoped 属性，
     故这三条不能写进上面的 scoped 块；类名带 abl__end-opt 前缀，不会污染其它处。 -->
<style>
.abl__end-opt { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.abl__end-opt-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.abl__end-opt-flag { flex: 0 0 auto; max-width: 50%; overflow: hidden; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
</style>
