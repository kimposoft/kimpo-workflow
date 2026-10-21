/**
 * graph/x6-adapter.arrow-and-port-fix.test.ts —— 连线箭头与连接点显隐规则中，落在 X6GraphAdapter
 * 内部、必须挂真实 X6 Graph 才能验证的两项单测（"连线箭头方向"是 applyEdgeVisual 的
 * 纯函数级 attrs 计算，守护已放在 x6-adapter.visual.test.ts 里，不重复在这里挂真实 Graph）：
 *   ② 选中连线只保留 target 端一个箭头指向下游——'edge:click' / 右键菜单"编辑顶点"两处
 *      addTools() 到底加了哪几个工具，只有真实 Edge 模型的 getTools() 才能读回，纯函数测不到。
 *   ③ 节点连接点（ports）只在指针悬停该节点时显示，选中态不豁免
 *      ——node:mouseenter/mouseleave 改的是真实 Node 的 port 属性，同样要挂真实 Graph。
 *
 * 手法：`graph.trigger(eventName, payload)` 直接触发 bindGraphEvents() 内部注册的处理器，用
 * `as unknown as { graph: Graph }` 拿到私有 graph 字段——这类"内部事件到底怎么被处理"的行为
 * 除了触达真实内部状态别无它法。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Edge, Graph, Node } from '@antv/x6';
import { X6GraphAdapter, type X6GraphMessages } from './x6-adapter';

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

/** 见文件头注释——测试专用，拿到 X6GraphAdapter 私有持有的真实 Graph 实例。 */
function internalGraph(adapter: X6GraphAdapter): Graph {
  return (adapter as unknown as { graph: Graph }).graph;
}

/** Cell.getTools() 的 items 可能是裸字符串或 {name,args?}，统一取出工具名数组方便断言。 */
function toolNames(edge: Edge): (string | null | undefined)[] {
  return (edge.getTools()?.items ?? []).map((item) => (typeof item === 'string' ? item : item.name));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('②选中连线只保留 target 端箭头：edge:click / 右键"编辑顶点" 的 addTools()', () => {
  function setupEdge(adapter: X6GraphAdapter): Edge {
    adapter.setNodes([
      { id: 'n1', type: 'start', label: 'S', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'end', label: 'E', position: { x: 300, y: 0 } }
    ]);
    adapter.setEdges([{ id: 'e1', from: 'n1', to: 'n2' }]);
    return internalGraph(adapter).getCellById('e1') as Edge;
  }

  it('单击连线（edge:click）：只加 vertices + target-arrowhead，不再加 source-arrowhead', () => {
    const { adapter } = mountAdapter();
    const edge = setupEdge(adapter);
    const graph = internalGraph(adapter);

    graph.trigger('edge:click', { edge, cell: edge, e: {} as never, x: 0, y: 0, view: {} as never });

    expect(toolNames(edge)).toEqual(['vertices', 'target-arrowhead']);
    expect(toolNames(edge)).not.toContain('source-arrowhead');
    adapter.unmount();
  });

  // 🔴 反向验证锚点：把生产代码的 addTools() 数组改回旧的三件套（补上 source-arrowhead），
  // 这条用例必须变红——证明它真的在守护"没有 source-arrowhead"这件事，不是碰巧对上一个宽松匹配。
  it('反向验证：工具数组长度恰好为 2（vertices + target-arrowhead），不是"至少包含"这种宽松断言', () => {
    const { adapter } = mountAdapter();
    const edge = setupEdge(adapter);
    const graph = internalGraph(adapter);

    graph.trigger('edge:click', { edge, cell: edge, e: {} as never, x: 0, y: 0, view: {} as never });

    expect(edge.getTools()?.items).toHaveLength(2);
    adapter.unmount();
  });

  it('只读模式：edge:click 不加任何工具（readOnly guard）', () => {
    const { adapter } = mountAdapter();
    const edge = setupEdge(adapter);
    adapter.setReadOnly(true);
    const graph = internalGraph(adapter);

    graph.trigger('edge:click', { edge, cell: edge, e: {} as never, x: 0, y: 0, view: {} as never });

    // Cell.getTools() 从未设置过时读回 undefined（Store.get 的既定行为，不是 null）——用同一份
    // toolNames() 口径断言"空"，避免这条用例因为 null/undefined 的字面量差异误报。
    expect(toolNames(edge)).toEqual([]);
    adapter.unmount();
  });

  it('右键菜单"编辑顶点"：同样只加 vertices + target-arrowhead（第二个改动入口，与 edge:click 一致）', () => {
    const { adapter, container } = mountAdapter();
    const edge = setupEdge(adapter);
    const graph = internalGraph(adapter);

    // openContextMenu() 右键落在未选中的 cell 上时会先 `graph.select(cell)`——对边而言，这会
    // 触发 Selection 插件的 showEdgeSelectionBox 分支去算 edge.getBBox()，依赖真实 DOM 的
    // SVGPoint.matrixTransform（happy-dom 未实现，见 x6-adapter.panning.test.ts
    // 头注释里同一个环境缺口）。本用例只关心"菜单按钮点击后
    // addTools() 加了什么"，与"这条边是否真的被选中"无关，桩掉 isSelected 让 openContextMenu
    // 走"已选中，不再重复 select"分支即可绕开，不影响本用例的断言目标。
    vi.spyOn(graph, 'isSelected').mockReturnValue(true);

    // openContextMenu 需要一个带 preventDefault/clientX/clientY 的 event 对象（见其签名），
    // 挂在 'edge:contextmenu' 上触发，同生产代码 `graph.on('edge:contextmenu', ({e,edge}) =>
    // this.openContextMenu(e, edge))` 完全一致的入口。
    graph.trigger('edge:contextmenu', {
      edge,
      cell: edge,
      e: { preventDefault: () => {}, clientX: 10, clientY: 10 } as never,
      x: 0,
      y: 0,
      view: {} as never
    });
    const menu = container.querySelector('.kimpo-workflow-context-menu');
    expect(menu).toBeTruthy();
    const editVerticesBtn = Array.from(menu!.querySelectorAll('button')).find((btn) => btn.textContent === messages.editVertices);
    expect(editVerticesBtn).toBeTruthy();
    editVerticesBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(toolNames(edge)).toEqual(['vertices', 'target-arrowhead']);
    adapter.unmount();
  });
});

describe('③节点连接点（ports）只在悬停时显示：node:mouseenter/mouseleave', () => {
  function setupNode(adapter: X6GraphAdapter): Node {
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    return internalGraph(adapter).getCellById('n1') as Node;
  }

  /** 四个方位（top/right/bottom/left）端口各自的 circle 可见性，顺序同 port.ts portGroups()
   * items 的固定声明顺序。读模型态 getPortProp()（同 bindGraphEvents 里 setPortProp() 写的
   * 是同一条路径）而不是读渲染 DOM——X6 的渲染走 Scheduler 异步批处理（happy-dom 下不保证在
   * `graph.trigger(...)` 同步返回时已经真的把节点/端口画进 DOM，本文件其余用例也统一不依赖
   * "读渲染 DOM 验证节点级视觉"，只有 openContextMenu 那个菜单 DOM 是本文件自己同步 append 的
   * 例外，见 ②"编辑顶点"用例）。
   *
   * 🔴 局限：这个口径只能验证"mouseenter/mouseleave 显式写过之后"的可见性，验证不了"创建、
   * 从未交互过"时的默认值是否为 hidden——那是 port.ts portGroups() 的**组级**默认 attrs，只在
   * DOM 渲染时合并生效，从未被写进某个具体端口自己的模型 props（getPortProp 在这种情况下读
   * 回 undefined，不是 'hidden'）。本文件因此不单独起一条"创建时默认隐藏"的用例；"悬停显示→
   * 离开隐藏"这条主线已经覆盖了"hover 显隐规则存在"。 */
  function portVisibilities(node: Node): string[] {
    return node.getPorts().map((port) => node.getPortProp<string>(port.id!, 'attrs/circle/style/visibility'));
  }

  it('mouseenter：四个端口都显示', () => {
    const { adapter } = mountAdapter();
    const node = setupNode(adapter);
    const graph = internalGraph(adapter);

    graph.trigger('node:mouseenter', { node, cell: node, e: {} as never, view: {} as never });

    expect(portVisibilities(node)).toEqual(['visible', 'visible', 'visible', 'visible']);
    adapter.unmount();
  });

  it('mouseleave：端口收回隐藏（普通态，未选中）', () => {
    const { adapter } = mountAdapter();
    const node = setupNode(adapter);
    const graph = internalGraph(adapter);

    graph.trigger('node:mouseenter', { node, cell: node, e: {} as never, view: {} as never });
    graph.trigger('node:mouseleave', { node, cell: node, e: {} as never, view: {} as never });

    expect(portVisibilities(node)).toEqual(['hidden', 'hidden', 'hidden', 'hidden']);
    adapter.unmount();
  });

  // 🔴 ③核心断言：选中 ≠ 端口常显——选中节点后指针离开，端口必须照样收回隐藏。若
  // mouseleave 处理器里出现 `if (graph.isSelected(node)) return` 这类豁免，这条用例会失败
  // （选中态下 mouseleave 直接跳过，端口停在 visible）。注：node 选中不会触发 Selection 插件的 showNodeSelectionBox 分支
  // （mount() 里已配置为 false，见其头注释），graph.select() 对节点是安全的，不需要像上面②的
  // 边选中用例那样额外规避 happy-dom 的 matrixTransform 缺口。
  it('反向验证：选中态同样不豁免——选中节点后指针离开，端口仍然收回隐藏', () => {
    const { adapter } = mountAdapter();
    const node = setupNode(adapter);
    const graph = internalGraph(adapter);

    adapter.setSelection(['n1'], []);
    expect(graph.isSelected(node)).toBe(true); // 前提：确实处于选中态，不是误测未选中场景

    graph.trigger('node:mouseenter', { node, cell: node, e: {} as never, view: {} as never });
    graph.trigger('node:mouseleave', { node, cell: node, e: {} as never, view: {} as never });

    expect(portVisibilities(node)).toEqual(['hidden', 'hidden', 'hidden', 'hidden']);
    adapter.unmount();
  });
});
