/**
 * graph/x6-adapter.set-palette.test.ts —— X6GraphAdapter.setPalette() 就地重绘单测（设计器画布
 * 暗色支持）。
 *
 * 与 x6-adapter.visual.test.ts（手写假 cell，不实例化真实 Graph）不同：本文件直接测
 * X6GraphAdapter.setPalette() 这个类方法本身——它内部要拿到真实挂载的 Graph 才有意义
 * （this.graph.drawBackground()/drawGrid()、graph.getNodes()/getEdges()、node.setPortProp()），
 * 因此 `new X6GraphAdapter(messages); adapter.mount(container);` 挂真实 Graph，用私有字段
 * 逃逸拿到内部 Graph 实例直接读回 cell 的当前 attrs（`cell.attr(path)` 单参数是 X6 官方 getter
 * 重载，见 @antv/x6 model/cell.d.ts）。
 *
 * 覆盖 setPalette 的四处重绘：画布底色、网格点、已渲染节点/边的样式、节点端口配置。每处都先读
 * 一次"切换前（LIGHT_PALETTE）"的值、再调用 setPalette(一份刻意与亮色处处不同的测试用 palette)
 * 之后读一次"切换后"的值，双向断言（等于新值、不等于旧值）——反证：把 setPalette() 方法体内的
 * 重绘调用注释掉，本文件会整体变红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Graph, type Node } from '@antv/x6';
import { X6GraphAdapter, type X6GraphMessages } from './x6-adapter';
import { LIGHT_PALETTE, type CanvasPalette } from '../model/design-tokens';

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

/** 本文件挂载过的全部 adapter 实例——afterEach 里逐个 unmount()（见下方注释）。 */
const mountedAdapters: X6GraphAdapter[] = [];

/** 挂载真实 X6GraphAdapter。
 * 🔴 real-Graph 环境坑：happy-dom 对 SVG `className`（返回裸字符串而非带 `.baseVal` 的
 * SVGAnimatedString）支持不全，X6 渲染多行文本节点（label/summary 等 text 元素，本文件的
 * 'approve'/'end' 类型节点都会产出）时若测试收尾不调用 `adapter.unmount()`（触发
 * `Graph.dispose()`），这处不兼容会在测试用例返回之后才被异步抛出，被 vitest 判定为
 * "unhandled error"（不影响断言结果，但会污染整条 `pnpm test` 输出/退出码）。本文件因此不用
 * 既有测试文件里"允许不 unmount"的简化写法——`mountAdapter()` 统一登记实例，afterEach 统一
 * unmount，问题消失。 */
function mountAdapter(): { adapter: X6GraphAdapter; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const adapter = new X6GraphAdapter(messages);
  adapter.mount(container);
  mountedAdapters.push(adapter);
  return { adapter, container };
}

/** 测试专用：逃逸拿到 X6GraphAdapter 私有持有的真实 Graph 实例。 */
function internalGraph(adapter: X6GraphAdapter): Graph {
  return (adapter as unknown as { graph: Graph }).graph;
}

/** 一份刻意与 LIGHT_PALETTE 每个会被 x6-adapter.ts 消费到的字段都不同的测试用 palette——不是
 * 真实的暗色推导值（design-tokens.test.ts 已经钉死 buildPalette 的暗色推导规则，不是本文件的
 * 职责），只用来验证"setPalette 传入的这份 palette 真的被用上了"这一件事：任何一处忘记接线，
 * 对应断言就会仍旧读到 LIGHT_PALETTE 的旧值而变红。 */
const TEST_PALETTE: CanvasPalette = {
  ...LIGHT_PALETTE,
  canvasBg: 'rgb(1 1 1)',
  gridDot: 'rgb(2 2 2)',
  surface: 'rgb(3 3 3)',
  border: 'rgb(4 4 4)',
  edge: 'rgb(5 5 5)',
  nodeTypes: {
    ...LIGHT_PALETTE.nodeTypes,
    approve: { iconBg: 'rgb(6 6 6)', iconColor: 'rgb(7 7 7)' }
  }
};

function setupScene(adapter: X6GraphAdapter): void {
  adapter.setNodes([
    { id: 'n1', type: 'approve', label: '审批', position: { x: 0, y: 0 } },
    { id: 'n2', type: 'end', label: '结束', position: { x: 300, y: 0 } }
  ]);
  adapter.setEdges([{ id: 'e1', from: 'n1', to: 'n2' }]);
}

afterEach(() => {
  // 见 mountAdapter() 注释——统一 unmount 避免真实 Graph 渲染文本节点在 happy-dom 下的已知
  // 环境坑污染测试输出。
  mountedAdapters.splice(0).forEach((adapter) => adapter.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('X6GraphAdapter.setPalette（真实 Graph）', () => {
  it('画布底色/网格：调用 graph.drawBackground/drawGrid，且带上新 palette 的颜色', () => {
    const { adapter } = mountAdapter();
    setupScene(adapter);
    const backgroundSpy = vi.spyOn(Graph.prototype, 'drawBackground');
    const gridSpy = vi.spyOn(Graph.prototype, 'drawGrid');

    adapter.setPalette(TEST_PALETTE);

    expect(backgroundSpy).toHaveBeenCalledWith({ color: 'rgb(1 1 1)' });
    expect(gridSpy).toHaveBeenCalledWith({ type: 'dot', args: { color: 'rgb(2 2 2)', thickness: 1 } });
  });

  it('已渲染的普通业务节点：body 白底、iconBg/icon 随新 palette 重新着色', () => {
    const { adapter } = mountAdapter();
    setupScene(adapter);
    const graph = internalGraph(adapter);
    const node = graph.getCellById('n1') as Node;
    // 切换前：亮色（LIGHT_PALETTE），确认这条断言本身有意义（不是恒真）。
    expect(node.attr('body/fill')).toBe(LIGHT_PALETTE.surface);
    expect(node.attr('iconBg/fill')).toBe(LIGHT_PALETTE.nodeTypes.approve.iconBg);

    adapter.setPalette(TEST_PALETTE);

    expect(node.attr('body/fill')).toBe('rgb(3 3 3)');
    expect(node.attr('iconBg/fill')).toBe('rgb(6 6 6)');
    // approve 图标是描边风格（NODE_ICONS.approve.fill === false，见 applyNodeVisual 对
    // icon.fill 的三元判断），因此颜色落在 stroke 而不是 fill 上（fill 恒为 'none'）。
    expect(node.attr('icon/stroke')).toBe('rgb(7 7 7)');
    // 双向断言：确实变了，不是巧合等于旧值。
    expect(node.attr('body/fill')).not.toBe(LIGHT_PALETTE.surface);
  });

  // 不设 structure（菱形）节点与分支结构块容器的重新着色用例：当前没有任何 NodeKind 映射到
  // 'structure' 形状家族（见 model/node-visual.ts NODE_SHAPE_FAMILY 注释），分支条件表达在
  // 引导线上，画布也不渲染分支结构块容器，这类断言没有真实输入。

  it('已渲染的端口圆点：四个方向端口的 fill 随新 palette 的 surface 重设（stroke 品牌蓝不变）', () => {
    const { adapter } = mountAdapter();
    setupScene(adapter);
    const graph = internalGraph(adapter);
    const node = graph.getCellById('n1') as Node;
    // 切换前：端口 fill 只在 group 级别配置（portGroups() 创建时写入），单个端口自身没有 attrs
    // 覆盖——getPortProp 读的是 item 级别的覆盖值，此时应为 undefined（同 setPortProp 注释
    // "item 级 attrs 覆盖优先于 group 级"，切换前从未写过 item 级覆盖）。
    expect(node.getPortProp<string | undefined>('port-top', 'attrs/circle/fill')).toBeUndefined();

    adapter.setPalette(TEST_PALETTE);

    for (const group of ['top', 'right', 'bottom', 'left']) {
      expect(node.getPortProp<string>(`port-${group}`, 'attrs/circle/fill')).toBe('rgb(3 3 3)');
    }
  });

  it('已渲染的边：line/stroke 随新 palette 的 edge 重新着色', () => {
    const { adapter } = mountAdapter();
    setupScene(adapter);
    const graph = internalGraph(adapter);
    const edge = graph.getCellById('e1');
    if (!edge?.isEdge()) throw new Error('e1 未渲染成边');
    expect(edge.attr('line/stroke')).toBe(LIGHT_PALETTE.edge);

    adapter.setPalette(TEST_PALETTE);

    expect(edge.attr('line/stroke')).toBe('rgb(5 5 5)');
  });

  it('未挂载时调用 setPalette：只记下新 palette 不抛错；随后 mount()/setNodes() 用它渲染', () => {
    const adapter = new X6GraphAdapter(messages);
    mountedAdapters.push(adapter); // 见 afterEach 注释——同样需要收尾 unmount()
    expect(() => adapter.setPalette(TEST_PALETTE)).not.toThrow();
    const container = document.createElement('div');
    document.body.appendChild(container);
    adapter.mount(container);
    adapter.setNodes([{ id: 'n1', type: 'approve', label: '审批', position: { x: 0, y: 0 } }]);
    const graph = internalGraph(adapter);
    const node = graph.getCellById('n1') as Node;
    // mount() 之前调过的 setPalette 被记在 this.palette 上（见该方法"未挂载时只记下新 palette"
    // 一段），setNodes() 创建新 cell 时用它 apply 视觉——不是恒定回落到 LIGHT_PALETTE。
    expect(node.attr('body/fill')).toBe('rgb(3 3 3)');
  });
});
