/**
 * DesignerCanvas.etip.test.ts —— 悬停条件气泡 etip 的 300ms 计时器状态机
 * 单测：真实挂载 DesignerCanvas.vue（Vue 原生 createApp，项目未引入 @vue/test-utils，见
 * ../canvas/minimap-collapse.test.ts 头注释同款前提），但把 X6GraphAdapter 换成一个不碰真实
 * X6/DOM 布局测算的假实现——同 src/surfaces/designer.test.ts 头注释"X6 rendering itself is
 * browser-covered...replaced here to avoid its CommonJS/ESM loader incompatibility under
 * happy-dom"的既定手法：vi.mock 整个模块，真实 @antv/x6 从未被 import，因此可以放心在
 * happy-dom 下挂载整个 SFC，用 vi.useFakeTimers() 驱动 300ms 延迟做真实的动态行为断言，而不是
 * 只能读源码文本的"static"正则测试。
 *
 * 假适配器只需要满足 DesignerCanvas.vue 在 onMounted 里实际调用的方法面（setMinimapContainer/
 * mount/setNodes/setEdges/setSelection/setReadOnly/setLayout/setMessages/
 * getZoomPercent/unmount/on），并把 on() 注册的 handler 记下来，供测试直接 emit()
 * edgeMarkerHover/edgeMarkerLeave 模拟"画布检测到珠子被悬停/离开"这一事实——这正是
 * x6-adapter.ts mount() 里 onEdgeLabelRendered 回调实际做的事，这里不另行验证那部分
 * （已在 graph/x6-adapter.visual.test.ts 覆盖 buildMarkerLabelConfig 的 tooltip 透传），只测
 * DesignerCanvas.vue 收到这两个事件后的计时器/浮层状态机本身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 假适配器的最小可测接口——只有测试实际用到的 handlers/on/emit 三项（type-only 声明，不参与
 * vi.hoisted 的运行时求值，因此可以放在其之前而不触发 TS "used before declaration" 之外的
 * 顾虑：接口在编译期整体擦除，不存在提升问题）。 */
interface FakeAdapterInstance {
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  on(event: string, handler: (...args: unknown[]) => void): () => void;
  emit(event: string, ...args: unknown[]): void;
}

const { instances, FakeAdapter } = vi.hoisted(() => {
  const instances: FakeAdapterInstance[] = [];
  class FakeAdapter implements FakeAdapterInstance {
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(_messages: unknown) {
      instances.push(this);
    }
    setMinimapContainer(): void {}
    mount(): void {}
    unmount(): void {}
    setNodes(): void {}
    setEdges(): void {}
    setSelection(): void {}
    setReadOnly(): void {}
    setLayout(): void {}
    setMessages(): void {}
    getZoomPercent(): number {
      return 100;
    }
    // 🔴 DesignerCanvas.vue onMounted 无条件调用 adapter.getViewport()/adapter.onViewportChange(...)
    // （画布标尺用，见 CanvasRulers.vue），假适配器缺这两个方法会让 onMounted 抛错、mount 失败——
    // 只是补齐接口面，不是本文件要测的东西。
    getViewport(): { scaleX: number; tx: number; ty: number } {
      return { scaleX: 1, tx: 0, ty: 0 };
    }
    onViewportChange(): () => void {
      return () => undefined;
    }
    // 🔴 同上：DesignerCanvas.vue onMounted 无条件调用一次 adapter.setPalette(palette.value)
    // （画布暗色模式），假适配器
    // 缺这个方法会让 mount 抛错——本文件不测主题重绘本身（见 x6-adapter.ts 单测与
    // DesignerCanvas.theme.static.test.ts），这里只补齐接口面。
    setPalette(): void {}
    // 🔴 同上：DesignerCanvas.vue onMounted 无条件调用 applyInitialAnchor()（首次打开设计器把
    // 发起节点锚到画布左中），其内部依次调 adapter.getNodeCenter()/getContainerSize()——
    // 假适配器缺这两个方法会让 onMounted 抛错。
    // 返回 null 即可（对齐"找不到发起节点/容器无效时静默跳过"的回退行为，本文件不测这条
    // 逻辑本身，见 DesignerCanvas.initial-viewport.test.ts）。
    getNodeCenter(): { x: number; y: number } | null {
      return null;
    }
    getContainerSize(): { width: number; height: number } | null {
      return null;
    }
    on(event: string, handler: (...args: unknown[]) => void): () => void {
      (this.handlers[event] ??= []).push(handler);
      return () => {
        this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== handler);
      };
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers[event] ?? []) handler(...args);
    }
  }
  return { instances, FakeAdapter };
});

vi.mock('../../graph/x6-adapter', () => ({ X6GraphAdapter: FakeAdapter }));

import { createApp, nextTick } from 'vue';
import DesignerCanvas from './DesignerCanvas.vue';

const fakeI18n = {
  t: (key: string) => key,
  getLocale: () => 'zh-CN',
  onChange: () => () => undefined,
  setLocale: () => undefined,
  dispose: () => undefined
};

const mountedApps: Array<ReturnType<typeof createApp>> = [];

/** 挂载真实 DesignerCanvas.vue（假适配器接管，见文件头注释），返回宿主 DOM 节点与本次挂载
 * 产生的假适配器实例，供测试直接 emit 事件。 */
function mountCanvas(): { host: HTMLElement; adapter: FakeAdapterInstance } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(DesignerCanvas, {
    nodes: [],
    edges: [],
    selectedNodeIds: [],
    selectedEdgeIds: [],
    i18n: fakeI18n
  });
  mountedApps.push(app);
  app.mount(host);
  const adapter = instances[instances.length - 1];
  return { host, adapter };
}

function etip(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[data-testid="workflow-edge-etip"]');
}

describe('DesignerCanvas.vue 悬停条件气泡 etip 计时器', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
  });

  afterEach(() => {
    mountedApps.splice(0).forEach((app) => app.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('悬停珠子后未满 300ms：气泡不出现（证明确实存在延迟，不是立即展示）', async () => {
    const { host, adapter } = mountCanvas();
    adapter.emit('edgeMarkerHover', 'e-1', 260, 120, '金额较大');
    await nextTick();
    expect(etip(host)).toBeNull();

    vi.advanceTimersByTime(299);
    await nextTick();
    expect(etip(host)).toBeNull();
  });

  it('满 300ms 后气泡出现：坐标按 shellRef 边界换算，文案原样透传', async () => {
    const { host, adapter } = mountCanvas();
    const shell = host.querySelector('[data-testid="designer-canvas"]') as HTMLElement;
    // happy-dom 不做真实布局测算，getBoundingClientRect 恒返回全零——用桩函数给定一个可验证的
    // 矩形（同 x6-adapter.center-and-zoom.test.ts 一类"给定容器尺寸反推公式"的既定手法）。
    shell.getBoundingClientRect = () => ({ left: 100, top: 50, right: 0, bottom: 0, width: 0, height: 0, x: 100, y: 50, toJSON: () => undefined }) as DOMRect;

    adapter.emit('edgeMarkerHover', 'e-1', 260, 120, '金额较大');
    vi.advanceTimersByTime(300);
    await nextTick();

    const tip = etip(host);
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toBe('金额较大');
    // 局部坐标 = 珠子几何坐标(260,120) - shell 边界(100,50)。
    expect(tip?.style.left).toBe('160px');
    expect(tip?.style.top).toBe('70px');
  });

  it('300ms 内离开：计时器被取消，即使之后又过了很久气泡也不出现', async () => {
    const { host, adapter } = mountCanvas();
    adapter.emit('edgeMarkerHover', 'e-1', 0, 0, '未设置条件');
    vi.advanceTimersByTime(200);
    adapter.emit('edgeMarkerLeave');
    vi.advanceTimersByTime(500); // 累计远超 300ms，但计时器已在 leave 时被清掉
    await nextTick();
    expect(etip(host)).toBeNull();
  });

  it('气泡已出现后离开：立即隐藏（不做淡出延迟）', async () => {
    const { host, adapter } = mountCanvas();
    adapter.emit('edgeMarkerHover', 'e-1', 0, 0, '其他情况');
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(etip(host)).not.toBeNull();

    adapter.emit('edgeMarkerLeave');
    await nextTick();
    expect(etip(host)).toBeNull();
  });

  it('连续快速划过多个珠子：只有最后一个珠子的 300ms 计时器生效，不残留前一个珠子的气泡/计时器', async () => {
    const { host, adapter } = mountCanvas();
    adapter.emit('edgeMarkerHover', 'e-1', 0, 0, '珠子A');
    vi.advanceTimersByTime(200); // 珠子A走了 200ms，还没到 300ms
    adapter.emit('edgeMarkerHover', 'e-2', 50, 50, '珠子B'); // 划到珠子B——应清掉珠子A的计时器
    vi.advanceTimersByTime(200); // 珠子B也才走 200ms（累计 400ms，但计时器已重置）
    await nextTick();
    expect(etip(host)).toBeNull();

    vi.advanceTimersByTime(100); // 珠子B满 300ms
    await nextTick();
    expect(etip(host)?.textContent).toBe('珠子B');
  });

  // 🔴 反向验证锚点：若把 DesignerCanvas.vue 里的 300ms 延迟去掉（比如 onEdgeMarkerHover 改成
  // 同步直接置 visible:true），本用例会在"未推进任何计时器"的情况下就看到气泡，断言随之变红——
  // 用于证明"确实存在可编程的 300ms 门槛"而不是巧合地在某个时间点之前不出现。
  it('反向验证：悬停后不推进任何计时器——气泡绝不应该出现', async () => {
    const { host, adapter } = mountCanvas();
    adapter.emit('edgeMarkerHover', 'e-1', 0, 0, '文案');
    await nextTick();
    expect(etip(host)).toBeNull();
  });

  it('组件卸载时清理待出现的计时器与缩放轮询定时器，不残留悬空定时器', () => {
    const { adapter } = mountCanvas();
    adapter.emit('edgeMarkerHover', 'e-1', 0, 0, '文案');
    expect(vi.getTimerCount()).toBeGreaterThan(0); // 至少有 zoomTimer + 待出现的 etip 计时器

    mountedApps.splice(0).forEach((app) => app.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
