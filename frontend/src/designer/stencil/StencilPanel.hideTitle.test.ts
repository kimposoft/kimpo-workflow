/**
 * StencilPanel.hideTitle.test.ts —— hideTitle prop 行为验收：浮动外壳自己的标题栏已经显示
 * "节点库"标题，StencilPanel 内部还有一份重复标题；本文件锁定"传 hide-title 时内部标题不渲染，不传时行为不变"这一条。
 *
 * 手法同 designer/canvas/DesignerCanvas.initial-viewport.test.ts 头注释："真实挂载 .vue，用
 * createApp 直接 mount 到一个 detached host"——StencilPanel 本身不依赖 X6/DOM 布局测算，可以
 * 真实挂载，不需要假适配器。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import StencilPanel from './StencilPanel.vue';

const fakeI18n = {
  t: (key: string) => key,
  getLocale: () => 'zh-CN',
  onChange: () => () => undefined,
  setLocale: () => undefined,
  dispose: () => undefined
};

const mountedApps: Array<ReturnType<typeof createApp>> = [];

function mountStencilPanel(extraProps: Record<string, unknown> = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(StencilPanel, { i18n: fakeI18n, ...extraProps });
  mountedApps.push(app);
  app.mount(host);
  return host;
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('StencilPanel：hideTitle', () => {
  it('不传 hideTitle（默认 false）：内部标题正常渲染，行为不变', () => {
    const el = mountStencilPanel();
    expect(el.querySelector('.workflow-stencil__header')).not.toBeNull();
  });

  it('hideTitle=true：内部标题不渲染', () => {
    const el = mountStencilPanel({ hideTitle: true });
    expect(el.querySelector('.workflow-stencil__header')).toBeNull();
  });

  it('hideTitle=true 时条目分组等其余内容仍正常渲染（只隐标题，不是整个面板不渲染）', () => {
    const el = mountStencilPanel({ hideTitle: true });
    expect(el.querySelector('.workflow-stencil__groups')).not.toBeNull();
    expect(el.querySelectorAll('.workflow-stencil__item').length).toBeGreaterThan(0);
  });
});
