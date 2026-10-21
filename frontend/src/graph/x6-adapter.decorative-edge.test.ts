/**
 * graph/x6-adapter.decorative-edge.test.ts —— 只渲染不入库的装饰边（审批按钮
 * 「不通过并结束流程」→ 结束节点的示意虚线，画布设计态）在画布适配器里的行为。
 *
 * 两层验证：
 *   1) applyEdgeVisual 的装饰分支——用手写假 cell（同 x6-adapter.visual.test.ts 手法）读回视觉；
 *   2) 真实挂载 X6GraphAdapter（同 x6-adapter.selection.test.ts 手法）验证 setEdges 增删更新、
 *      不可选中、不进 getLayout、不参与贴边就近判定、不可交互。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Graph } from '@antv/x6';
import { applyEdgeVisual, X6GraphAdapter, type EdgeVisualCell, type X6GraphMessages } from './x6-adapter';
import type { GraphEdgeView, GraphNodeView } from './port';
import { LIGHT_PALETTE } from '../model/design-tokens';

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

const NODES: GraphNodeView[] = [
  { id: 'a1', type: 'approve', label: '审批', position: { x: 0, y: 0 } },
  { id: 'e1', type: 'end', label: '结束', position: { x: 400, y: 0 } }
];

/** 文档里的一条真实连线（对照组）。 */
const REAL_EDGE: GraphEdgeView = { id: 'l1', from: 'a1', to: 'e1', marker: { kind: 'none', shortLabel: '', tooltip: '' } };

/** 装饰边：审批 → 结束，线上标按钮名。 */
const DECO_EDGE: GraphEdgeView = {
  id: 'x6-deco-endflow-a1-b1',
  from: 'a1',
  to: 'e1',
  label: '不通过并结束',
  marker: { kind: 'endflow', shortLabel: '不通过并结束', tooltip: '' },
  decorative: true
};

function internalGraph(adapter: X6GraphAdapter): Graph {
  return (adapter as unknown as { graph: Graph }).graph;
}

function mountAdapter(): X6GraphAdapter {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const adapter = new X6GraphAdapter(messages);
  adapter.mount(container);
  adapter.setNodes(NODES);
  return adapter;
}

let adapterUnderTest: X6GraphAdapter | undefined;
afterEach(() => {
  adapterUnderTest?.unmount();
  adapterUnderTest = undefined;
});

/** 假边 cell：记录 attr/setLabels 的最后一次调用，见 x6-adapter.visual.test.ts。 */
function makeFakeEdgeCell() {
  const attrs: Record<string, unknown> = {};
  let labels: unknown[] = [];
  const cell: EdgeVisualCell = {
    attr: (path: string, value: unknown) => {
      attrs[path] = value;
    },
    setSource: () => undefined,
    setTarget: () => undefined,
    setLabels: (next) => {
      labels = next;
    }
  };
  return { cell, attrs, labels: () => labels };
}

describe('applyEdgeVisual：装饰边视觉分支', () => {
  it('危险色虚线 + 箭头，忽略 hasIssues/hasCondition/isElseRoute，标签为危险色按钮名胶囊', () => {
    const { cell, attrs, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, { ...DECO_EDGE, hasIssues: true, hasCondition: true }, { source: 'port-right', target: 'port-left' });
    const line = attrs.line as { stroke: string; strokeDasharray: string; targetMarker: unknown };
    expect(line.stroke).toBe(LIGHT_PALETTE.semantic.danger);
    expect(line.strokeDasharray).toBe('6 4');
    expect(line.targetMarker).toBeTruthy();
    // 对鼠标完全透明 + 可供自动化识别的标记。
    expect(attrs['root/style/pointerEvents']).toBe('none');
    expect(attrs['root/data-decorative']).toBe('true');
    const [label] = labels() as Array<{ tooltip: string; attrs: { label: { text: string; fill: string }; body: { stroke: string } } }>;
    expect(label.attrs.label.text).toBe('不通过并结束');
    expect(label.attrs.label.fill).toBe(LIGHT_PALETTE.semantic.danger);
    expect(label.attrs.body.stroke).toBe(LIGHT_PALETTE.semantic.danger);
    // 无 tooltip：onEdgeLabelRendered 不会为它挂悬停监听。
    expect(label.tooltip).toBe('');
  });

  it('普通连线不受影响：不写 pointerEvents / data-decorative', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, REAL_EDGE, { source: 'port-right', target: 'port-left' });
    expect(attrs['root/style/pointerEvents']).toBeUndefined();
    expect(attrs['root/data-decorative']).toBeUndefined();
  });
});

describe('X6GraphAdapter：装饰边与画布交互', () => {
  it('setEdges 能增、更新、删装饰边（按 id 复用同一个 cell，按钮改名标签跟着变）', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    const graph = internalGraph(adapter);
    adapter.setEdges([REAL_EDGE, DECO_EDGE]);
    expect(graph.getEdges().map((edge) => edge.id).sort()).toEqual(['l1', DECO_EDGE.id]);
    const created = graph.getCellById(DECO_EDGE.id);

    adapter.setEdges([REAL_EDGE, { ...DECO_EDGE, marker: { kind: 'endflow', shortLabel: '驳回终止', tooltip: '' } }]);
    expect(graph.getCellById(DECO_EDGE.id)).toBe(created);
    const labels = (created as unknown as { getLabels(): Array<{ attrs: { label: { text: string } } }> }).getLabels();
    expect(labels[0].attrs.label.text).toBe('驳回终止');

    adapter.setEdges([REAL_EDGE]);
    expect(graph.getCellById(DECO_EDGE.id)).toBeNull();
    expect(graph.getCellById('l1')).toBeTruthy();
  });

  it('不可选中：setSelection / graph.select 都选不上装饰边，节点仍可选', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    const graph = internalGraph(adapter);
    adapter.setEdges([REAL_EDGE, DECO_EDGE]);

    adapter.setSelection([], [DECO_EDGE.id]);
    expect(graph.getSelectedCells()).toHaveLength(0);
    graph.select(graph.getCellById(DECO_EDGE.id));
    expect(graph.getSelectedCells()).toHaveLength(0);

    // 过滤只针对装饰边，不误伤其它 cell（节点仍可选；真实连线的选中框在 happy-dom 下无法测算
    // 几何，故用节点作对照，边的选中路径同一个 filter）。
    adapter.setSelection(['a1'], [DECO_EDGE.id]);
    expect(graph.getSelectedCells().map((cell) => cell.id)).toEqual(['a1']);
  });

  it('不进 getLayout：即使被塞了折点，edgeVertices 也不含装饰边；真实连线折点照常保存', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    const graph = internalGraph(adapter);
    adapter.setEdges([REAL_EDGE, DECO_EDGE]);
    (graph.getCellById(DECO_EDGE.id) as unknown as { setVertices(v: unknown[]): void }).setVertices([{ x: 10, y: 10 }]);
    (graph.getCellById('l1') as unknown as { setVertices(v: unknown[]): void }).setVertices([{ x: 20, y: 20 }]);

    const layout = adapter.getLayout();
    expect(Object.keys(layout.edgeVertices ?? {})).toEqual(['l1']);
  });

  it('setLayout 不会把布局折点回填到装饰边上', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    const graph = internalGraph(adapter);
    adapter.setEdges([REAL_EDGE, DECO_EDGE]);
    adapter.setLayout({ edgeVertices: { [DECO_EDGE.id]: [{ x: 5, y: 5 }], l1: [{ x: 6, y: 6 }] } });
    expect((graph.getCellById(DECO_EDGE.id) as unknown as { getVertices(): unknown[] }).getVertices()).toHaveLength(0);
    expect((graph.getCellById('l1') as unknown as { getVertices(): unknown[] }).getVertices()).toHaveLength(1);
  });

  it('不参与贴边插入就近判定：只有装饰边时返回 undefined，两者并存时只命中真实连线', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    adapter.setEdges([DECO_EDGE]);
    expect(adapter.getNearestEdgeId({ x: 200, y: 20 })).toBeUndefined();
    adapter.setEdges([DECO_EDGE, REAL_EDGE]);
    expect(adapter.getNearestEdgeId({ x: 200, y: 20 })).toBe('l1');
  });

  it('可点击/交互被关闭：interacting 对装饰边返回 false、对真实连线返回 true；点击装饰边不加编辑工具', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    const graph = internalGraph(adapter);
    adapter.setEdges([REAL_EDGE, DECO_EDGE]);
    const interacting = (graph.options as unknown as { interacting: (view: { cell: { id: string } }) => boolean }).interacting;
    expect(interacting({ cell: { id: DECO_EDGE.id } })).toBe(false);
    expect(interacting({ cell: { id: 'l1' } })).toBe(true);

    const deco = graph.getCellById(DECO_EDGE.id) as unknown as { hasTools(): boolean };
    graph.trigger('edge:click', { edge: deco });
    expect(deco.hasTools()).toBe(false);
    const real = graph.getCellById('l1') as unknown as { hasTools(): boolean };
    graph.trigger('edge:click', { edge: real });
    expect(real.hasTools()).toBe(true);
  });

  it('右键装饰边不弹出菜单', () => {
    const adapter = (adapterUnderTest = mountAdapter());
    const graph = internalGraph(adapter);
    adapter.setEdges([DECO_EDGE]);
    const deco = graph.getCellById(DECO_EDGE.id);
    graph.trigger('edge:contextmenu', { e: { preventDefault() {}, clientX: 0, clientY: 0 }, edge: deco });
    expect(document.querySelector('.kimpo-workflow-context-menu')).toBeNull();
  });
});
