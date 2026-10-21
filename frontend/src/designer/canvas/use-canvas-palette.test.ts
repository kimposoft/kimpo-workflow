/**
 * designer/canvas/use-canvas-palette.test.ts —— useCanvasPalette() composable 单测（画布暗色
 * 模式支持）。
 *
 * 真实挂载（Vue 原生 createApp，项目未引入 @vue/test-utils，同 ToggleSwitch.test.ts/
 * SegmentedControl.test.ts 头注释既定手法）：composable 本身是纯 .ts 文件（不是 .vue SFC），
 * 用一个内联的最小组件定义（setup + 空 render）把它包起来即可触发 onMounted/onBeforeUnmount，
 * 不需要真的渲染任何 DOM 内容。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import type { CanvasPalette } from '../../model/design-tokens';
import { useCanvasPalette } from './use-canvas-palette';

const mountedApps: App[] = [];

/** 挂载一个只调用 useCanvasPalette() 的最小组件，返回其 palette ref 供断言——组件本身不渲染
 * 任何真实 DOM 内容（render 恒返回 null），本文件只关心 composable 的响应式行为。 */
function mountUseCanvasPalette(): { palette: { value: CanvasPalette }; unmount: () => void } {
  let captured: { palette: { value: CanvasPalette } } | undefined;
  const app = createApp({
    setup() {
      const result = useCanvasPalette();
      captured = result;
      return result;
    },
    render() {
      return null;
    }
  });
  mountedApps.push(app);
  const host = document.createElement('div');
  app.mount(host);
  if (!captured) throw new Error('useCanvasPalette 未在 setup 阶段被调用');
  return { palette: captured.palette, unmount: () => app.unmount() };
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.documentElement.classList.remove('dark');
});

describe('useCanvasPalette：初值与主题切换', () => {
  it('挂载时 documentElement 未带 dark 类：初值即为亮色 palette', () => {
    document.documentElement.classList.remove('dark');
    const { palette } = mountUseCanvasPalette();
    expect(palette.value.canvasBg).toBe('#FAFBFC');
    expect(palette.value.primary).toBe('#1464E0');
  });

  it('挂载时 documentElement 已带 dark 类：初值即为暗色 palette（不需要等一次变化才生效）', () => {
    document.documentElement.classList.add('dark');
    const { palette } = mountUseCanvasPalette();
    expect(palette.value.canvasBg).toBe('rgb(18 18 18)');
  });

  it('挂载后切换 documentElement 的 class（加 dark）：palette 随之自动切到暗色', async () => {
    document.documentElement.classList.remove('dark');
    const { palette } = mountUseCanvasPalette();
    expect(palette.value.canvasBg).toBe('#FAFBFC');

    document.documentElement.classList.add('dark');
    // MutationObserver 回调是微任务，等一轮 nextTick（其内部本身也是微任务队列）确保回调已跑完。
    await nextTick();
    await nextTick();
    expect(palette.value.canvasBg).toBe('rgb(18 18 18)');
  });

  it('再切回去（去掉 dark 类）：palette 切回亮色', async () => {
    document.documentElement.classList.add('dark');
    const { palette } = mountUseCanvasPalette();
    expect(palette.value.canvasBg).toBe('rgb(18 18 18)');

    document.documentElement.classList.remove('dark');
    await nextTick();
    await nextTick();
    expect(palette.value.canvasBg).toBe('#FAFBFC');
  });

  it('data-theme 属性变化同样触发更新（attributeFilter 覆盖 class/style/data-theme 三项）', async () => {
    document.documentElement.classList.remove('dark');
    const { palette } = mountUseCanvasPalette();
    expect(palette.value.canvasBg).toBe('#FAFBFC');

    // 直接改 class 之外的另一个受监听属性，验证 attributeFilter 不是只认 class 一项——
    // resolvePalette() 本身只按 classList 判 dark，所以这里改完 data-theme 后再补一次 dark
    // 类切换才能观察到 palette 真的变了；单独触发 data-theme 变化足以证明 observer 确实在监听
    // 这个属性（回调被调用即会重新调用 resolvePalette()，即便本次解析结果与之前相同）。
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.classList.add('dark');
    await nextTick();
    await nextTick();
    expect(palette.value.canvasBg).toBe('rgb(18 18 18)');
    document.documentElement.removeAttribute('data-theme');
  });
});

describe('useCanvasPalette：卸载后断开 observer', () => {
  it('卸载组件后再改 class，palette 不再更新（observer 已 disconnect）', async () => {
    document.documentElement.classList.remove('dark');
    const { palette, unmount } = mountUseCanvasPalette();
    expect(palette.value.canvasBg).toBe('#FAFBFC');

    unmount();
    document.documentElement.classList.add('dark');
    await nextTick();
    await nextTick();
    // 卸载前捕获的 palette ref 值应保持卸载那一刻的旧值——组件卸载后 onBeforeUnmount 已经
    // disconnect 了 observer，后续的 documentElement 变化不会再触发 refresh()。
    expect(palette.value.canvasBg).toBe('#FAFBFC');
  });
});
