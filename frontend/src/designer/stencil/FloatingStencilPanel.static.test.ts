/**
 * FloatingStencilPanel.static.test.ts —— 浮动外壳接线的静态守护。
 * 手法同 StencilPanel.static.test.ts："对源码文本做结构化断言"，本文件只锁两条接线：
 *   ① 内层 StencilPanel 传了 hide-title（消掉与外壳标题栏重复的内部标题，见 StencilPanel.vue
 *      hideTitle prop 注释）；
 *   ② 夹回（reclamp）用的是实测尺寸 measuredSize，不是"主体最大高度"公式估算值 panelSize
 *      （原因见 FloatingStencilPanel.vue measuredSize 头注释）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/designer/stencil/FloatingStencilPanel.vue'), 'utf8');

describe('FloatingStencilPanel：内层 StencilPanel 隐藏重复标题', () => {
  it('<StencilPanel ... hide-title ... /> 已传', () => {
    expect(source).toMatch(/<StencilPanel[^>]*\bhide-title\b[^>]*\/>/);
  });
});

describe('FloatingStencilPanel：夹回用实测尺寸，不用公式估算值', () => {
  it('reclamp() 与 updateDrag() 的 clampPanelPosition 调用都传 measuredSize.value', () => {
    expect(source).toContain('clampPanelPosition(position.value, measuredSize.value, containerSize.value)');
    expect(source).toContain('clampPanelPosition(tentative, measuredSize.value, containerSize.value)');
  });

  it('挂载时会先测量真实尺寸（measurePanel）再夹回（reclamp），不是反过来', () => {
    const onMountedBody = source.match(/onMounted\(\(\) => \{([\s\S]*?)\n\}\);/)?.[1] ?? '';
    const measureIdx = onMountedBody.indexOf('measurePanel();');
    const reclampIdx = onMountedBody.indexOf('reclamp();');
    expect(measureIdx).toBeGreaterThanOrEqual(0);
    expect(reclampIdx).toBeGreaterThan(measureIdx);
  });

  it('挂载时对 rootRef 本身（不只是定位容器）也挂了一个 ResizeObserver，捕捉面板自身尺寸变化', () => {
    expect(source).toContain('panelResizeObserver = new ResizeObserver(');
    expect(source).toContain('panelResizeObserver.observe(rootRef.value)');
    expect(source).toContain('panelResizeObserver?.disconnect();');
  });
});
