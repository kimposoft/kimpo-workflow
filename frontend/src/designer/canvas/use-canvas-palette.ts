/**
 * designer/canvas/use-canvas-palette.ts —— 画布调色板响应式 composable（画布暗色模式
 * 支持的数据层）。
 *
 * 解析当前宿主主题（documentElement 是否带 `dark` 类）产出对应的 CanvasPalette（见
 * ../../model/design-tokens.ts），并用 MutationObserver 监听 documentElement 的
 * class/style/data-theme 变化自动重新解析——宿主切换亮暗主题时，画布色板跟着实时更新，不需要
 * 用户手动刷新页面。
 *
 * 监听写法同 CanvasRulers.vue 里 themeObserver 的既定手法（见其 onMounted/onBeforeUnmount 对 MutationObserver 的处理），attributeFilter 三项对齐：
 *   - class：宿主切换主题最常见的写法（`html.dark`）；
 *   - style：部分场景通过内联 style 直接设置 CSS 变量（而非切 class）；
 *   - data-theme：兼容宿主未来可能改用 data 属性表达主题的写法。
 *
 * 本文件只产出数据（palette 响应式引用），不做任何 DOM 渲染——把 palette 接进 X6 画布/
 * DOM 面板由消费方（如 DesignerCanvas.vue 调 adapter.setPalette）负责。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { resolvePalette, type CanvasPalette } from '../../model/design-tokens';

export interface UseCanvasPaletteResult {
  /** 当前主题下的画布调色板，随宿主 documentElement 主题变化自动更新。 */
  palette: Ref<CanvasPalette>;
}

export function useCanvasPalette(): UseCanvasPaletteResult {
  // 初值直接同步解析——组件首次渲染就需要正确的主题色，不能等 onMounted 才补一次（会有一帧
  // "先亮色后暗色"的闪烁）。
  const palette = ref<CanvasPalette>(resolvePalette());
  let observer: MutationObserver | undefined;

  function refresh(): void {
    palette.value = resolvePalette();
  }

  onMounted(() => {
    // 挂载时机与 setup 执行时机之间 documentElement 的主题状态理论上可能已经变化（如宿主在
    // 挂载间隙切了主题），这里再解析一次兜底，成本可忽略。
    refresh();
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = undefined;
  });

  return { palette };
}
