// designer/stencil/floating-panel.test.ts —— 浮动节点库面板几何计算单测：夹回边界、容器变小、
// 非法存储值回退、点击/拖动判别阈值、夹回用实测尺寸（不用公式估算值）、共享的本地存储读写、
// "绕开浮动节点库面板"估算函数 estimateStencilPanelAvoidZone。见 floating-panel.ts 头注释。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampPanelPosition,
  computeStencilPanelBodyMaxHeight,
  DEFAULT_STENCIL_PANEL_POSITION,
  DEFAULT_STENCIL_PANEL_STATE,
  estimateStencilPanelAvoidZone,
  FLOATING_PANEL_MARGIN,
  isDragGesture,
  parsePersistedStencilPanelState,
  readPersistedStencilPanelState,
  STENCIL_PANEL_DRAG_CLICK_THRESHOLD_PX,
  STENCIL_PANEL_HANDLE_HEIGHT,
  STENCIL_PANEL_ICON_SIZE,
  STENCIL_PANEL_MIN_BODY_HEIGHT,
  STENCIL_PANEL_WIDTH,
  writePersistedStencilPanelState
} from './floating-panel';

describe('clampPanelPosition：夹回边界', () => {
  const panelSize = { width: 248, height: 300 };
  const container = { width: 1000, height: 800 };

  it('位置在容器内部时原样返回（不误夹）', () => {
    expect(clampPanelPosition({ x: 100, y: 100 }, panelSize, container)).toEqual({ x: 100, y: 100 });
  });

  it('位置超出右边界时夹回到 container.width - panelSize.width - margin', () => {
    const result = clampPanelPosition({ x: 5000, y: 100 }, panelSize, container);
    expect(result.x).toBe(container.width - panelSize.width - FLOATING_PANEL_MARGIN);
  });

  it('位置超出下边界时夹回到 container.height - panelSize.height - margin', () => {
    const result = clampPanelPosition({ x: 100, y: 5000 }, panelSize, container);
    expect(result.y).toBe(container.height - panelSize.height - FLOATING_PANEL_MARGIN);
  });

  it('位置为负值时夹回到 FLOATING_PANEL_MARGIN（不贴死到 0，留一点间隙）', () => {
    const result = clampPanelPosition({ x: -999, y: -999 }, panelSize, container);
    expect(result).toEqual({ x: FLOATING_PANEL_MARGIN, y: FLOATING_PANEL_MARGIN });
  });

  it('非法数值（NaN）整体退回边距下限，不产出 NaN', () => {
    const result = clampPanelPosition({ x: Number.NaN, y: 100 }, panelSize, container);
    expect(result.x).toBe(FLOATING_PANEL_MARGIN);
    expect(Number.isFinite(result.x)).toBe(true);
  });
});

describe('clampPanelPosition：容器变小（窗口/画布尺寸变化时自动夹回）', () => {
  it('容器缩小后，此前合法的位置若越界会被重新夹回到新边界内', () => {
    const panelSize = { width: 248, height: 300 };
    const previousPosition = { x: 600, y: 400 }; // 在旧的大容器里合法
    const shrunkContainer = { width: 700, height: 500 };
    const result = clampPanelPosition(previousPosition, panelSize, shrunkContainer);
    expect(result.x).toBeLessThanOrEqual(shrunkContainer.width - panelSize.width);
    expect(result.y).toBeLessThanOrEqual(shrunkContainer.height - panelSize.height);
  });

  it('容器比面板本身还小（极端情况）时退化为贴左上角，不产生负向宽度的可用区间', () => {
    const panelSize = { width: 248, height: 300 };
    const tinyContainer = { width: 100, height: 100 }; // 比 panelSize 还小
    const result = clampPanelPosition({ x: 50, y: 50 }, panelSize, tinyContainer);
    expect(result).toEqual({ x: FLOATING_PANEL_MARGIN, y: FLOATING_PANEL_MARGIN });
  });

  it('容器尺寸为 0（尚未测出真实尺寸的初始态）时不产生 NaN/Infinity，退化为贴左上角', () => {
    const panelSize = { width: 248, height: 300 };
    const result = clampPanelPosition({ x: 0, y: 0 }, panelSize, { width: 0, height: 0 });
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(result).toEqual({ x: FLOATING_PANEL_MARGIN, y: FLOATING_PANEL_MARGIN });
  });

  it('收起态图标（36px 见方）用更小的 panelSize 夹回，允许比展开态更贴近边缘', () => {
    const iconSize = { width: STENCIL_PANEL_ICON_SIZE, height: STENCIL_PANEL_ICON_SIZE };
    const container = { width: 300, height: 300 };
    const result = clampPanelPosition({ x: 290, y: 290 }, iconSize, container);
    expect(result.x).toBe(container.width - STENCIL_PANEL_ICON_SIZE - FLOATING_PANEL_MARGIN);
  });
});

describe('computeStencilPanelBodyMaxHeight：主体可用高度随 y 坐标动态收缩', () => {
  it('面板贴容器顶部时，主体高度 ≈ 容器高度 - 标题栏 - 边距', () => {
    const containerHeight = 800;
    const positionY = 12;
    const result = computeStencilPanelBodyMaxHeight(containerHeight, positionY);
    expect(result).toBe(containerHeight - positionY - STENCIL_PANEL_HANDLE_HEIGHT - FLOATING_PANEL_MARGIN);
  });

  it('面板被拖到容器底部附近时，主体高度钳在 STENCIL_PANEL_MIN_BODY_HEIGHT 下限，不会压缩到 0', () => {
    const result = computeStencilPanelBodyMaxHeight(800, 780);
    expect(result).toBe(STENCIL_PANEL_MIN_BODY_HEIGHT);
  });

  it('容器高度小于面板本身占用（含标题栏）时同样钳在下限，不产出负数', () => {
    const result = computeStencilPanelBodyMaxHeight(100, 10);
    expect(result).toBe(STENCIL_PANEL_MIN_BODY_HEIGHT);
  });
});

describe('isDragGesture：点击 / 拖动判别阈值', () => {
  it('总位移为 0（纯点击）判定为非拖动', () => {
    expect(isDragGesture(0)).toBe(false);
  });

  it('总位移恰好等于阈值时判定为非拖动（严格大于才算拖动，阈值内的抖动仍算点击）', () => {
    expect(isDragGesture(STENCIL_PANEL_DRAG_CLICK_THRESHOLD_PX)).toBe(false);
  });

  it('总位移超过阈值 1px 时判定为拖动', () => {
    expect(isDragGesture(STENCIL_PANEL_DRAG_CLICK_THRESHOLD_PX + 1)).toBe(true);
  });

  it('总位移远超阈值（真实拖动）判定为拖动', () => {
    expect(isDragGesture(200)).toBe(true);
  });
});

describe('parsePersistedStencilPanelState：非法本地存储值一律回退默认值，页面照常渲染', () => {
  it('合法值原样通过', () => {
    const valid = { position: { x: 50, y: 60 }, collapsed: true };
    expect(parsePersistedStencilPanelState(valid)).toEqual(valid);
  });

  it('null / undefined 回退默认值', () => {
    expect(parsePersistedStencilPanelState(null)).toEqual(DEFAULT_STENCIL_PANEL_STATE);
    expect(parsePersistedStencilPanelState(undefined)).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });

  it('非对象（字符串/数字/数组）回退默认值', () => {
    expect(parsePersistedStencilPanelState('not-an-object')).toEqual(DEFAULT_STENCIL_PANEL_STATE);
    expect(parsePersistedStencilPanelState(123)).toEqual(DEFAULT_STENCIL_PANEL_STATE);
    expect(parsePersistedStencilPanelState([1, 2, 3])).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });

  it('缺 position 字段回退默认值', () => {
    expect(parsePersistedStencilPanelState({ collapsed: false })).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });

  it('position 里 x/y 类型不对（字符串）回退默认值', () => {
    expect(parsePersistedStencilPanelState({ position: { x: '50', y: 60 }, collapsed: false })).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });

  it('position 里 x/y 为 NaN/Infinity 回退默认值', () => {
    expect(parsePersistedStencilPanelState({ position: { x: Number.NaN, y: 0 }, collapsed: false })).toEqual(DEFAULT_STENCIL_PANEL_STATE);
    expect(parsePersistedStencilPanelState({ position: { x: 0, y: Number.POSITIVE_INFINITY }, collapsed: false })).toEqual(
      DEFAULT_STENCIL_PANEL_STATE
    );
  });

  it('缺 collapsed 字段或类型不对（非布尔）回退默认值', () => {
    expect(parsePersistedStencilPanelState({ position: { x: 1, y: 2 } })).toEqual(DEFAULT_STENCIL_PANEL_STATE);
    expect(parsePersistedStencilPanelState({ position: { x: 1, y: 2 }, collapsed: 'yes' })).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });

  it('默认值本身等于 DEFAULT_STENCIL_PANEL_POSITION + collapsed:false（两个导出常量口径一致）', () => {
    expect(DEFAULT_STENCIL_PANEL_STATE.position).toEqual(DEFAULT_STENCIL_PANEL_POSITION);
    expect(DEFAULT_STENCIL_PANEL_STATE.collapsed).toBe(false);
  });
});

// 夹回必须用面板根元素的实测宽高，不能用"主体最大高度"公式估算值——
// 公式给出的是 StencilPanel 本体一层的上限，没有把标题栏（32px）与面板自身边框（2px）算进去，
// 真实渲染出来的整块面板比公式估算值更高，拖到画布角落时会溢出定位容器 5～13px（见
// FloatingStencilPanel.vue measuredSize 头注释）。clampPanelPosition 这个纯函数本身是通用的
// （给什么尺寸就按什么尺寸夹），根因完全在调用侧"传了哪个尺寸"，因此这里用一个刻意比公式算出的
// 上限还大的高度验证：只要传对了尺寸，夹回结果就不会溢出。
describe('clampPanelPosition：夹回必须用真实渲染尺寸而不是"主体最大高度"公式估算值', () => {
  it('实测高度 > computeStencilPanelBodyMaxHeight 算出的主体上限时，仍按实测高度完整夹回，包围盒不溢出容器', () => {
    const containerHeight = 500;
    const positionY = 400; // 拖到接近容器底部
    const bodyMaxHeightFormula = computeStencilPanelBodyMaxHeight(containerHeight, positionY); // 公式上限（不含标题栏/边框）
    // 真实渲染高度 = 标题栏 32px + 边框 2px + 公式给出的主体上限——刻意构造成比公式估算值更大，
    // 复现"公式漏算一截"的根因场景。
    const measuredHeight = bodyMaxHeightFormula + STENCIL_PANEL_HANDLE_HEIGHT + 2;
    const container = { width: 300, height: containerHeight };
    const result = clampPanelPosition({ x: 10, y: positionY }, { width: STENCIL_PANEL_WIDTH, height: measuredHeight }, container);
    // 夹回后面板包围盒（y ~ y+measuredHeight）必须完全落在容器内，不溢出。
    expect(result.y + measuredHeight).toBeLessThanOrEqual(container.height);
    expect(result.y).toBeGreaterThanOrEqual(FLOATING_PANEL_MARGIN);
  });

  it('对照：若错误地只用 bodyMaxHeightFormula 当作面板整体高度去夹回，会算出一个仍然溢出真实渲染高度的 y', () => {
    const containerHeight = 500;
    const positionY = 400;
    const bodyMaxHeightFormula = computeStencilPanelBodyMaxHeight(containerHeight, positionY);
    const measuredHeight = bodyMaxHeightFormula + STENCIL_PANEL_HANDLE_HEIGHT + 2;
    const container = { width: 300, height: containerHeight };
    // 根因复现：错误地传公式值当面板高度。
    const wrongResult = clampPanelPosition({ x: 10, y: positionY }, { width: STENCIL_PANEL_WIDTH, height: bodyMaxHeightFormula }, container);
    // 用这个夹回结果去装真实渲染高度的面板，会溢出容器——这正是要防的缺陷。
    expect(wrongResult.y + measuredHeight).toBeGreaterThan(container.height);
  });
});

describe('readPersistedStencilPanelState / writePersistedStencilPanelState：共享的本地存储读写', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('未写入过时读到默认值', () => {
    expect(readPersistedStencilPanelState()).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });

  it('写入后能读回同一份状态（与 FloatingStencilPanel.vue 挂载时读的必须是同一份，见函数头注释）', () => {
    const state = { position: { x: 123, y: 45 }, collapsed: true };
    writePersistedStencilPanelState(state);
    expect(readPersistedStencilPanelState()).toEqual(state);
  });

  it('存储里是非法 JSON 时读回默认值，不抛错', () => {
    localStorage.setItem('kimpo_workflow_designer_stencil_panel_v1', '{not-json');
    expect(readPersistedStencilPanelState()).toEqual(DEFAULT_STENCIL_PANEL_STATE);
  });
});

// 估算面板此刻的占位，供"首次打开画布绕开浮动节点库面板"使用——四类
// 场景对齐 DesignerRoot.vue computeStencilAvoidZone 消费处的实际输入形状。
describe('estimateStencilPanelAvoidZone：首次打开锚定发起节点时估算面板占位', () => {
  const wrapSize = { width: 848, height: 706 };

  it('面板展开默认位：按"主体最大高度"公式估算高度，返回三边占位', () => {
    const zone = estimateStencilPanelAvoidZone(DEFAULT_STENCIL_PANEL_STATE, wrapSize);
    expect(zone).not.toBeNull();
    const expectedHeight = STENCIL_PANEL_HANDLE_HEIGHT + computeStencilPanelBodyMaxHeight(wrapSize.height, DEFAULT_STENCIL_PANEL_STATE.position.y);
    expect(zone).toEqual({
      right: DEFAULT_STENCIL_PANEL_STATE.position.x + STENCIL_PANEL_WIDTH,
      top: DEFAULT_STENCIL_PANEL_STATE.position.y,
      bottom: DEFAULT_STENCIL_PANEL_STATE.position.y + expectedHeight
    });
  });

  it('面板收起：返回 null（36px 图标不构成遮挡，调用方按"当前不需要绕开"处理）', () => {
    const zone = estimateStencilPanelAvoidZone({ position: { x: 28, y: 28 }, collapsed: true }, wrapSize);
    expect(zone).toBeNull();
  });

  it('面板被拖到右侧（持久化位置已经很靠右，但仍在容器可夹回范围内）：估算占位跟着位置走，right 相应变大', () => {
    const persisted = { position: { x: 400, y: 28 }, collapsed: false }; // 400 未越出 clampPanelPosition 的可用区间，不会被夹回改写
    const zone = estimateStencilPanelAvoidZone(persisted, wrapSize);
    expect(zone).not.toBeNull();
    expect(zone!.right).toBe(400 + STENCIL_PANEL_WIDTH);
  });

  it('极窄容器（比面板本身还窄）：内部经 clampPanelPosition 夹回，不产生越界或 NaN 的占位', () => {
    const tinyWrapSize = { width: 100, height: 100 };
    const zone = estimateStencilPanelAvoidZone(DEFAULT_STENCIL_PANEL_STATE, tinyWrapSize);
    expect(zone).not.toBeNull();
    expect(Number.isFinite(zone!.right)).toBe(true);
    expect(Number.isFinite(zone!.top)).toBe(true);
    expect(Number.isFinite(zone!.bottom)).toBe(true);
    expect(zone!.top).toBeGreaterThanOrEqual(FLOATING_PANEL_MARGIN);
  });
});
