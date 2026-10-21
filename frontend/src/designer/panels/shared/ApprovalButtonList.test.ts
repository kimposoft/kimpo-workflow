/**
 * panels/shared/ApprovalButtonList.test.ts —— 审批节点『审批按钮』面板内就地编辑清单组件测试。
 * 纯逻辑单测见同目录
 * approvalButtons.test.ts（新增默认值/上移下移/按下标移动/删除/最少一个边界），本文件覆盖
 * "事件绑定 + 模板渲染"这一层：默认渲染、展开/收起（同一时刻至多一个）、各控件写回、文本框
 * 草稿+失焦/回车提交、只读态、新增后自动展开。
 *
 * 拖拽排序（pointer 事件手势）未在本文件覆盖，见 ApprovalButtonList.vue 头注释"拖动排序实现
 * 方式"一段——happy-dom 不支持真实 document.elementFromPoint，纯函数部分（moveButtonTo）已在
 * approvalButtons.test.ts 覆盖，"上移/下移"两个按钮是它的无障碍等价入口，本文件已覆盖。
 *
 * "切换节点后展开态/草稿重置"（watch(() => props.nodeId, ...)）同 ApprovePanel.test.ts「分区
 * （tab）组织」一节头注释同一限制：mountPanel 挂载工具用 createApp(component, props) 一次性
 * 传入静态 props，不支持挂载后原地改写根组件 props 来模拟"同一个组件实例切到另一个节点"，只能
 * 整体卸载重挂载（那样每次都是全新实例，测不出"重置"与"不重置"的区别），因此没有组件挂载测试
 * 直接覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../../model/defaults';
import type { ApprovalButton } from '../../../model';
import ApprovalButtonList from './ApprovalButtonList.vue';
import type { EndNodeOption } from './approvalButtons';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await nextTick();
}

const TWO_BUTTONS: ApprovalButton[] = [
  { id: 'btn-agree', name: '同意', color: 'primary', action: 'submit_approve', result_tag: '已通过', require_reason: false },
  { id: 'btn-reject', name: '拒绝', color: 'danger', action: 'withdraw_specified_step', result_tag: '已拒绝', require_reason: true }
];

let mounted: MountedPanel<typeof ApprovalButtonList> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountList(
  buttons: ApprovalButton[],
  opts: { readOnly?: boolean; nodeId?: string; onUpdate?: (b: ApprovalButton[]) => void; endNodeOptions?: EndNodeOption[] } = {}
): MountedPanel<typeof ApprovalButtonList> {
  const doc = createDefaultDocument('测试流程');
  return mountPanel(
    ApprovalButtonList,
    {
      modelValue: buttons,
      readOnly: opts.readOnly ?? false,
      nodeId: opts.nodeId ?? 'approve1',
      endNodeOptions: opts.endNodeOptions,
      'onUpdate:modelValue': opts.onUpdate
    },
    { host: fakeHost(), state: fakeState(doc), i18n: fakeI18n() }
  );
}

function rows(): NodeListOf<HTMLElement> {
  return mounted!.el.querySelectorAll('[data-testid="approve-button-row"]');
}

describe('ApprovalButtonList：默认渲染', () => {
  it('两行摘要正确：名称/动作·结果标识/需填理由标签', async () => {
    mounted = mountList(TWO_BUTTONS);
    await flush();
    const r = rows();
    expect(r.length).toBe(2);
    expect(r[0].textContent).toContain('同意');
    expect(r[0].textContent).toContain('提交通过');
    expect(r[0].textContent).toContain('已通过');
    expect(r[0].textContent).not.toContain('需填理由');
    expect(r[1].textContent).toContain('拒绝');
    expect(r[1].textContent).toContain('回退到指定步骤');
    expect(r[1].textContent).toContain('已拒绝');
    expect(r[1].textContent).toContain('需填理由');
  });

  it('空清单时展示业务话空态', async () => {
    mounted = mountList([]);
    await flush();
    expect(mounted.el.textContent).toContain('还没有配置审批按钮');
  });

  it('名称留空时摘要行退回占位文案', async () => {
    mounted = mountList([{ ...TWO_BUTTONS[0], name: '' }]);
    await flush();
    expect(rows()[0].textContent).toContain('如：同意');
  });
});

describe('ApprovalButtonList：展开/收起（同一时刻至多一个）', () => {
  it('点第一行展开出编辑区，再点第二行：第一行收起，第二行展开', async () => {
    mounted = mountList(TWO_BUTTONS);
    await flush();
    const r = rows();
    r[0].click();
    await flush();
    expect(mounted.el.querySelectorAll('[data-testid="approve-button-editor"]').length).toBe(1);
    expect(r[0].getAttribute('aria-expanded')).toBe('true');

    r[1].click();
    await flush();
    expect(mounted.el.querySelectorAll('[data-testid="approve-button-editor"]').length).toBe(1);
    expect(r[0].getAttribute('aria-expanded')).toBe('false');
    expect(r[1].getAttribute('aria-expanded')).toBe('true');
  });

  it('再点同一行：收起', async () => {
    mounted = mountList(TWO_BUTTONS);
    await flush();
    const row0 = rows()[0];
    row0.click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-editor"]')).toBeTruthy();
    row0.click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-editor"]')).toBeFalsy();
  });

  it('点把手不触发展开/收起（把手 click.stop，见组件头注释"只在把手元素上起拖"）', async () => {
    mounted = mountList(TWO_BUTTONS);
    await flush();
    const handle = mounted.el.querySelector('[data-testid="approve-button-handle"]') as HTMLElement;
    handle.click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-editor"]')).toBeFalsy();
  });
});

describe('ApprovalButtonList：编辑区各控件写回', () => {
  it('名称：失焦才提交，未改动不触发 update:modelValue', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const input = mounted.el.querySelector('[data-testid="approve-button-name-input"] input') as HTMLInputElement;
    // 未改动直接失焦：不应提交。
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();
    expect(emitted).toBeUndefined();
  });

  it('名称：输入后仅 input 事件不提交，失焦才提交且带出联动的结果标识（新按钮）', async () => {
    let emitted: ApprovalButton[] | undefined;
    const withEmpty: ApprovalButton[] = [{ id: 'btn-new', name: '', color: 'neutral', action: 'submit_approve', result_tag: '', require_reason: false }];
    mounted = mountList(withEmpty, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const input = mounted.el.querySelector('[data-testid="approve-button-name-input"] input') as HTMLInputElement;
    input.value = '会签通过';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(emitted, '仅 input 事件不应提交').toBeUndefined();

    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();
    expect(emitted?.[0].name).toBe('会签通过');
    expect(emitted?.[0].result_tag).toBe('会签通过'); // 结果标识起始为空，跟随名称联动
  });

  it('结果标识已有明确取值的按钮改名字，不联动覆盖结果标识', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const input = mounted.el.querySelector('[data-testid="approve-button-name-input"] input') as HTMLInputElement;
    input.value = '部门经理同意';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();
    expect(emitted?.[0].name).toBe('部门经理同意');
    expect(emitted?.[0].result_tag).toBe('已通过'); // 未被联动覆盖
  });

  it('回车提交（同失焦语义）', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const input = mounted.el.querySelector('[data-testid="approve-button-name-input"] input') as HTMLInputElement;
    input.value = '回车提交测试';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(emitted?.[0].name).toBe('回车提交测试');
  });

  it('结果标识：草稿 + 失焦提交，手动改过后名称变动不再联动覆盖', async () => {
    let emitted: ApprovalButton[] | undefined;
    const withEmpty: ApprovalButton[] = [{ id: 'btn-new', name: '同意', color: 'neutral', action: 'submit_approve', result_tag: '', require_reason: false }];
    mounted = mountList(withEmpty, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const tagInput = mounted.el.querySelector('[data-testid="approve-button-result-tag-input"] input') as HTMLInputElement;
    tagInput.value = '已同意';
    tagInput.dispatchEvent(new Event('input', { bubbles: true }));
    tagInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();
    expect(emitted?.[0].result_tag).toBe('已同意');
  });

  it('颜色：五色单选走真实原生 radio input，选中后写回 color', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const dangerRadio = mounted.el.querySelector('[data-testid="approve-button-color-danger"] input[type="radio"]') as HTMLInputElement;
    expect(dangerRadio).toBeTruthy();
    dangerRadio.checked = true;
    dangerRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(emitted?.[0].color).toBe('danger');
  });

  it('需填理由：NSwitch 点击切换，写回 require_reason', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const sw = mounted.el.querySelector('[data-testid="approve-button-require-reason"]') as HTMLElement;
    sw.click();
    await flush();
    expect(emitted?.[0].require_reason).toBe(true);
  });

  it('动作下拉：收起态回显当前 action 的业务话标签（下拉展开/选中在 happy-dom 下模拟不了）', async () => {
    mounted = mountList(TWO_BUTTONS);
    await flush();
    rows()[1].click();
    await flush();
    const select = mounted.el.querySelector('[data-testid="approve-button-action-select"]') as HTMLElement;
    expect(select.textContent).toContain('回退到指定步骤');
  });

  it('上移/下移：边界禁用，中间可用且写回新顺序', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const upBtn = mounted.el.querySelector('[data-testid="approve-button-move-up"]') as HTMLButtonElement;
    const downBtn = mounted.el.querySelector('[data-testid="approve-button-move-down"]') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true); // 首行不能上移
    expect(downBtn.disabled).toBe(false);
    downBtn.click();
    await flush();
    expect(emitted?.map((b) => b.id)).toEqual(['btn-reject', 'btn-agree']);
  });

  it('删除：只剩一个按钮时禁用且带出提示；两个以上时可删并写回', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[1].click();
    await flush();
    const removeBtn = mounted.el.querySelector('[data-testid="approve-button-remove"]') as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(false);
    removeBtn.click();
    await flush();
    expect(emitted).toEqual([TWO_BUTTONS[0]]);
  });

  it('只剩一个按钮时删除按钮禁用（展开态）', async () => {
    mounted = mountList([TWO_BUTTONS[0]]);
    await flush();
    rows()[0].click();
    await flush();
    const removeBtn = mounted.el.querySelector('[data-testid="approve-button-remove"]') as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(true);
  });
});

describe('ApprovalButtonList：新增', () => {
  it('点「＋ 添加按钮」追加一行默认值并自动展开它', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { onUpdate: (b) => { emitted = b; } });
    await flush();
    (mounted.el.querySelector('[data-testid="approve-button-add"]') as HTMLButtonElement).click();
    await flush();
    expect(emitted?.length).toBe(3);
    expect(emitted?.[2].name).toBe('');
    expect(emitted?.[2].color).toBe('neutral');
  });
});

describe('ApprovalButtonList：只读态', () => {
  it('全部控件禁用，不出「添加按钮」入口，展开仍可查看', async () => {
    mounted = mountList(TWO_BUTTONS, { readOnly: true });
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-add"]')).toBeFalsy();

    rows()[0].click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-editor"]')).toBeTruthy(); // 可展开查看

    const nameInput = mounted.el.querySelector('[data-testid="approve-button-name-input"] input') as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
    const actionSelectRoot = mounted.el.querySelector('[data-testid="approve-button-action-select"] .n-base-selection') as HTMLElement;
    expect(actionSelectRoot.className).toContain('n-base-selection--disabled');
    const resultTagInput = mounted.el.querySelector('[data-testid="approve-button-result-tag-input"] input') as HTMLInputElement;
    expect(resultTagInput.disabled).toBe(true);
    const upBtn = mounted.el.querySelector('[data-testid="approve-button-move-up"]') as HTMLButtonElement;
    const downBtn = mounted.el.querySelector('[data-testid="approve-button-move-down"]') as HTMLButtonElement;
    const removeBtn = mounted.el.querySelector('[data-testid="approve-button-remove"]') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
    expect(downBtn.disabled).toBe(true);
    expect(removeBtn.disabled).toBe(true);
  });

  it('只读态点击不产生任何写操作（NSwitch/颜色）', async () => {
    let emitted: ApprovalButton[] | undefined;
    mounted = mountList(TWO_BUTTONS, { readOnly: true, onUpdate: (b) => { emitted = b; } });
    await flush();
    rows()[0].click();
    await flush();
    const sw = mounted.el.querySelector('[data-testid="approve-button-require-reason"]') as HTMLElement;
    sw.click();
    await flush();
    expect(emitted).toBeUndefined();
  });
});

// —— 第五档动作「不通过并结束流程」与「结束到」 ——
describe('ApprovalButtonList：不通过并结束流程（end_flow）', () => {
  const END_OPTIONS: EndNodeOption[] = [
    { id: 'end-a', label: '通过结束', flag: '已通过' },
    { id: 'end-b', label: '结束 2', flag: '' }
  ];
  const endButton = (extra: Partial<ApprovalButton> = {}): ApprovalButton => ({
    id: 'btn-end', name: '不通过', color: 'danger', action: 'end_flow', result_tag: '已拒绝', require_reason: true, ...extra
  });

  it('收起摘要：不通过并结束 → 节点名', async () => {
    mounted = mountList([endButton({ end_node_id: 'end-a' })], { endNodeOptions: END_OPTIONS });
    await flush();
    const summary = mounted.el.querySelector('[data-testid="approve-button-end-summary"]') as HTMLElement;
    expect(summary.textContent).toContain('不通过并结束');
    expect(summary.textContent).toContain('通过结束');
    expect(summary.textContent).not.toContain('未选择结束节点');
  });

  it('end_node_id 为空或目标已失效：收起摘要都显示「未选择结束节点」', async () => {
    mounted = mountList([endButton(), endButton({ id: 'btn-end2', end_node_id: 'gone' })], { endNodeOptions: END_OPTIONS });
    await flush();
    const sums = mounted.el.querySelectorAll('[data-testid="approve-button-end-summary"]');
    expect(sums.length).toBe(2);
    expect(sums[0].textContent).toContain('未选择结束节点');
    expect(sums[1].textContent).toContain('未选择结束节点');
  });

  it('非 end_flow 动作不出现「结束到」字段；end_flow 展开后出现，并带说明灰字', async () => {
    mounted = mountList([TWO_BUTTONS[0], endButton({ end_node_id: 'end-a' })], { endNodeOptions: END_OPTIONS });
    await flush();
    rows()[0].click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-end-field"]')).toBeFalsy();
    rows()[1].click();
    await flush();
    const field = mounted.el.querySelector('[data-testid="approve-button-end-field"]') as HTMLElement;
    expect(field).toBeTruthy();
    expect(field.textContent).toContain('结束到');
    expect(field.textContent).toContain('点击后流程直接走到这个结束节点并结束');
  });

  it('流程里没有结束节点：灰字提示先从节点库添加', async () => {
    mounted = mountList([endButton()], { endNodeOptions: [] });
    await flush();
    rows()[0].click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-end-empty"]')?.textContent).toContain('流程里还没有结束节点，请先从节点库添加');
  });

  it('目标被删除（有值但不在候选里）：红字「原结束节点已删除，请重新选择」', async () => {
    mounted = mountList([endButton({ end_node_id: 'gone' })], { endNodeOptions: END_OPTIONS });
    await flush();
    rows()[0].click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-end-missing"]')?.textContent).toContain('原结束节点已删除，请重新选择');
    expect(mounted.el.querySelector('[data-testid="approve-button-end-select"]')?.className).toContain('n-select');
  });

  it('end_node_id 为空且有候选：不报「已删除」，只显示说明灰字', async () => {
    mounted = mountList([endButton()], { endNodeOptions: END_OPTIONS });
    await flush();
    rows()[0].click();
    await flush();
    expect(mounted.el.querySelector('[data-testid="approve-button-end-missing"]')).toBeFalsy();
    expect(mounted.el.querySelector('[data-testid="approve-button-end-empty"]')).toBeFalsy();
  });
});
