/**
 * StencilPanel.engineUnsupported.test.ts —— 绑定引擎不支持的节点在节点库里禁用并提示：
 * disabledKeys 里的条目按钮禁用、不可拖、悬停浮层显示 disabledHint（取代条目描述），其余条目不受影响。
 * 手法同 StencilPanel.hideTitle.test.ts：真实挂载 .vue。
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

function item(el: HTMLElement, key: string): HTMLButtonElement {
  const btn = el.querySelector<HTMLButtonElement>(`[data-stencil-key="${key}"]`);
  if (!btn) throw new Error(`stencil item ${key} not rendered`);
  return btn;
}

describe('StencilPanel：引擎不支持的节点', () => {
  it('disabledKeys 条目禁用、不可拖，浮层显示「当前引擎不支持」；其余条目照常', () => {
    const el = mountStencilPanel({ disabledKeys: ['subflow', 'cc'], disabledHint: '当前引擎不支持' });
    for (const key of ['subflow', 'cc']) {
      const btn = item(el, key);
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('draggable')).toBe('false');
      expect(btn.dataset.engineUnsupported).toBe('true');
      expect(btn.querySelector('.workflow-stencil__tooltip')?.textContent).toBe('当前引擎不支持');
    }
    const approve = item(el, 'approve');
    expect(approve.disabled).toBe(false);
    expect(approve.dataset.engineUnsupported).toBeUndefined();
    expect(approve.querySelector('.workflow-stencil__tooltip')?.textContent).toBe('workflow.designer.stencil.approve.description');
  });

  it('不传 disabledHint：禁用条目仍显示条目描述（行为与改造前一致）', () => {
    const el = mountStencilPanel({ disabledKeys: ['subflow'] });
    expect(item(el, 'subflow').querySelector('.workflow-stencil__tooltip')?.textContent).toBe('workflow.designer.stencil.subflow.description');
  });
});
