<script setup lang="ts">
/**
 * FloatingStencilPanel.vue —— 节点库的浮动外壳：浮动在画布左侧，可拖动，点击收起后变成缩略图标。
 *
 * 本组件只负责"浮动壳"这一层：定位/拖动/夹回/收起成图标/本地记忆，节点条目本身（搜索/分组/
 * 拖拽建节点/双击顺接）完全交给内部的 StencilPanel.vue，不改动其行为（见该文件）。挂载在
 * DesignerRoot.vue 的 `.wf-designer-canvas-wrap`（position: relative，与 DesignerCanvas 同级）
 * 内，本组件用 position: absolute 盖在画布之上——DesignerRoot 不需要知道浮动面板的任何内部状态，
 * 两者之间只有一条 dblclick-item 事件转发（签名与此前 StencilPanel 直接使用时完全一致，
 * DesignerRoot.vue 的接线 `@dblclick-item="onStencilDblClick"` 不用改）。
 *
 * 几何计算（夹回边界/主体可用高度/点击拖动判别/本地存储值校验）全部委托 floating-panel.ts 的
 * 纯函数，本文件只管"接指针事件 → 算新位置 → 落盘"这层胶水逻辑，见该文件头注释。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { NodeKind } from '../../model';
import StencilPanel from './StencilPanel.vue';
import {
  clampPanelPosition,
  computeStencilPanelBodyMaxHeight,
  readPersistedStencilPanelState,
  isDragGesture,
  STENCIL_PANEL_ICON_SIZE,
  STENCIL_PANEL_WIDTH,
  writePersistedStencilPanelState,
  type PanelPosition,
  type PanelSize
} from './floating-panel';

const props = withDefaults(
  defineProps<{
    i18n: PluginI18n;
    localeTick?: number;
    disabled?: boolean;
    /** 逐条禁用的节点种类与悬停提示（绑定引擎不支持的节点），原样转手给内部 StencilPanel。 */
    disabledKeys?: NodeKind[];
    disabledHint?: string;
    /** 拖拽预览图的内容来源，原样转手给内部 StencilPanel（本外壳不消费，语义见其同名 prop 注释）。 */
    resolveDragPreview?: (key: NodeKind) => { label: string; summary?: string; scale?: number } | undefined;
  }>(),
  { disabled: false, disabledKeys: () => [], disabledHint: '', resolveDragPreview: undefined }
);

const emit = defineEmits<{ (e: 'dblclick-item', key: NodeKind): void }>();

function onItemDblClick(key: NodeKind): void {
  emit('dblclick-item', key);
}

// ── 本地记忆：位置 + 收起态一起落盘。真正的 localStorage 读写（含 STORAGE_KEY/try-catch）放在
// floating-panel.ts 的 readPersistedStencilPanelState()/writePersistedStencilPanelState() 共用——DesignerRoot.vue"首次打开绕开浮动面板"（见其
// computeStencilAvoidZone 消费处）需要读到与本组件挂载时完全同一份状态，不能两处各自维护一份
// 读取逻辑（见该函数头注释）。

const initial = readPersistedStencilPanelState();
const position = ref<PanelPosition>(initial.position);
const collapsed = ref(initial.collapsed);

function persist(): void {
  writePersistedStencilPanelState({ position: { ...position.value }, collapsed: collapsed.value });
}

// ── 容器尺寸测量：容器是本组件根元素的父节点（DesignerRoot.vue 的 .wf-designer-canvas-wrap，
// position:relative，与 DesignerCanvas 同级）——用 ResizeObserver 持续观察，画布区域随窗口缩放/
// 折叠右侧属性面板变化时都能重新夹回，不是只在挂载时算一次。
const rootRef = shallowRef<HTMLElement | null>(null);
const containerSize = ref({ width: 0, height: 0 });
let resizeObserver: ResizeObserver | undefined;

function measureContainer(): void {
  const container = rootRef.value?.parentElement;
  if (!container) return;
  containerSize.value = { width: container.clientWidth, height: container.clientHeight };
}

/** 展开态主体（StencilPanel 本体，不含标题栏）的可用高度，超出时内部滚动（面板高度不得
 * 超过画布可用高度）——随面板 y 坐标与容器高度实时变化，不是挂载时定死的常量。这份"主体高度
 * 上限"公式只用于给 .workflow-stencil-floating__body 设 CSS max-height（约束主体最多能长多高），
 * 不再用于夹回边界——见下方 measuredSize 头注释。 */
const bodyMaxHeight = computed(() => computeStencilPanelBodyMaxHeight(containerSize.value.height, position.value.y));

/**
 * measuredSize —— 面板根元素（rootRef）当前**实测**的渲染宽高，供夹回（clampPanelPosition）
 * 使用。
 *
 * 🔴 不能用"主体最大高度"公式（computeStencilPanelBodyMaxHeight，即上方 bodyMaxHeight）夹回：
 * 它只是 StencilPanel 本体一层的高度上限，没有把标题栏（32px）与面板自身的上下边框（2px）算进去，
 * 面板拖到画布角落时夹回边界比真实渲染的整块矮一截，会溢出定位容器 5～13px。所以不靠公式拼凑
 * 面板总高度，而是直接测量根元素 getBoundingClientRect()
 * （展开/收起两态、以及容器高度或内容变化导致的高度浮动都会被 ResizeObserver 捕捉到，见下方
 * onMounted/measurePanel 消费处），夹回永远针对"这一刻真实会占多大"。
 *
 * 初值用一个"展开态、主体贴最小高度"的保守估计兜底（比真实值通常偏小没关系——onMounted 里
 * measurePanel() 会在任何一次真正的 reclamp() 之前同步跑一遍，把它立刻覆盖成真实值，这个初值
 * 只是"还没测过"那一瞬间的占位，从未真正参与过一次视觉可见的夹回）。 */
const measuredSize = ref<PanelSize>({ width: STENCIL_PANEL_WIDTH, height: STENCIL_PANEL_ICON_SIZE });
let panelResizeObserver: ResizeObserver | undefined;

/** 重新测量面板根元素的真实渲染尺寸——挂载时、以及后续任何可能改变面板渲染高度的时机（收起/
 * 展开切换、容器尺寸变化导致的主体高度上限变化）都要在 reclamp() 之前调用一次，保证 reclamp()
 * 拿到的永远是"当下"的真实尺寸，不是上一次渲染前的旧值。测不出（尺寸为 0，如还未布局完成）时
 * 保留上一次的有效测量值，不用 0 去污染夹回边界。 */
function measurePanel(): void {
  const el = rootRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) measuredSize.value = { width: rect.width, height: rect.height };
}

function reclamp(): void {
  position.value = clampPanelPosition(position.value, measuredSize.value, containerSize.value);
}

onMounted(() => {
  measureContainer();
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
  // 面板自身尺寸变化（展开态因容器变矮而收缩主体高度、或未来内容变化）：观察 rootRef 本身，
  // 与上面观察定位容器（外部尺寸变化）是两件独立的事——一个测"面板此刻有多大"，一个测"能摆的
  // 空间有多大"，二者都要各自实时更新才能算对夹回边界。
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

// 收起/展开切换会立刻改变面板渲染尺寸（图标 36×36 ↔ 展开整块），切换后立刻重新测量 + 夹回一次，
// 避免"收起态贴在容器右下角、展开后面板主体探出容器外"这种瞬间越界——不等 ResizeObserver 的
// 异步回调，nextTick 后 DOM 已经是切换后的新形态，可以立刻同步测量。
watch(collapsed, () => {
  void nextTick(() => {
    measurePanel();
    reclamp();
  });
});

// ── 拖动：pointer 事件 + setPointerCapture，标题栏（或收起态图标本身）才是拖动把手，条目区域
// 不接手（StencilPanel.vue 内部条目拖拽走的是原生 HTML5 DnD，两套拖拽互不相关，不能和
// 条目自身的 HTML5 拖拽打架）。同一份 begin/update/end 逻辑同时服务展开态标题栏与收起态图标：
// 松手时按累计位移是否超过阈值（isDragGesture）区分"这是一次拖动"还是"这是一次点击"——收起态
// 图标需要用这个判据决定要不要展开，标题栏则不需要额外动作（标题栏本身没有"点击展开"语义）。
const dragging = ref(false);
let dragPointerId: number | null = null;
let dragStartClientX = 0;
let dragStartClientY = 0;
let dragStartPosition: PanelPosition = { x: 0, y: 0 };
let dragMaxDelta = 0;
/** mousedown→mouseup 之后浏览器还会补发一次原生 click，若这次松手判定为"拖动"，标记跳过紧随其后
 * 的那次 click，避免收起图标"拖完一放手又顺带触发了一次展开"。键盘 Enter/Space 触发的 click 不
 * 经过 pointerdown，不会被这个标记误伤。 */
let suppressNextClick = false;

function beginDrag(event: PointerEvent): void {
  if (dragPointerId !== null) return; // 已有一次拖动在进行，忽略新指针（多指针兜底）
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
</script>

<template>
  <div
    ref="rootRef"
    class="workflow-stencil-floating"
    data-testid="workflow-stencil-floating"
    :class="{ 'is-dragging': dragging }"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
  >
    <!-- 收起态：整块变成一个可拖动、可点击展开的小图标按钮，真正的 <button> 保证键盘可达
         （Tab 可聚焦、Enter/Space 可触发、:focus-visible 有可见焦点态）。图标本身用节点库语义的
         "网格块"图案（呼应节点库条目的色块图标），不是通用箭头/加号，一眼能认出"这是收起的节点
         库"。 -->
    <button
      v-if="collapsed"
      type="button"
      class="workflow-stencil-floating__icon"
      data-testid="workflow-stencil-icon"
      :aria-label="i18n.t('workflow.designer.stencil.floating.expand')"
      :title="i18n.t('workflow.designer.stencil.floating.expand')"
      @pointerdown="beginDrag"
      @pointermove="updateDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @click="onIconClick"
    >
      <svg viewBox="0 0 16 16" class="workflow-stencil-floating__icon-svg" aria-hidden="true">
        <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
        <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
        <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
        <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
      </svg>
    </button>

    <!-- 展开态：标题栏（拖动把手 + 收起按钮）+ 主体（StencilPanel 本体，超出可用高度时内部
         滚动）。标题栏用 div 而非 button——它不是一个"点一下触发动作"的控件，是拖动手柄，
         真正需要键盘可达的收起按钮单独是一个 <button>。 -->
    <div v-else class="workflow-stencil-floating__panel">
      <div
        class="workflow-stencil-floating__handle"
        data-testid="workflow-stencil-drag-handle"
        :title="i18n.t('workflow.designer.stencil.floating.dragHandle')"
        @pointerdown="beginDrag"
        @pointermove="updateDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <span class="workflow-stencil-floating__handle-grip" aria-hidden="true">⠿</span>
        <strong class="workflow-stencil-floating__handle-title">{{ i18n.t('workflow.designer.stencil.title') }}</strong>
        <button
          type="button"
          class="workflow-stencil-floating__collapse"
          data-testid="workflow-stencil-collapse"
          :aria-label="i18n.t('workflow.designer.stencil.floating.collapse')"
          :title="i18n.t('workflow.designer.stencil.floating.collapse')"
          @pointerdown.stop
          @click="collapseFromHandle"
        >‹</button>
      </div>
      <div class="workflow-stencil-floating__body" :style="{ maxHeight: `${bodyMaxHeight}px` }">
        <!-- 外壳标题栏（上方 __handle）已经显示"节点库"标题，StencilPanel 自己内部还有一份
             标题——hide-title 隐掉内层那份，避免同一面板两行"节点"标题叠在一起。StencilPanel 单独使用（若有其它挂载点）不受影响，见其
             hideTitle prop 注释。 -->
        <StencilPanel
          :i18n="i18n"
          :locale-tick="localeTick"
          :disabled="disabled"
          :disabled-keys="disabledKeys"
          :disabled-hint="disabledHint"
          :resolve-drag-preview="resolveDragPreview"
          hide-title
          @dblclick-item="onItemDblClick"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 浮动定位容器：绝对定位在 DesignerRoot.vue 的 .wf-designer-canvas-wrap 内（该容器
   position:relative，与 DesignerCanvas 同级），z-index 高于画布内部浮层（小地图 20/悬停气泡
   30），保证被拖到画布任意位置时都盖在画布内容与其余浮层之上，不会被半途吞掉。本元素自身不带
   边框/背景——那两层视觉分别由 __panel（展开态）与 __icon（收起态）各自的根节点提供，避免出现
   "外层一圈、内层又一圈"的双重描边。 */
.workflow-stencil-floating {
  position: absolute;
  z-index: 30;
}
/* 拖动过程中关掉过渡：实时跟手，不产生拖拽时的橡皮筋延迟感；松手后（is-dragging 类移除）恢复
   过渡，收起/展开、容器变化触发的重新夹回才有平滑动画。尊重"减少动态效果"系统偏好：该偏好下
   完全不设过渡，不是"变快"而是"没有"。 */
@media (prefers-reduced-motion: no-preference) {
  .workflow-stencil-floating:not(.is-dragging) {
    transition: left 0.12s ease, top 0.12s ease;
  }
}
.workflow-stencil-floating__panel {
  display: flex;
  flex-direction: column;
  width: 248px;
  overflow: hidden;
  /* 层次：边框/圆角/不透明底色 + 阴影，
     两套主题都要成立——全部走宿主 CSS 变量，不是写死的亮色值（同文件既有其他浮层token 用法）。 */
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 8px;
  background: rgb(var(--container-bg-color, 255 255 255));
  box-shadow: 0 6px 20px rgb(var(--shadow-color, 16 24 40) / 18%);
}
.workflow-stencil-floating__handle {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237));
  background: rgb(var(--fill-lighter-color, 250 250 250));
  cursor: grab;
  /* touch-action:none——触屏拖动标题栏时不要被浏览器当成页面滚动手势；user-select:none 避免
     拖动时不小心选中标题文字。 */
  touch-action: none;
  user-select: none;
}
.workflow-stencil-floating__handle:active { cursor: grabbing; }
.workflow-stencil-floating__handle-grip { color: rgb(var(--text-hint-color, 153 153 153)); font-size: 12px; line-height: 1; }
.workflow-stencil-floating__handle-title { flex: 1; overflow: hidden; color: rgb(var(--base-text-color, 31 31 31)); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.workflow-stencil-floating__collapse {
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
  font-size: 13px;
  cursor: pointer;
}
.workflow-stencil-floating__collapse:hover { background: rgb(var(--fill-color, 240 242 245)); }
/* 可达性：收起/展开按钮是真正的 <button>，可聚焦、有可见焦点态。 */
.workflow-stencil-floating__collapse:focus-visible,
.workflow-stencil-floating__icon:focus-visible {
  outline: 2px solid rgb(var(--primary-color, 100 108 255));
  outline-offset: 1px;
}
.workflow-stencil-floating__body {
  flex: 1;
  min-height: 0;
  /* 面板高度不得超过画布可用高度：本层是唯一的滚动边界（overflow-y:auto + JS 算出的
     max-height，见 bodyMaxHeight 注释），StencilPanel.vue 内部保持原样不需要另起一层滚动。 */
  overflow-x: hidden;
  overflow-y: auto;
}
/* 收起态图标：同展开态一样的边框+阴影+不透明底色层次，尺寸固定 36×36（STENCIL_PANEL_ICON_SIZE）。 */
.workflow-stencil-floating__icon {
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
.workflow-stencil-floating__icon:hover { background: rgb(var(--fill-color, 240 242 245)); }
.workflow-stencil-floating__icon:active { cursor: grabbing; }
.workflow-stencil-floating__icon-svg { width: 18px; height: 18px; fill: rgb(var(--text-secondary-color, 102 102 102)); }
</style>
