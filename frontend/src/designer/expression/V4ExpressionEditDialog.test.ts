/**
 * expression/V4ExpressionEditDialog.test.ts —— 表达式编辑弹窗的 Esc 内层分流（外壳是 KDialog，
 * Esc 由弹层栈在 window 捕获阶段统一派发，面板内「比取消弹窗更内层」的 Esc 语义须经 escapeInterceptor 保留）。
 *
 * 核实的面板内部 Esc 语义（AdvancedExpressionPanel 对外 expose）：函数「更多」目录开着 → 只收目录；
 * 树坞搜索框有内容 → 只清空搜索；其余 Esc = 取消弹窗（emit cancel）。
 * 面板整体用桩替换（带可控的 expose），避免真拉起表达式编辑器需要的宿主接线。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';

const panelState = vi.hoisted(() => ({ catalogOpen: false, searching: false, closeCatalog: vi.fn(), clearSearch: vi.fn() }));

vi.mock('@kimposoft/expression-editor', async importOriginal => {
  const original = await importOriginal<typeof import('@kimposoft/expression-editor')>();
  const PanelStub = defineComponent({
    name: 'AdvancedExpressionPanelStub',
    setup(_, { expose }) {
      expose({
        confirm: () => undefined,
        confirmDisabled: false,
        isFunctionCatalogOpen: () => panelState.catalogOpen,
        closeFunctionCatalog: panelState.closeCatalog,
        isSearching: () => panelState.searching,
        clearSearch: panelState.clearSearch
      });
      return () => h('div', { class: 'panel-stub' });
    }
  });
  return { ...original, AdvancedExpressionPanel: PanelStub };
});

import V4ExpressionEditDialog from './V4ExpressionEditDialog.vue';

let app: App | null = null;
let host: HTMLElement | null = null;
const cancel = vi.fn();

/** 等 NModal 传送落地与微任务清空（本插件未装 @vue/test-utils，沿用 createApp 手法）。 */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function mountDialog(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({
    render: () =>
      h(V4ExpressionEditDialog, {
        i18n: { t: (key: string) => key } as never,
        mode: 'condition',
        expressionId: 'e1',
        readableText: '',
        v4Host: {} as never,
        expressionHost: {} as never,
        tables: [],
        onCancel: cancel
      })
  });
  app.mount(host);
  await flush();
}

const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  cancel.mockClear();
  document.body.innerHTML = '';
  panelState.catalogOpen = false;
  panelState.searching = false;
  panelState.closeCatalog.mockClear();
  panelState.clearSearch.mockClear();
});

describe('V4ExpressionEditDialog Esc 内层分流', () => {
  it('树坞搜索有内容：Esc 只清空搜索，不取消弹窗', async () => {
    await mountDialog();
    panelState.searching = true;
    escape();
    await flush();
    expect(panelState.clearSearch).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('函数目录开着：Esc 只收目录（优先于清空搜索），不取消弹窗', async () => {
    await mountDialog();
    panelState.catalogOpen = true;
    panelState.searching = true;
    escape();
    await flush();
    expect(panelState.closeCatalog).toHaveBeenCalledTimes(1);
    expect(panelState.clearSearch).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('面板无内层状态：Esc = 取消弹窗', async () => {
    await mountDialog();
    escape();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(panelState.clearSearch).not.toHaveBeenCalled();
  });
});
