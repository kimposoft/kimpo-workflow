/**
 * designer/canvas/svg-adapter-viewport.test.ts —— SvgGraphAdapter viewport（缩放/平移/适应视图）
 * 的 DOM 级集成测试。通过 '../../graph' 公开导出的 SvgGraphAdapter 做黑盒测试，不依赖
 * graph/svg-adapter.test.ts 内部任何私有 helper。
 *
 * 覆盖重点（最容易出 bug 处）：缩放后节点拖拽的屏幕像素位移 -> 画布坐标位移换算，
 * 以及 getContentBounds() 与 designer/canvas/viewport.ts 的 computeFitViewport() 组合使用的
 * 端到端正确性。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvgGraphAdapter } from '../../graph';
import type { GraphNodeView } from '../../graph';
import { computeFitViewport, computeViewBox, DEFAULT_VIEWPORT } from './viewport';

/** 同 graph/svg-adapter.test.ts 的既有做法：happy-dom 对 PointerEvent 构造函数支持不稳定，
 * 统一用 MouseEvent 手工挂 pointerId。 */
function firePointerEvent(target: EventTarget, type: string, init: { clientX: number; clientY: number; pointerId?: number }): void {
  const event = new MouseEvent(type, { clientX: init.clientX, clientY: init.clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
}

/** happy-dom 默认不做真实布局，clientWidth/clientHeight 恒为 0；用 defineProperty 模拟一个
 * 真实容器尺寸，让 setViewport() 里的 viewBox 落地分支可测。 */
function stubContainerSize(container: HTMLElement, width: number, height: number): void {
  Object.defineProperty(container, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: height, configurable: true });
}

// svg-adapter.ts 有两档尺寸（NODE_WIDTH/HEIGHT 160x64 的矩形 与 BRANCH_NODE_SIZE 56x56 的菱形，
// 见该文件 nodeSize()），但当前没有任何 NodeKind 映射到菱形一档，因此样例只用矩形类型节点
// （start/handle，均 160x64），混合尺寸的包围盒计算场景暂不可测。
function sampleNodes(): GraphNodeView[] {
  return [
    { id: 'n-start', type: 'start', label: '开始', position: { x: 0, y: 0 } }, // 160x64
    { id: 'n-split', type: 'handle', label: '办理', position: { x: 300, y: 100 } } // 160x64
  ];
}

describe('designer/canvas SvgGraphAdapter viewport 集成', () => {
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

  it('getViewport() 默认返回恒等映射（scale=1, x=y=0）', () => {
    expect(adapter.getViewport()).toEqual(DEFAULT_VIEWPORT);
  });

  it('getContentBounds() 无节点时返回 null', () => {
    expect(adapter.getContentBounds()).toBeNull();
  });

  it('getContentBounds() 按各节点位置 + 尺寸精确计算包围盒（两节点均 160x64，见 sampleNodes 头注释）', () => {
    adapter.setNodes(sampleNodes());
    const bounds = adapter.getContentBounds();
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 460, maxY: 164 }); // max(300+160, 0+160)=460; max(100+64, 0+64)=164
  });

  it('setViewport() 在容器尺寸有效时把 viewBox 落地到 <svg>，并可通过 getViewport() 读回', () => {
    stubContainerSize(container, 800, 400);
    adapter.setViewport({ scale: 2, x: 10, y: 20 });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('10 20 400 200');
    expect(adapter.getViewport()).toEqual({ scale: 2, x: 10, y: 20 });
  });

  it('setViewport() 在容器尺寸无效（未布局）时仍记录状态，但不写入 viewBox 属性', () => {
    // 不 stub 容器尺寸：happy-dom 默认 clientWidth/clientHeight = 0。
    adapter.setViewport({ scale: 2, x: 10, y: 20 });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBeNull();
    expect(adapter.getViewport()).toEqual({ scale: 2, x: 10, y: 20 });
  });

  it('缩放（scale=2）后拖拽节点：屏幕像素位移需除以 scale 才是画布坐标位移，不能 1:1 直接相加', () => {
    stubContainerSize(container, 800, 400);
    adapter.setNodes(sampleNodes());
    adapter.setViewport({ scale: 2, x: 0, y: 0 });

    const onNodeMoveEnd = vi.fn();
    adapter.on('nodeMoveEnd', onNodeMoveEnd);

    const nodeEl = container.querySelector('[data-node-id="n-start"]')!;
    firePointerEvent(nodeEl, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 9 });
    firePointerEvent(window, 'pointermove', { clientX: 100, clientY: 40, pointerId: 9 });
    firePointerEvent(window, 'pointerup', { clientX: 100, clientY: 40, pointerId: 9 });

    // 原点 (0,0)，屏幕位移 (100,40)，scale=2 => 画布位移应为 (50,20)，而不是裸的 (100,40)。
    expect(onNodeMoveEnd).toHaveBeenCalledWith('n-start', { x: 50, y: 20 });
  });

  it('scale=1（默认视口）时拖拽换算与未缩放时的像素位移一致', () => {
    adapter.setNodes(sampleNodes());
    const onNodeMoveEnd = vi.fn();
    adapter.on('nodeMoveEnd', onNodeMoveEnd);

    const nodeEl = container.querySelector('[data-node-id="n-start"]')!;
    firePointerEvent(nodeEl, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 5 });
    firePointerEvent(window, 'pointermove', { clientX: 30, clientY: 15, pointerId: 5 });
    firePointerEvent(window, 'pointerup', { clientX: 30, clientY: 15, pointerId: 5 });

    expect(onNodeMoveEnd).toHaveBeenCalledWith('n-start', { x: 30, y: 15 });
  });

  it('getContentBounds() 与 viewport.ts 的 computeFitViewport() 组合：fit 后的 viewBox 完整覆盖内容包围盒', () => {
    stubContainerSize(container, 1000, 600);
    adapter.setNodes(sampleNodes());
    const bounds = adapter.getContentBounds()!;
    const containerSize = { width: 1000, height: 600 };
    const fitted = computeFitViewport(bounds, containerSize, 40);
    adapter.setViewport(fitted);

    const svg = container.querySelector('svg')!;
    const vb = computeViewBox(fitted, containerSize);
    expect(svg.getAttribute('viewBox')).toBe(`${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    expect(vb.x).toBeLessThanOrEqual(bounds.minX);
    expect(vb.y).toBeLessThanOrEqual(bounds.minY);
    expect(vb.x + vb.width).toBeGreaterThanOrEqual(bounds.maxX);
    expect(vb.y + vb.height).toBeGreaterThanOrEqual(bounds.maxY);
  });
});
