import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvgGraphAdapter } from './svg-adapter';
import type { GraphEdgeView, GraphNodeView } from './port';
// SvgGraphAdapter 直接消费 design-tokens.ts 的唯一色板权威源，见下方"防两画布视觉跑偏"一测——不做假设、直接比对渲染
// 出的 fill/stroke 属性与 NODE_TYPE_TOKENS 是否一致。
import { NODE_TYPE_TOKENS } from '../model/design-tokens';

/**
 * happy-dom 对 PointerEvent 构造函数的支持不稳定，这里统一用 MouseEvent 并手工挂
 * pointerId，规避构造函数差异——适配器内部只读 clientX/clientY/pointerId 三个字段
 * （见 svg-adapter.ts handlePointerMove/handlePointerUp），MouseEvent 已含前两者。
 */
function firePointerEvent(target: EventTarget, type: string, init: { clientX: number; clientY: number; pointerId?: number }): void {
  const event = new MouseEvent(type, { clientX: init.clientX, clientY: init.clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
}

function sampleNodes(): GraphNodeView[] {
  return [
    { id: 'n-start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
    { id: 'n-approve', type: 'approve', label: '审批', position: { x: 200, y: 0 } },
    { id: 'n-end', type: 'end', label: '结束', position: { x: 400, y: 0 } }
  ];
}
function sampleEdges(): GraphEdgeView[] {
  return [
    { id: 'e-1', from: 'n-start', to: 'n-approve' },
    { id: 'e-2', from: 'n-approve', to: 'n-end' }
  ];
}

describe('graph/svg-adapter SvgGraphAdapter', () => {
  let container: HTMLElement;
  let adapter: SvgGraphAdapter;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    adapter = new SvgGraphAdapter();
    adapter.mount(container);
  });

  afterEach(() => {
    adapter.unmount();
    container.remove();
  });

  it('mount() 在容器内创建带 role=img 的 svg', () => {
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('role')).toBe('img');
  });

  it('setNodes/setEdges 渲染出对应数量的 [data-node-id]/[data-edge-id] 元素', () => {
    adapter.setNodes(sampleNodes());
    adapter.setEdges(sampleEdges());
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-edge-id]')).toHaveLength(2);
    const edge = container.querySelector('[data-edge-id="e-1"]');
    expect(edge?.getAttribute('data-from-node-id')).toBe('n-start');
    expect(edge?.getAttribute('data-to-node-id')).toBe('n-approve');
  });

  it('setSelection 给对应节点/边加上 is-selected class', () => {
    adapter.setNodes(sampleNodes());
    adapter.setEdges(sampleEdges());
    adapter.setSelection(['n-approve'], ['e-1']);
    const node = container.querySelector('[data-node-id="n-approve"]');
    const edgeLine = container.querySelector('[data-edge-id="e-1"] .kimpo-wf-graph__edge');
    expect(node?.getAttribute('class')).toContain('is-selected');
    expect(edgeLine?.getAttribute('class')).toContain('is-selected');
  });

  it('setReadOnly(true) 隐藏连接手柄，setReadOnly(false) 恢复', () => {
    adapter.setNodes(sampleNodes());
    adapter.setReadOnly(true);
    expect(container.querySelectorAll('.kimpo-wf-graph__connector')).toHaveLength(0);
    adapter.setReadOnly(false);
    expect(container.querySelectorAll('.kimpo-wf-graph__connector').length).toBeGreaterThan(0);
  });

  it('点击节点（无位移的 pointerdown+pointerup）触发 nodeSelect(id)', () => {
    adapter.setNodes(sampleNodes());
    const onNodeSelect = vi.fn();
    adapter.on('nodeSelect', onNodeSelect);

    const nodeEl = container.querySelector('[data-node-id="n-start"]')!;
    firePointerEvent(nodeEl, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 7 });
    firePointerEvent(window, 'pointerup', { clientX: 10, clientY: 10, pointerId: 7 });

    expect(onNodeSelect).toHaveBeenCalledWith('n-start');
  });

  it('点击画布空白处触发 nodeSelect(null) 与 edgeSelect(null)', () => {
    adapter.setNodes(sampleNodes());
    const onNodeSelect = vi.fn();
    const onEdgeSelect = vi.fn();
    adapter.on('nodeSelect', onNodeSelect);
    adapter.on('edgeSelect', onEdgeSelect);

    const svg = container.querySelector('svg')!;
    firePointerEvent(svg, 'pointerdown', { clientX: 5, clientY: 5 });

    expect(onNodeSelect).toHaveBeenCalledWith(null);
    expect(onEdgeSelect).toHaveBeenCalledWith(null);
  });

  it('点击边的命中区域触发 edgeSelect(id)', () => {
    adapter.setNodes(sampleNodes());
    adapter.setEdges(sampleEdges());
    const onEdgeSelect = vi.fn();
    adapter.on('edgeSelect', onEdgeSelect);

    const hit = container.querySelector('[data-edge-id="e-1"] .kimpo-wf-graph__edge-hit')!;
    firePointerEvent(hit, 'pointerdown', { clientX: 100, clientY: 30 });

    expect(onEdgeSelect).toHaveBeenCalledWith('e-1');
  });

  it('拖拽节点（超过阈值的位移）触发 nodeMoveEnd 而不是 nodeSelect', () => {
    adapter.setNodes(sampleNodes());
    const onNodeSelect = vi.fn();
    const onNodeMoveEnd = vi.fn();
    adapter.on('nodeSelect', onNodeSelect);
    adapter.on('nodeMoveEnd', onNodeMoveEnd);

    const nodeEl = container.querySelector('[data-node-id="n-start"]')!;
    firePointerEvent(nodeEl, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 3 });
    firePointerEvent(window, 'pointermove', { clientX: 50, clientY: 20, pointerId: 3 });
    firePointerEvent(window, 'pointerup', { clientX: 50, clientY: 20, pointerId: 3 });

    expect(onNodeSelect).not.toHaveBeenCalled();
    expect(onNodeMoveEnd).toHaveBeenCalledWith('n-start', { x: 50, y: 20 }); // 原点 (0,0) + 位移 (50,20)
  });

  it('unmount() 移除 svg 并停止响应后续调用', () => {
    adapter.setNodes(sampleNodes());
    adapter.unmount();
    expect(container.querySelector('svg')).toBeNull();
    // unmount 后续调用不应抛错（幂等防御）。
    expect(() => adapter.setNodes(sampleNodes())).not.toThrow();
  });

  // branch_split/branch_join 节点类型已退役（GraphNodeView['type'] 不再承认这两个字面量），
  // svg-adapter.ts 的 DIAMOND_NODE_TYPES 虽仍保留这两个字符串但没有真实节点能命中，故不为
  // "菱形渲染/不渲染连接手柄"设用例；矩形渲染由上方 sampleNodes（approve/start/end）间接覆盖。

  // 🔴 反向验证：本测试直接比对渲染出的 fill/stroke 与 design-tokens.ts NODE_TYPE_TOKENS——
  // 若 svg-adapter.ts 又改回自行维护一份独立配色表（哪怕碰巧数值一样也不行，因为那样两块画布
  // 会各自漂移），或者随手改坏某个类型的 token 值，这条断言必须变红。
  it('节点 fill/stroke 直接取自 design-tokens.ts NODE_TYPE_TOKENS（防两画布视觉跑偏）', () => {
    adapter.setNodes(sampleNodes());
    const approveRect = container.querySelector('[data-node-id="n-approve"] rect')!;
    expect(approveRect.getAttribute('fill')).toBe(NODE_TYPE_TOKENS.approve.iconBg);
    expect(approveRect.getAttribute('stroke')).toBe(NODE_TYPE_TOKENS.approve.iconColor);

    const startRect = container.querySelector('[data-node-id="n-start"] rect')!;
    expect(startRect.getAttribute('fill')).toBe(NODE_TYPE_TOKENS.start.iconBg);
    expect(startRect.getAttribute('stroke')).toBe(NODE_TYPE_TOKENS.start.iconColor);
  });

  it('isElseRoute 边渲染带 is-else class（兜底路线虚线）', () => {
    adapter.setNodes(sampleNodes());
    adapter.setEdges([{ id: 'e-1', from: 'n-start', to: 'n-approve', isElseRoute: true }]);
    const edgeLine = container.querySelector('[data-edge-id="e-1"] .kimpo-wf-graph__edge');
    expect(edgeLine?.getAttribute('class')).toContain('is-else');
  });
});
