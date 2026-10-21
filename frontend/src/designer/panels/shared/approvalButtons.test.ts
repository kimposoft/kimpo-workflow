// panels/shared/approvalButtons.test.ts —— 审批节点『审批按钮』面板内就地编辑清单的纯逻辑单测。
// ApprovalButtonList.vue 只是这些纯函数
// 的薄包装（事件绑定/模板/拖拽手势），本文件覆盖真正的数据变换逻辑（见 approvalButtons.ts 头
// 注释：本插件前端未装 @vue/test-utils，纯函数是能被真正单测覆盖的唯一路径）。
import { describe, expect, it } from 'vitest';
import {
  addButton,
  canRemoveButton,
  createDefaultButton,
  generateButtonId,
  listEndNodeOptions,
  moveButtonDown,
  moveButtonTo,
  moveButtonUp,
  removeButtonAt,
  sameButtonOrder,
  updateButtonField
} from './approvalButtons';
import type { ApprovalButton, WorkflowNode } from '../../../model';

const TWO_BUTTONS: ApprovalButton[] = [
  { id: 'btn-agree', name: '同意', color: 'primary', action: 'submit_approve', result_tag: '已通过', require_reason: false },
  { id: 'btn-reject', name: '拒绝', color: 'danger', action: 'withdraw_specified_step', result_tag: '已拒绝', require_reason: true }
];

describe('generateButtonId / createDefaultButton：新增默认值', () => {
  it('generateButtonId：固定前缀，两次调用不相同（高概率不撞车）', () => {
    const a = generateButtonId();
    const b = generateButtonId();
    expect(a.startsWith('btn-')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('createDefaultButton：中性灰 / 提交通过 / 名称与结果标识留空 / 不需填理由', () => {
    const btn = createDefaultButton();
    expect(btn.color).toBe('neutral');
    expect(btn.action).toBe('submit_approve');
    expect(btn.name).toBe('');
    expect(btn.result_tag).toBe('');
    expect(btn.require_reason).toBe(false);
    expect(btn.id.startsWith('btn-')).toBe(true);
  });
});

describe('addButton：追加一条默认按钮', () => {
  it('不改入参，返回新数组，末尾新增一条默认值', () => {
    const next = addButton(TWO_BUTTONS);
    expect(TWO_BUTTONS.length).toBe(2); // 入参未被修改
    expect(next.length).toBe(3);
    expect(next[2].name).toBe('');
    expect(next[2].color).toBe('neutral');
  });
});

describe('canRemoveButton / removeButtonAt：删除与最少一个的边界', () => {
  it('两个及以上按钮时可以删除', () => {
    expect(canRemoveButton(TWO_BUTTONS)).toBe(true);
  });

  it('只剩一个按钮时不可删除', () => {
    expect(canRemoveButton([TWO_BUTTONS[0]])).toBe(false);
  });

  it('删除第 index 个按钮，返回去掉该项的新数组', () => {
    const next = removeButtonAt(TWO_BUTTONS, 0);
    expect(next).toEqual([TWO_BUTTONS[1]]);
  });

  it('只剩一个按钮时调用 removeButtonAt 原样返回（不产生零按钮态）', () => {
    const one = [TWO_BUTTONS[0]];
    const next = removeButtonAt(one, 0);
    expect(next).toBe(one);
  });

  it('index 越界时原样返回', () => {
    expect(removeButtonAt(TWO_BUTTONS, 5)).toBe(TWO_BUTTONS);
    expect(removeButtonAt(TWO_BUTTONS, -1)).toBe(TWO_BUTTONS);
  });
});

describe('moveButtonTo：按下标移动（供拖拽排序与上移/下移共用）', () => {
  it('把第 0 个挪到第 1 个位置：等价于交换相邻两项', () => {
    expect(moveButtonTo(TWO_BUTTONS, 0, 1)).toEqual([TWO_BUTTONS[1], TWO_BUTTONS[0]]);
  });

  it('把第 2 个挪到第 0 个位置（三项，非相邻移动）', () => {
    const three = addButton(TWO_BUTTONS);
    const next = moveButtonTo(three, 2, 0);
    expect(next.map((b) => b.id)).toEqual([three[2].id, three[0].id, three[1].id]);
  });

  it('from===to 或任一下标越界时原样返回', () => {
    expect(moveButtonTo(TWO_BUTTONS, 0, 0)).toBe(TWO_BUTTONS);
    expect(moveButtonTo(TWO_BUTTONS, -1, 0)).toBe(TWO_BUTTONS);
    expect(moveButtonTo(TWO_BUTTONS, 0, 9)).toBe(TWO_BUTTONS);
  });
});

describe('moveButtonUp / moveButtonDown：边界（首行不能上移、末行不能下移）', () => {
  it('中间行上移/下移正常交换', () => {
    const three = addButton(TWO_BUTTONS);
    expect(moveButtonUp(three, 1).map((b) => b.id)).toEqual([three[1].id, three[0].id, three[2].id]);
    expect(moveButtonDown(three, 1).map((b) => b.id)).toEqual([three[0].id, three[2].id, three[1].id]);
  });

  it('首行调用 moveButtonUp 原样返回', () => {
    expect(moveButtonUp(TWO_BUTTONS, 0)).toBe(TWO_BUTTONS);
  });

  it('末行调用 moveButtonDown 原样返回', () => {
    expect(moveButtonDown(TWO_BUTTONS, TWO_BUTTONS.length - 1)).toBe(TWO_BUTTONS);
  });
});

describe('updateButtonField：字段更新', () => {
  it('浅合并 patch，只改目标行，其余行原样保留', () => {
    const next = updateButtonField(TWO_BUTTONS, 0, { name: '部门经理同意', require_reason: true });
    expect(next[0]).toEqual({ ...TWO_BUTTONS[0], name: '部门经理同意', require_reason: true });
    expect(next[1]).toBe(TWO_BUTTONS[1]); // 未改的行保持同一引用
  });

  it('index 越界时原样返回', () => {
    expect(updateButtonField(TWO_BUTTONS, 9, { name: 'x' })).toBe(TWO_BUTTONS);
  });

  // —— 第五档动作 end_flow 与 end_node_id 的联动 ——
  it('动作改为 end_flow：不自动填目标（end_node_id 保持 undefined），其余字段不变', () => {
    const next = updateButtonField(TWO_BUTTONS, 1, { action: 'end_flow' });
    expect(next[1].action).toBe('end_flow');
    expect(next[1].end_node_id).toBeUndefined();
    expect(next[1].name).toBe('拒绝');
  });

  it('动作从 end_flow 改为其他档：清掉 end_node_id（键本身不再存在）', () => {
    const withEnd: ApprovalButton[] = [{ ...TWO_BUTTONS[1], action: 'end_flow', end_node_id: 'end-1' }];
    const next = updateButtonField(withEnd, 0, { action: 'withdraw_initiator' });
    expect(next[0].action).toBe('withdraw_initiator');
    expect('end_node_id' in next[0]).toBe(false);
  });

  it('动作保持 end_flow 时改其它字段：end_node_id 原样保留', () => {
    const withEnd: ApprovalButton[] = [{ ...TWO_BUTTONS[1], action: 'end_flow', end_node_id: 'end-1' }];
    const next = updateButtonField(withEnd, 0, { name: '不通过' });
    expect(next[0].end_node_id).toBe('end-1');
  });

  it('end_flow 下写入 end_node_id：正常合并；非 end_flow 动作下即使 patch 带 end_node_id 也被清掉', () => {
    const a = updateButtonField(TWO_BUTTONS, 1, { action: 'end_flow', end_node_id: 'end-2' });
    expect(a[1].end_node_id).toBe('end-2');
    const b = updateButtonField(TWO_BUTTONS, 0, { end_node_id: 'end-2' });
    expect('end_node_id' in b[0]).toBe(false);
  });

  it('新增按钮默认值不变：提交通过、无 end_node_id', () => {
    const btn = createDefaultButton();
    expect(btn.action).toBe('submit_approve');
    expect('end_node_id' in btn).toBe(false);
  });
});

describe('sameButtonOrder：判断顺序是否相同（供拖拽松手时跳过无变化写回）', () => {
  it('顺序完全相同（同一份或另一份但 id 顺序一致）判定相同', () => {
    expect(sameButtonOrder(TWO_BUTTONS, TWO_BUTTONS)).toBe(true);
    expect(sameButtonOrder(TWO_BUTTONS, [...TWO_BUTTONS])).toBe(true);
  });

  it('顺序不同或长度不同判定不同', () => {
    expect(sameButtonOrder(TWO_BUTTONS, moveButtonTo(TWO_BUTTONS, 0, 1))).toBe(false);
    expect(sameButtonOrder(TWO_BUTTONS, addButton(TWO_BUTTONS))).toBe(false);
  });
});

describe('listEndNodeOptions：「结束到」下拉候选', () => {
  const nodes: WorkflowNode[] = [
    { id: 'start', kind: 'start' },
    { id: 'end-a', kind: 'end', name: '通过结束', config: { end_flag: '已通过' } },
    { id: 'ap1', kind: 'approve' },
    { id: 'end-b', kind: 'end', config: { end_flag: '  ' } },
    { id: 'end-c', kind: 'end', name: '   ' }
  ];

  it('只取 kind 为 end 的节点，保持 doc.nodes 顺序', () => {
    expect(listEndNodeOptions(nodes, undefined).map((o) => o.id)).toEqual(['end-a', 'end-b', 'end-c']);
  });

  it('有名字用名字；名字为空/纯空白按「类型名 + 序号」兜底（序号按结束节点在清单里的出现位置）', () => {
    const opts = listEndNodeOptions(nodes, undefined);
    expect(opts[0].label).toBe('通过结束');
    expect(opts[1].label).toBe('结束 2');
    expect(opts[2].label).toBe('结束 3');
  });

  it('结束标识取 end_flag 并去首尾空白，未填为空串', () => {
    const opts = listEndNodeOptions(nodes, undefined);
    expect(opts[0].flag).toBe('已通过');
    expect(opts[1].flag).toBe('');
    expect(opts[2].flag).toBe('');
  });

  it('没有结束节点 / nodes 缺省时返回空数组', () => {
    expect(listEndNodeOptions([{ id: 'start', kind: 'start' }], undefined)).toEqual([]);
    expect(listEndNodeOptions(undefined, undefined)).toEqual([]);
  });
});
