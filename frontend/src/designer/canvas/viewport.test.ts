import { describe, expect, it } from 'vitest';
import {
  BUTTON_ZOOM_FACTOR,
  DEFAULT_FIT_PADDING,
  DEFAULT_VIEWPORT,
  INITIAL_ANCHOR_HORIZONTAL_MIN_PX,
  INITIAL_ANCHOR_HORIZONTAL_RATIO,
  INITIAL_ANCHOR_VERTICAL_RATIO,
  MAX_SCALE,
  MIN_SCALE,
  STENCIL_AVOID_GAP_PX,
  canvasToScreenPoint,
  clampScale,
  computeFitViewport,
  computeInitialAnchorTranslate,
  computeMinimalPanToReveal,
  computeViewBox,
  panBy,
  screenDeltaToCanvasDelta,
  screenToCanvasPoint,
  zoomAtPoint,
  type ViewportState
} from './viewport';

describe('designer/canvas/viewport 纯逻辑', () => {
  describe('clampScale', () => {
    it('落在 [MIN_SCALE, MAX_SCALE] 区间内的值原样返回', () => {
      expect(clampScale(1)).toBe(1);
      expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE);
      expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE);
    });

    it('超出上下限的值被夹紧', () => {
      expect(clampScale(0.01)).toBe(MIN_SCALE);
      expect(clampScale(100)).toBe(MAX_SCALE);
    });
  });

  describe('computeViewBox', () => {
    it('scale=1 时 viewBox 尺寸等于容器像素尺寸（默认视口=恒等映射）', () => {
      const vb = computeViewBox(DEFAULT_VIEWPORT, { width: 800, height: 400 });
      expect(vb).toEqual({ x: 0, y: 0, width: 800, height: 400 });
    });

    it('scale=2 时 viewBox 尺寸减半（放大 2 倍 = 可见画布范围缩小一半）', () => {
      const vb = computeViewBox({ scale: 2, x: 10, y: 20 }, { width: 800, height: 400 });
      expect(vb).toEqual({ x: 10, y: 20, width: 400, height: 200 });
    });
  });

  describe('zoomAtPoint —— 光标锚点缩放', () => {
    it('以容器中心为锚点放大 2 倍后，中心点换算出的画布坐标不变（光标下的内容不漂移）', () => {
      const containerSize = { width: 200, height: 100 };
      const center = { x: 100, y: 50 };
      const before = DEFAULT_VIEWPORT;
      const anchorCanvasBefore = screenToCanvasPoint(before, containerSize, center);

      const after = zoomAtPoint(before, containerSize, center, 2);
      expect(after.scale).toBe(2);
      const anchorCanvasAfter = screenToCanvasPoint(after, containerSize, center);

      expect(anchorCanvasAfter.x).toBeCloseTo(anchorCanvasBefore.x, 6);
      expect(anchorCanvasAfter.y).toBeCloseTo(anchorCanvasBefore.y, 6);
    });

    it('任意非中心锚点缩放后，该锚点对应的画布坐标依旧落在原屏幕位置（往返一致）', () => {
      const containerSize = { width: 600, height: 300 };
      const anchor = { x: 450, y: 80 }; // 偏右上角的一个锚点，不是几何中心
      const before: ViewportState = { scale: 1, x: 20, y: 5 };
      const anchorCanvasBefore = screenToCanvasPoint(before, containerSize, anchor);

      const after = zoomAtPoint(before, containerSize, anchor, 1.5);
      const anchorCanvasAfter = screenToCanvasPoint(after, containerSize, anchor);

      expect(anchorCanvasAfter.x).toBeCloseTo(anchorCanvasBefore.x, 6);
      expect(anchorCanvasAfter.y).toBeCloseTo(anchorCanvasBefore.y, 6);
    });

    it('缩放结果被夹紧在 [MIN_SCALE, MAX_SCALE]，多次放大不超过上限', () => {
      const containerSize = { width: 200, height: 100 };
      const center = { x: 100, y: 50 };
      let state = DEFAULT_VIEWPORT;
      for (let i = 0; i < 20; i += 1) {
        state = zoomAtPoint(state, containerSize, center, BUTTON_ZOOM_FACTOR);
      }
      expect(state.scale).toBe(MAX_SCALE);
    });

    it('缩放结果被夹紧在 [MIN_SCALE, MAX_SCALE]，多次缩小不低于下限', () => {
      const containerSize = { width: 200, height: 100 };
      const center = { x: 100, y: 50 };
      let state = DEFAULT_VIEWPORT;
      for (let i = 0; i < 20; i += 1) {
        state = zoomAtPoint(state, containerSize, center, 1 / BUTTON_ZOOM_FACTOR);
      }
      expect(state.scale).toBe(MIN_SCALE);
    });

    it('容器尺寸无效（未完成布局）时只改 scale，不产生 NaN', () => {
      const result = zoomAtPoint(DEFAULT_VIEWPORT, { width: 0, height: 0 }, { x: 0, y: 0 }, 2);
      expect(result).toEqual({ scale: 2, x: 0, y: 0 });
    });

    it('已到达缩放上限时再次放大返回同一个对象引用（避免无意义更新）', () => {
      const atMax = { scale: MAX_SCALE, x: 0, y: 0 };
      const result = zoomAtPoint(atMax, { width: 100, height: 100 }, { x: 50, y: 50 }, 1.2);
      expect(result).toBe(atMax);
    });
  });

  describe('panBy —— 拖拽平移', () => {
    it('scale=1 时屏幕像素位移与画布位移一比一（内容跟随光标反向移动视口原点）', () => {
      const after = panBy(DEFAULT_VIEWPORT, 30, -10);
      expect(after).toEqual({ scale: 1, x: -30, y: 10 });
    });

    it('scale=2 时相同的屏幕像素位移只产生一半的视口原点位移', () => {
      const after = panBy({ scale: 2, x: 0, y: 0 }, 30, -10);
      expect(after.x).toBeCloseTo(-15, 6);
      expect(after.y).toBeCloseTo(5, 6);
    });
  });

  describe('screenDeltaToCanvasDelta —— 节点拖拽的坐标换算', () => {
    it('scale=1 时画布位移等于屏幕位移（与未缩放时的裸 clientX 相减一致）', () => {
      expect(screenDeltaToCanvasDelta(DEFAULT_VIEWPORT, 50, 20)).toEqual({ x: 50, y: 20 });
    });

    it('scale=2 时画布位移是屏幕位移的一半（放大后鼠标移动同样像素，节点应少移动）', () => {
      expect(screenDeltaToCanvasDelta({ scale: 2, x: 0, y: 0 }, 50, 20)).toEqual({ x: 25, y: 10 });
    });
  });

  describe('screenToCanvasPoint / canvasToScreenPoint —— 屏幕↔画布坐标往返', () => {
    it('默认视口下，容器内某像素点换算出的画布坐标与像素坐标数值相同', () => {
      const containerSize = { width: 800, height: 400 };
      expect(screenToCanvasPoint(DEFAULT_VIEWPORT, containerSize, { x: 123, y: 45 })).toEqual({ x: 123, y: 45 });
    });

    it('任意视口状态下，screen -> canvas -> screen 往返得到原始坐标', () => {
      const containerSize = { width: 640, height: 480 };
      const state = { scale: 1.75, x: -37, y: 12 };
      const original = { x: 210, y: 300 };
      const canvasPoint = screenToCanvasPoint(state, containerSize, original);
      const roundTripped = canvasToScreenPoint(state, containerSize, canvasPoint);
      expect(roundTripped.x).toBeCloseTo(original.x, 6);
      expect(roundTripped.y).toBeCloseTo(original.y, 6);
    });
  });

  describe('computeFitViewport —— 适应视图', () => {
    it('内容包围盒按较紧的方向精确留出 padding，另一方向居中留出更多空白', () => {
      const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 100 };
      const containerSize = { width: 800, height: 400 };
      const padding = 48;
      const state = computeFitViewport(bounds, containerSize, padding);

      const vb = computeViewBox(state, containerSize);
      // 宽度方向是约束方向：viewBox 宽度精确等于内容宽度 + 2*padding。
      expect(vb.width).toBeCloseTo(400 + padding * 2, 6);
      // viewBox 左边界与内容左边界之间的间距应正好是 padding。
      expect(bounds.minX - vb.x).toBeCloseTo(padding, 6);
      expect(vb.x + vb.width - bounds.maxX).toBeCloseTo(padding, 6);
      // 高度方向空间更宽裕，留白应 >= padding（居中而非贴边）。
      expect(bounds.minY - vb.y).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(vb.y + vb.height - bounds.maxY).toBeGreaterThanOrEqual(padding - 1e-6);
    });

    it('内容整体在缩放后仍完全落在 viewBox 可见范围内', () => {
      const bounds = { minX: 50, minY: 20, maxX: 900, maxY: 260 };
      const containerSize = { width: 1000, height: 600 };
      const state = computeFitViewport(bounds, containerSize);
      const vb = computeViewBox(state, containerSize);

      expect(vb.x).toBeLessThanOrEqual(bounds.minX);
      expect(vb.y).toBeLessThanOrEqual(bounds.minY);
      expect(vb.x + vb.width).toBeGreaterThanOrEqual(bounds.maxX);
      expect(vb.y + vb.height).toBeGreaterThanOrEqual(bounds.maxY);
    });

    it('容器尺寸无效时退化为 DEFAULT_VIEWPORT', () => {
      const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
      expect(computeFitViewport(bounds, { width: 0, height: 0 })).toEqual(DEFAULT_VIEWPORT);
    });

    it('缩放结果同样受 MIN_SCALE/MAX_SCALE 夹紧（极小内容不会无限放大）', () => {
      const bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const containerSize = { width: 2000, height: 2000 };
      const state = computeFitViewport(bounds, containerSize, 0);
      expect(state.scale).toBe(MAX_SCALE);
    });
  });
});

// 首次打开设计器把发起节点锚到画布左中——覆盖"不同容器尺寸""极窄
// 容器""容器尺寸无效（回退现有行为）"三类场景（"找不到发起节点"这一支是调用方
// designer/canvas/DesignerCanvas.vue 的职责，本函数不知道"发起节点"这个业务概念，见其头
// 注释，因此不在本文件覆盖，留给 DesignerCanvas 相关测试）。
describe('computeInitialAnchorTranslate（首次打开设计器锚定发起节点）', () => {
  it('常规容器：水平目标=容器宽度的 30%，垂直目标=容器高度的 50%，scale 恒为 1', () => {
    const anchor = { x: 204, y: 228 }; // 发起节点渲染中心（示例值，与具体节点尺寸无关）
    const containerSize = { width: 1000, height: 600 };
    const result = computeInitialAnchorTranslate(anchor, containerSize);
    // 目标屏幕位置 = (1000*0.3, 600*0.5) = (300, 300)；X6 约定 screenX = canvasX*scale + tx，
    // 故 tx = 300 - 204 = 96，ty = 300 - 228 = 72。
    expect(result).toEqual({ scale: 1, tx: 96, ty: 72 });
  });

  it('30% 达不到 300px 下限时改用 300px（容器不算窄，但按比例算出的目标太靠左）', () => {
    const anchor = { x: 0, y: 0 };
    const containerSize = { width: 800, height: 600 }; // 30% = 240 < 300
    const result = computeInitialAnchorTranslate(anchor, containerSize);
    expect(result).toEqual({ scale: 1, tx: INITIAL_ANCHOR_HORIZONTAL_MIN_PX, ty: 300 });
  });

  it('极窄容器：300px 下限本身会超出容器，钳制到容器宽度的 90% 以内，不把锚点推出右侧', () => {
    const anchor = { x: 0, y: 0 };
    const containerSize = { width: 200, height: 400 }; // 30%=60、300px 下限都超过 90%=180
    const result = computeInitialAnchorTranslate(anchor, containerSize);
    expect(result).toEqual({ scale: 1, tx: 180, ty: 200 });
    // 钳制后的目标水平位置严格小于容器宽度本身，锚点确实落在可视区内。
    expect(result!.tx).toBeLessThan(containerSize.width);
  });

  it('容器尺寸无效（宽或高 ≤ 0）时返回 null，调用方据此回退现有行为、不改视口', () => {
    expect(computeInitialAnchorTranslate({ x: 0, y: 0 }, { width: 0, height: 600 })).toBeNull();
    expect(computeInitialAnchorTranslate({ x: 0, y: 0 }, { width: 800, height: 0 })).toBeNull();
    expect(computeInitialAnchorTranslate({ x: 0, y: 0 }, { width: -10, height: 600 })).toBeNull();
  });

  it('导出的比例常量与实现口径一致（30%/50%），防止实现悄悄漂移而常量注释没跟着改', () => {
    expect(INITIAL_ANCHOR_HORIZONTAL_RATIO).toBe(0.3);
    expect(INITIAL_ANCHOR_VERTICAL_RATIO).toBe(0.5);
  });

  // "绕开浮动节点库面板"——四类场景：面板展开默认位（挡住 30% 规则算出
  // 的目标）/面板收起（不绕开）/面板被拖到不挡的位置（含"拖到右侧"）/极窄容器（钳制优先于绕开）。
  describe('computeInitialAnchorTranslate + avoidZone（绕开浮动节点库面板）', () => {
    const anchor = { x: 204, y: 228 }; // 发起节点渲染中心（同上方既有用例）
    const anchorSize = { width: 168, height: 56 }; // 发起节点胶囊尺寸
    const containerSize = { width: 1000, height: 600 };

    it('面板展开默认位（贴容器左上，垂直方向必然挡住居中的目标行）：节点左缘被推到面板右缘+24px', () => {
      const avoidZone = { right: 256, top: 8, bottom: 500 }; // 面板从顶部一路延伸到接近容器底部
      const result = computeInitialAnchorTranslate(anchor, containerSize, { anchorSize, avoidZone });
      // minCenterX = 256 + 24 + 168/2 = 364；tx = 364 - 204 = 160，ty 不受影响仍是 300-228=72。
      expect(result).toEqual({ scale: 1, tx: 160, ty: 72 });
      // 换算回节点左缘：anchor.x + tx - anchorSize.width/2 = 204+160-84 = 280，与面板右缘 256
      // 的间距恰好 24px（不小于 STENCIL_AVOID_GAP_PX）。
      const nodeLeftEdgeScreen = anchor.x * result!.scale + result!.tx - anchorSize.width / 2;
      expect(nodeLeftEdgeScreen - avoidZone.right).toBe(STENCIL_AVOID_GAP_PX);
    });

    it('面板收起（不传 avoidZone，即 estimateStencilPanelAvoidZone 对收起态返回 null）：等同原有 30%/50% 规则，不绕开', () => {
      const result = computeInitialAnchorTranslate(anchor, containerSize, { anchorSize, avoidZone: null });
      expect(result).toEqual({ scale: 1, tx: 96, ty: 72 }); // 与不传 options 时的既有用例同一个结果
    });

    it('面板被拖到不挡的位置（垂直范围只覆盖容器底部一小段，不到目标行）：不绕开，仍按 30% 规则', () => {
      // 目标行 = [300-28,300+28] = [272,328]；面板占位 [550,650] 与该行完全不重叠。
      const avoidZone = { right: 900, top: 550, bottom: 650 };
      const result = computeInitialAnchorTranslate(anchor, containerSize, { anchorSize, avoidZone });
      expect(result).toEqual({ scale: 1, tx: 96, ty: 72 });
    });

    it('面板被拖到右侧（垂直范围仍挡住目标行，但 right 已经很大）：受"不推出容器右侧"的 90% 上限约束', () => {
      const avoidZone = { right: 920, top: 8, bottom: 500 }; // 挡住目标行，且右缘已接近容器边缘
      const result = computeInitialAnchorTranslate(anchor, containerSize, { anchorSize, avoidZone });
      // minCenterX = 920+24+84=1028，超出 90% 上限 900，被钳制到 900。
      expect(result).toEqual({ scale: 1, tx: 900 - 204, ty: 72 });
      expect(result!.tx + anchor.x).toBeLessThanOrEqual(containerSize.width * 0.9);
    });

    it('极窄容器：即便面板挡住目标行，钳制上限（90%）仍然优先生效，不把节点推出可视区', () => {
      const narrowContainer = { width: 200, height: 400 }; // 90% = 180
      const avoidZone = { right: 100, top: 0, bottom: 400 }; // 覆盖整列，必然与任意行重叠
      const result = computeInitialAnchorTranslate({ x: 0, y: 0 }, narrowContainer, { anchorSize, avoidZone });
      expect(result).toEqual({ scale: 1, tx: 180, ty: 200 });
      expect(result!.tx).toBeLessThan(narrowContainer.width);
    });

    it('不传 anchorSize（防御性场景）：按 0 宽高处理，行带退化成目标点本身，仍能正确判定重叠', () => {
      const avoidZone = { right: 256, top: 8, bottom: 500 };
      const result = computeInitialAnchorTranslate(anchor, containerSize, { avoidZone });
      // anchorHeight=0 时行带退化为单点 targetY=300，仍落在 [8,500] 内 → 判定重叠；但
      // anchorWidth=0 时 minCenterX = 256+24+0 = 280，小于 30% 规则已经给出的 targetX(300)，
      // max(300,280) 不变——最终结果与"未绕开"一致，只是巧合于这组数值，不代表跳过了绕开分支。
      expect(result).toEqual({ scale: 1, tx: 96, ty: 72 });
    });
  });
});

// 双击节点库新增节点后"刚好让它完整可见"的最小平移。
describe('computeMinimalPanToReveal（双击新增节点后把视口平移到刚好完整可见）', () => {
  const containerSize = { width: 800, height: 600 };

  it('目标矩形已经完整可见（含默认 padding 留白）时返回 null，不产生任何视口改动', () => {
    const current = { scale: 1, tx: 0, ty: 0 };
    // 矩形屏幕范围 [100,150]-[300,200]，四边距容器边缘都 ≥ DEFAULT_FIT_PADDING(48)。
    const rect = { minX: 100, minY: 150, maxX: 300, maxY: 200 };
    expect(computeMinimalPanToReveal(rect, current, containerSize)).toBeNull();
  });

  it('矩形右侧越界：只在水平方向平移，垂直方向不变', () => {
    const current = { scale: 1, tx: 0, ty: 0 };
    const rect = { minX: 700, minY: 100, maxX: 900, maxY: 150 }; // 右缘 900 超出容器宽度 800
    const result = computeMinimalPanToReveal(rect, current, containerSize);
    expect(result).not.toBeNull();
    expect(result!.ty).toBe(0); // 垂直方向本就在可见范围内，不变
    // 平移后矩形右缘恰好落在"容器宽度 - padding"处。
    expect(rect.maxX * result!.scale + result!.tx).toBeCloseTo(containerSize.width - DEFAULT_FIT_PADDING, 6);
  });

  it('矩形左侧越界（负坐标）：平移量为正，把矩形推回可见范围', () => {
    const current = { scale: 1, tx: 0, ty: 0 };
    const rect = { minX: -100, minY: 100, maxX: 50, maxY: 150 };
    const result = computeMinimalPanToReveal(rect, current, containerSize);
    expect(result).not.toBeNull();
    expect(rect.minX * result!.scale + result!.tx).toBeCloseTo(DEFAULT_FIT_PADDING, 6);
  });

  it('矩形底部越界：只在垂直方向平移', () => {
    const current = { scale: 1, tx: 10, ty: -20 };
    const rect = { minX: 100, minY: 550, maxX: 200, maxY: 650 }; // 底缘超出容器高度 600
    const result = computeMinimalPanToReveal(rect, current, containerSize);
    expect(result).not.toBeNull();
    expect(result!.tx).toBe(10); // 水平方向不变
    expect(rect.maxY * result!.scale + result!.ty).toBeCloseTo(containerSize.height - DEFAULT_FIT_PADDING, 6);
  });

  it('容器尺寸无效时返回 null（回退现有行为，不产生 NaN）', () => {
    const current = { scale: 1, tx: 0, ty: 0 };
    const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(computeMinimalPanToReveal(rect, current, { width: 0, height: 600 })).toBeNull();
  });

  it('非 1 缩放下同样正确换算（screen = model*scale + translate）', () => {
    const current = { scale: 2, tx: 0, ty: 0 };
    // 模型坐标 500 在 scale=2 时屏幕坐标为 1000，超出容器宽度 800。
    const rect = { minX: 480, minY: 100, maxX: 520, maxY: 150 };
    const result = computeMinimalPanToReveal(rect, current, containerSize);
    expect(result).not.toBeNull();
    expect(result!.scale).toBe(2); // 只平移不缩放
    expect(rect.maxX * result!.scale + result!.tx).toBeCloseTo(containerSize.width - DEFAULT_FIT_PADDING, 6);
  });
});
