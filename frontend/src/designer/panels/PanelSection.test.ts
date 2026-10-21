/**
 * designer/panels/PanelSection.test.ts —— PanelSection.vue「必填红星」行为单测。
 *
 * PanelSection 是纯结构组件，不 inject host/state/i18n（title/info/requiredLabel 等文本全部
 * 经 props 传入已翻译好的字面量，见其文件头注释），因此本文件不走 panel-test-helpers.ts 的
 * mountPanel（那个手法是给需要三个注入键的六个 *Panel.vue 用的），直接用 Vue 原生 createApp
 * 挂载即可——同 shared/FieldPermissionSummary.test.ts「计数」一节的轻量 mount() 手法。
 *
 * 只覆盖 required/requiredLabel 两个 prop；title/icon/info/collapsible/open 等
 * 行为已由六个 *Panel.vue 的间接挂载覆盖，不在本文件重复测。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from 'vue';
import PanelSection from './PanelSection.vue';

let app: App | undefined;
let el: HTMLElement | undefined;

afterEach(() => {
  app?.unmount();
  el?.remove();
  app = undefined;
  el = undefined;
});

function mount(props: Record<string, unknown>): HTMLElement {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(PanelSection, props);
  app.mount(el);
  return el;
}

describe('PanelSection：必填红星（required/requiredLabel）', () => {
  it('required 为 true 时，标题后渲染红星，且带无障碍标签（aria-label/title 都是 requiredLabel）', () => {
    const host = mount({ title: '目标表单', required: true, requiredLabel: '必填' });

    const star = host.querySelector('.wf-panel-section__required');
    expect(star, '应渲染红星元素').toBeTruthy();
    // 红星本身是装饰性视觉：role="img" 把裸 "*" 从可读文本里摘掉，屏幕阅读器读到的是
    // aria-label（"必填"），不是孤零零一个星号——同 title 属性一起兜底 hover 提示。
    expect(star!.getAttribute('role')).toBe('img');
    expect(star!.getAttribute('aria-label')).toBe('必填');
    expect(star!.getAttribute('title')).toBe('必填');
    expect(star!.textContent).toBe('*');

    // 标题文字本身仍然完整显示，红星是附加在标题后的独立元素，不吞掉标题文案。
    const titleEl = host.querySelector('.wf-panel-section__title');
    expect(titleEl!.textContent).toContain('目标表单');
  });

  it('required 为 false（或不传，走默认值）时，不渲染红星', () => {
    const hostFalse = mount({ title: '步骤摘要', required: false, requiredLabel: '必填' });
    expect(hostFalse.querySelector('.wf-panel-section__required')).toBeFalsy();

    app?.unmount();
    el?.remove();

    const hostDefault = mount({ title: '步骤摘要' });
    expect(hostDefault.querySelector('.wf-panel-section__required'), '不传 required 时应按默认值 false 处理').toBeFalsy();
  });
});
