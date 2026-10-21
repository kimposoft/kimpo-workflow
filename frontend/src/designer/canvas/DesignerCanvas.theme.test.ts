/**
 * designer/canvas/DesignerCanvas.theme.test.ts —— DesignerCanvas.vue 接线 useCanvasPalette()
 * 的测试（画布暗色模式支持）：断言 DesignerCanvas 挂载后调用过 setPalette，且 palette 变化时
 * 会再次调用。两层覆盖：
 *   1. 静态源码断言——source 层面确认接线代码确实存在（import/挂载后调用/watch 三处），防止
 *      "改对了行为但换了个写法导致静态检查失效"这类漂移；
 *   2. 动态行为断言——真实挂载 DesignerCanvas.vue（X6GraphAdapter 换成假实现接管，同
 *      DesignerCanvas.etip.test.ts 头注释既定手法），**不 mock useCanvasPalette 本身**——直接
 *      驱动真实的 document.documentElement class 切换（同 use-canvas-palette.test.ts 既定手法），
 *      断言假适配器记录到的 setPalette 调用次数与传入值符合预期：挂载后恰好一次（亮色），主题
 *      切到暗色后再一次（暗色），切回亮色后又一次。
 *
 * 🔴 反证靶子在别处：把 X6GraphAdapter.setPalette() 方法体内的重绘调用注释掉，不会让本文件
 * 变红（本文件的假适配器完全不执行真实重绘逻辑，只记录"被调用过"这件事）——那部分反证由
 * graph/x6-adapter.set-palette.test.ts（直接测真实 X6GraphAdapter.setPalette()，见其头注释）
 * 负责。本文件测的是"DesignerCanvas 是否正确
 * 接线"这一层，与"setPalette 内部是否正确重绘"是两件独立的事，因此需要两个文件分别覆盖。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------------
// 第一层：静态源码断言
// ------------------------------------------------------------------

const source = readFileSync(resolve(process.cwd(), 'src/designer/canvas/DesignerCanvas.vue'), 'utf8');
const scriptSetup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
const onMountedBody = scriptSetup.match(/onMounted\(\(\) => \{[\s\S]*?\n\}\);/)?.[0] ?? '';

describe('DesignerCanvas.vue 静态断言：接线 useCanvasPalette()', () => {
  it('导入并使用 useCanvasPalette（不是本地另起一份主题解析逻辑）', () => {
    expect(scriptSetup).toContain("import { useCanvasPalette } from './use-canvas-palette';");
    expect(scriptSetup).toContain('const { palette } = useCanvasPalette();');
  });

  it('onMounted 里先 mount() 再 setPalette(palette.value)（顺序不能反——mount() 之后才有真实 Graph 可重绘）', () => {
    expect(onMountedBody).toContain('adapter.mount(containerRef.value);');
    expect(onMountedBody).toContain('adapter.setPalette(palette.value);');
    const mountIndex = onMountedBody.indexOf('adapter.mount(containerRef.value);');
    const setPaletteIndex = onMountedBody.indexOf('adapter.setPalette(palette.value);');
    expect(mountIndex).toBeGreaterThan(-1);
    expect(setPaletteIndex).toBeGreaterThan(mountIndex);
  });

  it('有一条 watch(palette, ...) 在主题变化时再次调用 setPalette', () => {
    expect(scriptSetup).toContain('watch(palette, (next) => adapter?.setPalette(next));');
  });
});

// ------------------------------------------------------------------
// 第二层：动态行为断言（假适配器接管 X6GraphAdapter，同 DesignerCanvas.etip.test.ts 手法）
// ------------------------------------------------------------------

interface FakeAdapterInstance {
  setPaletteCalls: unknown[];
}

const { instances, FakeAdapter } = vi.hoisted(() => {
  const instances: FakeAdapterInstance[] = [];
  class FakeAdapter implements FakeAdapterInstance {
    setPaletteCalls: unknown[] = [];
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
    getViewport(): { scaleX: number; tx: number; ty: number } {
      return { scaleX: 1, tx: 0, ty: 0 };
    }
    onViewportChange(): () => void {
      return () => undefined;
    }
    // 本文件要测的核心方法——只记录调用参数，不执行任何真实重绘（真实重绘的正确性由
    // graph/x6-adapter.set-palette.test.ts 覆盖，见文件头注释）。
    setPalette(palette: unknown): void {
      this.setPaletteCalls.push(palette);
    }
    // 🔴 补齐接口面（同上方 getViewport/onViewportChange 一带注释）：为了"首次打开设计器把
    // 发起节点锚到画布左中"，DesignerCanvas.vue onMounted 无条件调用
    // applyInitialAnchor()，其内部依次调 adapter.getNodeCenter()/getContainerSize()——假
    // 适配器缺这两个方法会让 onMounted 抛错。返回 null 即可（对齐"找不到发起节点/容器无效时
    // 静默跳过"的回退行为），本文件不测这条逻辑本身，见 DesignerCanvas.initial-viewport.test.ts。
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

function mountCanvas(): FakeAdapterInstance {
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
  return instances[instances.length - 1];
}

describe('DesignerCanvas.vue 动态行为：挂载后调用一次 setPalette，主题变化时再次调用', () => {
  beforeEach(() => {
    instances.length = 0;
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    mountedApps.splice(0).forEach((app) => app.unmount());
    document.body.innerHTML = '';
    document.documentElement.classList.remove('dark');
  });

  it('挂载后（documentElement 未带 dark 类）：setPalette 恰好被调用一次，传入亮色 palette', () => {
    const adapter = mountCanvas();
    expect(adapter.setPaletteCalls).toHaveLength(1);
    expect((adapter.setPaletteCalls[0] as { canvasBg: string }).canvasBg).toBe('#FAFBFC');
  });

  it('挂载后切换主题（加 dark 类）：setPalette 被再次调用，传入暗色 palette', async () => {
    const adapter = mountCanvas();
    expect(adapter.setPaletteCalls).toHaveLength(1);

    document.documentElement.classList.add('dark');
    // useCanvasPalette() 的 MutationObserver 回调是微任务，同 use-canvas-palette.test.ts 既定
    // 手法等两轮 nextTick 确保回调与本组件的 watch(palette, ...) 都已跑完。
    await nextTick();
    await nextTick();

    expect(adapter.setPaletteCalls).toHaveLength(2);
    expect((adapter.setPaletteCalls[1] as { canvasBg: string }).canvasBg).toBe('rgb(18 18 18)');
  });

  it('再切回亮色：setPalette 第三次被调用，传入亮色 palette（不是"只响应第一次变化"）', async () => {
    const adapter = mountCanvas();
    document.documentElement.classList.add('dark');
    await nextTick();
    await nextTick();
    expect(adapter.setPaletteCalls).toHaveLength(2);

    document.documentElement.classList.remove('dark');
    await nextTick();
    await nextTick();

    expect(adapter.setPaletteCalls).toHaveLength(3);
    expect((adapter.setPaletteCalls[2] as { canvasBg: string }).canvasBg).toBe('#FAFBFC');
  });

  // 反向验证锚点（本层）：若 DesignerCanvas.vue 漏了 onMounted 里的 setPalette 调用，第一条用例
  // 会看到 setPaletteCalls 长度 0 而不是 1，变红；若漏了 watch(palette, ...)，第二/三条用例会
  // 卡在长度 1 不再增长。两处任一缺失都能被这三条用例中的至少一条捕获，不是只测"最终态"。
});
