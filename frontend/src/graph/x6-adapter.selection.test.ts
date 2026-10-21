/**
 * graph/x6-adapter.selection.test.ts —— 节点选中态视觉与 X6 Selection 插件真实状态对齐。
 *
 * 背景：applyNodeVisual() 读的 GraphNodeView.selected 字段不由上游（designer/DesignerRoot.vue 的
 * `nodes` computed，经 designer/graph-bridge.ts toGraphNodes() 产出）赋值——这个字段恒为
 * undefined/false，若直接信任它，选中态视觉永远不会被触发。因此"当下真实选中态"的来源是 X6
 * Selection 插件自身（this.graph.isSelected(cell)，setSelection() 用它驱动 graph.select()），并在
 * setSelection() 变更选中状态之后主动重绘一次受影响的节点视觉（见 x6-adapter.ts
 * withCurrentSelection()/refreshNodeSelectionVisuals() 消费处）。
 *
 * 为什么这份测试要真的 `new X6GraphAdapter(...).mount(container)`：本文件要验证的正是
 * "setSelection() 调用之后，节点视觉是否真的按 X6 当前选中态重绘"，这必须挂在真实 Graph 实例
 * 上才能观测（`this.graph.isSelected()` 是真实 X6 状态，不是可以单独构造的纯函数输入）。
 *
 * 断言手法：不读渲染后的 DOM（happy-dom 下不可靠，见 x6-adapter.center-and-zoom.test.ts
 * 头注释同款结论），改为 `vi.spyOn(Node.prototype, 'attr')` 观察 applyNodeVisual() 对节点模型
 * 发出的 attr 调用——`cell.attr(path, value)` 本身是模型层写入（不依赖渲染测算），在 happy-dom
 * 下可靠捕获，同 centerOn/zoomToPercent 测试对 `graph.translate`/`graph.zoomTo` 的既定手法。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Node, type Graph } from '@antv/x6';
import { X6GraphAdapter, type X6GraphMessages } from './x6-adapter';

/** 测试专用：逃逸拿到 X6GraphAdapter 私有持有的真实 Graph 实例（同 x6-adapter.set-palette.test.ts
 * 等既有测试文件的既定手法）。 */
function internalGraph(adapter: X6GraphAdapter): Graph {
  return (adapter as unknown as { graph: Graph }).graph;
}

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

/** 取某个 path 最后一次被 attr() 写入的值（同一 path 可能因为 applyNodeVisual 的幂等重绘被
 * 调用多次，只关心最终结果，同 X6 attr(path, value) 同 path 后写覆盖前写的真实语义）。 */
function lastAttrValue(spy: ReturnType<typeof vi.spyOn>, path: string): unknown {
  const calls = spy.mock.calls.filter((call) => call[0] === path);
  return calls.length ? calls[calls.length - 1]![1] : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('X6GraphAdapter.setSelection 驱动选中态视觉刷新', () => {
  it('setSelection 选中一个节点：root/data-selected 写成 "true"，root/style/filter 写成含 drop-shadow 的光环', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    const spy = vi.spyOn(Node.prototype, 'attr');

    adapter.setSelection(['n1'], []);

    expect(lastAttrValue(spy, 'root/data-selected')).toBe('true');
    expect(lastAttrValue(spy, 'root/style/filter')).toContain('drop-shadow');
    adapter.unmount();
  });

  it('取消选中（setSelection([], [])）：root/data-selected 回写为 "false"，filter 清空为 "none"', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    adapter.setSelection(['n1'], []);
    const spy = vi.spyOn(Node.prototype, 'attr');

    adapter.setSelection([], []);

    expect(lastAttrValue(spy, 'root/data-selected')).toBe('false');
    expect(lastAttrValue(spy, 'root/style/filter')).toBe('none');
    adapter.unmount();
  });

  it('只选中其中一个节点：另一个未选中节点的视觉不受影响（root/data-selected 仍是 "false"）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 0 } }
    ]);
    const spy = vi.spyOn(Node.prototype, 'attr');

    adapter.setSelection(['n1'], []);

    // n1/n2 两个节点共用同一个 Node.prototype.attr spy，按调用发生时该次调用所在的 cell 区分
    // 不现实（spy 只知道参数、不知道 this），改为直接读回模型当前值——cell.attr() 无参调用
    // 返回完整 attrs 对象，是模型层读取，不依赖渲染测算，同样可靠。
    const graph = internalGraph(adapter);
    const n1Attrs = graph.getCellById('n1').attr() as { root?: Record<string, unknown> };
    const n2Attrs = graph.getCellById('n2').attr() as { root?: Record<string, unknown> };
    expect(n1Attrs.root?.['data-selected']).toBe('true');
    expect(n2Attrs.root?.['data-selected']).toBe('false');
    void spy;
    adapter.unmount();
  });

  it('尚未 mount 时调用 setSelection：不抛错、不产生任何副作用（同其余方法的既定处理）', () => {
    const adapter = new X6GraphAdapter(messages);
    expect(() => adapter.setSelection(['n1'], [])).not.toThrow();
  });

  it('选中后再次 setNodes（如内容更新触发的重绘）：不需要重新 setSelection，视觉仍保持选中——setNodes 的更新分支同样按 X6 当前选中态取值，不是恒 false', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    adapter.setSelection(['n1'], []);

    // 只调 setNodes（不跟着调 setSelection），模拟"业务数据变化触发的重绘、选中态本身没变"
    // 这类场景（如 DesignerCanvas.vue sync() 之外，若未来有调用方只想刷新节点内容）。
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A（已改名）', position: { x: 0, y: 0 } }]);

    const graph = internalGraph(adapter);
    const attrs = graph.getCellById('n1').attr() as { root?: Record<string, unknown> };
    expect(attrs.root?.['data-selected']).toBe('true');
    adapter.unmount();
  });
});
