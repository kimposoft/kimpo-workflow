/**
 * DesignerCanvas.initial-viewport.test.ts —— "首次打开设计器，把发起节点锚到画布左中"的接线
 * 测试（新建流程后打开设计界面，发起节点默认落在中间偏左的区域）。
 *
 * 纯几何计算本身（不同容器尺寸/极窄容器/容器无效）已由 designer/canvas/viewport.test.ts 的
 * computeInitialAnchorTranslate 单测覆盖，本文件测的是"接线接对了"这一层：DesignerCanvas.vue
 * 在 onMounted 里是否真的按 getNodeCenter('start') + getContainerSize() 的结果调用了
 * adapter.setLayout({ viewport })，以及"找不到发起节点/容器尺寸无效"两种回退场景下是否确实
 * 不调用（不产生多余的视口改动、保留 mount()/setLayout(props.layout) 已经落地的既有视口）。
 *
 * 手法同 DesignerCanvas.etip.test.ts 头注释："真实挂载 DesignerCanvas.vue，把 X6GraphAdapter
 * 换成不碰真实 X6/DOM 布局测算的假实现"——真实 X6 在 happy-dom 下代价大且脆，这里只关心
 * DesignerCanvas.vue 自己那层调用逻辑，不另行验证 X6GraphAdapter.getNodeCenter/getContainerSize
 * 本身的正确性（那部分见 graph/x6-adapter.center-and-zoom.test.ts）。
 *
 * applyInitialAnchor 还会读 getNodeSize('start')（绕开浮动节点库面板需要节点真实宽高，
 * 不只是中心点）——假适配器默认返回胶囊尺寸 168×56（与
 * DEFAULT_NODE_CENTER 同一组"发起节点"示例几何），不影响基础锚定用例的数值断言（未传
 * stencilAvoidZone prop 时 avoidZone 恒为 null，anchorSize 不参与计算，见 viewport.ts
 * computeInitialAnchorTranslate 的 avoidZone 分支）。
 *
 * 假适配器的 getNodeCenter/getContainerSize 返回值由模块级 nextConfig 决定——DesignerCanvas.vue
 * 的 onMounted 是纯同步函数（`new X6GraphAdapter(...)` 到 applyInitialAnchor() 之间没有任何
 * await/nextTick），测试没有机会在"构造完实例"与"读取这两个方法"之间插入操作，因此改为在
 * app.mount() 之前用 setNextConfig() 把下一次构造出的实例应该返回什么值先准备好，构造函数读一
 * 次即生效（同一份手法可以复用给任何"onMounted 内一次性同步读取"的接线测试）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeAdapterInstance {
  setLayoutCalls: unknown[];
}

/** 默认几何：发起节点渲染中心 (204,228)（对齐 START_NODE_POSITION(120,200) + 胶囊家族半宽高
 * 84/28）、容器 1000×600——与 designer/canvas/viewport.test.ts「常规容器」用例同一组输入，
 * 目标视口 { scale:1, x:96, y:72 } 可以直接对照复算，不是拍脑袋数字。 */
const DEFAULT_NODE_CENTER = { x: 204, y: 228 };
const DEFAULT_CONTAINER_SIZE = { width: 1000, height: 600 };

const { instances, FakeAdapter, setNextConfig } = vi.hoisted(() => {
  const instances: FakeAdapterInstance[] = [];
  let nextNodeCenter: { x: number; y: number } | null = { x: 204, y: 228 };
  let nextNodeSize: { width: number; height: number } | null = { width: 168, height: 56 };
  let nextContainerSize: { width: number; height: number } | null = { width: 1000, height: 600 };

  class FakeAdapter implements FakeAdapterInstance {
    setLayoutCalls: unknown[] = [];
    private nodeCenter = nextNodeCenter;
    private nodeSize = nextNodeSize;
    private containerSize = nextContainerSize;
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
    setPalette(): void {}
    setMessages(): void {}
    getZoomPercent(): number {
      return 100;
    }
    getViewport(): { scaleX: number; tx: number; ty: number } {
      return { scaleX: 1, tx: 0, ty: 0 };
    }
    onViewportChange(): () => void {
      return () => undefined;
    }
    on(): () => void {
      return () => undefined;
    }
    setLayout(layout: unknown): void {
      this.setLayoutCalls.push(layout);
    }
    getNodeCenter(_id: string): { x: number; y: number } | null {
      return this.nodeCenter;
    }
    getNodeSize(_id: string): { width: number; height: number } | null {
      return this.nodeSize;
    }
    getContainerSize(): { width: number; height: number } | null {
      return this.containerSize;
    }
  }

  function setNextConfig(config: {
    nodeCenter?: { x: number; y: number } | null;
    nodeSize?: { width: number; height: number } | null;
    containerSize?: { width: number; height: number } | null;
  }): void {
    if ('nodeCenter' in config) nextNodeCenter = config.nodeCenter ?? null;
    if ('nodeSize' in config) nextNodeSize = config.nodeSize ?? null;
    if ('containerSize' in config) nextContainerSize = config.containerSize ?? null;
  }

  return { instances, FakeAdapter, setNextConfig };
});

vi.mock('../../graph/x6-adapter', () => ({ X6GraphAdapter: FakeAdapter }));

import { createApp } from 'vue';
import DesignerCanvas from './DesignerCanvas.vue';

const fakeI18n = {
  t: (key: string) => key,
  getLocale: () => 'zh-CN',
  onChange: () => () => undefined,
  setLocale: () => undefined,
  dispose: () => undefined
};

const mountedApps: Array<ReturnType<typeof createApp>> = [];

/** 挂载真实 DesignerCanvas.vue（假适配器接管，见文件头注释），返回本次挂载产生的假适配器实例。 */
function mountCanvas(extraProps: Record<string, unknown> = {}): FakeAdapterInstance {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(DesignerCanvas, {
    nodes: [],
    edges: [],
    selectedNodeIds: [],
    selectedEdgeIds: [],
    i18n: fakeI18n,
    ...extraProps
  });
  mountedApps.push(app);
  app.mount(host);
  return instances[instances.length - 1]!;
}

/** 本次调用产生的 setLayout({ viewport }) 调用次数与最后一次的 viewport 参数——props.layout
 * 未传（undefined）时 mount() 里第一次 adapter.setLayout(props.layout) 是空调用（不带
 * viewport，见 x6-adapter.ts setLayout() 对 layout 为空的早退处理），本文件只关心带 viewport
 * 的那一类调用，过滤掉前者。 */
function viewportCallsOf(adapter: FakeAdapterInstance): Array<{ viewport: { scale: number; x: number; y: number } }> {
  return adapter.setLayoutCalls.filter(
    (call): call is { viewport: { scale: number; x: number; y: number } } => typeof call === 'object' && call !== null && 'viewport' in call
  );
}

describe('DesignerCanvas.vue 首次打开：把发起节点锚到画布左中', () => {
  beforeEach(() => {
    instances.length = 0;
    setNextConfig({ nodeCenter: DEFAULT_NODE_CENTER, containerSize: DEFAULT_CONTAINER_SIZE });
  });

  afterEach(() => {
    mountedApps.splice(0).forEach((app) => app.unmount());
    document.body.innerHTML = '';
  });

  it("挂载后按 getNodeCenter('start') + getContainerSize() 的结果调用一次 setLayout({ viewport })", () => {
    const adapter = mountCanvas();
    const calls = viewportCallsOf(adapter);
    expect(calls).toHaveLength(1);
    // 目标屏幕位置 = (1000*0.3, 600*0.5) = (300, 300)；X6 约定 screenX = canvasX*scale + tx，
    // tx = 300 - 204 = 96，ty = 300 - 228 = 72，与 viewport.test.ts 同一组输入同一个结果。
    expect(calls[0]!.viewport).toEqual({ scale: 1, x: 96, y: 72 });
  });

  it('getNodeCenter 返回 null（找不到发起节点，理论不应发生）：不调用 setLayout({ viewport }），回退现有行为', () => {
    setNextConfig({ nodeCenter: null });
    const adapter = mountCanvas();
    expect(viewportCallsOf(adapter)).toHaveLength(0);
  });

  it('传入的布局自带视口：以它为准，不再用锚定覆盖（只出现恢复布局那一次带视口的调用）', () => {
    const saved = { scale: 0.8, x: -40, y: 12 };
    const adapter = mountCanvas({ layout: { viewport: saved } });
    const calls = viewportCallsOf(adapter);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.viewport).toEqual(saved);
  });

  it('getContainerSize 返回 null（容器尚未完成布局）：不调用 setLayout({ viewport }），回退现有行为', () => {
    setNextConfig({ containerSize: null });
    const adapter = mountCanvas();
    expect(viewportCallsOf(adapter)).toHaveLength(0);
  });

  it('getNodeSize 返回 null（理论不应发生）：不调用 setLayout({ viewport }），回退现有行为', () => {
    setNextConfig({ nodeSize: null });
    const adapter = mountCanvas();
    expect(viewportCallsOf(adapter)).toHaveLength(0);
  });
});

// stencilAvoidZone 回调接线——DesignerCanvas 自己不认识"节点库面板"，
// 只负责"把画布尺寸换算成近似 wrap 尺寸传给回调、把回调返回的 wrap 坐标换算回画布坐标"这一层
// 坐标转换，回调本身的计算逻辑由 designer/stencil/floating-panel.test.ts 覆盖。
describe('DesignerCanvas.vue 首次打开：stencilAvoidZone 回调的坐标换算接线', () => {
  beforeEach(() => {
    instances.length = 0;
    setNextConfig({ nodeCenter: DEFAULT_NODE_CENTER, nodeSize: { width: 168, height: 56 }, containerSize: DEFAULT_CONTAINER_SIZE });
  });

  afterEach(() => {
    mountedApps.splice(0).forEach((app) => app.unmount());
    document.body.innerHTML = '';
  });

  it('回调入参是"画布尺寸 + 20"（近似 wrap 尺寸，画布本体让出左上 20px 标尺）', () => {
    const stencilAvoidZone = vi.fn().mockReturnValue(null);
    mountCanvas({ stencilAvoidZone });
    expect(stencilAvoidZone).toHaveBeenCalledTimes(1);
    expect(stencilAvoidZone).toHaveBeenCalledWith({ width: 1020, height: 620 });
  });

  it('回调返回的占位（wrap 坐标）会先减回 20px 换算成画布坐标，再用于绕开计算', () => {
    // 面板占位 wrap 坐标 { right: 276, top: 8, bottom: 900 } → 画布坐标 { right: 256, top: -12,
    // bottom: 880 }：容器高度 600、targetY=300，行带 [300-28,300+28]=[272,328] 显然落在
    // [-12,880] 内（重叠）→ 应用绕开：minCenterX = 256+24+84(胶囊半宽)=364。
    const stencilAvoidZone = vi.fn().mockReturnValue({ right: 276, top: 8, bottom: 900 });
    const adapter = mountCanvas({ stencilAvoidZone });
    const calls = viewportCallsOf(adapter);
    expect(calls).toHaveLength(1);
    // tx = 364 - 204 = 160，ty 不受影响仍是 72（300-228）。
    expect(calls[0]!.viewport).toEqual({ scale: 1, x: 160, y: 72 });
  });

  it('未传 stencilAvoidZone prop：行为与基础锚定完全一致（不绕开）', () => {
    const adapter = mountCanvas();
    const calls = viewportCallsOf(adapter);
    expect(calls[0]!.viewport).toEqual({ scale: 1, x: 96, y: 72 });
  });
});
