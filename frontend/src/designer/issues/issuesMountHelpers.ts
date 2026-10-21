/**
 * designer/issues/issuesMountHelpers.ts —— IssuesBar.vue 真实挂载单测的最小工具。
 * 不是 *.test.ts（vitest 的 include 只收 `src/**​/*.test.ts`），单纯是给同目录测试文件 import 的
 * 工具模块，手法同 designer/panels/panel-test-helpers.ts 头注释"真实挂载（Vue 原生 createApp，
 * 本插件没有 @vue/test-utils）"——不复用那一份，是因为它内部 mountPanel() 在函数体内就同步调用了
 * app.mount()，测试拿到返回值时早已错过 app.provide() 的时机（provide 必须在 mount 之前完成），
 * 没法再追加 DESIGNER_ISSUES_KEY，所以单独写一份只服务本目录测试的小工具。
 */
import { createApp, type App, type Component } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import { createDesignerI18n } from '../i18n';
import { DESIGNER_ISSUES_KEY, useIssues, type UseIssuesOptions, type UseIssuesReturn } from './useIssues';

/** 真实 i18n 实例（走本插件默认语言包，不需要宿主），供测试断言真实渲染出的中文文案。 */
export function fakeI18n(): PluginI18n {
  return createDesignerI18n();
}

export interface MountedWithIssues {
  app: App;
  el: HTMLElement;
  issuesApi: UseIssuesReturn;
  unmount: () => void;
}

/** 挂载任意消费 DESIGNER_ISSUES_KEY 的组件（当前只有 IssuesBar.vue），App 级 provide 一份真实
 *  useIssues() 实例——用真实组合式而不是手写假对象：next()/prev()/focusAt() 都是真实业务逻辑，
 *  假对象只会让测试测的是"我以为它会怎么写"而不是"它真的怎么写"（同 panel-test-helpers.ts
 *  fakeState() 头注释同一理由）。调用方可传 issuesOptions 定制 onFocus 回调以断言定位行为。 */
export function mountWithIssues(component: Component, props: Record<string, unknown>, issuesOptions?: UseIssuesOptions): MountedWithIssues {
  const issuesApi = useIssues(issuesOptions);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(component, props);
  app.provide(DESIGNER_ISSUES_KEY, issuesApi);
  app.mount(el);
  return {
    app,
    el,
    issuesApi,
    unmount: () => {
      app.unmount();
      el.remove();
    }
  };
}
