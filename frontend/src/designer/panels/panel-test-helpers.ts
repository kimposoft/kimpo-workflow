/**
 * designer/panels/panel-test-helpers.ts —— 属性面板及其 shared 子组件单测共用的挂载 + 假宿主工具。
 *
 * 不是 *.test.ts（vitest 的 include 只收 `src/**​/*.test.ts`），不会被当成一份独立测试文件收集，
 * 单纯是给同目录测试文件 import 的工具模块。
 *
 * 真实挂载（Vue 原生 createApp，本插件没有 @vue/test-utils，同 designer/canvas/use-canvas-palette
 * .test.ts 等既有用例头注释的既定手法）：`app.provide(key, value)` 是 App 级注入，覆盖整棵组件
 * 树（含根组件自身的 inject），因此不需要额外包一层"provider 组件"。
 */
import { createApp, shallowRef, type App, type Component, type Ref } from 'vue';
import type { HostUi, InteractiveSessionHandle, PluginI18n } from '@kimposoft/plugin-sdk';
import { createDesignerI18n } from '../i18n';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY, DESIGNER_STATE_KEY, type DesignerHost } from '../host';
import { WorkflowDocumentState } from '../../model/document-state';
import type { WorkflowDocument } from '../../model';

/** 真实 i18n 实例（走本插件默认语言包，不需要宿主），供测试断言真实渲染出的中文文案。 */
export function fakeI18n(): PluginI18n {
  return createDesignerI18n();
}

/** 一个逐项 vi.fn() 兜底、可用 overrides 覆盖任意方法的假 DesignerHost；缺省返回值均为"空但不
 *  抛错"的安全值，保证挂载依赖它的组件（含内嵌的 V4ExpressionField，其 useMainTableScope 同样
 *  经这个 host 取主表/字段）不会因为方法缺失而报错。 */
export function fakeHost(overrides: Partial<DesignerHost> = {}): DesignerHost {
  const ui: HostUi = {
    has: () => false,
    openExpressionEditor: () => Promise.reject(new Error('not wired in test')),
    openEntityPicker: () => Promise.resolve({ confirmed: false, records: [] }) as never,
    openRecordPicker: () => Promise.reject(new Error('not wired in test')),
    openImageCropper: () => Promise.reject(new Error('not wired in test')),
    openTemplatePicker: () => Promise.resolve({ confirmed: false, template: null }),
    openOrgTriPicker: () => Promise.resolve({ confirmed: false, users: [], roles: [], depts: [] }),
    // 确认框 / 输入框缺省按"取消"处理（与无宿主时取不到服务的口径一致），用例需要时用 overrides.ui 覆盖。
    openConfirm: () => Promise.resolve({ confirmed: false }),
    openPrompt: () => Promise.resolve({ confirmed: false, value: null }),
    ...overrides.ui
  };
  const base: DesignerHost = {
    appId: 'app_test',
    getDefinition: async () => ({ data: undefined, error: undefined }) as never,
    saveDraft: async () => ({ data: undefined, error: undefined }) as never,
    validate: async () => ({ data: undefined, error: undefined }) as never,
    publish: async () => ({ data: undefined, error: undefined }) as never,
    setEnabled: async () => ({ data: undefined, error: undefined }) as never,
    listAppTemplates: async () => ({ data: { items: [] } }),
    getTemplate: async () => ({ data: undefined, error: { message: 'not found' } }),
    listTemplateTables: async () => ({ data: { items: [] } }),
    listTemplateFields: async () => ({ data: { items: [] } }),
    // 三个只读方法的假实现——模板限制对照/已发布流程目录缺省空列表，
    // 通知渠道缺省三档全可用（面板测试多数只关心"渲染不报错"，具体不可用场景由各面板测试
    // 自行用 overrides 覆盖成对应的假值）。
    templateFieldRestrictions: async () => ({ data: { fields: [] } }),
    listAppWorkflows: async () => ({ data: { definitions: [] } }),
    channelCapabilities: async () => ({
      data: {
        channels: [
          { channel: 'system', available: true },
          { channel: 'email', available: true },
          { channel: 'sms', available: true }
        ]
      }
    }),
    ui,
    interactiveSession: { markDirty: () => undefined } as unknown as InteractiveSessionHandle,
    aliceV4: async () => null,
    expression: () => ({}) as never
  };
  return { ...base, ...overrides, ui };
}

/** 造一个真实 WorkflowDocumentState（纯 TS，无 Vue 依赖，见 document-state.ts 头注释），包成
 *  DESIGNER_STATE_KEY 期望的 Ref 形状。用真实类而不是手写假对象：面板对 state 的写操作
 *  （updateNodeConfig/setName，含节点级通知配置——那也是走
 *  updateNodeConfig 的 config patch，不是独立方法）都是真实业务逻辑，假对象只会让测试测的是
 *  "我以为它会怎么写"而不是"它真的怎么写"。 */
export function fakeState(doc: WorkflowDocument): Ref<WorkflowDocumentState | undefined> {
  // shallowRef（不是 ref）：同 DesignerRoot.vue 既定用法——WorkflowDocumentState 是一个带私有
  // 字段的类实例，塞进深响应式 ref() 会被 Vue 的 UnwrapRef 尝试展开/代理，与类的名义类型（含
  // 私有字段）对不上，vue-tsc 会报"缺少 _doc/selection/dirty 等属性"。
  return shallowRef(new WorkflowDocumentState(doc));
}

export interface MountedPanel<P extends Component> {
  app: App;
  el: HTMLElement;
  unmount: () => void;
}

/** 挂载任意面板 SFC，App 级 provide 三个注入键；调用方拿到宿主 DOM 节点自行 querySelector /
 *  dispatchEvent，用完调用 unmount() 收尾（测试文件的 afterEach 里统一调用）。 */
export function mountPanel<P extends Component>(
  component: P,
  props: Record<string, unknown>,
  deps: { host: DesignerHost; state: Ref<WorkflowDocumentState | undefined>; i18n: PluginI18n }
): MountedPanel<P> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(component, props);
  app.provide(DESIGNER_HOST_KEY, deps.host);
  app.provide(DESIGNER_STATE_KEY, deps.state);
  app.provide(DESIGNER_I18N_KEY, deps.i18n);
  app.mount(el);
  return {
    app,
    el,
    unmount: () => {
      app.unmount();
      el.remove();
    }
  };
}
