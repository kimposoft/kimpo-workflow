/**
 * designer/panels/HandlePanel.test.ts —— 办理节点（N2）属性面板『D 办理方式』『E 回退』
 * 『F 自动办理条件』三段行为单测 + 接线静态守护。
 *
 * 真正的数据变换（百分比换算/回退方式勾选顺序/回退清空复合键/按表分组选项）已在
 * ./shared/handleSections.test.ts 用纯函数单测覆盖，本文件只覆盖"接线对不对"这一层：三段分区
 * 渲染在正确位置、点击/输入触发正确的文档写入、E2 依赖 useTemplateFieldCatalog 而不是自行重复
 * 取数、只读态禁用。同 ApprovePanel.test.ts 头注释的既定分工：NSelect 的下拉展开/选中交互在
 * happy-dom 下模拟不了，改用 @update:value 事件对应的原生 change/input 可断言到的部分。
 *
 * 静态守护部分（对源码文本做结构化断言，同 ../expression/V4ExpressionField.static.test.ts 手法）
 * 覆盖：D/E/F 三段在『办理人』和『无路可走时的提示』之间、E2 走共享取数件、
 * AssigneeSourceList.vue 不含原生 select/checkbox、data-testid 齐全。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { HandleConfig, StartConfig, WorkflowNode } from '../../model';
import HandlePanel from './HandlePanel.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';
import { invalidateTemplateFieldCatalog } from './shared/templateFieldCatalog';

// 绝大多数用例的目标表单 id 恒为 'tpl_x'（见 buildDocWithHandleNode 默认值），而
// useTemplateFieldCatalog 内部按 templateId 做模块级缓存（见 templateFieldCatalog.ts 头注释），
// 不同用例挂的假 host 返回的字段目录并不相同——每个用例开始前必须失效缓存，否则会读到上一个用例
// 缓存下来的结果（同 templateFieldCatalog.test.ts 既定手法）。
beforeEach(() => {
  invalidateTemplateFieldCatalog();
});

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function buildDocWithHandleNode(handleConfig: Partial<HandleConfig> = {}, hasTargetTemplate = true) {
  const doc = createDefaultDocument('测试流程');
  const startNode = doc.nodes.find((n) => n.kind === 'start')!;
  startNode.config = {
    target_template_id: hasTargetTemplate ? 'tpl_x' : '',
    allow_manual_start: true,
    no_route_hint: '',
    start_permission: {}
  } satisfies StartConfig;
  const handleNode: WorkflowNode = {
    id: 'handle1',
    kind: 'handle',
    name: '',
    config: {
      assignees: [],
      complete_mode: { kind: 'any' },
      no_route_hint: '',
      ...handleConfig
    } satisfies HandleConfig,
    position_x: 320,
    position_y: 200
  };
  doc.nodes.push(handleNode);
  return { doc, handleNode };
}

function fieldHost(overrides: Partial<Parameters<typeof fakeHost>[0]> = {}) {
  return fakeHost({
    listTemplateTables: async () => ({
      data: {
        items: [
          { data_table_id: 'dt1', table_name: '主表', table_role: 'main' },
          { data_table_id: 'dt2', table_name: '明细表', table_role: 'detail' }
        ]
      }
    }),
    listTemplateFields: async (_templateId: string, dataTableId: string) => {
      if (dataTableId === 'dt1') return { data: { items: [{ field_id: 'f1', field_name: '主表字段', data_type: 'text' }] } };
      return { data: { items: [{ field_id: 'f2', field_name: '明细字段', data_type: 'text' }] } };
    },
    ...overrides
  });
}

let mounted: MountedPanel<typeof HandlePanel> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function handleConfigOf(state: ReturnType<typeof fakeState>): HandleConfig {
  return state.value!.doc.nodes.find((n) => n.id === 'handle1')!.config as unknown as HandleConfig;
}

describe('HandlePanel：头部 + 三个分区都在', () => {
  it('挂载后头部渲染 + 三个分区标题齐全（各分区常驻 DOM，只是用 v-show 切显隐，textContent 读得到未激活分区的文案）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('[data-testid="panel-header"]'), '应渲染公共头部 PanelHeader（取代此前各面板各自的「节点名称」分区）').toBeTruthy();
    const text = mounted.el.textContent ?? '';
    for (const title of ['从哪里选人', '办理方式', '回退', '自动办理条件', '无路可走时的提示', '步骤摘要', '字段权限']) {
      expect(text, `缺少分区标题：${title}`).toContain(title);
    }
  });
});

// 节点改名由公共头部 PanelHeader.vue 就地改名——本节经 PanelHeader 渲染出的 DOM 覆盖写入
// renameNode / 清空失焦回填默认名 / 有值不回填。
describe('HandlePanel：节点名称（经由 PanelHeader 就地改名）', () => {
  it('点击名称进入编辑态、输入并失焦提交后写回 renameNode', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const input = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    expect(input, '点击名称后应出现改名输入框').toBeTruthy();
    input.value = '财务复核';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === 'handle1')!.name).toBe('财务复核');
  });

  // 清空名称、失焦回填"类型名+序号"默认名——doc.nodes 里这是唯一的办理节点（start/end 各一个
  // 在它之前），回填值应为「办理 1」。
  it('清空名称后失焦：回填「办理 1」（doc.nodes 里的第一个办理节点）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    handleNode.name = '原名字';
    doc.nodes = doc.nodes.map((n) => (n.id === handleNode.id ? handleNode : n));
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const input = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === 'handle1')!.name).toBe('办理 1');
  });

  it('失焦时名称非空：不回填，保留设计者填的值', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const input = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    input.value = '财务复核';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === 'handle1')!.name).toBe('财务复核');
  });

  it('只读态：点击名称不进入编辑态，不产生写入', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    handleNode.name = '原名字';
    doc.nodes = doc.nodes.map((n) => (n.id === handleNode.id ? handleNode : n));
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    expect(display.getAttribute('aria-disabled')).toBe('true');
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]'), '只读态点击不应出现改名输入框').toBeFalsy();
    expect(state.value!.doc.nodes.find((n) => n.id === 'handle1')!.name).toBe('原名字');
  });
});

describe('HandlePanel：D 办理方式', () => {
  it('点击"按比例"单选后，写回默认 100%（万分比 10000）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const percentageRadio = mounted.el.querySelector('[data-testid="handle-complete-mode-percentage"] input[type="radio"]') as HTMLInputElement;
    expect(percentageRadio).toBeTruthy();
    percentageRadio.checked = true;
    percentageRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(handleConfigOf(state).complete_mode).toEqual({ kind: 'percentage', percentage_bp: 10000 });
  });

  it('点击"任意一人办理即可"单选后，写回 {kind: any}', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ complete_mode: { kind: 'percentage', percentage_bp: 8000 } });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const anyRadio = mounted.el.querySelector('[data-testid="handle-complete-mode-any"] input[type="radio"]') as HTMLInputElement;
    anyRadio.checked = true;
    anyRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(handleConfigOf(state).complete_mode).toEqual({ kind: 'any' });
  });

  it('已是"按比例"档时，NInputNumber 改百分比写回万分比（钳到 1~100）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ complete_mode: { kind: 'percentage', percentage_bp: 8000 } });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    // 同 ApprovePanel.test.ts 头注释：NInputNumber 内部真正的原生 <input> 不在 data-testid 落点
    // 的那个元素本身（data-testid 落在 NInputNumber 组件根节点，原生 input 是其后代），用外层容器
    // class 选择器定位，同 ApprovePanel.test.ts 既有用法（`.ap__percentage-row input`）。
    const percentInput = mounted.el.querySelector('.hp__percentage-row input') as HTMLInputElement;
    expect(percentInput).toBeTruthy();
    expect(percentInput.value).toBe('80');
    percentInput.value = '150';
    percentInput.dispatchEvent(new Event('input', { bubbles: true }));
    // 越界值（150 > max 100）在"正在输入"态不会立即提交（见 naive-ui InputNumber 源码
    // deriveValueFromDisplayedValue 的 isInputing 分支），要等 blur 才会钳到边界并提交——同用户
    // 真实交互"打字后移开焦点"一致，不是测试专用手法。
    percentInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(handleConfigOf(state).complete_mode).toEqual({ kind: 'percentage', percentage_bp: 10000 });
  });

  // 办理方式第三档「全部完成」（all），语义等同按比例 100%，但落库形状不带
  // percentage_bp——以下四条用例覆盖这一档。
  it('三格齐全且顺序正确：任意一人 / 全部完成 / 按比例', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const group = mounted.el.querySelector('.hp__mode-group') as HTMLElement;
    const testids = Array.from(group.querySelectorAll('[data-testid^="handle-complete-mode-"]')).map((el) => el.getAttribute('data-testid'));
    expect(testids).toEqual(['handle-complete-mode-any', 'handle-complete-mode-all', 'handle-complete-mode-percentage']);
    expect(group.textContent).toContain('任意一人');
    expect(group.textContent).toContain('全部完成');
    expect(group.textContent).toContain('按比例');
  });

  it('点击"全部完成"单选后，写回恰为 { kind: all }（不含 percentage_bp）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ complete_mode: { kind: 'percentage', percentage_bp: 8000 } });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const allRadio = mounted.el.querySelector('[data-testid="handle-complete-mode-all"] input[type="radio"]') as HTMLInputElement;
    allRadio.checked = true;
    allRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    const mode = handleConfigOf(state).complete_mode;
    expect(mode).toEqual({ kind: 'all' });
    expect(Object.prototype.hasOwnProperty.call(mode, 'percentage_bp')).toBe(false);
  });

  it('"全部完成"档下不显示比例数值框，说明块文案正确', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ complete_mode: { kind: 'all' } });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('.hp__percentage-row')).toBeFalsy();
    expect(mounted.el.textContent).toContain('全部完成：所有办理人都提交了，这一步才往下走；中途有人回退，整步立即回退。');
  });

  // 同 E1 回退方式勾选 describe 块头注释的既定限制：面板读的是挂载时传入的静态 node prop，写完
  // 之后不会自己触发这份 prop 重渲染，同一个挂载实例上连续两次真实点击测不出真实结果——因此
  // "从按比例切到全部完成再切回按比例"这条验收点拆成两个独立的单次点击挂载来覆盖，分别对应
  // 这条路径的两段：percentage→all（上面那条用例已覆盖，写回恰为 { kind: 'all' }）、
  // all→percentage（下面这条）。
  it('从"全部完成"档切回"按比例"：all 档没有历史 percentage_bp，回退到默认 100%（同"任意一人→按比例"既有路径同一套默认值兜底）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ complete_mode: { kind: 'all' } });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const percentageRadio = mounted.el.querySelector('[data-testid="handle-complete-mode-percentage"] input[type="radio"]') as HTMLInputElement;
    percentageRadio.checked = true;
    percentageRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(handleConfigOf(state).complete_mode).toEqual({ kind: 'percentage', percentage_bp: 10000 });
  });
});

describe('HandlePanel：E1 回退方式勾选', () => {
  // 同 EndPanel.test.ts / ApprovePanel.test.ts 既定口径（见其头注释）：面板读的是挂载时传入的
  // 静态 node prop，写完之后不会自己触发这份 prop 重渲染，因此同一个挂载实例上连续点两次勾选框
  // 断言不出真实结果（第二次点击算出的还是基于挂载时那份旧 config）——每条用例只做一次写入，
  // "多个已勾选档位时结果数组按固定顺序排列"这件事已经在 handleSections.test.ts 用纯函数覆盖过。
  // NCheckbox 不渲染原生 <input type="checkbox">（naive-ui 用 role="checkbox" 的 div 自绘，见
  // node_modules/naive-ui checkbox/src/Checkbox.mjs render()），data-testid 落在该 div 根节点
  // 本身；交互走原生 click，不是勾选 .checked 属性。
  it('勾选「回退到指定步骤」写回 [specified_step]', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const specified = mounted.el.querySelector('[data-testid="handle-withdraw-specified_step"]') as HTMLElement;
    specified.click();
    await flush();

    expect(handleConfigOf(state).allowed_withdraw_methods).toEqual(['specified_step']);
  });

  it('已勾选「指定步骤」时再勾选「上一步」：写回按固定顺序排列的两档', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ allowed_withdraw_methods: ['specified_step'] });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const previous = mounted.el.querySelector('[data-testid="handle-withdraw-previous_step"]') as HTMLElement;
    previous.click();
    await flush();

    expect(handleConfigOf(state).allowed_withdraw_methods).toEqual(['previous_step', 'specified_step']);
  });

  it('未勾选任何回退方式时 E2 处于禁用态并给出业务话提示', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({}, false);
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).toContain('请先至少勾选一种回退方式');
    const select = mounted.el.querySelector('[data-testid="handle-clear-on-withdraw"] .n-base-selection') as HTMLElement;
    expect(select.className).toContain('n-base-selection--disabled');
  });
});

describe('HandlePanel：E2 回退时清空的字段', () => {
  it('勾选一种回退方式且目标表单已选时，取到跨主表/明细表字段目录，已配置 clear_on_withdraw 时回显对应标签', async () => {
    // 同 ApprovePanel.test.ts 头注释：NSelect 的下拉展开在 happy-dom 下模拟不了，只能断言"已选中
    // 的字段在收起态的 tag 上回显了正确名字"，用它侧面验证目录确实取到了、且写到了正确的表/字段。
    const { doc, handleNode } = buildDocWithHandleNode({
      allowed_withdraw_methods: ['previous_step'],
      clear_on_withdraw: [
        { table_id: 'dt1', field_id: 'f1' },
        { table_id: 'dt2', field_id: 'f2' }
      ]
    });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fieldHost(), state, i18n: fakeI18n() });
    await flush(10);

    const selectRoot = mounted.el.querySelector('[data-testid="handle-clear-on-withdraw"]') as HTMLElement;
    expect(selectRoot.textContent).toContain('主表字段');
    expect(selectRoot.textContent).toContain('明细字段');
  });

  it('已选字段在目录里已不存在：保留占位标签，不静默丢弃', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({
      allowed_withdraw_methods: ['previous_step'],
      clear_on_withdraw: [{ table_id: 'dt_ghost', field_id: 'f_gone' }]
    });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fieldHost(), state, i18n: fakeI18n() });
    await flush(10);

    const selectRoot = mounted.el.querySelector('[data-testid="handle-clear-on-withdraw"]') as HTMLElement;
    expect(selectRoot.textContent).toContain('字段已不存在');
  });

  it('目录加载失败：给出业务话提示 + 「重试」按钮，点击后重新拉取并恢复', async () => {
    // 不断言内部具体发了几次请求（useTemplateFieldCatalog 的 watch 在挂载期可能不止触发一次，
    // 那是共享取数件自己的实现细节，不是这里的断言对象——同项目一贯口径"断言业务可观察结果，
    // 不断言内部调用次数"）；用一个可翻转的失败开关，只断言"翻转前恒失败态 → 点重试 → 翻转后
    // 失败提示消失"这一业务结果。
    const { doc, handleNode } = buildDocWithHandleNode({ allowed_withdraw_methods: ['initiator'] });
    const state = fakeState(doc);
    let shouldFail = true;
    const host = fieldHost({
      listTemplateTables: async () => {
        if (shouldFail) return { error: { message: 'boom' } };
        return { data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } };
      }
    });
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush(10);

    expect(mounted.el.textContent).toContain('字段目录加载失败');
    const retryBtn = mounted.el.querySelector('[data-testid="handle-clear-fields-retry"]') as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();

    shouldFail = false;
    retryBtn.click();
    await flush(10);

    expect(mounted.el.textContent).not.toContain('字段目录加载失败');
  });
});

describe('HandlePanel：F 自动办理条件 / 步骤摘要挂点', () => {
  it('两个 V4ExpressionField 均有可编辑入口（自动办理条件 + 步骤摘要）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();
    const editButtons = mounted.el.querySelectorAll('[data-testid="v4field-edit"]');
    expect(editButtons.length).toBe(2);
  });
});

describe('HandlePanel：再缩小范围（与上步处理人的关系，过滤器）', () => {
  it('basic 分区渲染出该卡，位置在『从哪里选人』之后、『步骤摘要』之前', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    // querySelector 拿到的是文档序里第一个 `.hp__pane`——三个分区面板常驻 DOM（v-show 只切
    // display），模板里 basic 分区在最前面，因此第一个匹配恰是 basic 分区（同文件其余用例
    // "读的是挂载时的静态渲染结果"这一既定手法，不依赖 activeTab 当前值）。
    const basicPane = mounted.el.querySelector('.hp__pane') as HTMLElement;
    const titles = Array.from(basicPane.querySelectorAll('.wf-panel-section__title')).map((el) => el.textContent);
    expect(titles).toEqual(['从哪里选人', '再缩小范围', '步骤摘要']);
  });

  it('回显：config.relation_filters 已配置的档位对应胶囊选中态', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ relation_filters: ['same_department', 'child_department'] });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect((mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect((mounted.el.querySelector('[data-testid="relation-filter-child_department"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect((mounted.el.querySelector('[data-testid="relation-filter-department_manager"]') as HTMLElement).getAttribute('aria-checked')).toBe('false');
  });

  it('勾选一档：经 patchConfig 写回 config.relation_filters', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).click();
    await flush();

    expect(handleConfigOf(state).relation_filters).toEqual(['same_department']);
  });

  it('取消唯一已勾选的档位：写回 undefined（不是空数组）', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ relation_filters: ['same_department'] });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).click();
    await flush();

    expect(handleConfigOf(state).relation_filters).toBeUndefined();
  });

  it('只读态：胶囊禁用，点击不产生写操作', async () => {
    const { doc, handleNode } = buildDocWithHandleNode();
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const pill = mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement;
    expect(pill.getAttribute('aria-disabled')).toBe('true');
    pill.click();
    await flush();

    expect(handleConfigOf(state).relation_filters).toBeUndefined();
  });
});

describe('HandlePanel：只读态', () => {
  it('readOnly 时名称改名入口/办理方式/回退勾选/清空字段选择均禁用', async () => {
    const { doc, handleNode } = buildDocWithHandleNode({ allowed_withdraw_methods: ['previous_step'] });
    const state = fakeState(doc);
    mounted = mountPanel(HandlePanel, { node: handleNode, readOnly: true }, { host: fieldHost(), state, i18n: fakeI18n() });
    await flush(10);

    // 名称改名入口在 PanelHeader，只读态体现为不可点击（同一份
    // aria-disabled 断言见上面「节点名称（经由 PanelHeader 就地改名）」describe 块，这里只额外
    // 确认它和办理方式/回退/清空字段几个控件在同一次只读挂载里一起被禁用）。
    const nameDisplay = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    expect(nameDisplay.getAttribute('aria-disabled')).toBe('true');
    const anyRadio = mounted.el.querySelector('[data-testid="handle-complete-mode-any"] input[type="radio"]') as HTMLInputElement;
    expect(anyRadio.disabled).toBe(true);
    // NCheckbox 无原生 disabled 属性可读，禁用态体现为根节点上的 --disabled 修饰类（同上一个
    // describe 块头注释）。
    const previousCheck = mounted.el.querySelector('[data-testid="handle-withdraw-previous_step"]') as HTMLElement;
    expect(previousCheck.className).toContain('n-checkbox--disabled');
    const select = mounted.el.querySelector('[data-testid="handle-clear-on-withdraw"] .n-base-selection') as HTMLElement;
    expect(select.className).toContain('n-base-selection--disabled');
  });
});

// ── 静态守护：源码文本结构化断言（同 ../expression/V4ExpressionField.static.test.ts 手法） ──────
const handlePanelSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/HandlePanel.vue'), 'utf8');
const assigneeSourceListSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/shared/AssigneeSourceList.vue'), 'utf8');
// 『关系』胶囊是独立小组件（RelationPills.vue，见其头注释），relation-filter-<relation> 这个
// data-testid 落在该文件里；挂载点是 shared/RelationFilterCard.vue（关系是独立过滤器而不是
// 人员来源），两处源码一并读取核对。
const relationPillsSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/shared/RelationPills.vue'), 'utf8');
const relationFilterCardSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/shared/RelationFilterCard.vue'), 'utf8');

describe('静态守护：D/E/F 三段位置固定在『办理人』与『无路可走时的提示』之间', () => {
  it('模板里分区标题的出现顺序：assignees → completeModeTitle(D) → section.withdraw(E) → section.autoComplete(F) → section.noRouteHint', () => {
    const anchors = [
      'workflow.designer.panel.section.assignees',
      // 办理面板改用自己的标题键（审批那一份的文案已改成「审批方式」，两者不再共用）。
      'workflow.designer.panel.handle.completeModeTitle',
      'workflow.designer.panel.section.withdraw',
      'workflow.designer.panel.section.autoComplete',
      'workflow.designer.panel.section.noRouteHint'
    ];
    const positions = anchors.map((key) => handlePanelSource.indexOf(key));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `${anchors[i]} 应该出现在 ${anchors[i - 1]} 之后`).toBeGreaterThan(positions[i - 1]);
    }
  });
});

describe('静态守护：E2 走共享取数件 useTemplateFieldCatalog，不自行重复调 host.listTemplate*', () => {
  it('引入并使用 useTemplateFieldCatalog', () => {
    expect(handlePanelSource).toContain("from './shared/templateFieldCatalog'");
    expect(handlePanelSource).toContain('useTemplateFieldCatalog(');
  });

  it('不直接调用 host.listTemplateTables / host.listTemplateFields（那是共享取数件内部的事）', () => {
    expect(handlePanelSource).not.toContain('host.listTemplateTables');
    expect(handlePanelSource).not.toContain('host.listTemplateFields');
  });
});

describe('静态守护：AssigneeSourceList.vue 不再含原生 select / checkbox', () => {
  it('不含 <select 标签', () => {
    expect(assigneeSourceListSource).not.toContain('<select');
  });

  it('不含 type="checkbox"', () => {
    expect(assigneeSourceListSource).not.toContain('type="checkbox"');
  });
});

describe('静态守护：新增 data-testid 齐全', () => {
  it('HandlePanel.vue 新增的 D/E/F 各控件 data-testid 都在', () => {
    for (const testid of [
      'handle-complete-mode-any',
      'handle-complete-mode-all',
      'handle-complete-mode-percentage',
      'handle-complete-percentage',
      'handle-withdraw-previous_step',
      'handle-withdraw-initiator',
      'handle-withdraw-specified_step',
      'handle-clear-on-withdraw',
      'handle-clear-fields-retry'
    ]) {
      expect(handlePanelSource, `缺少 data-testid="${testid}"`).toContain(`data-testid="${testid}"`);
    }
  });

  it('AssigneeSourceList.vue 的 data-testid 都在（含动态拼接的 asl-add-<kind> / asl-row(-remove)-${index} / asl-matchby-${index}；不含 asl-relation-*，见下方独立断言）', () => {
    expect(assigneeSourceListSource).toContain('data-testid="asl-add"');
    expect(assigneeSourceListSource).toContain("'data-testid': `asl-add-${kind}`");
    expect(assigneeSourceListSource).toContain(':data-testid="`asl-row-${index}`"');
    expect(assigneeSourceListSource).toContain(':data-testid="`asl-row-remove-${index}`"');
    expect(assigneeSourceListSource).toContain(':data-testid="`asl-matchby-${index}`"');
  });
});

// 人员来源「发起人」档接线静态守护。NDropdown 的展开/选中交互在 happy-dom
// 下模拟不了（同 ApprovePanel.vue/HandlePanel.vue 头注释里"NSelect 下拉在 happy-dom 里不会真的
// 弹出/可点选"同一限制，NDropdown 同理），真正的增删逻辑已在 assigneeSource.test.ts 用纯函数
// 覆盖（addInitiatorSource 去重/describeSource），这里只做"接线对不对"的源码结构断言——位置在
// main_field 之后（菜单末位，relation 不在菜单里，见下一个 describe 块），已存在
// 时菜单项置灰，onAddSelect 分发到 addInitiator。
describe('静态守护：AssigneeSourceList.vue「发起人」档接线（ADD_KINDS 顺序 / 置灰 / 分发）', () => {
  it('ADD_KINDS 里 initiator 排在 main_field 之后（末位）', () => {
    const match = /const ADD_KINDS: AssigneeSourceKind\[\] = \[([^\]]+)\];/.exec(assigneeSourceListSource);
    expect(match, '应能找到 ADD_KINDS 声明').toBeTruthy();
    const kinds = (match![1].match(/'[a-z_]+'/g) ?? []).map((s) => s.slice(1, -1));
    expect(kinds).toEqual(['user', 'role', 'department', 'main_field', 'initiator']);
  });

  it('已存在一条 initiator 来源时，「＋添加来源」菜单里的发起人项置灰', () => {
    expect(assigneeSourceListSource).toContain("disabled: kind === 'initiator' ? props.modelValue.some((s) => s.kind === 'initiator') : undefined");
  });

  it('onAddSelect 选中 initiator 时直接调用 addInitiator（不弹任何选择器）', () => {
    expect(assigneeSourceListSource).toContain("} else if (kind === 'initiator') {\n    addInitiator();");
  });
});

// 『与上步处理人的关系』不是 AssigneeSourceList.vue 的来源菜单项，挂载点在独立的
// shared/RelationFilterCard.vue；本节覆盖"来源清单里没有关系接线 + 过滤卡接线落地"两个方向。
describe('静态守护：『与上步处理人的关系』挂载点（AssigneeSourceList.vue 不含 / RelationFilterCard.vue 接线）', () => {
  it('AssigneeSourceList.vue 不引入/挂载关系胶囊组件，没有展开态开关', () => {
    expect(assigneeSourceListSource).not.toContain("from './RelationPills.vue'");
    expect(assigneeSourceListSource).not.toContain('<RelationPills');
    expect(assigneeSourceListSource).not.toContain('PickerOpen');
  });

  it('RelationPills.vue 的 data-testid 为 relation-filter-${r}（不是 asl-relation-*，见其头注释）', () => {
    expect(relationPillsSource).toContain(':data-testid="`relation-filter-${r}`"');
    expect(relationPillsSource).not.toContain(':data-testid="`asl-relation');
  });

  it('RelationFilterCard.vue 引入 RelationPills 与 ./relationFilters.ts 的纯函数，写回经 patchConfig 收口在调用方（本文件不重复断言 HandlePanel.vue 的 patchConfig 接线，已在上面动态挂载用例覆盖）', () => {
    expect(relationFilterCardSource).toContain("from './RelationPills.vue'");
    expect(relationFilterCardSource).toContain("from './relationFilters'");
    expect(relationFilterCardSource).toContain('toggleRelationFilter(');
  });
});
