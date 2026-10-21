/**
 * graph/x6-adapter.center-and-zoom.test.ts —— centerOn(nodeId)（校验点击定位）与状态栏缩放滑杆
 * （zoomToPercent）两项能力的单测。
 *
 * 为什么这份测试要真的 `new X6GraphAdapter(...).mount(container)`（不像 x6-adapter.visual.test.ts
 * 那样只测纯函数、刻意避开真实 X6 Graph）：centerOn/zoomToPercent 的正确性天然依赖"给定一个
 * cell/给定一个百分比，adapter 有没有把正确的值转发给 X6"，这段转发逻辑必须挂在真实 Graph 实例
 * 上才存在（this.graph 是私有字段，没有别的缝可插）。
 *
 * 但实测：happy-dom 环境下 X6 的 TransformManager 无法把
 * translate/zoomTo 的计算结果写回可读的 DOM 变换矩阵——即使直接调用 `graph.translate(tx, ty)`
 * 或 `graph.zoomTo(scale)`，随后的 `graph.translate()`/`graph.zoom()`（读）与 DOM `transform`
 * 属性都仍是初始单位矩阵（同 x6-adapter.visual.test.ts 头注释"X6 Graph 挂载依赖真实 DOM
 * 布局测算，happy-dom 环境下代价大且脆"）。因此本文件不断言"读回的缩放/平移值"，
 * 改为 `vi.spyOn(Graph.prototype, 'translate' | 'zoomTo')`——这两个方法本身的**调用**在
 * happy-dom 下是可靠的（参数被正确捕获，只是底层渲染的 DOM 副作用不可读），断言"adapter 用
 * 正确的参数调用了它们"就是"视口确实按目标移动/缩放"这件事在这个测试环境下唯一可验证、也足够
 * 诚实的落点——不产生"看起来测了、其实测的是别的东西"的假绿。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Graph } from '@antv/x6';
import { computeCenterTranslate, X6GraphAdapter, type X6GraphMessages } from './x6-adapter';

const messages: X6GraphMessages = {
  renamePrompt: 'rename',
  rename: 'rename',
  copy: 'copy',
  delete: 'delete',
  editVertices: 'editVertices',
  clearVertices: 'clearVertices',
  deleteEdge: 'deleteEdge',
  paste: 'paste',
  fit: 'fit',
  zoom100: 'zoom100'
};

function mountAdapter(): { adapter: X6GraphAdapter; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const adapter = new X6GraphAdapter(messages);
  adapter.mount(container);
  return { adapter, container };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeCenterTranslate（纯函数，centerOn 的核心计算）', () => {
  it('目标点在容器中心时，translate 恰好为 0（缩放 1、容器居中对齐画布原点）', () => {
    expect(computeCenterTranslate({ x: 400, y: 300 }, 1, { width: 800, height: 600 })).toEqual({ tx: 0, ty: 0 });
  });

  it('公式＝容器中心 - 目标点 * 缩放（与 @antv/x6 transform.js positionPoint 的 dx/dy 公式等价）', () => {
    expect(computeCenterTranslate({ x: 550, y: 420 }, 1, { width: 800, height: 600 })).toEqual({ tx: -150, ty: -120 });
  });

  it('缩放不为 1 时按比例缩放目标点坐标', () => {
    expect(computeCenterTranslate({ x: 100, y: 100 }, 2, { width: 800, height: 600 })).toEqual({ tx: 200, ty: 100 });
  });

  it('容器尺寸为 0（happy-dom 无真实布局的兜底场景）：不产生 NaN，退化为负的目标点坐标', () => {
    expect(computeCenterTranslate({ x: 550, y: 420 }, 1, { width: 0, height: 0 })).toEqual({ tx: -550, ty: -420 });
  });
});

describe('X6GraphAdapter.centerOn（校验点击定位）', () => {
  it('给定节点 id，调用 graph.translate() 且传入值与该节点当前位置对应的 computeCenterTranslate 结果一致', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 500, y: 400 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 900, y: 100 } }
    ]);
    const spy = vi.spyOn(Graph.prototype, 'translate');

    adapter.centerOn('n1');

    // 节点宽 184、高 64（x6-adapter.ts NODE_WIDTH/NODE_HEIGHT），中心＝position + 半宽高。
    // NODE_WIDTH/NODE_HEIGHT 常量变更时这条断言需要同步。
    const n1Center = { x: 500 + 184 / 2, y: 400 + 64 / 2 };
    const expected = computeCenterTranslate(n1Center, 1, { width: 0, height: 0 }); // happy-dom 容器尺寸恒为 0
    expect(spy).toHaveBeenCalledWith(expected.tx, expected.ty);
    adapter.unmount();
  });

  it('视口确实"跟随"目标节点：定位到位置不同的两个节点，translate 调用参数随之不同', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 500, y: 400 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 900, y: 100 } }
    ]);
    const spy = vi.spyOn(Graph.prototype, 'translate');

    adapter.centerOn('n1');
    const [firstCallArgs] = spy.mock.calls;
    adapter.centerOn('n2');
    const secondCallArgs = spy.mock.calls[spy.mock.calls.length - 1];

    expect(secondCallArgs).not.toEqual(firstCallArgs);
    adapter.unmount();
  });

  it('对边 id 同样生效（IssuePanel/BlockPanel 的"定位路线"用同一个入口，见 x6-adapter.ts centerOn 注释）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'start', label: 'S', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'end', label: 'E', position: { x: 400, y: 0 } }
    ]);
    adapter.setEdges([{ id: 'e1', from: 'n1', to: 'n2' }]);
    const spy = vi.spyOn(Graph.prototype, 'translate');

    adapter.centerOn('e1');

    expect(spy).toHaveBeenCalled();
    adapter.unmount();
  });

  it('目标 id 不存在（已被删除等竞态）：静默跳过，不调用 translate、不抛错', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    const spy = vi.spyOn(Graph.prototype, 'translate');

    expect(() => adapter.centerOn('does-not-exist')).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    adapter.unmount();
  });

  it('尚未 mount 时调用：不抛错、不产生任何副作用', () => {
    const adapter = new X6GraphAdapter(messages);
    expect(() => adapter.centerOn('n1')).not.toThrow();
  });
});

// "首次打开设计器把发起节点锚到画布左中"用到的两个只读几何取值
// 方法——与 centerOn() 共用同一份 cell.getBBox().getCenter() 取值逻辑，但只返回数据、不产生
// 任何 translate 副作用（调用方 designer/canvas/DesignerCanvas.vue 拿到中心点后还要经
// designer/canvas/viewport.ts 的纯函数算一遍目标视口，不能像 centerOn() 那样直接落地）。
describe('X6GraphAdapter.getNodeCenter / getContainerSize（首次打开定位发起节点用的几何取值）', () => {
  it('getNodeCenter：给定存在的节点 id，返回其渲染包围盒中心（position + 半宽高）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'start', type: 'start', label: 'S', position: { x: 120, y: 200 } }]);

    // 胶囊（start/end）家族尺寸 168×56（x6-adapter.ts CAPSULE_WIDTH/CAPSULE_HEIGHT），
    // 中心 = position + 半宽高。
    expect(adapter.getNodeCenter('start')).toEqual({ x: 120 + 168 / 2, y: 200 + 56 / 2 });
    adapter.unmount();
  });

  it('getNodeCenter：目标 id 不存在时返回 null（不抛错，同 centerOn 的既定处理）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    expect(adapter.getNodeCenter('does-not-exist')).toBeNull();
    adapter.unmount();
  });

  it('getNodeCenter：尚未 mount 时调用返回 null，不抛错', () => {
    const adapter = new X6GraphAdapter(messages);
    expect(adapter.getNodeCenter('start')).toBeNull();
  });

  it('getContainerSize：已 mount 时返回容器 getBoundingClientRect 的宽高（happy-dom 下恒为 0，与 centerOn 同一测试环境下的既有断言口径一致）', () => {
    const { adapter } = mountAdapter();
    expect(adapter.getContainerSize()).toEqual({ width: 0, height: 0 });
    adapter.unmount();
  });

  it('getContainerSize：尚未 mount 时调用返回 null', () => {
    const adapter = new X6GraphAdapter(messages);
    expect(adapter.getContainerSize()).toBeNull();
  });
});

describe('X6GraphAdapter.zoomToPercent（状态栏缩放滑杆"设为指定缩放比"）', () => {
  it('把百分比换算成 X6 的小数缩放比（50% -> 0.5）转发给 graph.zoomTo', () => {
    const { adapter } = mountAdapter();
    const spy = vi.spyOn(Graph.prototype, 'zoomTo');

    adapter.zoomToPercent(50);

    expect(spy).toHaveBeenCalledWith(0.5);
    adapter.unmount();
  });

  it('钳制在 [20, 400] 区间内，同 mount() 里 mousewheel/zoomIn/zoomOut 的既有 minScale:0.2/maxScale:4', () => {
    const { adapter } = mountAdapter();
    const spy = vi.spyOn(Graph.prototype, 'zoomTo');

    adapter.zoomToPercent(5); // 低于下限
    expect(spy).toHaveBeenLastCalledWith(0.2);

    adapter.zoomToPercent(9999); // 高于上限
    expect(spy).toHaveBeenLastCalledWith(4);
    adapter.unmount();
  });

  it('尚未 mount 时调用：不抛错、不产生任何副作用', () => {
    const adapter = new X6GraphAdapter(messages);
    expect(() => adapter.zoomToPercent(50)).not.toThrow();
  });
});
