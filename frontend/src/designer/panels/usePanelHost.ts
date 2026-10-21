/**
 * designer/panels/usePanelHost.ts —— 面板骨架级注入桥接 composable。
 *
 * 各 *Panel.vue 与 PanelHeader.vue 共用的一段逻辑：inject host/i18n/state 三个注入键 + 订阅
 * state.onChange() 打一个 changeTick，用来驱动"WorkflowDocumentState 内部变更不天然触发 Vue
 * 响应式"这类 computed 重新求值。
 *
 * 注入写法：inject 三者、判空后把 `injected*` 重新赋值给一个非空的局部变量——判空之后 TS 本身
 * 就能把联合类型里的 undefined 收窄掉，不需要类型断言；缺失时在挂载点就地报错，能立刻定位到
 * "没有挂在设计器根组件之下"这个真正原因（直接 `as PluginI18n` 断言的写法会让 undefined 带着
 * 假类型往下传，等到更远处才抛错）。
 *
 * host/i18n/state 三者均由设计器根组件（../shell/、../DesignerRoot.vue）在挂载时 provide；
 * 不存在"注入齐了两个、缺一个"的场景，因此三者但凡缺一个就直接 throw，不做"host 可选、
 * 其余必需"的区分。
 *
 * changeTick：state 是 WorkflowDocumentState 类实例（见 ../../model/document-state.ts），其
 * 内部字段变更不天然驱动 Vue 响应式；订阅 state.onChange() 在每次文档变化时 +1，消费方在
 * computed 里 `void changeTick.value` 强制重新求值（同 HandlePanel.vue templateId 既定写法）。
 * 订阅解绑：state 是一个 Ref，其 `.value` 本身可能随 DesignerRoot 异步造出新的
 * WorkflowDocumentState 实例而整体替换——watch 的 onCleanup 在 state.value 变化前把上一个
 * 实例的订阅解绑，避免残留监听持续引用一个已经不再使用的旧文档实例。
 */
import { inject, ref, watch, type Ref } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY, DESIGNER_STATE_KEY, type DesignerHost } from '../host';
import type { WorkflowDocumentState } from '../../model/document-state';

export interface PanelHost {
  host: DesignerHost;
  i18n: PluginI18n;
  /** 当前文档状态机；`.value` 在文档未加载完成/加载失败时仍可能是 undefined，消费方按既有
   *  约定用 `state.value?.xxx` 读写，不假设它恒为真。 */
  state: Ref<WorkflowDocumentState | undefined>;
  /** 文档发生变化时递增的计数器；在 computed 里 `void changeTick.value` 即可让该 computed
   *  跟随文档变化重新求值。 */
  changeTick: Ref<number>;
}

export function usePanelHost(): PanelHost {
  const injectedHost = inject(DESIGNER_HOST_KEY);
  const injectedI18n = inject(DESIGNER_I18N_KEY);
  const injectedState = inject(DESIGNER_STATE_KEY);
  if (!injectedHost || !injectedI18n || !injectedState) {
    throw new Error('[usePanelHost] 缺少设计器注入（host/i18n/state），请确认挂载在设计器根组件之下');
  }
  // 判空重绑：三者判空之后已经是非空类型，不需要再写任何 `as` 断言（见头注释"两种写法"）。
  const host = injectedHost;
  const i18n = injectedI18n;
  const state = injectedState;

  const changeTick = ref(0);
  watch(
    () => state.value,
    (s, _old, onCleanup) => {
      const unsubscribe = s?.onChange(() => {
        changeTick.value++;
      });
      onCleanup(() => unsubscribe?.());
    },
    { immediate: true }
  );

  return { host, i18n, state, changeTick };
}
