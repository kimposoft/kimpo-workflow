/**
 * designer/panels/StartPanel.test.ts —— 发起节点属性面板行为单测。
 *
 * 覆盖本面板的几条核心行为：换模板二次确认与清空 / 发起权限回填 / 必填（无路可走
 * 提示）空值提示。目标表单选择经宿主通用弹窗 host.ui.openTemplatePicker（appId 现由
 * DesignerHost.appId 提供，见 StartPanel.vue 头注释），本文件断言"点按钮时带上了正确的
 * appId/selectedTemplateId 调用弹窗"与"弹窗确认后的换模板二次确认 + 清空逻辑"，不断言弹窗
 * 内部渲染（那是宿主侧的范围，不在本插件）。步骤摘要
 * （V4ExpressionField）内部渲染同理不在本文件覆盖范围，本文件只锁定"写入文档"这一层结果
 * 是否正确。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { StartConfig, WorkflowNode } from '../../model';
import StartPanel from './StartPanel.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';

/** 多轮 microtask + 一次 setTimeout(0)，把面板挂载/交互触发的异步 host 调用与随后的 Vue
 *  响应式更新一并落定；本文件多处 await host 方法（Promise），单一 nextTick 不够用。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i++) await nextTick();
}

function buildStartNode(config: Partial<StartConfig>): WorkflowNode {
  return {
    id: 'start',
    kind: 'start',
    config: {
      target_template_id: '',
      allow_manual_start: true,
      no_route_hint: '',
      start_permission: {},
      ...config
    } satisfies StartConfig
  };
}

let mounted: MountedPanel<typeof StartPanel> | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

// 发起节点的节点名会显示在填报层流程进度页/任务列表/管理页，改名入口在公共头部 PanelHeader.vue
// （就地改名），本节驱动 PanelHeader 渲染出的 DOM 来覆盖改名行为。
describe('StartPanel：节点名称（经由 PanelHeader 就地改名）', () => {
  it('头部回显 node.name', async () => {
    const startNode = buildStartNode({});
    startNode.name = '发起申请';
    const doc = createDefaultDocument('测试流程');
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]');
    expect(display).toBeTruthy();
    expect(display!.textContent).toBe('发起申请');
  });

  it('点击名称进入编辑态、输入并失焦提交后写回 renameNode', async () => {
    const startNode = buildStartNode({});
    const doc = createDefaultDocument('测试流程');
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    expect(nameInput, '点击名称后应出现改名输入框').toBeTruthy();
    nameInput.value = '提交申请';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === startNode.id)!.name).toBe('提交申请');
  });

  it('只读态：点击名称不进入编辑态，不产生写入', async () => {
    const startNode = buildStartNode({});
    startNode.name = '原名字';
    const doc = createDefaultDocument('测试流程');
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    expect(display.getAttribute('aria-disabled')).toBe('true');
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]'), '只读态点击不应出现改名输入框').toBeFalsy();
    expect(state.value!.doc.nodes.find((n) => n.id === startNode.id)!.name).toBe('原名字');
  });

  // 清空名称、失焦回填默认名——发起节点
  // 全图恒唯一，回填值恒为不带序号的「发起」（同 createDefaultStartNode 的默认名规则，不是
  // 「发起 1」）。
  it('清空名称后失焦：回填不带序号的「发起」', async () => {
    const startNode = buildStartNode({});
    startNode.name = '原名字';
    const doc = createDefaultDocument('测试流程');
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const display = mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement;
    display.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const nameInput = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    nameInput.value = '';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === startNode.id)!.name).toBe('发起');
  });
});

describe('StartPanel：目标表单——调宿主通用弹窗 + 换模板二次确认与清空', () => {
  // 二次确认走宿主确认框服务 host.ui.openConfirm；各用例按需构造 mock 并传给 fakeHost。

  it('点「选择模板」：调 openTemplatePicker 时带上 appId 与当前已选模板', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: 'tpl_old' });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const openTemplatePicker = vi.fn().mockResolvedValue({ confirmed: false, template: null });
    const host = fakeHost({
      appId: 'app_123',
      getTemplate: async (id: string) => ({ data: { template_id: id, template_name: '旧表单', has_active_bundle: true } }),
      ui: { ...fakeHost().ui, openTemplatePicker }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    const pickBtn = Array.from(mounted.el.querySelectorAll('button')).find((b) => b.textContent?.includes('选择模板'));
    expect(pickBtn).toBeTruthy();
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(openTemplatePicker).toHaveBeenCalledTimes(1);
    expect(openTemplatePicker).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app_123', selectedTemplateId: 'tpl_old' }));
  });

  it('已有目标表单时换成另一个：弹窗确认后二次确认，确认后清空 summary_expr / field_permissions', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({
      target_template_id: 'tpl_old',
      summary_expr: {
        schema_version: 'kimpo.report-expression/v4',
        mode: 'value',
        expression: { expression_id: 'start:summary', purpose: 'output', source_text: '"旧摘要"', refs: [] }
      },
      field_permissions: [{ table_id: 't1', field_id: 'f1', grade: 'edit' }]
    });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const openConfirm = vi.fn().mockResolvedValue({ confirmed: true });
    const host = fakeHost({
      appId: 'app_123',
      getTemplate: async (id: string) => ({ data: { template_id: id, template_name: id === 'tpl_old' ? '旧表单' : '新表单', has_active_bundle: true } }),
      ui: {
        ...fakeHost().ui,
        openTemplatePicker: async () => ({ confirmed: true, template: { template_id: 'tpl_new', template_name: '新表单', published: true } }),
        openConfirm
      }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    const pickBtn = Array.from(mounted.el.querySelectorAll('button')).find((b) => b.textContent?.includes('选择模板'));
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(openConfirm).toHaveBeenCalledTimes(1);
    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.target_template_id).toBe('tpl_new');
    expect(nextConfig.summary_expr).toBeUndefined();
    expect(nextConfig.field_permissions).toBeUndefined();
  });

  it('弹窗内选中后拒绝二次确认：目标表单与已有摘要/字段权限保持不变', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({
      target_template_id: 'tpl_old',
      field_permissions: [{ table_id: 't1', field_id: 'f1', grade: 'edit' }]
    });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const host = fakeHost({
      getTemplate: async () => ({ data: { template_id: 'tpl_old', template_name: '旧表单', has_active_bundle: true } }),
      ui: {
        ...fakeHost().ui,
        openTemplatePicker: async () => ({ confirmed: true, template: { template_id: 'tpl_new', template_name: '新表单', published: true } }),
        openConfirm: vi.fn().mockResolvedValue({ confirmed: false })
      }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    const pickBtn = Array.from(mounted.el.querySelectorAll('button')).find((b) => b.textContent?.includes('选择模板'));
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.target_template_id).toBe('tpl_old');
    expect(nextConfig.field_permissions).toEqual([{ table_id: 't1', field_id: 'f1', grade: 'edit' }]);
  });

  it('弹窗本身被取消（confirmed=false）：不产生任何写入，也不弹二次确认', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: 'tpl_old' });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const openConfirm = vi.fn().mockResolvedValue({ confirmed: true });
    const host = fakeHost({
      getTemplate: async () => ({ data: { template_id: 'tpl_old', template_name: '旧表单', has_active_bundle: true } }),
      ui: { ...fakeHost().ui, openTemplatePicker: async () => ({ confirmed: false, template: null }), openConfirm }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    const pickBtn = Array.from(mounted.el.querySelectorAll('button')).find((b) => b.textContent?.includes('选择模板'));
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(openConfirm).not.toHaveBeenCalled();
    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.target_template_id).toBe('tpl_old');
  });

  it('首次选择（此前未选过任何模板）：不弹二次确认，直接写入', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: '' });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const openConfirm = vi.fn().mockResolvedValue({ confirmed: true });
    const host = fakeHost({
      ui: {
        ...fakeHost().ui,
        openTemplatePicker: async () => ({ confirmed: true, template: { template_id: 'tpl_new', template_name: '新表单', published: true } }),
        openConfirm
      }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    const pickBtn = Array.from(mounted.el.querySelectorAll('button')).find((b) => b.textContent?.includes('选择模板'));
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    expect(openConfirm).not.toHaveBeenCalled();
    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.target_template_id).toBe('tpl_new');
  });
});

describe('StartPanel：发起权限——回填', () => {
  it('选择器确认后：写入 start_permission 的 user_ids，且展示行改用回填的真实姓名', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({});
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const host = fakeHost({
      ui: {
        ...fakeHost().ui,
        openOrgTriPicker: async () => ({
          confirmed: true,
          users: [{ user_id: 'u1', login_name: 'zhangsan', display_name: '张三' }],
          roles: [],
          depts: []
        })
      }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    // 🔴 入口是 NDropdown 菜单（两项：用户/角色/部门、表单字段），点 `org-tri-add` 只是展开菜单，
    // 需要再点 `org-tri-add-org` 才会真正调用 openOrgTriPicker。
    const pickBtn = mounted.el.querySelector('[data-testid="org-tri-add"]');
    expect(pickBtn).toBeTruthy();
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const orgOption = document.body.querySelector('[data-testid="org-tri-add-org"]');
    expect(orgOption, '菜单应展开出「用户 / 角色 / 部门」这一项').toBeTruthy();
    orgOption!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    // 面板读的是挂载时传入的静态 node prop（同 EndPanel.test.ts 头注释同一理由），OrgTriLine
    // 的 modelValue 因此也不会在这次挂载里"自己"跟着变新——姓名回填缓存与展示行的正确性由
    // OrgTriLine 自己的单测（OrgTriLine.test.ts）覆盖，这里只锁住"确认后写对了
    // start_permission"这一结果。
    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.start_permission?.user_ids).toEqual(['u1']);
  });

  it('选择器取消：不产生任何写入', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({});
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const host = fakeHost({
      ui: { ...fakeHost().ui, openOrgTriPicker: async () => ({ confirmed: false, users: [], roles: [], depts: [] }) }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    // 同上一条改写理由：先展开菜单，再点「用户 / 角色 / 部门」才会真正调用
    // openOrgTriPicker（该 mock 返回 confirmed:false），确保本用例仍在真正测"取消"这条路径。
    const pickBtn = mounted.el.querySelector('[data-testid="org-tri-add"]');
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    document.body.querySelector('[data-testid="org-tri-add-org"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.start_permission).toEqual({});
  });

  it('来源列表形态：一类来源一行；点某一行的 × 只清空这一类，其余两类原样保留', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ start_permission: { user_ids: ['u1'], role_ids: ['r1', 'r2'], department_ids: [] } });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    // 有选的两类各一行，没选的部门不出行。
    expect(mounted.el.querySelector('[data-testid="org-tri-row-user"]')).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-role"]')).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-department"]')).toBeNull();

    mounted.el.querySelector('[data-testid="org-tri-row-remove-role"]')!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.start_permission).toEqual({ user_ids: ['u1'], role_ids: [], department_ids: [] });
  });
});

// 选填：空值不是"待补的必填"，灰字告诉设计者默认文案是什么。
describe('StartPanel：无路可走时的提示（选填）', () => {
  it('为空时提示默认文案而非催填；填写后写回文档', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ no_route_hint: '' });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).toContain('不填写时，提交人会看到默认提示「没有满足条件的后续步骤」');
    // 反向锁：不应出现带必填星号的催填红字。
    expect(mounted.el.textContent).not.toContain('还没有填写无路可走时的提示');

    // 同 EndPanel.test.ts 头注释：面板读的是挂载时传入的静态 node prop，写完不会自己重渲染，
    // 这里只断言写对了地方。
    const textarea = mounted.el.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    textarea.value = '请联系流程管理员处理';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.no_route_hint).toBe('请联系流程管理员处理');
  });
});

// 发起条件卡。V4ExpressionField 的「编辑」弹窗需要
// 完整的 V4 表达式 host（parse/validate/restore 等）与真实作用域，不在本文件覆盖范围（同头注释
// 既定分工：步骤摘要/条件的表达式编辑器内部渲染另有专门文件覆盖，本文件只锁定"写入文档"这一层）；
// 「清空」按钮（v4field-clear）是纯粹的 emit(undefined)，可以直接 DOM 驱动——本组测试因此覆盖
// 清空/联动展示两条，不覆盖"从空到有"的编辑弹窗流程（同 EndPanel.test.ts「NSelect 交互测不到，
// 只测挂点」既定口径）。
//
// 🔴 页面上同时存在两个 V4ExpressionField（发起条件 + 步骤摘要），两者的「清空」按钮共用同一个
// data-testid="v4field-clear"，且发起条件在模板顺序里排在步骤摘要之前——本组用例只在 fixture 里
// 配置 start_condition、不配置 summary_expr，页面上此时只会渲染出一个「清空」按钮（v-if="modelValue"），
// 避免了按下标定位的脆弱性。
const SAMPLE_CONDITION = {
  schema_version: 'kimpo.report-expression/v4' as const,
  mode: 'condition' as const,
  expression: { expression_id: 'start:start_cond', purpose: 'condition', source_text: '"金额" > 0', refs: [] }
};

function hostWithPublishedTemplate() {
  return fakeHost({
    getTemplate: async (id: string) => ({ data: { template_id: id, template_name: '表单', has_active_bundle: true } })
  });
}

describe('StartPanel：发起条件卡——配了条件才出「不满足时的提示」输入', () => {
  it('未配置发起条件：不出现提示输入，也不出现警示', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: 'tpl_x' });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: hostWithPublishedTemplate(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('[data-testid="start-condition-hint"]')).toBeNull();
    expect(mounted.el.textContent).not.toContain('发布前需要填写不满足条件时的提示');
  });

  it('配置了发起条件：出现提示输入；提示为空时出现警示小字', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: 'tpl_x', start_condition: SAMPLE_CONDITION });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: hostWithPublishedTemplate(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('[data-testid="start-condition-hint"]')).toBeTruthy();
    expect(mounted.el.textContent).toContain('发布前需要填写不满足条件时的提示');
  });

  it('配置了发起条件且提示非空：不出现警示', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: 'tpl_x', start_condition: SAMPLE_CONDITION, start_condition_hint: '金额需大于 0' });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: hostWithPublishedTemplate(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).not.toContain('发布前需要填写不满足条件时的提示');
  });
});

describe('StartPanel：发起条件卡——「不满足时的提示」草稿 + 失焦提交', () => {
  it('逐字输入时不进撤销栈（文档暂不更新）；失焦后才一次性写回', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({ target_template_id: 'tpl_x', start_condition: SAMPLE_CONDITION });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: hostWithPublishedTemplate(), state, i18n: fakeI18n() });
    await flush();

    const textarea = (mounted.el.querySelector('[data-testid="start-condition-hint"]') as HTMLElement).querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    textarea.value = '金';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    let nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.start_condition_hint ?? '').toBe('');

    textarea.value = '金额需大于 0';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.start_condition_hint).toBe('金额需大于 0');
  });
});

describe('StartPanel：发起条件卡——写回/清空', () => {
  it('清空发起条件（点「清空」按钮）：start_condition 写为 undefined，start_condition_hint 原样保留（不清）', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({
      target_template_id: 'tpl_x',
      start_condition: SAMPLE_CONDITION,
      start_condition_hint: '金额需大于 0'
    });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host: hostWithPublishedTemplate(), state, i18n: fakeI18n() });
    await flush();

    const clearBtn = mounted.el.querySelector('[data-testid="v4field-clear"]') as HTMLElement;
    expect(clearBtn, '配置了发起条件时应出现清空按钮').toBeTruthy();
    clearBtn.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.start_condition).toBeUndefined();
    expect(nextConfig.start_condition_hint).toBe('金额需大于 0');
  });
});

describe('StartPanel：换目标模板——一并清空发起条件与发起权限里的表单字段', () => {
  it('确认换模板后：start_condition 与 start_permission.main_field_id/match_by 清空，user_ids 等三维来源保留', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = buildStartNode({
      target_template_id: 'tpl_old',
      start_condition: SAMPLE_CONDITION,
      start_condition_hint: '金额需大于 0',
      start_permission: { user_ids: ['u1'], main_field_id: 'f1', match_by: 'login_name' },
      summary_expr: {
        schema_version: 'kimpo.report-expression/v4',
        mode: 'value',
        expression: { expression_id: 'start:summary', purpose: 'output', source_text: '"旧摘要"', refs: [] }
      }
    });
    doc.nodes = [startNode, ...doc.nodes.filter((n) => n.kind !== 'start')];
    const state = fakeState(doc);

    const host = fakeHost({
      getTemplate: async (id: string) => ({ data: { template_id: id, template_name: id === 'tpl_old' ? '旧表单' : '新表单', has_active_bundle: true } }),
      ui: {
        ...fakeHost().ui,
        openTemplatePicker: async () => ({ confirmed: true, template: { template_id: 'tpl_new', template_name: '新表单', published: true } }),
        openConfirm: vi.fn().mockResolvedValue({ confirmed: true })
      }
    });

    mounted = mountPanel(StartPanel, { node: startNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();

    const pickBtn = Array.from(mounted.el.querySelectorAll('button')).find((b) => b.textContent?.includes('选择模板'));
    pickBtn!.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();

    const nextConfig = state.value!.doc.nodes.find((n) => n.kind === 'start')!.config as unknown as StartConfig;
    expect(nextConfig.target_template_id).toBe('tpl_new');
    expect(nextConfig.start_condition).toBeUndefined();
    expect(nextConfig.summary_expr).toBeUndefined();
    expect(nextConfig.start_permission?.main_field_id).toBeUndefined();
    expect(nextConfig.start_permission?.match_by).toBeUndefined();
    // 发起权限里用户/角色/部门三维来源与换模板无关，原样保留。
    expect(nextConfig.start_permission?.user_ids).toEqual(['u1']);
    // 提示文本不因换模板清空（与「清空条件」场景同一口径：提示是设计者
    // 自己的文字，不随表达式失效自动抹掉）。
    expect(nextConfig.start_condition_hint).toBe('金额需大于 0');
  });
});
