/**
 * designer/shell/props-panel-position.ts —— 属性面板浮层的几何计算（纯函数）：属性面板不占固定
 * 栏位，浮在画布上。
 *
 * 本文件是 ../stencil/floating-panel.ts 的复制体，按属性面板的需要参数化了三处（本地存储 key /
 * 默认位置 / 面板宽度，见下方对应常量与函数头注释），刻意不与原文件抽公共层——原文件已有两份
 * 测试逐字符串锁死了调用形状（floating-panel.test.ts 与 FloatingStencilPanel.static.test.ts，
 * 例如整串 `clampPanelPosition(position.value, measuredSize.value, containerSize.value)`、用
 * indexOf 断言 measurePanel() 排在 reclamp() 之前），抽取会打红一大片而收益为零，因此接受这约
 * 150 行重复。
 *
 * 与节点库浮层的一处本质差异：节点库只有"展开/收起"两态，本文件要多支持一档"钉住"——钉住时
 * 面板贴回画布右缘、画布让位（固定侧栏式的非遮挡形态），不参与拖动与夹回；
 * 因此持久化形状比 StencilPanelPersistedState 多一个 pinned 字段，其余（夹回/点击拖动判别/
 * 本地存储读写）与原文件同构，见下方 PropsPanelPersistedState 头注释。
 */

/** 面板/图标的像素尺寸。 */
export interface PanelSize {
  width: number;
  height: number;
}

/** 面板左上角在其容器内的像素坐标（容器 = DesignerRoot.vue 的 `.wf-designer-canvas-wrap`，与
 * 节点库浮层共用同一个定位容器）。 */
export interface PanelPosition {
  x: number;
  y: number;
}

/** 容器（画布区域）的像素尺寸。 */
export interface ContainerSize {
  width: number;
  height: number;
}

/** 面板离容器四边至少留出的间隙（px）——与 stencil/floating-panel.ts 同值，不是共享导入
 * （本文件按头注释"刻意不抽公共层"独立维护一份）。 */
export const FLOATING_PANEL_MARGIN = 8;

/** 展开态面板固定宽度（参数化点①：原节点库浮层是 248；属性面板取 312，与
 * FloatingPropsPanel.vue `.workflow-props-floating__panel { width: 312px }` 同值，两处必须一起改）。 */
export const PROPS_PANEL_WIDTH = 312;

/** 收起后图标按钮的边长，与节点库浮层同规格（约 36px 见方）。 */
export const PROPS_PANEL_ICON_SIZE = 36;

/** 展开态标题栏（拖动把手 + 钉住/收起按钮那一行）高度。 */
export const PROPS_PANEL_HANDLE_HEIGHT = 32;

/** 展开态面板主体允许收窄到的最小高度——同节点库浮层，即使拖到容器底部也至少留出这么高的
 * 可视区域 + 内部滚动。 */
export const PROPS_PANEL_MIN_BODY_HEIGHT = 120;

/** 点击 / 拖动判别阈值（px），同节点库浮层。 */
export const PROPS_PANEL_DRAG_CLICK_THRESHOLD_PX = 4;

/** 钉住态：画布与面板之间留的视觉间隙（px）——用来换算钉住时画布应该让出的宽度
 * （PROPS_PANEL_WIDTH + PROPS_PANEL_DOCK_GAP），在画布与属性面板之间留一条 10px 的缝，
 * 见 DesignerRoot.vue 消费处注释。 */
export const PROPS_PANEL_DOCK_GAP = 10;

/** 画布标尺占用的尺寸（CanvasRulers.vue RULER_SIZE，顶部横标尺 `top:0;left:0;right:0;height:20px`
 * 贯穿整个容器宽度，因此不论落在左上角还是右上角都要让开这一条，同 stencil/floating-panel.ts
 * 头注释的既定处理——不从画布模块导入，本文件保持零 DOM/Vue 依赖，按其只读注释里的数值固定
 * 复刻一份）。 */
const CANVAS_RULER_SIZE = 20;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  // min 可能大于 max（容器比面板还小的极端情况），此时以 min 为准整体退化到左上角。
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 把面板位置夹回容器可视范围内：容器变小、或此前记忆的位置在新容器里越界时都要收口。
 * 与 stencil/floating-panel.ts 的 clampPanelPosition 完全同构，见其头注释。
 */
export function clampPanelPosition(position: PanelPosition, panelSize: PanelSize, container: ContainerSize): PanelPosition {
  const maxX = container.width - panelSize.width - FLOATING_PANEL_MARGIN;
  const maxY = container.height - panelSize.height - FLOATING_PANEL_MARGIN;
  return {
    x: clampNumber(position.x, FLOATING_PANEL_MARGIN, maxX),
    y: clampNumber(position.y, FLOATING_PANEL_MARGIN, maxY)
  };
}

/**
 * 展开态面板主体（不含标题栏）的可用高度：容器高度减去面板当前 y 坐标、标题栏高度、底部间隙，
 * 下限钳在 PROPS_PANEL_MIN_BODY_HEIGHT（容器极矮时 MIN 仍要赢，同 clampNumber 里"min 可能大于
 * max 时退化取 min"一致的思路）。与 stencil/floating-panel.ts 的 computeStencilPanelBodyMaxHeight
 * 同构。
 *
 * 不给画布右下角小地图预留高度：若为避开小地图开关恒扣固定预留，节点设置浮层会永远拉不到画布
 * 底部。因此浮层允许盖住小地图（浮层
 * z-index 30 高于小地图 20），开关被挡时由用户拖开浮层即可，不做任何联动避让。
 */
export function computePropsPanelBodyMaxHeight(containerHeight: number, positionY: number): number {
  const available = containerHeight - positionY - PROPS_PANEL_HANDLE_HEIGHT - FLOATING_PANEL_MARGIN;
  return Math.max(PROPS_PANEL_MIN_BODY_HEIGHT, available);
}

/** 指针按下到当前为止的"总位移"超过阈值才判定为一次拖动手势，否则视为点击，同
 * stencil/floating-panel.ts 的 isDragGesture。 */
export function isDragGesture(totalDeltaPx: number): boolean {
  return totalDeltaPx > PROPS_PANEL_DRAG_CLICK_THRESHOLD_PX;
}

/**
 * 首次打开、或本地存储里没有记住位置时的默认落点（参数化点②：节点库浮层的默认位置是冻结的
 * 左上角常量 `{x:28,y:28}`——本函数改为"容器宽度的函数"，落点在容器右上角，即钉住态侧栏所在的
 * 一侧）。容器宽度未知
 * 时（组件首次同步求值、真实容器还没测出）调用方可以先传一个粗略估计值（如 window.innerWidth），
 * onMounted 测出真实容器尺寸后的 reclamp() 会立刻用真实值把位置收口一次，这个初值只是"还没测过"
 * 那一瞬间的占位，同 stencil/floating-panel.ts 里 measuredSize 初值的既定处理。
 */
export function defaultPropsPanelPosition(containerWidth: number): PanelPosition {
  const x = Math.max(FLOATING_PANEL_MARGIN, containerWidth - PROPS_PANEL_WIDTH - FLOATING_PANEL_MARGIN);
  return { x, y: CANVAS_RULER_SIZE + FLOATING_PANEL_MARGIN };
}

/** 本地存储的持久化形状：位置 + 收起态 + 钉住态一起落盘（同 StencilPanelPersistedState 的
 * "一份 JSON 原子读写"理由，见 stencil/floating-panel.ts 头注释）。
 *
 * collapsed 与 pinned 是两个正交的布尔量，不是三选一的枚举——原因：钉住态下用户仍可能收起面板
 * （画布全幅），此时需要记住"收起前是钉住还是浮动"，下次选中节点自动展开时才能恢复到正确的
 * 那一态，而不是每次收起都退化成浮动。三种可见形态由这两个布尔量组合得出：
 *   - collapsed=true                → 收起（36×36 图标，pinned 值只是"记着展开后回哪一态"）；
 *   - collapsed=false, pinned=true  → 钉住（贴右缘，画布让位）；
 *   - collapsed=false, pinned=false → 浮动（按 position 摆放，可拖动）。
 * position 在 collapsed/pinned 为 true 时不参与渲染，但仍要保留——切回浮动态要接着摆在原处，
 * 不能因为中途钉住/收起过一次就把位置记忆丢了。 */
export interface PropsPanelPersistedState {
  position: PanelPosition;
  collapsed: boolean;
  pinned: boolean;
}

/**
 * 校验从 localStorage 读回的原始 JSON 是否是合法的持久化形状，非法/缺失时返回 undefined——
 * 与 stencil/floating-panel.ts 的 parsePersistedStencilPanelState 不同：那边非法时退回一个
 * 冻结常量默认值；本函数故意不这样做，因为属性面板的默认位置是容器宽度的函数（见
 * defaultPropsPanelPosition），本模块内没有一个不依赖容器尺寸就能给出的默认 position 常量——
 * 调用方（组件）在拿到 undefined 时，用它此刻测出的容器尺寸现算一个默认值，见
 * FloatingPropsPanel.vue 消费处注释。
 */
export function parsePersistedPropsPanelState(raw: unknown): PropsPanelPersistedState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  const rawPosition = obj.position;
  if (!rawPosition || typeof rawPosition !== 'object') return undefined;
  const { x, y } = rawPosition as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  if (typeof obj.collapsed !== 'boolean') return undefined;
  if (typeof obj.pinned !== 'boolean') return undefined;

  return { position: { x, y }, collapsed: obj.collapsed, pinned: obj.pinned };
}

// ── 本地存储读写（参数化点③：storage key 与节点库浮层各自独立一份，互不串——见下方
// props-panel-position.test.ts"两个浮层的 localStorage key 互不串"一节）。
const PROPS_PANEL_STORAGE_KEY = 'kimpo_workflow_designer_props_panel_v1';

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** 读取面板此刻的持久化状态；隐私模式/存储被禁用/值非法/从未存过都统一返回 undefined——
 * 与 stencil 版本的差异见 parsePersistedPropsPanelState 头注释。 */
export function readPersistedPropsPanelState(): PropsPanelPersistedState | undefined {
  const storage = safeStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(PROPS_PANEL_STORAGE_KEY);
    if (!raw) return undefined;
    return parsePersistedPropsPanelState(JSON.parse(raw));
  } catch {
    // JSON.parse 失败（存储值被截断/手改成非法 JSON 等）同样视为"没存过"。
    return undefined;
  }
}

/** 写入面板此刻的持久化状态；写入失败（隐私模式/配额超限等）静默忽略，同 stencil 版本的
 * best-effort 处理。 */
export function writePersistedPropsPanelState(state: PropsPanelPersistedState): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(PROPS_PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* best effort，见函数头注释。 */
  }
}
