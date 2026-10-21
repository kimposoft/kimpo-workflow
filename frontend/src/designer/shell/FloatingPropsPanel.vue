<script setup lang="ts">
/**
 * shell/FloatingPropsPanel.vue —— 属性面板的浮动外壳：属性面板浮在画布上，不占固定
 * 栏位，画布因此多出约 300px 可视宽。
 *
 * 本组件是 ../stencil/FloatingStencilPanel.vue 的同构写法（拖动/夹回/本地记忆全套照抄，见
 * props-panel-position.ts 头注释"不抽公共层"），多一档"钉住"——钉住时贴回画布右缘、不参与
 * 拖动，画布让位（真实变窄，不是被盖住），得到固定侧栏式的非遮挡观感，见 DesignerRoot.vue 消费处
 * 注释。三态：
 *   - 浮动（默认）：卡片盖在画布右上角，标题栏可拖动，位置记忆；
 *   - 钉住：贴右缘、高度撑满容器，画布真实让出 PROPS_PANEL_WIDTH + PROPS_PANEL_DOCK_GAP 宽度
 *     （本组件只负责"自己贴右缘摆多宽多高"，画布让位的那部分 margin 由 DesignerRoot.vue 根据
 *     本组件 emit 的 pinned-change 事件决定，见其 canvasYieldStyle 消费处）；
 *   - 收起：36×36 图标，选中项从空变为非空时自动展开回收起前的那一态（浮动/钉住），见下方
 *     autoExpandOnSelect 消费处。
 *
 * 空选/多选态隐藏：只有"恰好选中 1 个节点"或"恰好选中 1 条连线"
 * 这两种"存在单个可配置目标"的情况才显示浮层；空选、多选节点、多选连线、节点与连线混选——
 * 一律隐藏整个浮层，不渲染"选中节点或连线后在这里配置"这类占位文案（多选时画布工具条已经
 * 显示"已选中 N 个节点"，浮层再弹占位提示会自相矛盾；批量操作集中在工具条一处，见下方
 * hasSingleSelectionTarget 消费处）。用 v-show 而
 * 非 v-if——组件保持挂载、ResizeObserver 不需要反复重建，隐藏时 getBoundingClientRect 会测出
 * 0，measurePanel() 本就对 0 尺寸做了"保留上次有效值"的防御（见该函数注释），重新显示时交给
 * 下方 watch(nothingSelected) 主动补一次测量 + 夹回，不依赖 `display:none → 可见` 这个
 * ResizeObserver 边界情况是否总能如期触发。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { DocumentSelection } from '../../model/document-state';
import type { WorkflowDocument } from '../../model';
import PropsPanel from './PropsPanel.vue';
import {
  clampPanelPosition,
  computePropsPanelBodyMaxHeight,
  defaultPropsPanelPosition,
  isDragGesture,
  PROPS_PANEL_ICON_SIZE,
  PROPS_PANEL_WIDTH,
  readPersistedPropsPanelState,
  writePersistedPropsPanelState,
  type PanelPosition,
  type PanelSize
} from './props-panel-position';

const props = defineProps<{
  i18n: PluginI18n;
  localeTick?: number;
  doc?: WorkflowDocument;
  selection: DocumentSelection;
  readOnly?: boolean;
}>();

/** 钉住态变化时通知 DesignerRoot.vue 调整画布让位宽度——本组件不认识"画布"这个概念，只汇报
 * 自己此刻是不是钉住了，具体怎么改画布宽度是宿主（DesignerRoot）的职责，同
 * FloatingStencilPanel.vue"本组件只 emit 用户意图，具体调用留给上层"的既定分工。 */
const emit = defineEmits<{ (e: 'pinned-change', pinned: boolean): void }>();

const nothingSelected = computed(() => props.selection.nodeIds.length === 0 && props.selection.linkIds.length === 0);

/**
 * hasSingleSelectionTarget —— 是否"存在单个可配置目标"：恰好选中 1 个节点（不含任何连线）或
 * 恰好选中 1 条连线（不含任何节点）。多选（≥2 个节点/连线，或节点与
 * 连线混选）与空选一样都不显示浮层，批量操作只留在画布工具条一处。本计算属性只驱动下方模板
 * v-show 这一处显示判据，不影响 nothingSelected——nothingSelected 仍保留字面"完全无选中"的
 * 语义，专供下方 autoExpandOnSelect 联动使用，两者用途不同、故意分成两个计算属性（理由
 * 见该 watch 处注释）。
 */
/** 浮层标题随选中对象变（选中节点叫「节点设置」，选中连线叫「连线设置」）——只看
 *  "有没有选中连线"即可：本浮层只在恰好单选一个目标时可见（见下方 hasSingleSelectionTarget）。 */
const panelTitleKey = computed(() =>
  props.selection.linkIds.length === 1 ? 'workflow.designer.panel.titleEdge' : 'workflow.designer.panel.titleNode'
);

const hasSingleSelectionTarget = computed(
  () =>
    (props.selection.nodeIds.length === 1 && props.selection.linkIds.length === 0) ||
    (props.selection.nodeIds.length === 0 && props.selection.linkIds.length === 1)
);

// ── 本地记忆：位置 + 收起态 + 钉住态一起落盘。持久化读回可能是 undefined（从未存过/值非法，
// 见 props-panel-position.ts parsePersistedPropsPanelState 头注释"与 stencil 版本的差异"）——
// 此时 collapsed/pinned 落默认值 false（浮动），position 先用一个粗略估计值占位
// （window.innerWidth，纯浏览器环境读不到时退化 1200），onMounted 测出真实容器宽度后
// 会用 defaultPropsPanelPosition() 现算一次真正的默认落点并覆盖掉这个粗略值，见下方
// usedFallbackPosition 消费处。
const persisted = readPersistedPropsPanelState();
const usedFallbackPosition = !persisted;
const roughContainerWidthGuess = typeof window !== 'undefined' ? window.innerWidth : 1200;
const position = ref<PanelPosition>(persisted?.position ?? defaultPropsPanelPosition(roughContainerWidthGuess));
const collapsed = ref(persisted?.collapsed ?? false);
const pinned = ref(persisted?.pinned ?? false);

function persist(): void {
  writePersistedPropsPanelState({ position: { ...position.value }, collapsed: collapsed.value, pinned: pinned.value });
}

watch(
  pinned,
  (value) => emit('pinned-change', value),
  { immediate: true }
);

// ── 容器尺寸测量：容器是本组件根元素的父节点（DesignerRoot.vue 的 .wf-designer-canvas-wrap，
// position:relative，与 DesignerCanvas、FloatingStencilPanel 同级）——用 ResizeObserver 持续
// 观察，同 FloatingStencilPanel.vue 既定手法。
const rootRef = shallowRef<HTMLElement | null>(null);
const containerSize = ref({ width: 0, height: 0 });
let resizeObserver: ResizeObserver | undefined;

function measureContainer(): void {
  const container = rootRef.value?.parentElement;
  if (!container) return;
  containerSize.value = { width: container.clientWidth, height: container.clientHeight };
}

/** 展开态（浮动）主体可用高度，超出内部滚动——仅浮动态使用；钉住态高度撑满容器由 CSS 直接给
 * （见下方 pinnedStyle），不需要这份"主体高度上限"公式。 */
const bodyMaxHeight = computed(() => computePropsPanelBodyMaxHeight(containerSize.value.height, position.value.y));

/**
 * measuredSize —— 面板根元素当前**实测**的渲染宽高，供夹回使用（同
 * FloatingStencilPanel.vue measuredSize 头注释"根因"：夹回必须用实测尺寸，不能用公式估算值，
 * 否则面板真实渲染出来的高度与夹回边界对不上，会溢出定位容器）。只在浮动/收起两态下参与
 * clampPanelPosition 调用，钉住态不夹回（钉住是确定性的贴边布局，见 pinnedStyle）。
 */
const measuredSize = ref<PanelSize>({ width: PROPS_PANEL_WIDTH, height: PROPS_PANEL_ICON_SIZE });
let panelResizeObserver: ResizeObserver | undefined;

function measurePanel(): void {
  const el = rootRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) measuredSize.value = { width: rect.width, height: rect.height };
}

function reclamp(): void {
  if (pinned.value) return; // 钉住态不参与拖动夹回，位置由 CSS 贴边决定。
  position.value = clampPanelPosition(position.value, measuredSize.value, containerSize.value);
}

onMounted(() => {
  measureContainer();
  if (usedFallbackPosition) position.value = defaultPropsPanelPosition(containerSize.value.width);
  measurePanel();
  reclamp();
  const container = rootRef.value?.parentElement;
  if (container && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      measureContainer();
      reclamp();
    });
    resizeObserver.observe(container);
  }
  if (rootRef.value && typeof ResizeObserver !== 'undefined') {
    panelResizeObserver = new ResizeObserver(() => {
      measurePanel();
      reclamp();
    });
    panelResizeObserver.observe(rootRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  panelResizeObserver?.disconnect();
});

// 收起/展开、钉住/取消钉住都会立刻改变面板渲染尺寸/形态，切换后立刻重新测量 + 夹回一次，同
// FloatingStencilPanel.vue watch(collapsed) 既定手法。
watch([collapsed, pinned], () => {
  void nextTick(() => {
    measurePanel();
    reclamp();
  });
});

/** 选中项从"无"变为"有"时，若面板此刻是收起态，自动展开回收起前记住的那一态（浮动/钉住）——
 * 用户选中一个节点/连线通常就是想看它的属性，不该还要先点一下图标。immediate:true 覆盖"组件
 * 挂载时选中项已经非空、且之前收起过"这一初始情形，不需要再等一次后续变化才展开。只在"从空到非空"这个方向自动展开——从一个非空选中切到另一个非空
 * 选中不重复触发（此时面板本就展开着）。
 *
 * 本 watch 依赖的是 nothingSelected（字面"完全无选中"），刻意不用上面的
 * hasSingleSelectionTarget——"折叠/展开"按钮只可能在浮层可见时被点到，而浮层此刻只在
 * "单个可配置目标"时可见，也就是说 collapsed 这个偏好只会在单选态下被用户手动改动；多选态下
 * 浮层整体隐藏、按钮点不到，collapsed 的值原样保留、不会被多选/空选之间的切换污染。因此"多选
 * →单选"这类切换（selection 数组从头到尾都非空，nothingSelected 恒为 false，watch 不触发）
 * 不会误触发自动展开，而是保留用户上一次在单选态下手动设置的收起/展开偏好，与本浮层"位置/
 * 收起/钉住全部本地记忆、跨选中项持续生效"的既定设计一致，不是回归。 */
watch(
  nothingSelected,
  (isEmpty, wasEmpty) => {
    if (isEmpty) return;
    if (wasEmpty === false) return; // 非"从空到非空"的变化，不处理。
    if (!collapsed.value) return;
    collapsed.value = false;
    persist();
  },
  { immediate: true }
);

// ── 拖动：pointer 事件 + setPointerCapture，同 FloatingStencilPanel.vue 既定手法照抄。钉住态
// 不接受拖动（贴边固定），标题栏在钉住态下不绑定这几个处理函数（见下方模板）。
const dragging = ref(false);
let dragPointerId: number | null = null;
let dragStartClientX = 0;
let dragStartClientY = 0;
let dragStartPosition: PanelPosition = { x: 0, y: 0 };
let dragMaxDelta = 0;
let suppressNextClick = false;

function beginDrag(event: PointerEvent): void {
  if (pinned.value) return;
  if (dragPointerId !== null) return;
  dragPointerId = event.pointerId;
  dragStartClientX = event.clientX;
  dragStartClientY = event.clientY;
  dragStartPosition = { ...position.value };
  dragMaxDelta = 0;
  dragging.value = true;
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
}

function updateDrag(event: PointerEvent): void {
  if (dragPointerId === null || event.pointerId !== dragPointerId) return;
  const dx = event.clientX - dragStartClientX;
  const dy = event.clientY - dragStartClientY;
  dragMaxDelta = Math.max(dragMaxDelta, Math.hypot(dx, dy));
  const tentative = { x: dragStartPosition.x + dx, y: dragStartPosition.y + dy };
  position.value = clampPanelPosition(tentative, measuredSize.value, containerSize.value);
}

function endDrag(event: PointerEvent): void {
  if (dragPointerId === null || event.pointerId !== dragPointerId) return;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  dragPointerId = null;
  dragging.value = false;
  // 只在收起态（拖的是那枚小图标）才需要置位抑制标志——标题栏本身没有"点击展开"语义，没人消费
  // 这个标志，若无条件置位，展开态拖完标题栏后标志会一直残留为 true，直到用户之后第一次点收起
  // 图标时才被吞掉（表现为"拖过面板后点图标第一次没反应，要点第二次"），见 onIconClick 消费处。
  if (isDragGesture(dragMaxDelta) && collapsed.value) suppressNextClick = true;
  persist();
}

function onIconClick(): void {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  collapsed.value = false;
  persist();
}

function collapseFromHandle(): void {
  collapsed.value = true;
  persist();
}

function togglePinned(): void {
  pinned.value = !pinned.value;
  persist();
}

/** 钉住态的贴边样式：与浮动态的 `{left,top}` 定位互斥，撑满容器高度，宽度固定
 * PROPS_PANEL_WIDTH——不经 clampPanelPosition（贴边布局本就确定性地落在容器内，不存在越界
 * 夹回的问题）。 */
const pinnedStyle = computed(() => ({
  left: `${Math.max(0, containerSize.value.width - PROPS_PANEL_WIDTH)}px`,
  top: '0px',
  width: `${PROPS_PANEL_WIDTH}px`,
  height: `${containerSize.value.height}px`
}));

const floatingStyle = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }));
</script>

<template>
  <div
    ref="rootRef"
    v-show="hasSingleSelectionTarget"
    class="workflow-props-floating"
    data-testid="workflow-props-floating"
    :class="{ 'is-dragging': dragging, 'is-pinned': pinned && !collapsed }"
    :style="collapsed || !pinned ? floatingStyle : pinnedStyle"
  >
    <!-- 收起态：同节点库浮层，整块变成一个可拖动、可点击展开的小图标按钮。图标用"属性/齿轮"
         语义的方块+勾边图案，与节点库浮层的网格块图标区分开，一眼能认出"这是收起的属性面板"。 -->
    <button
      v-if="collapsed"
      type="button"
      class="workflow-props-floating__icon"
      data-testid="workflow-props-icon"
      :aria-label="i18n.t('workflow.designer.shell.expandPanel')"
      :title="i18n.t('workflow.designer.shell.expandPanel')"
      @pointerdown="beginDrag"
      @pointermove="updateDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @click="onIconClick"
    >
      <svg viewBox="0 0 16 16" class="workflow-props-floating__icon-svg" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
        <path d="M4.5 8 L7 10.5 L11.5 5.5" fill="none" stroke-width="1.4" />
      </svg>
    </button>

    <!-- 展开态（浮动或钉住）：标题栏（钉住态下拖动把手不可拖，仅作视觉留白）+ 钉住/取消钉住
         按钮 + 收起按钮 + 主体（PropsPanel 本体，浮动态超出可用高度内部滚动，钉住态高度已由
         pinnedStyle 撑满容器，主体走 flex:1 自身滚动）。 -->
    <div v-else class="workflow-props-floating__panel">
      <div
        class="workflow-props-floating__handle"
        :class="{ 'is-pinned': pinned }"
        data-testid="workflow-props-drag-handle"
        :title="pinned ? undefined : i18n.t('workflow.designer.shell.propsPanel.dragHandle')"
        @pointerdown="beginDrag"
        @pointermove="updateDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <!-- 拖动把手：六点线性图标，不用盲文点字符——字符在不同系统字体下
             粗细/基线都不一致。 -->
        <svg v-if="!pinned" class="workflow-props-floating__handle-grip" viewBox="0 0 10 12" aria-hidden="true">
          <circle cx="2.6" cy="2" r="1.1" /><circle cx="7.4" cy="2" r="1.1" />
          <circle cx="2.6" cy="6" r="1.1" /><circle cx="7.4" cy="6" r="1.1" />
          <circle cx="2.6" cy="10" r="1.1" /><circle cx="7.4" cy="10" r="1.1" />
        </svg>
        <strong class="workflow-props-floating__handle-title">{{ i18n.t(panelTitleKey) }}</strong>
        <button
          type="button"
          class="workflow-props-floating__pin"
          :class="{ 'is-active': pinned }"
          data-testid="workflow-props-pin"
          :aria-label="i18n.t(pinned ? 'workflow.designer.shell.propsPanel.unpin' : 'workflow.designer.shell.propsPanel.pin')"
          :title="i18n.t(pinned ? 'workflow.designer.shell.propsPanel.unpin' : 'workflow.designer.shell.propsPanel.pin')"
          @pointerdown.stop
          @click="togglePinned"
        >
          <!-- 图钉：线性图标（不再用 emoji 字符——emoji 自带彩色，不跟随主题色，也没法表达常亮态）。 -->
          <svg class="workflow-props-floating__btn-svg" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M9.6 2.2l4.2 4.2-1.9.6-2.3 2.3.2 3-1.2 1.2-2.9-2.9L2.5 13.8M5.7 10.6L2.8 7.7 4 6.5l3 .2 2.3-2.3z" />
          </svg>
        </button>
        <button
          type="button"
          class="workflow-props-floating__collapse"
          data-testid="workflow-props-collapse"
          :aria-label="i18n.t('workflow.designer.shell.collapsePanel')"
          :title="i18n.t('workflow.designer.shell.collapsePanel')"
          @pointerdown.stop
          @click="collapseFromHandle"
        >
          <!-- 收起：线性箭头图标（不再用「‹」字符）。 -->
          <svg class="workflow-props-floating__btn-svg" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5l4.5 4.5L6 12.5" />
          </svg>
        </button>
      </div>
      <div class="workflow-props-floating__body" :style="pinned ? undefined : { maxHeight: `${bodyMaxHeight}px` }">
        <!-- 外壳标题栏（上方 __handle）已经显示浮层标题——hide-title 隐掉内层那份，避免同一浮层两行标题叠在一起（同
             stencil/FloatingStencilPanel.vue 传 hide-title 给 StencilPanel 的既定解法）。 -->
        <PropsPanel :i18n="i18n" :locale-tick="localeTick" :doc="doc" :selection="selection" :read-only="readOnly" hide-title />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 浮动定位容器：绝对定位在 DesignerRoot.vue 的 .wf-designer-canvas-wrap 内，z-index 与节点库
   浮层一致，同一层级互不遮挡优先级问题（两者默认分别贴左上/右上，正常操作不会重叠）。 */
.workflow-props-floating {
  position: absolute;
  z-index: 30;
}
@media (prefers-reduced-motion: no-preference) {
  .workflow-props-floating:not(.is-dragging) {
    transition: left 0.12s ease, top 0.12s ease;
  }
}
.workflow-props-floating__panel {
  display: flex;
  flex-direction: column;
  /* 浮层宽 312（与 props-panel-position.ts PROPS_PANEL_WIDTH 同值，两处必须一起改）。 */
  width: 312px;
  overflow: hidden;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 8px;
  background: rgb(var(--container-bg-color, 255 255 255));
  box-shadow: 0 6px 20px rgb(var(--shadow-color, 16 24 40) / 18%);
}
/* 钉住态：贴边栏位形态，去掉浮动卡片的圆角/阴影观感，呈现固定侧栏的样子——只在左
   侧留一条边框，视觉上是"画布到此为止，后面是属性面板"，不是一张盖上去的卡片。高度也只在
   这一态显式撑满根元素（根元素的像素高度由 pinnedStyle 给出）——浮动态根元素没有显式高度，
   height:100% 在那种情况下会被浏览器当成"父级高度不确定"而退化成 auto，与不写这条规则等效，
   但显式只在钉住态声明语义更清楚，不依赖这条边界行为。 */
.workflow-props-floating.is-pinned .workflow-props-floating__panel {
  height: 100%;
  border-radius: 4px;
  box-shadow: none;
}
.workflow-props-floating__handle {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  /* 把手条高 34、浅填充底。 */
  height: 34px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237));
  background: rgb(var(--fill-light-color, 245 247 250));
  cursor: grab;
  touch-action: none;
  user-select: none;
}
/* 钉住态标题栏不可拖动，光标恢复默认，不再给"可抓取"的视觉暗示。 */
.workflow-props-floating__handle.is-pinned {
  cursor: default;
  touch-action: auto;
}
.workflow-props-floating__handle:not(.is-pinned):active { cursor: grabbing; }
.workflow-props-floating__handle-grip { flex: 0 0 auto; width: 10px; height: 12px; fill: rgb(var(--text-hint-color, 153 153 153)); }
.workflow-props-floating__handle-title { flex: 1; overflow: hidden; color: rgb(var(--base-text-color, 31 31 31)); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
/* 标题栏两个图标按钮共用的线性图标：颜色跟随按钮文字色（currentColor），常亮态自动变主色。 */
.workflow-props-floating__btn-svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.workflow-props-floating__pin,
.workflow-props-floating__collapse {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  cursor: pointer;
}
.workflow-props-floating__pin:hover,
.workflow-props-floating__collapse:hover { background: rgb(var(--fill-color, 240 242 245)); }
/* 已钉住时图钉按钮常亮，与"未钉住"的悬停态区分——不写死颜色，走既有主色 token。 */
.workflow-props-floating__pin.is-active {
  background: rgb(var(--primary-color, 100 108 255) / 12%);
  color: rgb(var(--primary-color, 100 108 255));
}
.workflow-props-floating__pin:focus-visible,
.workflow-props-floating__collapse:focus-visible,
.workflow-props-floating__icon:focus-visible {
  outline: 2px solid rgb(var(--primary-color, 100 108 255));
  outline-offset: 1px;
}
/* display:flex;flex-direction:column——本层是 .wf-props-panel（shell/PropsPanel.vue 根元素）唯一
   的直接父层。若本层是普通块级容器，.wf-props-panel 只能靠 height:100% 这条百分比继承拿高度，
   而百分比继承要求祖先有显式 height，本层浮动态只给了下面这条 max-height（内联样式），不满足
   条件，百分比会退化成 auto，导致内容超高时不裁剪也不出现滚动条、直接撑爆浮层（详见
   shell/PropsPanel.vue .wf-props-panel 规则处注释）。作为 flex 容器，.wf-props-panel 用 flex:1;min-height:0 就能精确填满本层的
   实际渲染高度（不论那个高度是这条 max-height 算出来的，还是钉住态那条真正的 height:100%），
   真正的滚动条交给更内层的 .wf-props-panel__body，本层因此不再需要自己滚动，overflow 改
   hidden——一处内容只有一层滚动条，不会出现内外两层滚动条重叠的观感。 */
.workflow-props-floating__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 收起态图标：同节点库浮层一样的边框+阴影+不透明底色层次，尺寸固定 36×36。 */
.workflow-props-floating__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 8px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--text-secondary-color, 102 102 102));
  box-shadow: 0 4px 12px rgb(var(--shadow-color, 16 24 40) / 16%);
  cursor: grab;
  touch-action: none;
}
.workflow-props-floating__icon:hover { background: rgb(var(--fill-color, 240 242 245)); }
.workflow-props-floating__icon:active { cursor: grabbing; }
.workflow-props-floating__icon-svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: rgb(var(--text-secondary-color, 102 102 102));
  stroke-width: 1.4;
}
.workflow-props-floating__icon-svg rect { fill: none; stroke: rgb(var(--text-secondary-color, 102 102 102)); }
</style>
