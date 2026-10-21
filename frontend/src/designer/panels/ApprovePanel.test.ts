/**
 * designer/panels/ApprovePanel.test.ts —— 审批节点（N3）属性面板行为单测。
 *
 * 覆盖：挂载后各分区渲染 + 默认两按钮摘要行、节点名称写回（经 PanelHeader 就地改名）、办理方式
 * 百分比（NInputNumber）、结果/理由绑定字段只列文本字段、审批按钮就地编辑与写回、无路可走时的
 * 提示（选填）空值提示、回退时清空的目标表单未选/已选两态渲染（NSelect multiple——下拉打开选中的
 * 交互在 happy-dom 下无法真实模拟，见 ApprovePanel.vue 顶部 <script> 块头注释）、自动办理条件/
 * 步骤摘要挂点存在、按分区（tab）组织的显隐与切节点重置。
 *
 * 节点名称由公共头部 PanelHeader.vue 就地改名（点击 data-testid="panel-header-name-display"
 * 进入编辑态，data-testid="panel-header-name-input" 是编辑框）；本文件挂载 ApprovePanel → 操作
 * 真实 DOM → 断言写回 state，覆盖"名称改动经这条链路落到 state"。v-show 只隐藏、不从 DOM 移除
 * 元素，因此非当前分区里的控件仍可被 querySelector 找到并断言（见"只读态"用例）。
 *
 * 回退时清空用的编解码函数在 ./shared/handleSections.ts（与 HandlePanel.vue 同一套实现），单测
 * 在 shared/handleSections.test.ts。bpToPercent/percentToBp 从 './ApprovePanel.vue' 具名导入——
 * 该文件用普通 <script> + <script setup> 双块手法导出，见其头注释与 designer/canvas/CanvasRulers.vue。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { ApproveConfig, ApprovalButton, StartConfig, WorkflowNode } from '../../model';
import ApprovePanel, { bpToPercent, percentToBp } from './ApprovePanel.vue';
import { mainFieldOptionsOf } from './shared/MainFieldSelect.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';
import { invalidateTemplateFieldCatalog } from './shared/templateFieldCatalog';

// 绝大多数用例的目标表单 id 恒为 'tpl_x'，而 useTemplateFieldCatalog（E2 回退时清空 / 结果理由
// 绑定字段所用的 MainFieldSelect 共同消费）按 templateId 做模块级缓存（见 templateFieldCatalog.ts
// 头注释）；不同用例挂的假 host 返回的字段目录并不相同——每个用例开始前必须失效缓存，否则会读到
// 上一个用例缓存下来的结果（同 HandlePanel.test.ts 既定手法）。
beforeEach(() => {
  invalidateTemplateFieldCatalog();
});

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const DEFAULT_BUTTONS: ApprovalButton[] = [
  { id: 'btn-agree', name: '同意', color: 'primary', action: 'submit_approve', result_tag: '已通过', require_reason: false },
  { id: 'btn-reject', name: '拒绝', color: 'danger', action: 'withdraw_specified_step', result_tag: '已拒绝', require_reason: true }
];

function buildDocWithApproveNode(approveConfig: Partial<ApproveConfig> = {}, hasTargetTemplate = true) {
  const doc = createDefaultDocument('测试流程');
  const startNode = doc.nodes.find((n) => n.kind === 'start')!;
  startNode.config = {
    target_template_id: hasTargetTemplate ? 'tpl_x' : '',
    allow_manual_start: true,
    no_route_hint: '',
    start_permission: {}
  } satisfies StartConfig;
  const approveNode: WorkflowNode = {
    id: 'approve1',
    kind: 'approve',
    name: '',
    config: {
      approvers: [],
      complete_mode: { kind: 'any' },
      field_permissions: [],
      buttons: DEFAULT_BUTTONS,
      result_field_id: '',
      reason_field_id: '',
      clear_on_withdraw: [],
      no_route_hint: '',
      ...approveConfig
    } satisfies ApproveConfig,
    position_x: 320,
    position_y: 200
  };
  doc.nodes.push(approveNode);
  return { doc, approveNode };
}

function fieldHost(overrides: Partial<Parameters<typeof fakeHost>[0]> = {}) {
  return fakeHost({
    listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
    listTemplateFields: async () => ({
      data: {
        items: [
          { field_id: 'f1', field_name: '结果字段', data_type: 'text' },
          { field_id: 'f2', field_name: '数字字段', data_type: 'number' }
        ]
      }
    }),
    ...overrides
  });
}

let mounted: MountedPanel<typeof ApprovePanel> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function approveConfigOf(state: ReturnType<typeof fakeState>): ApproveConfig {
  return state.value!.doc.nodes.find((n) => n.id === 'approve1')!.config as unknown as ApproveConfig;
}

describe('ApprovePanel：分区渲染', () => {
  it('挂载后各分区标题齐全，默认两按钮行渲染正确（含需填理由标记）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const text = mounted.el.textContent ?? '';
    for (const title of [
      '从哪里选人',
      '审批方式',
      '字段权限',
      '审批按钮',
      '结果与理由',
      '回退时清空',
      '无路可走时的提示',
      '自动办理条件',
      '步骤摘要'
    ]) {
      expect(text, `缺少分区标题：${title}`).toContain(title);
    }

    const rows = mounted.el.querySelectorAll('[data-testid="approve-button-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('同意');
    expect(rows[1].textContent).toContain('拒绝');
    expect(rows[1].textContent).toContain('需填理由');
    expect(rows[0].textContent).not.toContain('需填理由');
  });
});

describe('ApprovePanel：节点名称（经公共头部 PanelHeader 就地改名）', () => {
  it('点击名称进入编辑态，输入后失焦写回 renameNode', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement).click();
    await flush();
    const input = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = '部门经理审批';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === 'approve1')!.name).toBe('部门经理审批');
  });

  // 清空名称、失焦回填"类型名+序号"默认名——doc.nodes 里这是唯一的审批节点（start/end 各一个
  // 在它之前），回填值应为「审批 1」；改名交互由 PanelHeader 承载，回填逻辑见 defaultNameForNodeAt。
  it('清空名称后失焦：回填「审批 1」（doc.nodes 里的第一个审批节点）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    approveNode.name = '原名字';
    doc.nodes = doc.nodes.map((n) => (n.id === approveNode.id ? approveNode : n));
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement).click();
    await flush();
    const input = mounted.el.querySelector('[data-testid="panel-header-name-input"] input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.nodes.find((n) => n.id === 'approve1')!.name).toBe('审批 1');
  });
});

describe('ApprovePanel：分区（tab）组织', () => {
  it('默认展示「基本」分区，其余两个分区隐藏；点击分区标签切换显示', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const basicPane = mounted.el.querySelector('[data-testid="approve-tab-basic"]') as HTMLElement;
    const rulePane = mounted.el.querySelector('[data-testid="approve-tab-approveRule"]') as HTMLElement;
    const formPane = mounted.el.querySelector('[data-testid="approve-tab-formAndHint"]') as HTMLElement;
    expect(basicPane).toBeTruthy();
    expect(basicPane.style.display).not.toBe('none');
    expect(rulePane.style.display).toBe('none');
    expect(formPane.style.display).toBe('none');

    (mounted.el.querySelector('[data-testid="panel-tab-approveRule"]') as HTMLElement).click();
    await flush();

    expect(basicPane.style.display).toBe('none');
    expect(rulePane.style.display).not.toBe('none');
  });

  // 注：ApprovePanel.vue 里"切换节点时分区重置回「基本」"那条 watch(() => props.node.id, ...)
  // 未在本文件用组件挂载测试覆盖——mountPanel 挂载工具用 createApp(component, props) 一次性
  // 传入静态 props（见 panel-test-helpers.ts），不支持挂载后原地改写根组件 props 来模拟"同一个
  // 面板实例切换到另一个节点"，只能整体卸载重挂载（那样每次都是全新实例，ref 初始值本就是
  // 'basic'，测不出"重置"与"不重置"的区别）。同一限制下 PanelHeader.vue 里语义相同的"切换节点
  // 时退出编辑态"watch（其头注释同样写明这一场景）目前也没有独立测试覆盖。
});

describe('ApprovePanel：办理方式', () => {
  // 同 EndPanel.test.ts 既定口径（见其头注释）：面板读的是挂载时传入的静态 node prop，写完之后
  // 同一份 prop 是否触发 DOM 重渲染是外壳 changeTick 桥接的职责，不在本组件范围——因此"点单选
  // 切档"只断言写对了地方（state 里的 config），不断言点完单选那一刻 DOM 会自己长出/收起百分比
  // 输入框；"编辑百分比"单独用一次已经是 percentage 档的挂载来断言。
  it('点击"按比例同意"单选后，写回默认 100%（万分比 10000）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    // 三档（或签/会签/按比例）齐全，共 3 个原生 radio；按比例用 testid
    // 定位（不再靠下标猜测第几个，见下方「三档齐全」用例同一手法）。
    const radios = mounted.el.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    expect(radios.length).toBe(3);
    const percentageRadio = mounted.el.querySelector('[data-testid="approve-complete-mode-percentage"] input[type="radio"]') as HTMLInputElement;
    percentageRadio.checked = true;
    percentageRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(approveConfigOf(state).complete_mode).toEqual({ kind: 'percentage', percentage_bp: 10000 });
  });

  it('点击"一人同意即过"单选后，写回 {kind: any}', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ complete_mode: { kind: 'percentage', percentage_bp: 8000 } });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const radios = mounted.el.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    radios[0].checked = true;
    radios[0].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(approveConfigOf(state).complete_mode).toEqual({ kind: 'any' });
  });

  it('已是"按比例同意"档时，NInputNumber 改百分比写回万分比（钳到 1~100）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ complete_mode: { kind: 'percentage', percentage_bp: 8000 } });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const percentInput = mounted.el.querySelector('.ap__percentage-row input') as HTMLInputElement;
    expect(percentInput).toBeTruthy();
    expect(percentInput.value).toBe('80');
    percentInput.value = '77';
    percentInput.dispatchEvent(new Event('input', { bubbles: true }));
    percentInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(approveConfigOf(state).complete_mode).toEqual({ kind: 'percentage', percentage_bp: 7700 });
  });

  // 审批方式第三档「会签」（all），语义等同按比例 100%，但落库形状不带
  // percentage_bp——同 HandlePanel.test.ts 同名用例组既定手法。
  it('三格齐全且顺序正确：或签 / 会签 / 按比例', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const group = mounted.el.querySelector('.ap__mode-group') as HTMLElement;
    const testids = Array.from(group.querySelectorAll('[data-testid^="approve-complete-mode-"]')).map((el) => el.getAttribute('data-testid'));
    expect(testids).toEqual(['approve-complete-mode-any', 'approve-complete-mode-all', 'approve-complete-mode-percentage']);
    expect(group.textContent).toContain('或签');
    expect(group.textContent).toContain('会签');
    expect(group.textContent).toContain('按比例');
  });

  it('点击"会签"单选后，写回恰为 { kind: all }（不含 percentage_bp）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ complete_mode: { kind: 'percentage', percentage_bp: 8000 } });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const allRadio = mounted.el.querySelector('[data-testid="approve-complete-mode-all"] input[type="radio"]') as HTMLInputElement;
    allRadio.checked = true;
    allRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    const mode = approveConfigOf(state).complete_mode;
    expect(mode).toEqual({ kind: 'all' });
    expect(Object.prototype.hasOwnProperty.call(mode, 'percentage_bp')).toBe(false);
  });

  it('"会签"档下不显示比例数值框，说明块文案正确', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ complete_mode: { kind: 'all' } });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('.ap__percentage-row')).toBeFalsy();
    expect(mounted.el.textContent).toContain('会签：所有审批人都同意才通过。只要有一个人驳回，这一步立即结束，走驳回那条线。');
  });

  // 同 HandlePanel.test.ts「从'全部完成'档切回'按比例'」既定手法：单个挂载实例内连续两次真实
  // 点击测不出真实结果（面板读的是挂载时静态 node prop，写完不会自己触发重渲染），"percentage→
  // all"已在上面用例覆盖，这里只补"all→percentage"这一段（无历史 percentage_bp 时回退默认
  // 100%，与"一人同意即过→按比例"既有路径同一套默认值兜底）。
  it('从"会签"档切回"按比例"：all 档没有历史 percentage_bp，回退到默认 100%', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ complete_mode: { kind: 'all' } });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const percentageRadio = mounted.el.querySelector('[data-testid="approve-complete-mode-percentage"] input[type="radio"]') as HTMLInputElement;
    percentageRadio.checked = true;
    percentageRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(approveConfigOf(state).complete_mode).toEqual({ kind: 'percentage', percentage_bp: 10000 });
  });
});

describe('ApprovePanel：再缩小范围（与上步处理人的关系，过滤器）', () => {
  it('basic 分区渲染出该卡，位置在『从哪里选人』之后、『步骤摘要』之前', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const basicPane = mounted.el.querySelector('[data-testid="approve-tab-basic"]') as HTMLElement;
    const titles = Array.from(basicPane.querySelectorAll('.wf-panel-section__title')).map((el) => el.textContent);
    expect(titles).toEqual(['从哪里选人', '再缩小范围', '步骤摘要']);
  });

  it('勾选一档：经 patchConfig 写回 config.relation_filters', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="relation-filter-department_manager"]') as HTMLElement).click();
    await flush();

    expect(approveConfigOf(state).relation_filters).toEqual(['department_manager']);
  });

  it('取消唯一已勾选的档位：写回 undefined（不是空数组）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ relation_filters: ['department_manager'] });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="relation-filter-department_manager"]') as HTMLElement).click();
    await flush();

    expect(approveConfigOf(state).relation_filters).toBeUndefined();
  });

  it('只读态：胶囊禁用，点击不产生写操作', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const pill = mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement;
    expect(pill.getAttribute('aria-disabled')).toBe('true');
    pill.click();
    await flush();

    expect(approveConfigOf(state).relation_filters).toBeUndefined();
  });
});

describe('ApprovePanel：结果绑定字段 / 理由绑定字段', () => {
  // NSelect 下拉打开/选中在 happy-dom 下模拟不了（见 MainFieldSelect.vue 头注释与 ApprovePanel.vue
  // 顶部 <script> 块头注释同一理由），"只列文本类型字段"这条过滤规则改由其具名导出纯函数
  // mainFieldOptionsOf 直接单测覆盖；组件层只断言回显——挂载时 modelValue 传入文本字段 id，
  // 选择框应显示该字段名；传入被类型过滤掉的数字字段 id，NSelect 找不到匹配选项时退回展示原始
  // 取值本身（不会显示"数字字段"这个标签），侧面证明目录确实被按类型收窄过。
  it('mainFieldOptionsOf：dataType 命中时只保留主表内该类型字段', () => {
    const catalog = {
      templateId: 'tpl_x',
      tables: [
        {
          tableId: 'dt1',
          tableName: '主表',
          isMain: true,
          fields: [
            { fieldId: 'f1', fieldName: '结果字段', dataType: 'text', tableId: 'dt1', tableName: '主表', isMain: true },
            { fieldId: 'f2', fieldName: '数字字段', dataType: 'number', tableId: 'dt1', tableName: '主表', isMain: true }
          ]
        }
      ],
      byFieldId: new Map()
    };
    const items = mainFieldOptionsOf(catalog, 'text');
    expect(items.map((f) => f.fieldName)).toEqual(['结果字段']);
  });

  it('挂载后：已选文本字段正确回显，选中后分别写回 result_field_id / reason_field_id 的挂点齐全', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ result_field_id: 'f1', reason_field_id: 'f1' });
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fieldHost(), state, i18n: fakeI18n() });
    await flush(10);

    const resultField = mounted.el.querySelector('[data-testid="approve-result-field"]') as HTMLElement;
    const reasonField = mounted.el.querySelector('[data-testid="approve-reason-field"]') as HTMLElement;
    expect(resultField.textContent).toContain('结果字段');
    expect(reasonField.textContent).toContain('结果字段');
    // 挂点仍在（写回方向由 onResultFieldChange/onReasonFieldChange 两个一行透传函数保证，
    // 见 ApprovePanel.vue 同名函数，不需要额外覆盖）。
    expect(approveConfigOf(state).result_field_id).toBe('f1');
    expect(approveConfigOf(state).reason_field_id).toBe('f1');
  });

  it('目标表单未选择时两个字段选择框均禁用', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({}, false);
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fieldHost(), state, i18n: fakeI18n() });
    await flush();

    const resultSelection = mounted.el.querySelector('[data-testid="approve-result-field"] .n-base-selection') as HTMLElement;
    const reasonSelection = mounted.el.querySelector('[data-testid="approve-reason-field"] .n-base-selection') as HTMLElement;
    expect(resultSelection.className).toContain('n-base-selection--disabled');
    expect(reasonSelection.className).toContain('n-base-selection--disabled');
  });
});

// 审批按钮在面板内就地编辑。增删改排/展开收起/只读态等深度行为已在
// shared/ApprovalButtonList.test.ts 覆盖（本组件是纯薄包装），这里只保留一条"接线正确"的集成
// 用例：证明 ApprovePanel.vue 确实把 config.buttons 传给了 ApprovalButtonList，且它的
// update:modelValue 确实经 onButtonsUpdate → patchConfig 落到了 state。内联编辑没有"取消"
// 动作，反悔靠画布撤销。
describe('ApprovePanel：审批按钮（面板内就地编辑）', () => {
  it('点击第一行展开编辑区，改名并失焦后经 ApprovalButtonList 写回按钮清单', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.querySelector('[data-testid="approve-button-editor"]')).toBeFalsy();
    const buttonRows = mounted.el.querySelectorAll('[data-testid="approve-button-row"]');
    (buttonRows[0] as HTMLElement).click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-editor"]')).toBeTruthy();

    // NInput 换装后 data-testid 落在其外层根节点（.n-input），真实原生 <input> 是其后代——
    // 同 HandlePanel.test.ts「.hp__percentage-row input」既定手法，选择器补一段 " input"。
    const nameInput = mounted.el.querySelector('[data-testid="approve-button-name-input"] input') as HTMLInputElement;
    nameInput.value = '部门经理同意';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('blur', { bubbles: true })); // 失焦才提交（即改即存，无确定按钮）
    await flush();

    const buttons = approveConfigOf(state).buttons;
    expect(buttons[0].name).toBe('部门经理同意');
    expect(buttons[0].result_tag).toBe('已通过'); // 已有明确取值，改名字不联动覆盖
    expect(buttons[1]).toEqual(DEFAULT_BUTTONS[1]);
  });
});

// 选填：空值不是"待补的必填"，灰字告诉设计者默认文案是什么。
describe('ApprovePanel：无路可走时的提示（选填）', () => {
  it('为空时提示默认文案而非催填，填写后写回文档', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).toContain('不填写时，提交人会看到默认提示「没有满足条件的后续步骤」');
    // 反向锁：选填项不应出现带必填星号的催填红字。
    expect(mounted.el.textContent).not.toContain('还没有填写无路可走时的提示');

    const textarea = mounted.el.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '当前没有可审批人，流程已暂存';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(approveConfigOf(state).no_route_hint).toBe('当前没有可审批人，流程已暂存');
  });
});

describe('ApprovePanel：回退时清空（渲染态）', () => {
  it('目标表单未选择时给业务话空态，NSelect 禁用', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({}, false);
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).toContain('请先在发起节点选择目标模板');
    const select = mounted.el.querySelector('[data-testid="approve-clear-on-withdraw"] .n-base-selection') as HTMLElement;
    expect(select.className).toContain('n-base-selection--disabled');
  });

  it('已配置 clear_on_withdraw 时，跨主表/明细表取到字段目录后回显对应标签', async () => {
    const { doc, approveNode } = buildDocWithApproveNode({ clear_on_withdraw: [{ table_id: 'dt1', field_id: 'f1' }] });
    const state = fakeState(doc);
    const host = fakeHost({
      listTemplateTables: async () => ({
        data: {
          items: [
            { data_table_id: 'dt1', table_name: '主表', table_role: 'main' },
            { data_table_id: 'dt2', table_name: '明细表', table_role: 'detail' }
          ]
        }
      }),
      listTemplateFields: async (_templateId: string, dataTableId: string) => {
        if (dataTableId === 'dt1') return { data: { items: [{ field_id: 'f1', field_name: '结果字段', data_type: 'text' }] } };
        return { data: { items: [{ field_id: 'f2', field_name: '明细金额', data_type: 'number' }] } };
      }
    });
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush(10);

    const selectRoot = mounted.el.querySelector('[data-testid="approve-clear-on-withdraw"]') as HTMLElement;
    expect(selectRoot.textContent).toContain('结果字段');
  });
});

describe('ApprovePanel：字段权限（只看型）', () => {
  it('渲染继承摘要 + 只看型提示', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();
    expect(mounted.el.textContent).toContain('继承模板');
    expect(mounted.el.textContent).toContain('本节点不修改单据内容');
  });
});

describe('ApprovePanel：自动办理条件 / 步骤摘要挂点', () => {
  it('两个 V4ExpressionField 均带正确的 expressionId 与 mode（经 data-testid 可编辑入口断言存在）', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();
    const editButtons = mounted.el.querySelectorAll('[data-testid="v4field-edit"]');
    // 自动办理条件 + 步骤摘要，各一个入口。
    expect(editButtons.length).toBe(2);
  });
});

describe('ApprovePanel：只读态', () => {
  it('readOnly 时名称/无路提示/办理方式均禁用，审批按钮清单不出「添加按钮」入口，不产生写操作', async () => {
    const { doc, approveNode } = buildDocWithApproveNode();
    const state = fakeState(doc);
    mounted = mountPanel(ApprovePanel, { node: approveNode, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    // 名称改名入口在 PanelHeader，readOnly 经 :read-only="readOnly" 透传：点击名称展示区不应进入
    // 编辑态（PanelHeader.vue startEdit 首行 `if (props.readOnly) return`，本文件不重复测该组件
    // 内部实现，只断言 readOnly 确实传下去）。
    (mounted.el.querySelector('[data-testid="panel-header-name-display"]') as HTMLElement).click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="panel-header-name-input"]')).toBeFalsy();

    expect((mounted.el.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    const radios = mounted.el.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    expect(radios[0].disabled).toBe(true);
    // 审批按钮清单本身的 readOnly 深度行为（控件全部禁用、不出「添加按钮」）已在
    // shared/ApprovalButtonList.test.ts「只读态」一节覆盖，这里只断言 ApprovePanel.vue 确实把
    // readOnly 透传下去——「＋ 添加按钮」入口不应出现。
    expect(mounted.el.querySelector('[data-testid="approve-button-add"]')).toBeFalsy();
  });
});

// 回退时清空的编解码由 shared/handleSections.ts 的 encodeClearFieldKey/decodeClearFieldKey/
// clearFieldsToKeys/keysToClearFields/buildWithdrawClearFieldOptions 提供，单测在
// shared/handleSections.test.ts 里，不在本文件重复。
describe('ApprovePanel.vue 纯函数导出（办理方式百分比换算）', () => {
  it('bpToPercent / percentToBp 互换，未配置按 100% 处理，边界钳到 [1,100]', () => {
    expect(bpToPercent(undefined)).toBe(100);
    expect(bpToPercent(5000)).toBe(50);
    expect(bpToPercent(0)).toBe(1);
    expect(bpToPercent(999999)).toBe(100);
    expect(percentToBp(50)).toBe(5000);
    expect(percentToBp(0)).toBe(100);
    expect(percentToBp(1000)).toBe(10000);
  });
});
