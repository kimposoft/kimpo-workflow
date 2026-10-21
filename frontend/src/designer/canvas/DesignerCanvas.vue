<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { DesignLayout } from '../../model';
import type { GraphEdgeView, GraphNodeView } from '../../graph';
import { X6GraphAdapter, nodeDimensions } from '../../graph/x6-adapter';
import { DESIGNER_HOST_KEY } from '../host';
import type { StencilItem } from '../stencil';
import { computeStencilDropPosition } from '../stencil-drop-placement';
// 小地图可收起成 28px 胶囊，收起状态本地记忆：composable 内部是模块级单例（见
// minimap-collapse.ts 头注释"一处状态两处入口"），DesignerRoot.vue 工具条"🗺 小地图"按钮
// 与本组件的画布内嵌折叠胶囊各自调用一次，拿到同一份响应式状态，天然联动。
import { useMinimapCollapsed } from './minimap-collapse';
// 画布标尺（常驻）：挂载在画布容器内，见其头注释；数据源是下方 adapter.getViewport()/
// onViewportChange()。
import CanvasRulers from './CanvasRulers.vue';
// 画布暗色模式：随宿主主题自动更新的调色板，见其头注释。本组件只负责"挂载后设置一次 + 变化时
// 重设"两处接线，具体重绘手法（drawBackground/drawGrid + 重新 apply 已渲染 cell）全在 X6GraphAdapter.setPalette() 里。
import { useCanvasPalette } from './use-canvas-palette';
// 首次打开设计器：把发起节点锚到画布容器左中，见本文件 applyInitialAnchor() 消费处与该函数
// 的纯几何计算；computeMinimalPanToReveal：双击节点库新增节点后若落在可视区外，把视口平移到
// 刚好完整可见（见 revealRect 消费处）。
import { computeInitialAnchorTranslate, computeMinimalPanToReveal } from './viewport';

const props = withDefaults(
  defineProps<{
    nodes: GraphNodeView[];
    edges: GraphEdgeView[];
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    layout?: DesignLayout;
    i18n: PluginI18n;
    localeTick?: number;
    readOnly?: boolean;
    /** 首次打开定位"绕开浮动节点库面板"用的估算回调：入参是画布本体
     * 当时的近似定位容器尺寸（见 applyInitialAnchor() 消费处的坐标换算注释），返回面板此刻的
     * 估算占位，或 null（不需要绕开，如面板已收起）。画布本身不认识"节点库面板"这个业务概念
     * （designer/canvas/** 不 import stencil/** 模块），只认识这个泛型回调形状——具体怎么算全部
     * 由 DesignerRoot.vue 提供（该文件才认识 stencil/floating-panel.ts）。不传时不绕开
     * （纯 30%/50% 规则）。 */
    stencilAvoidZone?: (wrapSize: { width: number; height: number }) => { right: number; top: number; bottom: number } | null;
  }>(),
  { readOnly: false }
);

const emit = defineEmits<{
  (e: 'selection-change', nodeIds: string[], edgeIds: string[]): void;
  (e: 'node-move-end', nodeId: string, position: { x: number; y: number }): void;
  (e: 'nodes-move-end', moves: Array<{ nodeId: string; position: { x: number; y: number } }>): void;
  (e: 'connect', fromNodeId: string, toNodeId: string): void;
  (e: 'delete-selection'): void;
  (e: 'undo'): void;
  (e: 'redo'): void;
  (e: 'save'): void;
  (e: 'paste', nodeIds: string[]): void;
  (e: 'rename-node', nodeId: string, name: string): void;
  (e: 'stencil-drop', key: StencilItem['key'], position: { x: number; y: number }, edgeId?: string): void;
  (e: 'layout-change'): void;
  /** 缩放百分比变化推送（工具栏用它显示当前缩放，避免工具栏自己再轮询一遍）：
   * zoomPercent 已由下方 120ms 定时器/各 zoom* 方法维持，这里只是多加一条 watch 把它的变化
   * 广播出去，不新增第二份状态。 */
  (e: 'zoom-change', percent: number): void;
}>();

/** 画布本体让出左上 20px（CanvasRulers.vue 导出的 RULER_SIZE，见其头注释；本文件 <style>
 * .workflow-canvas 的 `inset: 20px 0 0 20px` 就是这个数值的落地处）——本地复刻一份数值用于
 * applyInitialAnchor()/revealRect() 的 wrap↔画布坐标换算，不直接 import CanvasRulers.vue（那是
 * 一个 Vue 组件文件，仅为复用一个几何数字引入组件依赖没有必要；同 stencil/floating-panel.ts
 * CANVAS_RULER_SIZE 既定的"两处数值如需变动需人工同步"处理，理由相同）。 */
const CANVAS_RULER_SIZE = 20;

const containerRef = ref<HTMLElement | null>(null);
const minimapRef = ref<HTMLElement | null>(null);
// 悬停条件气泡 etip 的定位基准——气泡是 containerRef 的兄弟节点（不能挂在
// containerRef 内部：X6 直接接管该 div 的 DOM 子树，Vue 管理的兄弟元素混进去会被 X6 的渲染
// 覆盖/冲突），坐标换算需要一个与 containerRef 同级、包住两者的容器边界，shellRef 正是这个
// 外层 <section>（见下方模板 ref="shellRef"）。
const shellRef = ref<HTMLElement | null>(null);
const zoomPercent = ref(100);
let adapter: X6GraphAdapter | null = null;
let zoomTimer: ReturnType<typeof setInterval> | undefined;
const unsubscribers: Array<() => void> = [];
const zoomLabel = computed(() => `${zoomPercent.value}%`);
/** 画布标尺的数据源——adapter.getViewport() 的镜像，onViewportChange 回调时
 * 重新读一次。初值取 mount() 之前 X6GraphAdapter 尚未挂载时的缺省视口（scale 1、原点 0），
 * onMounted 里 mount() 完成后立刻同步一次真实初值。 */
const viewport = ref<{ scaleX: number; tx: number; ty: number }>({ scaleX: 1, tx: 0, ty: 0 });

/** 悬停条件气泡 etip 展示态：x/y 是相对 shellRef 左上角的局部坐标（珠子横向中点/顶部边缘，
 * 见 x6-adapter.ts mount() 里 onEdgeLabelRendered 的算法注释"跟随珠子定位"）。 */
const edgeTip = ref<{ visible: boolean; x: number; y: number; text: string }>({ visible: false, x: 0, y: 0, text: '' });
/** 悬停出现的 300ms 计时器——这份可编程延迟是用自绘浮层而不用浏览器原生 `<title>` 的原因
 * （原生 title 的出现延迟由浏览器控制、不可编程，见 port.ts EdgeConditionMarker.tooltip 注释）。 */
let edgeTipTimer: ReturnType<typeof setTimeout> | undefined;

/** 悬停珠子：进入时先清掉上一次可能还没触发的计时器（避免连续快速划过多个珠子时残留多个
 * pending 定时器、稍后一起触发出多个气泡），300ms 后再真正显示——期间若鼠标移出（onEdgeMarkerLeave）
 * 会把这个计时器取消掉，气泡不会出现。 */
function onEdgeMarkerHover(_edgeId: string, clientX: number, clientY: number, text: string): void {
  if (edgeTipTimer) clearTimeout(edgeTipTimer);
  if (!text) return;
  edgeTipTimer = setTimeout(() => {
    edgeTipTimer = undefined;
    const bounds = shellRef.value?.getBoundingClientRect();
    edgeTip.value = { visible: true, x: clientX - (bounds?.left ?? 0), y: clientY - (bounds?.top ?? 0), text };
  }, 300);
}

/** 离开珠子：还没到 300ms 就清掉待出现的计时器（不出现，同其余"划过但没停留"的悬停交互约定）；
 * 已经出现的气泡立即隐藏（不做淡出延迟，同点击/悬停类浮层组件的既有约定）。 */
function onEdgeMarkerLeave(): void {
  if (edgeTipTimer) {
    clearTimeout(edgeTipTimer);
    edgeTipTimer = undefined;
  }
  if (edgeTip.value.visible) edgeTip.value = { ...edgeTip.value, visible: false };
}
// 小地图收起态 + 本地记忆，见 minimap-collapse.ts 头注释（不复用 usePanelSectionOpen，
// 那是按节点类型记忆面板小节的折叠态，与本状态的记忆维度不同）。
const { collapsed: minimapCollapsed, toggle: toggleMinimapCollapsed } = useMinimapCollapsed();
// 画布暗色模式：当前主题下的画布调色板，随宿主 documentElement 主题变化自动
// 更新（见 use-canvas-palette.ts）。下方 onMounted 里挂载完成后先手动 setPalette 一次（首帧就
// 要是正确的主题色，不能等 watch 的下一次变化才补），watch 负责之后每次主题切换。
const { palette } = useCanvasPalette();

// 宿主门面（可选注入）：沙盒 / 单测里没有设计器根组件时为 undefined，此时重命名不可用。
const designerHost = inject(DESIGNER_HOST_KEY, undefined);

/** 节点重命名输入：经宿主输入框服务取新名称，替代原生 window.prompt；
 * 取不到服务（无宿主 / 未挂载 ui 总线）时视为取消，不回退原生弹框。 */
async function promptRename(current: string): Promise<string | null> {
  const ui = designerHost?.ui;
  if (!ui) return null;
  const { confirmed, value } = await ui.openPrompt({
    title: props.i18n.t('workflow.designer.canvas.renamePrompt'),
    label: props.i18n.t('workflow.designer.canvas.renamePrompt'),
    defaultValue: current,
    required: true
  });
  return confirmed ? value : null;
}

function graphMessages() {
  void props.localeTick;
  return {
    renamePrompt: props.i18n.t('workflow.designer.canvas.renamePrompt'),
    rename: props.i18n.t('workflow.designer.canvas.menu.rename'),
    copy: props.i18n.t('workflow.designer.canvas.menu.copy'),
    delete: props.i18n.t('workflow.designer.canvas.menu.delete'),
    editVertices: props.i18n.t('workflow.designer.canvas.menu.editVertices'),
    clearVertices: props.i18n.t('workflow.designer.canvas.menu.clearVertices'),
    deleteEdge: props.i18n.t('workflow.designer.canvas.menu.deleteEdge'),
    paste: props.i18n.t('workflow.designer.canvas.menu.paste'),
    fit: props.i18n.t('workflow.designer.canvas.fit'),
    zoom100: props.i18n.t('workflow.designer.canvas.zoom100')
  };
}

onMounted(() => {
  if (!containerRef.value || !minimapRef.value) return;
  adapter = new X6GraphAdapter(graphMessages(), { promptRename });
  adapter.setMinimapContainer(minimapRef.value);
  adapter.mount(containerRef.value);
  // 画布暗色模式：挂载后立即按当前主题设一次 palette（mount() 内部只在 Graph
  // 构造那一刻用 X6GraphAdapter 默认的 LIGHT_PALETTE 画了一次底色/网格，这里补上真实当前主题）。
  adapter.setPalette(palette.value);
  unsubscribers.push(
    adapter.on('selectionChange', (nodes, edges) => emit('selection-change', nodes, edges)),
    adapter.on('nodeMoveEnd', (id, position) => emit('node-move-end', id, position)),
    adapter.on('nodesMoveEnd', (moves) => emit('nodes-move-end', moves)),
    adapter.on('connect', (from, to) => emit('connect', from, to)),
    adapter.on('deleteSelection', () => emit('delete-selection')),
    adapter.on('undo', () => emit('undo')),
    adapter.on('redo', () => emit('redo')),
    adapter.on('save', () => emit('save')),
    adapter.on('paste', (ids) => emit('paste', ids)),
    adapter.on('renameNode', (id, name) => emit('rename-node', id, name)),
    adapter.on('layoutChange', () => emit('layout-change')),
    // 悬停条件气泡 etip：适配器只上报"进入/离开珠子"这一事实，300ms 延迟与浮层渲染
    // 全在本组件（见 edgeTip/edgeTipTimer 与上方 onEdgeMarkerHover/onEdgeMarkerLeave）。
    adapter.on('edgeMarkerHover', (edgeId, clientX, clientY, text) => onEdgeMarkerHover(edgeId, clientX, clientY, text)),
    adapter.on('edgeMarkerLeave', () => onEdgeMarkerLeave()),
    // 画布标尺：adapter.onViewportChange 不是 GraphPortEvents 的一员（画布专属
    // 能力，同 zoom/grid/snap 等既定分工），直接调用具体 X6GraphAdapter 实例的方法，返回值同样是
    // 标准的取消订阅函数，并入同一个 unsubscribers 数组统一在 onBeforeUnmount 里清理。
    adapter.onViewportChange(() => {
      if (adapter) viewport.value = adapter.getViewport();
    })
  );
  viewport.value = adapter.getViewport(); // mount() 完成后立刻同步一次真实初值
  sync();
  adapter.setLayout(props.layout);
  // 首次打开设计器：把发起节点锚到画布左中（见 applyInitialAnchor 头注释）。必须排在
  // sync()/setLayout() 之后——前者建好节点 cell 才有中心点可取，后者先还原节点坐标；传入的
  // 布局若带视口则本函数跳过（见其函数头注释），否则"每次打开都落在左中"对所有流程一致生效。
  // 落地视口用的是 adapter.setLayout()，会触发上面已经订阅的 onViewportChange（标尺联动），不需要在这里再手动同步一次 viewport.value。
  applyInitialAnchor();
  zoomTimer = setInterval(() => {
    if (adapter) zoomPercent.value = adapter.getZoomPercent();
  }, 120);
});

onBeforeUnmount(() => {
  if (zoomTimer) clearInterval(zoomTimer);
  if (edgeTipTimer) clearTimeout(edgeTipTimer); // 卸载时若还有待出现的气泡计时器，一并清掉
  unsubscribers.splice(0).forEach((off) => off());
  adapter?.unmount();
  adapter = null;
});

/**
 * applyInitialAnchor —— 设计器首次打开：把发起节点（固定 id 'start'，见 model/defaults.ts
 * createDefaultStartNode）锚到画布容器"水平约 30%（不小于 300px，给浮动节点库面板留白）、
 * 垂直居中"的位置，让新建流程打开时发起节点落在中间偏左的区域。
 *
 * 只在 onMounted 里调用一次（不在 sync() 里，不随 props 变化重跑）——之后用户平移/缩放、
 * 增删节点、自动布局、工具条"适应画布"都不再被本函数打断（只在每次打开的首帧
 * 做一次）；对所有流程一致生效（不止新建的），因此排在 adapter.setLayout(props.layout)
 * 之后。目前文档不持久化视口（layoutFromDocument 只还原节点坐标与连线折点），所以实际效果是
 * "每次打开都落在左中"；若将来传入的布局带了视口，则以它为准、本函数直接跳过。
 *
 * 只设置视口：借道 adapter.setLayout({ viewport }) 这条既有通道——与"恢复已保存视口"走
 * 同一份实现（见 x6-adapter.ts setLayout() 的 restoringLayout 门槛），因此不会触发
 * layoutChange 事件、不会把画布置脏、不进撤销栈，也不改写 WorkflowDocument 本身（发起节点
 * 的文档坐标含义不变）。
 *
 * 找不到发起节点（getNodeCenter 返回 null，理论不应发生：'start' 节点由 model/defaults.ts
 * 保证恒存在，此处防御性兜底）或容器尺寸尚未就绪（getContainerSize 返回 null/无效尺寸）时
 * 静默跳过，保留 mount()/setLayout() 已经落地的既有视口。
 *
 * 绕开浮动节点库面板：面板默认展开时会压住 30%/300px 规则算出的发起节点位置。
 * props.stencilAvoidZone 回调返回的估算占位是"面板定位容器"
 * （DesignerRoot.vue 的 .wf-designer-canvas-wrap）坐标系，与本函数其余计算使用的"画布本体"
 * （adapter.getContainerSize() 对应的 .workflow-canvas，比 wrap 左/上各少 CANVAS_RULER_SIZE
 * 20px，见画布标尺 CanvasRulers.vue RULER_SIZE 与本文件 <style> .workflow-canvas 的 inset
 * 声明）不是同一套坐标系，需要两次换算：入参把画布尺寸加回 20px 近似 wrap 尺寸，回传结果再减回
 * 20px 落回画布本体坐标。
 */
function applyInitialAnchor(): void {
  if (!adapter) return;
  // 传入的布局若带视口（目前文档不持久化视口，layoutFromDocument 不产出该字段；留给将来
  // 加视口记忆时用），以它为准，不再用锚定覆盖设计者上次的视图。
  if (props.layout?.viewport) return;
  const center = adapter.getNodeCenter('start');
  if (!center) return;
  const anchorSize = adapter.getNodeSize('start');
  if (!anchorSize) return;
  const containerSize = adapter.getContainerSize();
  if (!containerSize) return;
  const wrapSize = { width: containerSize.width + CANVAS_RULER_SIZE, height: containerSize.height + CANVAS_RULER_SIZE };
  const zoneInWrapCoords = props.stencilAvoidZone?.(wrapSize) ?? null;
  const avoidZone = zoneInWrapCoords
    ? {
        right: zoneInWrapCoords.right - CANVAS_RULER_SIZE,
        top: zoneInWrapCoords.top - CANVAS_RULER_SIZE,
        bottom: zoneInWrapCoords.bottom - CANVAS_RULER_SIZE
      }
    : null;
  const result = computeInitialAnchorTranslate(center, containerSize, { anchorSize, avoidZone });
  if (!result) return;
  adapter.setLayout({ viewport: { scale: result.scale, x: result.tx, y: result.ty } });
}

function sync(): void {
  if (!adapter) return;
  adapter.setNodes(props.nodes);
  adapter.setEdges(props.edges);
  adapter.setSelection(props.selectedNodeIds, props.selectedEdgeIds);
  adapter.setReadOnly(props.readOnly);
}

watch(
  () => [props.nodes, props.edges, props.selectedNodeIds, props.selectedEdgeIds, props.readOnly],
  sync,
  { deep: true }
);

watch(
  () => props.localeTick,
  () => adapter?.setMessages(graphMessages())
);

watch(
  () => props.layout,
  async (layout) => {
    // loadDefinition 会在同一 tick 内替换 store 与 layout；等节点/边 watcher 完成后再恢复拐点。
    await nextTick();
    adapter?.setLayout(layout);
  }
);

// 画布暗色模式：宿主主题切换（palette 引用变化，见 use-canvas-palette.ts 的
// MutationObserver）时就地重绘——不重建画布、不丢选中态与视口，见 X6GraphAdapter.setPalette()
// 注释。onMounted 里已经手动设过一次初值，这里只负责"之后每次变化"。
watch(palette, (next) => adapter?.setPalette(next));

// 缩放百分比推送（见上方 defineEmits 'zoom-change' 注释）：zoomPercent 已经由上方 120ms
// 定时器 + 各 zoom* 方法维持为"当前真实缩放比"，这里只是把它的变化广播给外部工具栏，不新增
// 第二份状态、不改变 zoomPercent 本身的刷新节奏。
watch(zoomPercent, (percent) => emit('zoom-change', percent));

defineExpose({
  getLayout: (): DesignLayout => adapter?.getLayout() ?? {},
  // 缩放/网格/吸附由顶部工具条统一操作，这些能力经 expose 交给 DesignerRoot 驱动；
  // 画布自身不渲染浮动按钮。
  zoomIn: () => { adapter?.zoomIn(); updateZoom(); },
  zoomOut: () => { adapter?.zoomOut(); updateZoom(); },
  zoomTo100: () => { adapter?.zoomTo100(); updateZoom(); },
  zoomToFit: () => { adapter?.zoomToFit(); updateZoom(); },
  // 状态栏缩放滑杆："设为指定缩放比"——zoomIn/zoomOut/zoomTo100 是几个固定档位，滑杆需要
  // 任意值。缩放/网格/吸附这类画布专属能力不进 graph/port.ts（那是 svg/x6 双实现的最小
  // 接口，见 GraphPort 头注释），
  // 只在 X6GraphAdapter 本体 + 本处 expose + DesignerRoot 手写类型标注三处同步。
  zoomToPercent: (percent: number) => { adapter?.zoomToPercent(percent); updateZoom(); },
  getZoomPercent: () => zoomPercent.value,
  // 校验面板"点击定位"：把画布平移到给定节点/边的中心，见 x6-adapter.ts centerOn 注释。
  // 同样只是"画布专属能力"，不进 GraphPort（沿用上面缩放滑杆同一条既定约定）。
  centerOn: (id: string) => adapter?.centerOn(id),
  setGridVisible: (v: boolean) => adapter?.setGridVisible(v),
  isGridVisible: () => adapter?.isGridVisible() ?? false,
  // 🔴 三开关拆分：吸附/参考线不共用同一个 Snapline 开关，各自独立
  // 转发到 X6GraphAdapter 对应方法，见其头注释。
  setSnapToGrid: (v: boolean) => adapter?.setSnapToGrid(v),
  isSnapToGridEnabled: () => adapter?.isSnapToGridEnabled() ?? false,
  setSnaplineEnabled: (v: boolean) => adapter?.setSnaplineEnabled(v),
  isSnaplineEnabled: () => adapter?.isSnaplineEnabled() ?? false,
  // 对齐/分布图标按钮（对齐六档、分布分水平/垂直）：同样是"画布专属能力"，
  // 不进 GraphPort，参数原样透传给 X6GraphAdapter（六档语义与轴的对应关系见其头注释）。
  alignSelection: (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => adapter?.alignSelection(mode),
  distributeSelection: (mode: 'horizontal' | 'vertical') => adapter?.distributeSelection(mode),
  /**
   * revealRect —— 双击节点库新增节点后，若新节点包围盒没有完整落在当前可视区内，把视口平移到
   * 刚好让它完整可见（只平移不缩放，见 viewport.ts
   * computeMinimalPanToReveal() 头注释）；rect 用文档/模型坐标（与 GraphNodeView.position 同
   * 一套单位），不依赖该节点此刻是否已经真的渲染成 X6 cell——纯粹是"当前视口 + 容器尺寸 + 目标
   * 矩形"的几何换算，因此不像 centerOn() 那样需要先等 sync() watcher 把新节点画出来才能调用
   * （调用方不需要包一层 nextTick）。已经完整可见时静默不产生任何视口改动。
   */
  revealRect: (rect: { x: number; y: number; width: number; height: number }) => {
    if (!adapter) return;
    const containerSize = adapter.getContainerSize();
    if (!containerSize) return;
    const current = adapter.getViewport();
    const bounds = { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height };
    const result = computeMinimalPanToReveal(bounds, { scale: current.scaleX, tx: current.tx, ty: current.ty }, containerSize);
    if (!result) return;
    adapter.setLayout({ viewport: { scale: result.scale, x: result.tx, y: result.ty } });
  }
});

function allowDrop(event: DragEvent): void {
  if (!props.readOnly && event.dataTransfer?.types.includes('application/x-kimpo-workflow-stencil')) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }
}

function onDrop(event: DragEvent): void {
  if (!adapter || props.readOnly) return;
  const key = event.dataTransfer?.getData('application/x-kimpo-workflow-stencil') as StencilItem['key'] | '';
  if (!key) return;
  event.preventDefault();
  // 节点中心对准指针（position 是左上角，需减去半个节点尺寸，见 computeStencilDropPosition 头注释）。
  const position = computeStencilDropPosition(adapter.clientToLocal(event.clientX, event.clientY), nodeDimensions(key));
  // StencilItem['key'] 就是 NodeKind 本身，没有需要落到边上的结构模板键，第四个参数（锚点边 id）
  // 因此恒为 undefined。
  emit('stencil-drop', key, position, undefined);
}

function updateZoom(): void {
  zoomPercent.value = adapter?.getZoomPercent() ?? 100;
}
</script>

<template>
  <section ref="shellRef" class="workflow-canvas-shell" data-testid="designer-canvas">
    <div ref="containerRef" class="workflow-canvas" @dragover="allowDrop" @drop="onDrop"></div>
    <!-- 画布标尺（常驻无开关）：挂在 shellRef 内、.workflow-canvas 之后——画布区
         本身已经用 CSS inset 让出左上 20px（见下方 .workflow-canvas 样式），标尺不与画布内容
         重叠；小地图/etip 两个既有浮层的定位基准是 shellRef 本身（同级绝对定位，不受画布区域
         让出 20px 影响）。 -->
    <CanvasRulers :scale-x="viewport.scaleX" :tx="viewport.tx" :ty="viewport.ty" />
    <!-- 小地图收起为 28px 胶囊——外层 shell 只用 CSS 控制展示尺寸，minimapRef 这个
         div 全程保持挂载（X6 MiniMap 插件用构造期传入的固定 190×120 渲染内部 SVG，不依赖容器
         实时尺寸，见 minimap-collapse.ts 头注释同款考量），收起时靠 overflow:hidden 裁掉，
         避免收起/展开之间要求 MiniMap 插件重新测算尺寸。 -->
    <div class="workflow-minimap-shell" :class="{ 'is-collapsed': minimapCollapsed }" data-testid="workflow-minimap-shell">
      <button
        type="button"
        class="workflow-minimap-toggle"
        data-testid="workflow-minimap-toggle"
        :title="minimapCollapsed ? i18n.t('workflow.designer.canvas.minimapExpand') : i18n.t('workflow.designer.canvas.minimapCollapse')"
        :aria-label="minimapCollapsed ? i18n.t('workflow.designer.canvas.minimapExpand') : i18n.t('workflow.designer.canvas.minimapCollapse')"
        @click="toggleMinimapCollapsed"
      >
        <span v-if="minimapCollapsed" class="workflow-minimap-toggle__label">{{ i18n.t('workflow.designer.canvas.minimapLabel') }}</span>
        <span class="workflow-minimap-toggle__chevron">{{ minimapCollapsed ? '⌃' : '⌄' }}</span>
      </button>
      <div ref="minimapRef" class="workflow-minimap" data-testid="workflow-minimap"></div>
    </div>
    <div class="workflow-canvas-hint">{{ i18n.t('workflow.designer.canvas.hint') }}</div>
    <!-- 悬停条件气泡 etip：绝对定位在 shellRef 内，x/y 是相对 shellRef 左上角
         的局部坐标（见上方 edgeTip/onEdgeMarkerHover 注释）；pointer-events:none 见样式块，
         浮层本身不拦截鼠标事件，避免遮住珠子下方触发 mouseleave 造成的闪烁。 -->
    <div
      v-if="edgeTip.visible"
      class="workflow-edge-etip"
      data-testid="workflow-edge-etip"
      :style="{ left: `${edgeTip.x}px`, top: `${edgeTip.y}px` }"
    >{{ edgeTip.text }}</div>
  </section>
</template>

<style>
.workflow-canvas-shell {
  position: relative;
  min-width: 0;
  min-height: 440px;
  overflow: hidden;
  /* 文字/描边/填充与品牌蓝统一使用宿主配色 token（宿主 CSS 变量），不写硬编码色 */
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 8px;
  background: rgb(var(--fill-light-color, 245 247 250));
}
/* 画布标尺：画布本体让出左上 20px（顶部横标尺高 20 / 左侧竖标尺宽 20），
   不与标尺重叠——X6 autoResize:true 会自动跟着这个更小的容器矩形重新测算，不需要额外通知
   适配器"容器变小了"。其余三条浮层（小地图/etip 提示/悬停气泡）定位基准是 shellRef 本身
   （同级绝对定位，不是 .workflow-canvas 的子元素），不受这处收缩影响。 */
.workflow-canvas { position: absolute; inset: 20px 0 0 20px; }
.workflow-canvas .x6-widget-selection-box { pointer-events: none !important; }
/* 参考线颜色：Snapline 插件自身不提供颜色配置项（只有 enabled/sharp/tolerance 等交互参数），
   只能靠非 scoped CSS 覆写其渲染出的两条线条元素颜色——这是本文件唯一"确实只能走 CSS + 宿主
   变量"的场景（第三方插件渲染、没有暴露颜色配置项）；节点选中态是我们自己完全控制的渲染，
   走 SVG attrs 内联样式（见 graph/x6-adapter.ts applyNodeVisual 消费处）。
   🔴 这两个元素是 SVG `<line>`（插件内部用 Vector('line') 创建，只在构造时设了
   display:none，没有设 stroke），颜色属性是 SVG 的 `stroke`，不是 HTML 元素的
   `background-color`；插件自带的默认 CSS（@antv/x6-plugin-snapline/dist/index.css）本项目没有
   import，不加这条规则时参考线无描边、不可见（SVG stroke 默认值是 none）。 */
.workflow-canvas .x6-widget-snapline-vertical,
.workflow-canvas .x6-widget-snapline-horizontal {
  stroke: rgb(var(--primary-color, 100 108 255)) !important;
}
/* 节点选中态：描边换色/加粗、四角手柄、外圈光环、卡片底色轻微着色，全部在
   graph/x6-adapter.ts applyNodeVisual()/applySelectionHandles() 里通过 X6 attrs（含内联
   style）落地，本文件没有任何一条选中态 CSS 规则。不用 CSS + data-selected + 宿主
   --primary-color 的原因：读宿主变量会与画布自身的 CanvasPalette 主题系统脱节。
   data-selected 属性本身仍然写入，只是没有消费它的 CSS 规则，留给 DOM/e2e 断言用。
   连接点只在指针悬停时显示（选中态同样收起），显隐完全由 x6-adapter 的
   node:mouseenter/mouseleave 内联样式控制，CSS 不兜任何一态。 */
/* 悬停条件气泡 etip：黑底白字浮层，下方居中 4px 三角箭头指向珠子。
   pointer-events:none——浮层本身不拦截鼠标事件，避免遮住珠子导致误触发 mouseleave。 */
.workflow-edge-etip {
  position: absolute;
  z-index: 30;
  max-width: 260px;
  padding: 6px 10px;
  transform: translate(-50%, calc(-100% - 8px));
  border-radius: 6px;
  background: rgb(var(--tooltip-bg-color, 42 47 56));
  color: rgb(var(--tooltip-text-color, 255 255 255));
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgb(var(--shadow-color, 15 23 42) / 25%);
  pointer-events: none;
}
.workflow-edge-etip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  width: 0;
  height: 0;
  border: 4px solid transparent;
  border-top-color: rgb(var(--tooltip-bg-color, 42 47 56));
  transform: translateX(-50%);
}
/* 小地图外层 shell——展开态＝胶囊头部(28px) + 小地图本体(88px)；收起态＝仅 28px
   胶囊头部，宽度也收到胶囊内容本身（不再占 176px），过渡用 width/height 简单动画。
   位置 right16/bottom12；宽度 176 与 x6-adapter.ts 的 MiniMap 构造参数（176×88）保持一致，
   改尺寸时需同步那边的 width/height 选项（连带 padding/minScale 需要重新校验）。 */
.workflow-minimap-shell {
  position: absolute;
  z-index: 20;
  right: 16px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  width: 176px;
  height: 116px;
  overflow: hidden;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 8px;
  background: rgb(var(--container-bg-color, 255 255 255));
  box-shadow: 0 2px 8px rgb(var(--shadow-color, 16 24 40) / 10%);
  transition: width 0.15s ease, height 0.15s ease;
}
.workflow-minimap-shell.is-collapsed {
  width: 76px;
  height: 28px;
  border-radius: 14px;
}
.workflow-minimap-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 0 0 28px;
  height: 28px;
  padding: 0 8px;
  border: none;
  background: rgb(var(--fill-lighter-color, 250 250 250));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 11px;
  cursor: pointer;
}
.workflow-minimap-toggle:hover { background: rgb(var(--fill-color, 240 242 245)); }
.workflow-minimap-toggle__chevron { font-size: 12px; line-height: 1; }
.workflow-minimap-shell:not(.is-collapsed) .workflow-minimap-toggle { border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237)); }
.workflow-minimap {
  width: 176px;
  height: 88px;
  flex: 0 0 auto;
  overflow: hidden;
  background: rgb(var(--container-bg-color, 255 255 255));
}
/* 🔴 提示条放在画布左下角——放右下角（right:10/bottom:7）会与小地图 shell
   （.workflow-minimap-shell，right:16/bottom:12）重叠。left:26px 让开左侧竖标尺（.workflow-canvas-ruler--left
   宽 20px，见 CanvasRulers.vue）留出 6px 间隙，不与标尺刻度视觉打架；小地图恒在右侧，提示条
   挪到左侧后与小地图展开/收起两态都不会再有交集，不需要按 minimapCollapsed 联动调整位置。 */
.workflow-canvas-hint { position: absolute; z-index: 20; left: 26px; bottom: 7px; color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 11px; pointer-events: none; }
.kimpo-workflow-context-menu {
  position: absolute;
  z-index: 100;
  display: grid;
  min-width: 150px;
  padding: 5px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 7px;
  background: rgb(var(--container-bg-color, 255 255 255));
  box-shadow: 0 8px 24px rgb(var(--shadow-color, 16 24 40) / 16%);
}
.kimpo-workflow-context-menu button { padding: 7px 10px; border: 0; border-radius: 4px; background: transparent; color: rgb(var(--base-text-color, 31 31 31)); text-align: left; cursor: pointer; }
.kimpo-workflow-context-menu button:hover { background: rgb(var(--fill-color, 240 242 245)); }
.kimpo-workflow-context-menu button:disabled { color: rgb(var(--text-hint-color, 153 153 153)); cursor: not-allowed; }
</style>
