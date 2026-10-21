/**
 * designer/stencil/floating-panel.ts —— 节点库浮动面板的几何计算（纯函数）：面板浮动在画布左侧，
 * 可拖动，点击收起后变成缩略图标。
 *
 * 不依赖 Vue/DOM：拖动夹回、收起后图标尺寸、点击/拖动判别阈值、本地存储值校验，全部写成不碰
 * window/localStorage 的纯函数，供 FloatingStencilPanel.vue 在指针事件回调里调用，也供本文件
 * 同目录单测直接验证边界情况——同 model/document-state.ts 等既定"业务逻辑与宿主环境分离"的
 * 分工。校验部分只管"给定原始值，判断它合不合法、该退回什么默认值"；真正读写 localStorage 的
 * try/catch 包装单独收在文件下方的 readPersistedStencilPanelState()/writePersistedStencilPanelState()
 * （同 canvas/minimap-collapse.ts safeStorage() 手法）。
 */

/** 面板/图标的像素尺寸。 */
export interface PanelSize {
  width: number;
  height: number;
}

/** 面板左上角在其容器内的像素坐标（容器 = DesignerCanvas 外层定位容器，见
 * DesignerRoot.vue .wf-designer-canvas-wrap）。 */
export interface PanelPosition {
  x: number;
  y: number;
}

/** 容器（画布区域）的像素尺寸。 */
export interface ContainerSize {
  width: number;
  height: number;
}

/** 面板离容器四边至少留出的间隙（px）——避免贴死边缘，也避开画布左上角的标尺
 * （CanvasRulers.vue RULER_SIZE=20，见 DesignerRoot.vue 初始位置注释）。 */
export const FLOATING_PANEL_MARGIN = 8;

/** 展开态面板固定宽度（对齐原左栏 StencilPanel 224px 内容 + 浮动外壳自身的边框，是一个近似值，
 * 不必与像素级还原原左栏严格相同——原左栏是固定栏位，浮动面板是新交互形态）。 */
export const STENCIL_PANEL_WIDTH = 248;

/** 收起后图标按钮的边长（约 36px 见方）。 */
export const STENCIL_PANEL_ICON_SIZE = 36;

/** 展开态标题栏（拖动把手 + 收起按钮那一行）高度。 */
export const STENCIL_PANEL_HANDLE_HEIGHT = 32;

/** 展开态面板主体（StencilPanel 本体）允许收窄到的最小高度——即使把面板拖到容器底部，
 * 主体也至少留出这么高的可视区域 + 内部滚动，不会被挤压到 0 高度看不见内容。 */
export const STENCIL_PANEL_MIN_BODY_HEIGHT = 120;

/** 点击 / 拖动判别阈值（px）：指针按下到松开之间的总位移超过它才算一次拖动，否则算点击
 * （收起图标的"点它展开"与展开态标题栏本身都要用这条阈值，避免手指/鼠标的轻微抖动被误判成
 * 拖动、或一次真实拖动松手时被误判成点击触发展开/收起）。 */
export const STENCIL_PANEL_DRAG_CLICK_THRESHOLD_PX = 4;

/** 画布标尺占用的尺寸（CanvasRulers.vue RULER_SIZE，顶部横标尺高 20 / 左侧竖标尺宽 20，只读
 * 常量——不从画布模块导入，是因为本文件被要求保持零 DOM/Vue 依赖，也不进 canvas/** 白名单，这里
 * 按其只读注释里的数值固定复刻一份，两处数值如需变动需人工同步）。 */
const CANVAS_RULER_SIZE = 20;

/** 首次打开、或本地存储值不合法时的默认位置：面板定位容器 .wf-designer-canvas-wrap 与画布本身
 * 边界重合（DesignerCanvas 根节点铺满整个 wrap），因此要显式让开左上角的标尺（CANVAS_RULER_SIZE
 * 20px），再加一点间隙（FLOATING_PANEL_MARGIN），不能直接贴 wrap 的 (0,0)——那样会正好压在标尺
 * 上。落点仍在画布左上（面板浮动在画布左侧）。 */
export const DEFAULT_STENCIL_PANEL_POSITION: PanelPosition = Object.freeze({
  x: CANVAS_RULER_SIZE + FLOATING_PANEL_MARGIN,
  y: CANVAS_RULER_SIZE + FLOATING_PANEL_MARGIN
});

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  // min 可能大于 max（容器比面板还小的极端情况，见下方 clampPanelPosition 注释），此时以 min
  // 为准整体退化到左上角，不产生"min>max 导致 Math.min/Math.max 顺序颠倒"的诡异结果。
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 把面板位置夹回容器可视范围内：容器变小、或此前记忆的位置在新容器里越界时都要收口。
 * 面板尺寸 ≥ 容器尺寸的极端情况（容器还没测出真实尺寸时兜底为 0，或窗口缩得比面板还窄）不产生
 * 负向越界的"可用区间"，统一退化为贴容器左上角（留一点边距），不产生 NaN 或负数尺寸。
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
 * 展开态面板主体（StencilPanel 本体，不含标题栏）的可用高度：容器高度减去面板当前 y 坐标、
 * 标题栏高度、底部间隙——面板越往容器下方拖，主体可用高度越小；下限钳在
 * STENCIL_PANEL_MIN_BODY_HEIGHT，保证任何拖动位置下主体都还留有可视区域（超出部分靠调用方
 * 给主体加 overflow-y:auto 内部滚动，不是被压缩到看不见）。
 */
export function computeStencilPanelBodyMaxHeight(containerHeight: number, positionY: number): number {
  const available = containerHeight - positionY - STENCIL_PANEL_HANDLE_HEIGHT - FLOATING_PANEL_MARGIN;
  return Math.max(STENCIL_PANEL_MIN_BODY_HEIGHT, available);
}

/** 指针按下到当前为止的“总位移”（不是瞬时位移）超过阈值才判定为一次拖动手势；否则视为点击
 * （收起图标"点它展开"、以及标题栏本身松手时都要用这条同一判据，见 floating-panel.ts 头注释）。 */
export function isDragGesture(totalDeltaPx: number): boolean {
  return totalDeltaPx > STENCIL_PANEL_DRAG_CLICK_THRESHOLD_PX;
}

/** 本地存储的持久化形状：位置 + 收起态，一起落盘（分开存两条 key 会有"位置更新成功但收起态
 * 写入失败"之类的半吊子不一致状态，一份 JSON 原子读写更简单）。 */
export interface StencilPanelPersistedState {
  position: PanelPosition;
  collapsed: boolean;
}

export const DEFAULT_STENCIL_PANEL_STATE: StencilPanelPersistedState = Object.freeze({
  position: DEFAULT_STENCIL_PANEL_POSITION,
  collapsed: false
});

/**
 * 校验从 localStorage 读回的原始 JSON（JSON.parse 的结果，类型是 unknown）是否是合法的持久化
 * 形状：字段缺失、类型不对、数值非法（NaN/Infinity）都整体判定非法，退回默认值——不做"部分字段
 * 可信、部分字段兜底"的拼凑（那样反而可能拼出一个从未真实产生过的状态组合，更难排查）。
 */
export function parsePersistedStencilPanelState(raw: unknown): StencilPanelPersistedState {
  if (!raw || typeof raw !== 'object') return DEFAULT_STENCIL_PANEL_STATE;
  const obj = raw as Record<string, unknown>;

  const rawPosition = obj.position;
  if (!rawPosition || typeof rawPosition !== 'object') return DEFAULT_STENCIL_PANEL_STATE;
  const { x, y } = rawPosition as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return DEFAULT_STENCIL_PANEL_STATE;
  }

  if (typeof obj.collapsed !== 'boolean') return DEFAULT_STENCIL_PANEL_STATE;

  return { position: { x, y }, collapsed: obj.collapsed };
}

// ── 本地存储读写（FloatingStencilPanel.vue 与 DesignerRoot.vue 共用）——首次打开
// 设计器"绕开浮动节点库面板"（见下方 estimateStencilPanelAvoidZone）必须读到与面板自己挂载时
// 读到的同一份持久化状态，不能各自维护一份 STORAGE_KEY/try-catch 逻辑再各自读一遍——那样两处
// 一旦漂移（比如以后改存储 key 或改校验规则时只改了一处）就会读出不一致的状态。真正的
// localStorage 读写全部收在这两个函数里，FloatingStencilPanel.vue 与 DesignerRoot.vue 都只调用
// 它们，不各自 new 一遍 safeStorage()。
const STENCIL_PANEL_STORAGE_KEY = 'kimpo_workflow_designer_stencil_panel_v1';

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** 读取面板此刻的持久化状态（位置 + 收起态）；隐私模式/存储被禁用/值非法都统一退回默认值，见
 * parsePersistedStencilPanelState()。 */
export function readPersistedStencilPanelState(): StencilPanelPersistedState {
  const storage = safeStorage();
  if (!storage) return DEFAULT_STENCIL_PANEL_STATE;
  try {
    const raw = storage.getItem(STENCIL_PANEL_STORAGE_KEY);
    if (!raw) return DEFAULT_STENCIL_PANEL_STATE;
    return parsePersistedStencilPanelState(JSON.parse(raw));
  } catch {
    // JSON.parse 失败（存储值被截断/手改成非法 JSON 等）同样退回默认值，不让整页因此崩掉。
    return DEFAULT_STENCIL_PANEL_STATE;
  }
}

/** 写入面板此刻的持久化状态；写入失败（隐私模式/配额超限等）静默忽略，同既有 minimap-collapse.ts
 * toggle() 的 best-effort 处理——只影响"下次打开是否记得住"，不影响本次交互本身。 */
export function writePersistedStencilPanelState(state: StencilPanelPersistedState): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STENCIL_PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* best effort，见函数头注释。 */
  }
}

/**
 * estimateStencilPanelAvoidZone —— 首次打开画布锚定发起节点时，用来"绕开"本面板此刻估算占位的
 * 只读几何计算。面板此刻其实还没挂载——DesignerCanvas.vue 的首帧
 * 定位（onMounted 内同步执行）早于 FloatingStencilPanel.vue 自己的 onMounted（两者是
 * DesignerRoot.vue 模板里的兄弟组件，前者在前，Vue 挂载时同一批 onMounted 按声明顺序入队执行，
 * 见 DesignerRoot.vue applyInitialAnchor 消费处注释），因此这里只能用"主体最大高度"这份公式
 * 近似高度，而不是真实测量值。
 *
 * 这与 FloatingStencilPanel.vue 夹回时用"实测宽高"（防止拖到角落溢出 5～13px）是两个不同问题：那里要防止的是"真实渲染出来的面板比公式算的还高，夹回却按公式留
 * 了个偏小的安全边界导致溢出"，公式给的是主体高度的上限，通常比真实内容更高（真实内容常常够
 * 不到这个上限）——本函数因此天然偏保守，宁可把发起节点推得远一点，也不要真的被面板压住。
 *
 * @param persisted 面板此刻的持久化状态，调用方经 readPersistedStencilPanelState() 取得——与
 *   面板自己挂载时读的必须是同一份状态（见上方两个共享函数的注释）。
 * @param wrapSize 面板定位容器（DesignerRoot.vue 的 .wf-designer-canvas-wrap）此刻的像素尺寸。
 * @returns 面板估算占位（容器像素坐标系，与 wrapSize 同一套单位）；收起态（36px 图标，用户已经
 *   主动收起，视觉上不构成遮挡）返回 null，调用方按"当前不需要绕开"处理。
 */
export function estimateStencilPanelAvoidZone(
  persisted: StencilPanelPersistedState,
  wrapSize: ContainerSize
): { right: number; top: number; bottom: number } | null {
  if (persisted.collapsed) return null;
  const estimatedHeight = STENCIL_PANEL_HANDLE_HEIGHT + computeStencilPanelBodyMaxHeight(wrapSize.height, persisted.position.y);
  const estimatedSize: PanelSize = { width: STENCIL_PANEL_WIDTH, height: estimatedHeight };
  const position = clampPanelPosition(persisted.position, estimatedSize, wrapSize);
  return { right: position.x + STENCIL_PANEL_WIDTH, top: position.y, bottom: position.y + estimatedHeight };
}
