/**
 * designer/canvas/viewport.ts —— 画布视口（缩放/平移/适应视图）纯逻辑层。
 *
 * 定位：视口变换是 DesignerCanvas 的本地视图态——几何/渲染层面编辑器自身的内部事务，不进
 * 撤销历史、不改 model，与业务数据完全无关，纯粹是画布怎么显示。因此本文件
 * 只是一组无 DOM/Vue 依赖的纯函数 + 类型，可独立单测（zoom clamp / 光标锚点换算 / fit bounds
 * 计算 / 屏幕↔画布坐标换算），不持有任何状态。
 *
 * 接线关系：
 *   DesignerCanvas.vue —— 挂 wheel/pointer 事件，调用本文件纯函数算出下一个 ViewportState，
 *     再调用 graph/svg-adapter.ts 的 SvgGraphAdapter.setViewport() 落地到 <svg viewBox>。
 *   graph/svg-adapter.ts —— 节点拖拽时用 ViewportState.scale 把屏幕像素位移换算回画布坐标位移
 *     （见该文件 handlePointerMove 注释），并以 `import type` 方式复用本文件的 ViewportState/
 *     Bounds 类型（只复用类型，不复用运行时代码/常量——graph/ 是"唯一 X6 适配边界"，不应反向
 *     依赖 designer/ 的运行时逻辑；类型共享是类型系统层面的事，不产生真实的模块运行时依赖，
 *     port.ts 已有先例：graph/port.ts 用 `import type` 复用 model/store.ts 的 NodePosition）。
 */

/** 画布视口状态：viewBox 左上角在"画布坐标系"（与 GraphNodeView.position 同一套单位）中的
 * (x, y) + 缩放比例 scale。viewBox 的可见宽高由"容器像素尺寸 / scale"反推（见
 * graph/svg-adapter.ts setViewport()），因此本状态不需要保存容器尺寸本身——容器 resize 后，
 * 下一次任意视口操作都会用当时最新的容器尺寸重算 viewBox，无需专门监听 resize 事件。 */
export interface ViewportState {
  scale: number;
  x: number;
  y: number;
}

/** 容器/内容的像素或画布单位尺寸（视场景而定，见各函数参数注释）。 */
export interface Size {
  width: number;
  height: number;
}

/** 一个二维坐标点（视场景而定：容器内像素坐标 或 画布坐标）。 */
export interface Point {
  x: number;
  y: number;
}

/** 内容包围盒（画布坐标系），fit-to-view 用；来自 SvgGraphAdapter.getContentBounds()。 */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 缩放上下限（需求："min/max scale 限制，如 0.2~2.5"）。 */
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2.5;

/** 初始视口：100% 缩放、原点对齐——等价于不设置 viewBox 时浏览器对 SVG 的默认 1:1 像素映射
 * （见 svg-adapter.ts setViewport() 注释：容器未布局完成时会跳过 viewBox 落地，但 viewport
 * 状态本身仍以此为默认值，保证读写一致）。 */
export const DEFAULT_VIEWPORT: ViewportState = { scale: 1, x: 0, y: 0 };

/** fit-to-view 默认留白（画布坐标单位）。 */
export const DEFAULT_FIT_PADDING = 48;

/** 滚轮/按钮缩放的默认步长倍数（每次滚轮 tick 或点击一次缩放按钮，scale 乘以/除以该倍数）。 */
export const WHEEL_ZOOM_FACTOR = 1.1;
export const BUTTON_ZOOM_FACTOR = 1.2;

/** 缩放比例夹紧到 [MIN_SCALE, MAX_SCALE]。 */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 由 ViewportState + 容器像素尺寸反推 SVG viewBox 的四个分量。 */
export function computeViewBox(state: ViewportState, containerSize: Size): { x: number; y: number; width: number; height: number } {
  return {
    x: state.x,
    y: state.y,
    width: containerSize.width / state.scale,
    height: containerSize.height / state.scale
  };
}

/**
 * 以"容器像素坐标系"里的某一点（例如鼠标光标，或容器中心）为锚点缩放：缩放前后该点对应的
 * 画布坐标保持在屏幕上的同一像素位置不动（标准的"光标锚点缩放"手感），滚轮缩放与缩放按钮
 * 共用本函数（按钮缩放传容器中心点作锚点）。
 *
 * @param state 当前视口
 * @param containerSize 画布容器当前像素尺寸（用于把 viewBox 宽高换算回像素）
 * @param anchorInContainer 锚点相对容器左上角的像素坐标（调用方需先减去容器
 *   getBoundingClientRect().left/top，不是裸的 clientX/clientY）
 * @param factor 缩放倍数（>1 放大，<1 缩小），最终 scale 会被 clampScale 夹紧
 */
export function zoomAtPoint(state: ViewportState, containerSize: Size, anchorInContainer: Point, factor: number): ViewportState {
  const newScale = clampScale(state.scale * factor);
  if (newScale === state.scale) return state; // 已到边界：避免产生等价的新对象，减少下游无意义更新
  if (containerSize.width <= 0 || containerSize.height <= 0) {
    // 容器尚未完成布局（如测试环境/隐藏 tab）：退化为"只改缩放不改锚点"，保证至少缩放本身
    // 正确、不产生 NaN；真实浏览器场景下容器尺寸恒为正，不会走到这一分支。
    return { ...state, scale: newScale };
  }
  const oldViewBox = computeViewBox(state, containerSize);
  // 锚点在旧视口下对应的画布坐标。
  const anchorCanvas: Point = {
    x: oldViewBox.x + (anchorInContainer.x / containerSize.width) * oldViewBox.width,
    y: oldViewBox.y + (anchorInContainer.y / containerSize.height) * oldViewBox.height
  };
  const newWidth = containerSize.width / newScale;
  const newHeight = containerSize.height / newScale;
  // 反推新视口原点，使 anchorCanvas 在新 viewBox 下仍落在 anchorInContainer 这个像素位置。
  return {
    scale: newScale,
    x: anchorCanvas.x - (anchorInContainer.x / containerSize.width) * newWidth,
    y: anchorCanvas.y - (anchorInContainer.y / containerSize.height) * newHeight
  };
}

/** 按屏幕像素位移平移画布（拖拽画布空白处用）：内容跟随光标移动，故视口原点按 -delta/scale
 * 反向移动——scale 越大，同样的像素位移对应的画布位移越小，手感与"直接拖拽内容"一致。 */
export function panBy(state: ViewportState, dxScreen: number, dyScreen: number): ViewportState {
  return {
    ...state,
    x: state.x - dxScreen / state.scale,
    y: state.y - dyScreen / state.scale
  };
}

/** 屏幕像素位移换算成画布坐标位移（节点拖拽用）：缩放后 1 屏幕像素不再等于 1 画布单位，必须
 * 除以当前 scale 才能让节点在视觉上"跟手"。graph/svg-adapter.ts 内联了同款换算（不 import
 * 本函数本身，只 import 类型，见文件头注释），这里单独导出主要供 viewport.test.ts 覆盖同一套
 * 换算公式的正确性（往返：canvasDelta * scale 应约等于原始 screenDelta）。 */
export function screenDeltaToCanvasDelta(state: ViewportState, dxScreen: number, dyScreen: number): Point {
  return { x: dxScreen / state.scale, y: dyScreen / state.scale };
}

/** 屏幕（容器内像素）坐标换算成画布坐标——光标锚点缩放、以及测试里验证"屏幕↔画布坐标往返"
 * 都会用到。与 zoomAtPoint 内部的 anchorCanvas 计算同一公式，这里独立导出便于单测覆盖。 */
export function screenToCanvasPoint(state: ViewportState, containerSize: Size, pointInContainer: Point): Point {
  const viewBox = computeViewBox(state, containerSize);
  if (containerSize.width <= 0 || containerSize.height <= 0) return { x: viewBox.x, y: viewBox.y };
  return {
    x: viewBox.x + (pointInContainer.x / containerSize.width) * viewBox.width,
    y: viewBox.y + (pointInContainer.y / containerSize.height) * viewBox.height
  };
}

/** 画布坐标换算成屏幕（容器内像素）坐标，screenToCanvasPoint 的逆运算（用于测试里验证往返
 * 一致性，运行时暂无直接调用方）。 */
export function canvasToScreenPoint(state: ViewportState, containerSize: Size, pointInCanvas: Point): Point {
  const viewBox = computeViewBox(state, containerSize);
  if (viewBox.width <= 0 || viewBox.height <= 0) return { x: 0, y: 0 };
  return {
    x: ((pointInCanvas.x - viewBox.x) / viewBox.width) * containerSize.width,
    y: ((pointInCanvas.y - viewBox.y) / viewBox.height) * containerSize.height
  };
}

// —— 首次打开设计器：把发起节点锚到画布容器"左中"（新建流程后打开设计界面，发起节点默认
// 落在中间偏左的区域）——
//
// 背景：发起节点的文档坐标写死在 model/defaults.ts 的 START_NODE_POSITION（120,200），画布
// 初始视口是原点对齐（DEFAULT_VIEWPORT），两者叠加会让节点贴在画布左上角。本节的纯函数
// 只负责"给定一个锚点（通常是发起节点渲染中心）和容器像素尺寸，算出应该把哪个视口落地"这件
// 几何计算，不知道"发起节点"这个业务概念，也不碰 X6——调用方（designer/canvas/DesignerCanvas.vue）
// 负责在画布首次渲染完成的那一帧，把 X6 侧查到的节点中心与容器尺寸喂进来，再把结果落到
// X6GraphAdapter 的视口上（借道其既有的 setLayout({ viewport }) 通道，不新增写文档/置脏的
// 路径，见 DesignerCanvas.vue applyInitialAnchor() 头注释）。
//
// 🔴 与本文件其余函数使用的 ViewportState（x/y 是 viewBox 左上角，服务于 graph/svg-adapter.ts
// 那条遗留渲染路径）不同——下面这组函数采用 X6 自身的 translate 约定（screen = local * scale +
// translate，与 graph/x6-adapter.ts computeCenterTranslate 同一公式），因为真正的消费方
// DesignerCanvas.vue 持有的是 X6GraphAdapter，需要的正是这里返回的 tx/ty，没有必要先算成
// ViewportState 的 x/y 再反过来换算一遍。两套坐标约定只是符号相反（等价于 tx = -x * scale），
// 混用容易出符号错，因此单独给一个不同的返回类型，不复用 ViewportState 这个名字。

/** 锚点水平目标位置的比例——容器宽度的 30%（"中间偏左"）。 */
export const INITIAL_ANCHOR_HORIZONTAL_RATIO = 0.3;
/** 锚点水平目标位置的像素下限——给浮动节点库面板（画布左侧）
 * 留白，不让发起节点贴着面板的右边缘。 */
export const INITIAL_ANCHOR_HORIZONTAL_MIN_PX = 300;
/** 锚点水平目标位置的比例上限——容器很窄时（比如嵌在一个很小的预览区里），30%/300px 算出的
 * 目标值可能已经超出容器本身，钳制到容器宽度的 90% 以内，保证锚点仍落在可视区、不被推出
 * 右侧边缘（比机械地把它推到 100% 边界更留一点呼吸感）。 */
const INITIAL_ANCHOR_HORIZONTAL_MAX_RATIO = 0.9;
/** 锚点垂直目标位置的比例——容器高度的 50%（垂直方向取最不容易"看起来乱"的
 * 居中）。 */
export const INITIAL_ANCHOR_VERTICAL_RATIO = 0.5;

/** X6 视口参数——scale 为缩放比，tx/ty 为 X6 Graph.translate() 接受的平移量（画布坐标系原点
 * 在容器内的像素位置），与本文件其余函数的 ViewportState 不是同一套坐标约定，见上方分节注释。 */
export interface X6ViewportTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** 首次打开定位时"绕开浮动节点库面板"要求的最小间距（节点左缘到面板右缘：发起节点整张卡片
 * 不得被展开态的浮动节点库遮住，且与面板右缘至少留 24px）。 */
export const STENCIL_AVOID_GAP_PX = 24;

/** 浮动节点库面板此刻的估算占位（容器像素坐标系，与 computeInitialAnchorTranslate 的
 * containerSize/anchor 同一套单位）——只需要"节点目标位置那一行"是否被挡住所需的三个边：
 * 面板右缘（决定节点左缘下限）+ 面板垂直范围上/下缘（决定是否与节点所在行有交集）。调用方
 * （designer/canvas/DesignerCanvas.vue applyInitialAnchor()）把 DesignerRoot.vue 提供的估算
 * 结果换算到本函数使用的坐标系后传入，本文件不认识"节点库面板"这个业务概念（同文件头注释
 * "只是一组无 DOM/Vue 依赖的纯函数"），只认识这三个数字。 */
export interface StencilAvoidZone {
  right: number;
  top: number;
  bottom: number;
}

/**
 * computeInitialAnchorTranslate —— 算出把 anchor（画布坐标，通常是发起节点渲染包围盒中心）
 * 定位到容器内"水平约 30%（不小于 300px）、垂直居中"处所需的 X6 视口参数。
 *
 * 缩放恒为 1（100%，需求明确要求"打开设计器时视口为 100% 缩放"，不是"适应内容"那种会缩放的
 * fit-to-view 语义，两者是正交的两件事，互不影响，见 computeFitViewport）。
 *
 * @param anchor 锚点在画布坐标系中的位置（如发起节点渲染包围盒中心）
 * @param containerSize 画布容器当前像素尺寸；宽高任一 ≤ 0（容器尚未完成布局，如测试环境/
 *   隐藏 tab）时返回 null——调用方按"找不到可用容器尺寸，回退现有行为（不改视口）"处理，不
 *   产生 NaN。
 * @param options.anchorSize 锚点节点的渲染宽高（如发起节点胶囊 168×56）——用于把"节点左缘"这个
 *   约束换算成"节点中心"目标值，以及算出节点所在"行"的上下边界；缺省时按 0 处理（退化为只用
 *   目标点本身做重叠判断，理论只有调用方拿不到节点尺寸这种防御性场景才会走到）。
 * @param options.avoidZone 浮动节点库面板此刻的估算占位（见 StencilAvoidZone 注释）；缺省或
 *   null 时完全不做绕开（原有的纯 30%/50% 规则），对应"面板收起"或调用方没有这个概念的旧调用点
 *   （见 designer/canvas/viewport.test.ts 未传第三参的既有用例，行为逐字节不变）。面板占位与
 *   "节点所在行"（[targetY - anchorSize.height/2, targetY + anchorSize.height/2]）没有垂直交集
 *   时同样不绕开——面板此刻位置本就挡不到节点，不需要多此一举地把节点推远。
 */
export function computeInitialAnchorTranslate(
  anchor: Point,
  containerSize: Size,
  options?: { anchorSize?: Size; avoidZone?: StencilAvoidZone | null }
): X6ViewportTransform | null {
  if (containerSize.width <= 0 || containerSize.height <= 0) return null;
  const scale = 1;
  // 水平目标：30%，但不小于 300px；两者取较大值后再钳制到容器宽度的 90% 以内（容器很窄时的
  // 兜底，见上方 INITIAL_ANCHOR_HORIZONTAL_MAX_RATIO 注释）。
  const preferredX = Math.max(containerSize.width * INITIAL_ANCHOR_HORIZONTAL_RATIO, INITIAL_ANCHOR_HORIZONTAL_MIN_PX);
  let targetX = Math.min(preferredX, containerSize.width * INITIAL_ANCHOR_HORIZONTAL_MAX_RATIO);
  const targetY = containerSize.height * INITIAL_ANCHOR_VERTICAL_RATIO;

  const avoidZone = options?.avoidZone;
  if (avoidZone) {
    const anchorWidth = options?.anchorSize?.width ?? 0;
    const anchorHeight = options?.anchorSize?.height ?? 0;
    const rowTop = targetY - anchorHeight / 2;
    const rowBottom = targetY + anchorHeight / 2;
    // 矩形区间重叠判据：两段 [a,b)/[c,d) 有交集当且仅当 a<d && b>c（同 stencil-drop-placement.ts
    // rectsOverlap 同一套写法，两处各自独立实现——一个是一维区间、一个是二维矩形，没有共用的
    // 必要）。
    const rowOverlapsPanel = rowTop < avoidZone.bottom && rowBottom > avoidZone.top;
    if (rowOverlapsPanel) {
      // 节点左缘 ≥ 面板右缘 + 24px ⇔ 节点中心 ≥ 面板右缘 + 24px + 半个节点宽度。
      const minCenterX = avoidZone.right + STENCIL_AVOID_GAP_PX + anchorWidth / 2;
      targetX = Math.max(targetX, minCenterX);
      // 仍受"不把节点推出右侧"的上限约束（同上方常量 INITIAL_ANCHOR_HORIZONTAL_MAX_RATIO 注释）
      // ——容器很窄、面板又恰好挡在那一行时，宁可让节点贴回面板附近也不推出可视区外。
      targetX = Math.min(targetX, containerSize.width * INITIAL_ANCHOR_HORIZONTAL_MAX_RATIO);
    }
  }

  // X6 translate 约定：screenX = canvasX * scale + tx，反推 tx 使 anchor 落在 (targetX, targetY)。
  return {
    scale,
    tx: targetX - anchor.x * scale,
    ty: targetY - anchor.y * scale
  };
}

/**
 * computeMinimalPanToReveal —— 双击节点库新增节点后，若新节点包围盒没有完整落在当前可视区内，
 * 算出"刚好让它完整可见"所需的最小视口平移。只平移不缩放（与
 * computeInitialAnchorTranslate 一样，缩放/适应视图是另一件正交的事，见 computeFitViewport）；
 * 与 computeFitViewport 的关键差异是"最小"——已经可见的方向不会被重新居中，只在真的越界的那
 * 一侧移动刚好够用的距离，避免不必要的视口跳动。
 *
 * @param rect 目标矩形（画布/模型坐标系，如新建节点的 {x,y,width,height}）
 * @param current 当前视口（X6 translate 约定，与 computeInitialAnchorTranslate 返回值同一套
 *   坐标系）
 * @param containerSize 画布容器当前像素尺寸；宽高任一 ≤ 0 时返回 null（回退现有行为，不产生
 *   NaN）
 * @param margin 目标矩形与容器边缘至少保留的留白（画布坐标单位，复用 DEFAULT_FIT_PADDING 的
 *   既定取值，不另造数字）
 * @returns 已经完整可见时返回 null（调用方据此不产生任何视口改动）；否则返回平移后的视口。
 */
export function computeMinimalPanToReveal(
  rect: Bounds,
  current: X6ViewportTransform,
  containerSize: Size,
  margin = DEFAULT_FIT_PADDING
): X6ViewportTransform | null {
  if (containerSize.width <= 0 || containerSize.height <= 0) return null;
  const { scale, tx, ty } = current;
  // X6 translate 约定：screen = model*scale + translate（与本文件其余 X6ViewportTransform
  // 消费处同一公式）。
  const screenLeft = rect.minX * scale + tx;
  const screenRight = rect.maxX * scale + tx;
  const screenTop = rect.minY * scale + ty;
  const screenBottom = rect.maxY * scale + ty;

  let dtx = 0;
  let dty = 0;
  // 水平/垂直各自独立判断，同一方向只可能一侧越界（节点卡片远小于画布容器，不会同时顶到两侧）；
  // 已经完整可见的方向 dtx/dty 保持 0，不产生多余平移。
  if (screenLeft < margin) dtx = margin - screenLeft;
  else if (screenRight > containerSize.width - margin) dtx = containerSize.width - margin - screenRight;
  if (screenTop < margin) dty = margin - screenTop;
  else if (screenBottom > containerSize.height - margin) dty = containerSize.height - margin - screenBottom;

  if (dtx === 0 && dty === 0) return null;
  return { scale, tx: tx + dtx, ty: ty + dty };
}

/** 计算适应全部内容（bounds）到容器视口的视口状态，四周留 padding（画布坐标单位）；
 * 保持宽高比（取宽高两个方向缩放比的较小值），内容居中。bounds 为空/容器尺寸无效时调用方应
 * 改用 DEFAULT_VIEWPORT（本函数在这些边界情况下也直接返回 DEFAULT_VIEWPORT，双重保险）。 */
export function computeFitViewport(bounds: Bounds, containerSize: Size, padding = DEFAULT_FIT_PADDING): ViewportState {
  const contentWidth = Math.max(bounds.maxX - bounds.minX, 0) + padding * 2;
  const contentHeight = Math.max(bounds.maxY - bounds.minY, 0) + padding * 2;
  if (containerSize.width <= 0 || containerSize.height <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return DEFAULT_VIEWPORT;
  }
  const scale = clampScale(Math.min(containerSize.width / contentWidth, containerSize.height / contentHeight));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    x: centerX - containerSize.width / scale / 2,
    y: centerY - containerSize.height / scale / 2
  };
}
