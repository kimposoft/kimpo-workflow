// designer/shell/props-panel-position.test.ts —— 属性面板浮层几何计算单测：夹回边界（用实测尺寸夹回，不是公式估算值——本模块的 clampPanelPosition 本身就只接受
// 调用方传入的"此刻尺寸"这一个参数，不内部再猜测/重算，这份约束由类型签名保证，单测覆盖的是
// "传入不同的实测尺寸，夹回结果确实随之变化"）、默认位置随容器宽度变化、持久化读写往返、与
// 节点库浮层的 localStorage key 互不串。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampPanelPosition,
  computePropsPanelBodyMaxHeight,
  defaultPropsPanelPosition,
  FLOATING_PANEL_MARGIN,
  isDragGesture,
  parsePersistedPropsPanelState,
  PROPS_PANEL_DRAG_CLICK_THRESHOLD_PX,
  PROPS_PANEL_HANDLE_HEIGHT,
  PROPS_PANEL_ICON_SIZE,
  PROPS_PANEL_MIN_BODY_HEIGHT,
  PROPS_PANEL_WIDTH,
  readPersistedPropsPanelState,
  writePersistedPropsPanelState,
  type PropsPanelPersistedState
} from './props-panel-position';

describe('clampPanelPosition：夹回用调用方传入的实测尺寸，不是内部公式估算值', () => {
  const container = { width: 1000, height: 800 };

  it('位置在容器内部时原样返回（不误夹）', () => {
    expect(clampPanelPosition({ x: 100, y: 100 }, { width: PROPS_PANEL_WIDTH, height: 400 }, container)).toEqual({ x: 100, y: 100 });
  });

  it('超出右边界时夹回到 container.width - 实测宽度 - margin', () => {
    const measured = { width: PROPS_PANEL_WIDTH, height: 400 };
    const result = clampPanelPosition({ x: 5000, y: 100 }, measured, container);
    expect(result.x).toBe(container.width - measured.width - FLOATING_PANEL_MARGIN);
  });

  it('同一个越界位置，换一份更大的"实测尺寸"传入，夹回结果会更靠左——证明夹回真的吃的是传入尺寸而非写死常量', () => {
    const smallMeasured = { width: 200, height: 300 };
    const bigMeasured = { width: 400, height: 600 };
    const smallResult = clampPanelPosition({ x: 5000, y: 5000 }, smallMeasured, container);
    const bigResult = clampPanelPosition({ x: 5000, y: 5000 }, bigMeasured, container);
    expect(bigResult.x).toBeLessThan(smallResult.x);
    expect(bigResult.y).toBeLessThan(smallResult.y);
  });

  it('收起态图标（36px 见方）用更小的实测尺寸夹回，允许比展开态更贴近边缘', () => {
    const iconSize = { width: PROPS_PANEL_ICON_SIZE, height: PROPS_PANEL_ICON_SIZE };
    const expandedSize = { width: PROPS_PANEL_WIDTH, height: 400 };
    const iconResult = clampPanelPosition({ x: 5000, y: 5000 }, iconSize, container);
    const expandedResult = clampPanelPosition({ x: 5000, y: 5000 }, expandedSize, container);
    expect(iconResult.x).toBeGreaterThan(expandedResult.x);
  });

  it('容器比面板本身还小（极端情况）时退化为贴左上角，不产生负向宽度的可用区间', () => {
    const result = clampPanelPosition({ x: 50, y: 50 }, { width: PROPS_PANEL_WIDTH, height: 400 }, { width: 100, height: 100 });
    expect(result).toEqual({ x: FLOATING_PANEL_MARGIN, y: FLOATING_PANEL_MARGIN });
  });

  it('非法数值（NaN）整体退回边距下限，不产出 NaN', () => {
    const result = clampPanelPosition({ x: Number.NaN, y: 100 }, { width: PROPS_PANEL_WIDTH, height: 400 }, container);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(result.x).toBe(FLOATING_PANEL_MARGIN);
  });
});

describe('defaultPropsPanelPosition：默认位置是容器宽度的函数，不是冻结常量', () => {
  it('容器越宽，默认落点的 x 越靠右（贴右上角，不是节点库那种写死的左上角）', () => {
    const narrow = defaultPropsPanelPosition(800);
    const wide = defaultPropsPanelPosition(1600);
    expect(wide.x).toBeGreaterThan(narrow.x);
  });

  it('x 恰好是"容器宽度 - 面板宽度 - 间距"，落在右上角', () => {
    const containerWidth = 1200;
    const result = defaultPropsPanelPosition(containerWidth);
    expect(result.x).toBe(containerWidth - PROPS_PANEL_WIDTH - FLOATING_PANEL_MARGIN);
  });

  it('容器窄到比面板还小时不产生负值，退化贴左边距', () => {
    const result = defaultPropsPanelPosition(100);
    expect(result.x).toBe(FLOATING_PANEL_MARGIN);
  });

  it('y 恒为顶部标尺高度 + 间距（不随容器宽度变化）', () => {
    const a = defaultPropsPanelPosition(800).y;
    const b = defaultPropsPanelPosition(1600).y;
    expect(a).toBe(b);
  });
});

describe('computePropsPanelBodyMaxHeight：主体可用高度随 y 坐标与容器高度变化', () => {
  it('面板越靠容器下方，主体可用高度越小', () => {
    const near = computePropsPanelBodyMaxHeight(800, 50);
    const far = computePropsPanelBodyMaxHeight(800, 700);
    expect(far).toBeLessThan(near);
  });

  it('下限钳在 PROPS_PANEL_MIN_BODY_HEIGHT，不会被压缩到看不见', () => {
    const result = computePropsPanelBodyMaxHeight(200, 190);
    expect(result).toBe(PROPS_PANEL_MIN_BODY_HEIGHT);
  });

  // 主体高度不为右下角小地图扣固定预留：浮层底边恰好落在容器底边留出 FLOATING_PANEL_MARGIN
  // 处，允许盖住小地图，避免节点设置浮层高度被小地图压缩。
  it('主体撑到容器底部，只留底部间隙，不再为小地图预留高度', () => {
    const positionY = 28;
    for (const containerHeight of [400, 600, 900, 1200]) {
      const bodyMaxHeight = computePropsPanelBodyMaxHeight(containerHeight, positionY);
      expect(positionY + PROPS_PANEL_HANDLE_HEIGHT + bodyMaxHeight).toBe(containerHeight - FLOATING_PANEL_MARGIN);
    }
  });

  it('容器极矮时下限仍优先，返回 PROPS_PANEL_MIN_BODY_HEIGHT', () => {
    const result = computePropsPanelBodyMaxHeight(150, 140);
    expect(result).toBe(PROPS_PANEL_MIN_BODY_HEIGHT);
  });
});

describe('isDragGesture：点击/拖动判别阈值', () => {
  it('位移不超过阈值判定为点击', () => {
    expect(isDragGesture(PROPS_PANEL_DRAG_CLICK_THRESHOLD_PX)).toBe(false);
  });
  it('位移超过阈值判定为拖动', () => {
    expect(isDragGesture(PROPS_PANEL_DRAG_CLICK_THRESHOLD_PX + 0.1)).toBe(true);
  });
});

describe('parsePersistedPropsPanelState：非法/缺失时返回 undefined（不是冻结默认值）', () => {
  it('合法值原样通过', () => {
    const raw: PropsPanelPersistedState = { position: { x: 10, y: 20 }, collapsed: false, pinned: true };
    expect(parsePersistedPropsPanelState(raw)).toEqual(raw);
  });
  it('缺 pinned 字段视为非法', () => {
    expect(parsePersistedPropsPanelState({ position: { x: 1, y: 2 }, collapsed: false })).toBeUndefined();
  });
  it('缺 collapsed 字段视为非法', () => {
    expect(parsePersistedPropsPanelState({ position: { x: 1, y: 2 }, pinned: false })).toBeUndefined();
  });
  it('position 里带 NaN 视为非法', () => {
    expect(parsePersistedPropsPanelState({ position: { x: Number.NaN, y: 2 }, collapsed: false, pinned: false })).toBeUndefined();
  });
  it('非对象整体视为非法', () => {
    expect(parsePersistedPropsPanelState(null)).toBeUndefined();
    expect(parsePersistedPropsPanelState('garbage')).toBeUndefined();
  });
});

describe('读写往返 + 与节点库浮层的 localStorage key 互不串', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('写入后能原样读回', () => {
    const state: PropsPanelPersistedState = { position: { x: 111, y: 222 }, collapsed: true, pinned: false };
    writePersistedPropsPanelState(state);
    expect(readPersistedPropsPanelState()).toEqual(state);
  });

  it('从未写过时读回 undefined（不是某个默认值）', () => {
    expect(readPersistedPropsPanelState()).toBeUndefined();
  });

  it('storage 里手改成非法 JSON 时读回 undefined，不抛异常', () => {
    localStorage.setItem('kimpo_workflow_designer_props_panel_v1', '{not json');
    expect(readPersistedPropsPanelState()).toBeUndefined();
  });

  it('写入属性面板状态不会污染节点库浮层的 key（也不会被它污染）——两者读写各自独立', () => {
    const stencilKey = 'kimpo_workflow_designer_stencil_panel_v1';
    localStorage.setItem(stencilKey, JSON.stringify({ position: { x: 1, y: 2 }, collapsed: true }));

    const propsState: PropsPanelPersistedState = { position: { x: 50, y: 60 }, collapsed: false, pinned: true };
    writePersistedPropsPanelState(propsState);

    // 属性面板的读取结果只反映自己那份，节点库那份原样保留、未被覆盖。
    expect(readPersistedPropsPanelState()).toEqual(propsState);
    expect(JSON.parse(localStorage.getItem(stencilKey) as string)).toEqual({ position: { x: 1, y: 2 }, collapsed: true });

    // 两个 key 在 localStorage 里确实是各自独立的两条记录。
    expect(localStorage.getItem('kimpo_workflow_designer_props_panel_v1')).not.toBeNull();
    expect(localStorage.getItem(stencilKey)).not.toBeNull();
    expect(localStorage.getItem('kimpo_workflow_designer_props_panel_v1')).not.toBe(localStorage.getItem(stencilKey));
  });
});
