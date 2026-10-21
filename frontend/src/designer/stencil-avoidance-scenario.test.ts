/**
 * designer/stencil-avoidance-scenario.test.ts —— 首次打开锚定发起节点 + 浮动节点库面板 + 绕开
 * 面板 / 双击新增节点落点 / 视口平移带入可视区，几项叠加后的组合场景验算。
 *
 * 场景：828×686 的画布 + 面板默认展开（DEFAULT_STENCIL_PANEL_STATE）+ 只有发起节点的文档
 * （createDefaultDocument，真实工厂函数，不是手写字面量）。全程只调用真实的几何纯函数（不 mock
 * 任何一层），逐步验算：
 *   1) 锚定发起节点后，发起节点包围盒与面板包围盒不相交且间距 ≥ 24px；
 *   2) 双击新增一个"办理"节点后，新节点包围盒完全落在可视区内，且不与面板、发起节点相交；
 *   3) 新节点自动成为选中节点后，再双击一个"结束"节点，同样成立。
 *
 * 坐标系说明（与 DesignerCanvas.vue applyInitialAnchor()/revealRect() 消费处一致）：
 *   - "画布本体"坐标系 = adapter.getContainerSize() 对应的 .workflow-canvas，本场景取
 *     828×686（本文件里 computeInitialAnchorTranslate/computeMinimalPanToReveal/节点屏幕坐标
 *     换算全部用这一套）；
 *   - "面板定位容器"坐标系 = DesignerRoot.vue 的 .wf-designer-canvas-wrap，比画布本体左/上各多
 *     20px（CanvasRulers.vue RULER_SIZE），本文件里换算成 wrapSize = { 848, 706 } 喂给
 *     estimateStencilPanelAvoidZone，返回结果再减回 20px 落回画布本体坐标——与 DesignerCanvas.vue
 *     applyInitialAnchor() 的换算逐字节一致；
 *   - 浮动节点库面板是画布之上的绝对定位覆盖层，视口平移（双击新增节点后可能触发）不会移动它，
 *     它的包围盒在整个场景里恒定不变（这一点与画布内容形成对照，见文件末尾"已知风险"说明）。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultDocument } from '../model/defaults';
import { nodeDimensions } from '../graph/x6-adapter';
import { computeInitialAnchorTranslate, computeMinimalPanToReveal, STENCIL_AVOID_GAP_PX, type X6ViewportTransform } from './canvas/viewport';
import { DEFAULT_STENCIL_PANEL_STATE, estimateStencilPanelAvoidZone } from './stencil/floating-panel';
import { computeStencilDblClickPosition, type PlacedNodeRect } from './stencil-drop-placement';

const CANVAS_RULER_SIZE = 20; // 同 DesignerCanvas.vue 本地复刻的同名常量

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function horizontalGap(a: Rect, b: Rect): number {
  // a 在 b 左侧时的水平间距（本场景节点恒被推到面板右侧，不考虑反向）。
  return b.left - a.right;
}

/** 文档模型坐标 → 当前视口下的屏幕坐标（画布本体坐标系），与 DesignerCanvas.vue revealRect()/
 * computeMinimalPanToReveal 内部同一条换算公式：screen = model*scale + translate。 */
function toScreenRect(node: { x: number; y: number; width: number; height: number }, viewport: X6ViewportTransform): Rect {
  return {
    left: node.x * viewport.scale + viewport.tx,
    top: node.y * viewport.scale + viewport.ty,
    right: (node.x + node.width) * viewport.scale + viewport.tx,
    bottom: (node.y + node.height) * viewport.scale + viewport.ty
  };
}

describe('节点库避让组合场景：828×686 画布 + 面板默认展开 + 只有发起节点的文档', () => {
  const containerSize = { width: 828, height: 686 }; // 画布本体（.workflow-canvas）
  const wrapSize = { width: containerSize.width + CANVAS_RULER_SIZE, height: containerSize.height + CANVAS_RULER_SIZE }; // 848×706

  // 面板包围盒（画布本体坐标系）——全场景恒定：浮动面板是画布之上的覆盖层，不随画布视口平移。
  const panelZoneWrap = estimateStencilPanelAvoidZone(DEFAULT_STENCIL_PANEL_STATE, wrapSize);
  if (!panelZoneWrap) throw new Error('测试前置条件：面板默认展开，estimateStencilPanelAvoidZone 不应返回 null');
  const panelRect: Rect = {
    left: DEFAULT_STENCIL_PANEL_STATE.position.x - CANVAS_RULER_SIZE,
    top: panelZoneWrap.top - CANVAS_RULER_SIZE,
    right: panelZoneWrap.right - CANVAS_RULER_SIZE,
    bottom: panelZoneWrap.bottom - CANVAS_RULER_SIZE
  };

  // 只有发起节点的真实文档（工厂函数产出，不是手写字面量）。
  const doc = createDefaultDocument('场景流程');
  const startNode = doc.nodes.find((n) => n.kind === 'start')!;
  const startSize = nodeDimensions('start'); // 胶囊 168×56

  it('步骤 1：锚定发起节点后，发起节点包围盒与面板包围盒不相交，且间距 ≥ 24px', () => {
    const anchorCenter = { x: startNode.position_x! + startSize.width / 2, y: startNode.position_y! + startSize.height / 2 };

    const avoidZoneCanvasLocal = { right: panelZoneWrap.right - CANVAS_RULER_SIZE, top: panelZoneWrap.top - CANVAS_RULER_SIZE, bottom: panelZoneWrap.bottom - CANVAS_RULER_SIZE };
    const anchorResult = computeInitialAnchorTranslate(anchorCenter, containerSize, { anchorSize: startSize, avoidZone: avoidZoneCanvasLocal });
    expect(anchorResult).not.toBeNull();
    const viewport: X6ViewportTransform = anchorResult!;

    const startRect = toScreenRect({ x: startNode.position_x!, y: startNode.position_y!, ...startSize }, viewport);

    expect(rectsIntersect(startRect, panelRect)).toBe(false);
    expect(horizontalGap(panelRect, startRect)).toBeGreaterThanOrEqual(STENCIL_AVOID_GAP_PX);

    // 数值留痕（已手算复核）：面板包围盒 [8,8]-[256,678]；视口
    // {scale:1,tx:160,ty:115}；发起节点屏幕包围盒 [280,315]-[448,371]；水平间距恰好 24px。
    expect(panelRect).toEqual({ left: 8, top: 8, right: 256, bottom: 678 });
    expect(viewport).toEqual({ scale: 1, tx: 160, ty: 115 });
    expect(startRect).toEqual({ left: 280, top: 315, right: 448, bottom: 371 });
    expect(horizontalGap(panelRect, startRect)).toBe(24);
  });

  it('步骤 2/3：连续双击新增"办理"节点、"结束"节点，均完整可见且不与面板/发起节点相交', () => {
    // 复算步骤 1 的视口（本用例独立于上一条 it，不共享可变状态——同文件其余测试的既定风格）。
    const anchorCenter = { x: startNode.position_x! + startSize.width / 2, y: startNode.position_y! + startSize.height / 2 };
    const avoidZoneCanvasLocal = { right: panelZoneWrap.right - CANVAS_RULER_SIZE, top: panelZoneWrap.top - CANVAS_RULER_SIZE, bottom: panelZoneWrap.bottom - CANVAS_RULER_SIZE };
    let viewport: X6ViewportTransform = computeInitialAnchorTranslate(anchorCenter, containerSize, { anchorSize: startSize, avoidZone: avoidZoneCanvasLocal })!;

    // existingNodes：只有发起节点（文档模型坐标，左上角 + 尺寸）。
    const existingNodes: PlacedNodeRect[] = [{ id: startNode.id, x: startNode.position_x!, y: startNode.position_y!, width: startSize.width, height: startSize.height }];
    let selectedNodeId: string | undefined; // 打开设计器后默认无选中

    // —— 第一次双击：新增"办理"节点（没有选中节点 → 落在最靠右的节点——此刻即发起节点——右侧）——
    const handleSize = nodeDimensions('handle'); // 184×64
    const handlePos = computeStencilDblClickPosition({ existingNodes, newNodeSize: handleSize, selectedNodeId });
    const handleRect = toScreenRect({ x: handlePos.x, y: handlePos.y, ...handleSize }, viewport);

    // revealRect：若新节点未完整落在可视区内则平移视口（本场景理论应已可见，见下方留痕数值）。
    const handleReveal = computeMinimalPanToReveal(
      { minX: handlePos.x, minY: handlePos.y, maxX: handlePos.x + handleSize.width, maxY: handlePos.y + handleSize.height },
      viewport,
      containerSize
    );
    if (handleReveal) viewport = handleReveal;
    const handleRectAfterReveal = toScreenRect({ x: handlePos.x, y: handlePos.y, ...handleSize }, viewport);

    expect(handleRectAfterReveal.left).toBeGreaterThanOrEqual(0);
    expect(handleRectAfterReveal.top).toBeGreaterThanOrEqual(0);
    expect(handleRectAfterReveal.right).toBeLessThanOrEqual(containerSize.width);
    expect(handleRectAfterReveal.bottom).toBeLessThanOrEqual(containerSize.height);
    expect(rectsIntersect(handleRectAfterReveal, panelRect)).toBe(false);
    const startRectNow = toScreenRect({ x: startNode.position_x!, y: startNode.position_y!, ...startSize }, viewport);
    expect(rectsIntersect(handleRectAfterReveal, startRectNow)).toBe(false);

    // 新建节点建好后自动成为选中节点（连续双击沿它一路向右顺接）。
    existingNodes.push({ id: 'handle-1', x: handlePos.x, y: handlePos.y, width: handleSize.width, height: handleSize.height });
    selectedNodeId = 'handle-1';

    // —— 第二次双击：新增"结束"节点（有选中节点 → 落在选中节点右侧）——
    const endSize = nodeDimensions('end'); // 胶囊 168×56
    const endPos = computeStencilDblClickPosition({ existingNodes, newNodeSize: endSize, selectedNodeId });

    const endReveal = computeMinimalPanToReveal(
      { minX: endPos.x, minY: endPos.y, maxX: endPos.x + endSize.width, maxY: endPos.y + endSize.height },
      viewport,
      containerSize
    );
    if (endReveal) viewport = endReveal;
    const endRectAfterReveal = toScreenRect({ x: endPos.x, y: endPos.y, ...endSize }, viewport);

    expect(endRectAfterReveal.left).toBeGreaterThanOrEqual(0);
    expect(endRectAfterReveal.top).toBeGreaterThanOrEqual(0);
    expect(endRectAfterReveal.right).toBeLessThanOrEqual(containerSize.width);
    expect(endRectAfterReveal.bottom).toBeLessThanOrEqual(containerSize.height);
    expect(rectsIntersect(endRectAfterReveal, panelRect)).toBe(false);
    // "不与发起节点相交"这条断言用的是发起节点在**本次视口**下的屏幕矩形（若 endReveal 平移了
    // 视口，发起节点的屏幕位置也会跟着变——本用例只覆盖这条不变式，不覆盖"平移后
    // 发起节点是否仍不被面板遮挡"，见文件末尾"已知风险"说明）。
    const startRectFinal = toScreenRect({ x: startNode.position_x!, y: startNode.position_y!, ...startSize }, viewport);
    expect(rectsIntersect(endRectAfterReveal, startRectFinal)).toBe(false);

    // 数值留痕（已手算复核）：
    //   办理节点文档坐标 {x:380,y:196}，首次视口下屏幕矩形 [540,311]-[724,375]（已完整可见，
    //   revealRect 判定不产生平移，故 handleRectAfterReveal 与之相同）；
    //   结束节点文档坐标 {x:640,y:200}，首次视口下右缘 968 超出容器宽度 828，revealRect 把视口
    //   平移到 {scale:1,tx:-28,ty:115}，平移后屏幕矩形 [612,315]-[780,371]，完整落在
    //   [0,828]x[0,686] 内。
    expect(handlePos).toEqual({ x: 380, y: 196 });
    expect(handleRect).toEqual({ left: 540, top: 311, right: 724, bottom: 375 });
    expect(handleRectAfterReveal).toEqual(handleRect); // 本步骤未触发平移
    expect(endPos).toEqual({ x: 640, y: 200 });
    expect(viewport).toEqual({ scale: 1, tx: -28, ty: 115 }); // revealRect 触发了一次左移
    expect(endRectAfterReveal).toEqual({ left: 612, top: 315, right: 780, bottom: 371 });
  });
});

// 已知局限（不在本文件断言范围内）：第二次双击新增"结束"节点触发
// revealRect 视口左移（tx: 160→-28）后，重新换算的发起节点屏幕矩形会与浮动面板重新出现交集——
// 视口平移只考虑"让新节点完整可见"，不知道也不关心"平移后已有节点是否又被面板挡住"。因此连续双击顺接多个节点时，视口可能把更早创建的节点（含发起节点）
// 带回浮动面板遮挡区域下方。
