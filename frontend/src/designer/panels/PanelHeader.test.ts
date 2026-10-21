/**
 * designer/panels/PanelHeader.test.ts —— PanelHeader.vue（属性面板公共头部：节点类型徽标 +
 * 节点名 + 就地改名）行为单测。
 *
 * 直接挂载 PanelHeader.vue 本体（不经由任何具体 *Panel.vue 中转），覆盖点击改名、回车/Esc/失焦
 * 等键盘交互，以及改名输入框键盘监听接线不触发 NaiveUI 运行期类型告警（见 PanelHeader.vue 头注释
 * "🔴"一节与下方"回归——…运行期类型告警"一节）。
 *
 * 挂载手法沿用 panel-test-helpers.ts 既定套路（本插件前端未装 @vue/test-utils，Vue 原生
 * createApp + app.provide 三个注入键，见该文件头注释）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { WorkflowNode } from '../../model';
import PanelHeader from './PanelHeader.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';

/** 同 StartPanel.test.ts 既定手法：多轮 microtask 把交互触发的 Vue 响应式更新一并落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i++) await nextTick();
}

/** 造一个"办理"节点 + 只含它一个可重复节点的文档——defaultNameForNodeAt 对可重复节点类型按
 *  "类型名+序号"算默认名（同 model/node-naming.ts 既定规则），这里唯一一个办理节点序号恒为 1，
 *  回填值恒为「办理 1」，断言不依赖节点在数组里的具体位置。 */
function buildHandleFixture(name?: string): { node: WorkflowNode; doc: ReturnType<typeof createDefaultDocument> } {
  const doc = createDefaultDocument('测试流程');
  const node: WorkflowNode = { id: 'handle_1', kind: 'handle', name, config: { assignees: [], complete_mode: { kind: 'any' }, no_route_hint: '' } };
  doc.nodes = [...doc.nodes, node];
  return { node, doc };
}

let mounted: MountedPanel<typeof PanelHeader> | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('PanelHeader：展示态', () => {
  it('回显节点类型名与节点名', async () => {
    const { node, doc } = buildHandleFixture('审核办理');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    // 类型行写全称「办理节点」，节点名照常回显。
    expect(mounted.el.querySelector('[data-testid="panel-header-type"]')!.textContent).toBe('办理节点');
    expect(mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.textContent).toBe('审核办理');
  });

  it('节点没起名时，名称回退成短类型名「办理」，不跟着类型行变成全称「办理节点」', async () => {
    const { node, doc } = buildHandleFixture('审核办理');
    const unnamed = { ...node, name: '' };
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node: unnamed, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('[data-testid="panel-header-type"]')!.textContent).toBe('办理节点');
    expect(mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.textContent).toBe('办理');
  });

  it('点击名称展示区进入编辑态：展示区消失、出现改名输入框并回显当前名字', async () => {
    const { node, doc } = buildHandleFixture('审核办理');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(mounted.el.querySelector('[data-testid="panel-header-name-display"]'), '进入编辑态后展示区应隐藏').toBeFalsy();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    expect(nameInput, '应出现改名输入框').toBeTruthy();
    expect(nameInput.value).toBe('审核办理');
  });

  it('只读态：点击名称不进入编辑态，不产生写入', async () => {
    const { node, doc } = buildHandleFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    expect(display.getAttribute('aria-disabled')).toBe('true');
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]'), '只读态点击不应出现改名输入框').toBeFalsy();
    expect(state.value!.doc.nodes.find((n) => n.id === node.id)!.name).toBe('原名字');
  });
});

describe('PanelHeader：就地改名——提交路径', () => {
  it('失焦提交：写回 renameNode，退出编辑态', async () => {
    const { node, doc } = buildHandleFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    nameInput.value = '改名后';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    // 只断言写回文档状态（state.doc）这一层结果，不断言重新挂载后展示区文案——真实运行时
    // 展示区文案来自父层按 doc 重新算出的 node prop（同 StartPanel.test.ts 既有断言范围的
    // 既定口径），本文件直接挂载 PanelHeader、拿的是一次性静态 node prop，commit 之后不会有
    // 谁把新名字重新灌回这个 prop，断言它理所当然还是原样，不代表真实运行时也不刷新。
    expect(state.value!.doc.nodes.find((n) => n.id === node.id)!.name).toBe('改名后');
    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]'), '提交后应退出编辑态').toBeFalsy();
  });

  // 覆盖回车这条提交路径本身的行为正确性（与展示区文案不做要求，见"失焦提交"用例的同款说明）；
  // 真正钉住那处接线缺陷（键盘监听在组件上错误的挂法触发运行期类型告警）的是下方独立的
  // "回归——…运行期类型告警"一节，见其说明与 PanelHeader.vue 头注释"🔴"一节的核实结论。
  it('回车提交：写回 renameNode，退出编辑态', async () => {
    const { node, doc } = buildHandleFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    nameInput.value = '回车提交后';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();

    // 同上一条"失焦提交"用例头部注释：只断言写回 state.doc + 退出编辑态，不断言展示区文案
    // （那要靠父层重新灌 node prop，本文件的静态 prop 挂载方式覆盖不到）。
    expect(state.value!.doc.nodes.find((n) => n.id === node.id)!.name).toBe('回车提交后');
    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]'), '回车提交后应退出编辑态').toBeFalsy();
  });

  it('清空名称后失焦：回填「类型名+序号」默认名（本文档内唯一办理节点，回填「办理 1」）', async () => {
    const { node, doc } = buildHandleFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    nameInput.value = '';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === node.id)!.name).toBe('办理 1');
  });
});

describe('PanelHeader：就地改名——取消路径', () => {
  it('Esc 取消：不落库，展示区还原为改名前的值', async () => {
    const { node, doc } = buildHandleFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    nameInput.value = '还没提交就按了 Esc';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === node.id)!.name, 'Esc 不应写回文档').toBe('原名字');
    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]'), 'Esc 后应退出编辑态').toBeFalsy();
    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]');
    expect(display, 'Esc 后应还原展示区').toBeTruthy();
    expect(display!.textContent).toBe('原名字');
  });
});

// 守住的缺陷：若改名输入框在同一个 keydown 事件名上分别挂两条带按键修饰符的监听，模板编译器
// 会把它们合并成一个函数数组整体传给 NaiveUI 组件，
// NaiveUI 对这个 prop 声明的类型是单个函数，收到数组会报"类型不对"的运行期告警——上面几条
// "回车提交"/"Esc 取消" 用例断言的是最终行为结果，哪怕是坏写法也不会把结果断言拖垮
// （NaiveUI 内部对这一类回调改用了"数组则逐个调用"的兼容处理，属于组件内部实现细节、不是公开
// 承诺的行为，不能依赖它长期成立），真正能钉住这个坏写法的只有这条告警本身，因此单独补一条
// 直接断言"不产生这条告警"。
describe('PanelHeader：回归——改名输入框不产生 NaiveUI 的运行期类型告警', () => {
  it('进入编辑态并触发一次回车提交，全程不出现"onKeydown"类型告警', async () => {
    const { node, doc } = buildHandleFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(PanelHeader, { node, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const warnings: string[] = [];
    mounted.app.config.warnHandler = (msg) => {
      warnings.push(msg);
    };

    mounted.el.querySelector('[data-testid="panel-header-name-display"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    nameInput.value = '回车提交后';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();

    expect(warnings, `不应出现任何运行期告警，实际收到：${JSON.stringify(warnings)}`).toHaveLength(0);
  });
});
