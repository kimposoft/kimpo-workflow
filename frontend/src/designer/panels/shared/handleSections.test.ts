// panels/shared/handleSections.test.ts —— 办理节点『D 办理方式』『E 回退』纯函数单测。
// 覆盖百分比换算与钳制、回退方式勾选顺序固定与幂等、复合键往返与坏键丢弃、按表分组
// 选项构造（主表第一、已不存在字段占位）——同 assigneeSource.test.ts 头注释的既定分工。
import { describe, expect, it } from 'vitest';
import {
  WITHDRAW_METHOD_ORDER,
  bpToPercent,
  buildWithdrawClearFieldOptions,
  clearFieldsToKeys,
  decodeClearFieldKey,
  encodeClearFieldKey,
  hasAnyWithdrawMethod,
  isWithdrawMethodChecked,
  keysToClearFields,
  percentToBp,
  toggleWithdrawMethod
} from './handleSections';
import type { ClearOnWithdrawField, WithdrawMethod } from '../../../model';
import type { TemplateFieldCatalog } from './templateFieldCatalog';

describe('D 办理方式：万分比 ⇄ 百分比换算与钳制', () => {
  it('bpToPercent：未配置（undefined）按默认 100% 展示', () => {
    expect(bpToPercent(undefined)).toBe(100);
  });

  it('bpToPercent：正常值整除换算', () => {
    expect(bpToPercent(5000)).toBe(50);
    expect(bpToPercent(10000)).toBe(100);
    expect(bpToPercent(100)).toBe(1);
  });

  it('bpToPercent：历史脏数据（0 或超出 100%）钳到 [1,100]', () => {
    expect(bpToPercent(0)).toBe(1);
    expect(bpToPercent(-500)).toBe(1);
    expect(bpToPercent(20000)).toBe(100);
  });

  it('percentToBp：正常整数换算为万分比', () => {
    expect(percentToBp(50)).toBe(5000);
    expect(percentToBp(1)).toBe(100);
    expect(percentToBp(100)).toBe(10000);
  });

  it('percentToBp：越界值先钳到 [1,100] 再换算，非整数四舍五入', () => {
    expect(percentToBp(0)).toBe(100);
    expect(percentToBp(150)).toBe(10000);
    expect(percentToBp(33.6)).toBe(3400);
  });

  it('往返：percentToBp(bpToPercent(x)) 在合法区间内是恒等映射', () => {
    for (const bp of [100, 2500, 5000, 7500, 10000]) {
      expect(percentToBp(bpToPercent(bp))).toBe(bp);
    }
  });
});

describe('回退方式：勾选顺序固定 + 幂等', () => {
  it('WITHDRAW_METHOD_ORDER 恰好是三档回退方式，顺序为 上一步→发起人→指定步骤', () => {
    expect(WITHDRAW_METHOD_ORDER).toEqual(['previous_step', 'initiator', 'specified_step']);
  });

  it('toggleWithdrawMethod：未勾选时追加，已勾选时移除', () => {
    expect(toggleWithdrawMethod(undefined, 'initiator')).toEqual(['initiator']);
    expect(toggleWithdrawMethod(['initiator'], 'initiator')).toEqual([]);
  });

  it('toggleWithdrawMethod：无论勾选的先后顺序，结果数组恒按固定顺序排列', () => {
    let a: WithdrawMethod[] = [];
    a = toggleWithdrawMethod(a, 'specified_step');
    a = toggleWithdrawMethod(a, 'previous_step');
    a = toggleWithdrawMethod(a, 'initiator');
    expect(a).toEqual(['previous_step', 'initiator', 'specified_step']);

    let b: WithdrawMethod[] = [];
    b = toggleWithdrawMethod(b, 'initiator');
    b = toggleWithdrawMethod(b, 'specified_step');
    b = toggleWithdrawMethod(b, 'previous_step');
    expect(b).toEqual(a);
  });

  it('toggleWithdrawMethod：连续两次 toggle 同一档回到原样（幂等）', () => {
    const start: WithdrawMethod[] = ['previous_step'];
    const once = toggleWithdrawMethod(start, 'initiator');
    const twice = toggleWithdrawMethod(once, 'initiator');
    expect(twice).toEqual(start);
  });

  it('isWithdrawMethodChecked：反映当前是否已勾选，undefined 视为未勾选', () => {
    expect(isWithdrawMethodChecked(undefined, 'previous_step')).toBe(false);
    expect(isWithdrawMethodChecked(['previous_step'], 'previous_step')).toBe(true);
    expect(isWithdrawMethodChecked(['previous_step'], 'initiator')).toBe(false);
  });

  it('hasAnyWithdrawMethod：空数组/undefined 都视为"一种都没勾"', () => {
    expect(hasAnyWithdrawMethod(undefined)).toBe(false);
    expect(hasAnyWithdrawMethod([])).toBe(false);
    expect(hasAnyWithdrawMethod(['initiator'])).toBe(true);
  });
});

describe('回退时清空字段：复合键编解码与往返', () => {
  it('encodeClearFieldKey/decodeClearFieldKey：往返一致', () => {
    const key = encodeClearFieldKey('t1', 'f1');
    expect(key).toBe('t1::f1');
    expect(decodeClearFieldKey(key)).toEqual({ tableId: 't1', fieldId: 'f1' });
  });

  it('decodeClearFieldKey：不含分隔符的野值解不出，返回 undefined', () => {
    expect(decodeClearFieldKey('not-a-valid-key')).toBeUndefined();
  });

  it('clearFieldsToKeys/keysToClearFields：往返一致', () => {
    const fields: ClearOnWithdrawField[] = [
      { table_id: 't1', field_id: 'f1' },
      { table_id: 't2', field_id: 'f2' }
    ];
    const keys = clearFieldsToKeys(fields);
    expect(keys).toEqual(['t1::f1', 't2::f2']);
    expect(keysToClearFields(keys)).toEqual(fields);
  });

  it('keysToClearFields：坏键（解不出）直接丢弃，不抛错、不产出半条记录', () => {
    expect(keysToClearFields(['t1::f1', 'garbage', 't2::f2'])).toEqual([
      { table_id: 't1', field_id: 'f1' },
      { table_id: 't2', field_id: 'f2' }
    ]);
  });

  it('clearFieldsToKeys：undefined 输入返回空数组', () => {
    expect(clearFieldsToKeys(undefined)).toEqual([]);
  });
});

describe('回退时清空字段：按表分组选项构造', () => {
  const catalog: TemplateFieldCatalog = {
    templateId: 'tpl1',
    tables: [
      {
        tableId: 't_main',
        tableName: '主表',
        isMain: true,
        fields: [
          { fieldId: 'f_m1', fieldName: '主表字段一', dataType: 'text', tableId: 't_main', tableName: '主表', isMain: true }
        ]
      },
      {
        tableId: 't_detail',
        tableName: '明细表',
        isMain: false,
        fields: [
          { fieldId: 'f_d1', fieldName: '明细字段一', dataType: 'text', tableId: 't_detail', tableName: '明细表', isMain: false }
        ]
      }
    ],
    byFieldId: new Map()
  };

  it('catalog 为 null：返回空数组', () => {
    expect(buildWithdrawClearFieldOptions(null, [], '（字段已不存在）')).toEqual([]);
  });

  it('主表排第一，其余表按目录里的顺序，字段为空的表不产出分组', () => {
    const options = buildWithdrawClearFieldOptions(catalog, [], '（字段已不存在）');
    expect(options).toEqual([
      { type: 'group', key: 't_main', label: '主表', children: [{ label: '主表字段一', value: 't_main::f_m1' }] },
      { type: 'group', key: 't_detail', label: '明细表', children: [{ label: '明细字段一', value: 't_detail::f_d1' }] }
    ]);
  });

  it('已选但目录里已不存在的字段：追加一条占位选项，不静默丢弃已选值', () => {
    const options = buildWithdrawClearFieldOptions(catalog, ['t_main::f_m1', 't_ghost::f_gone'], '（字段已不存在）');
    expect(options).toHaveLength(3);
    expect(options[2]).toEqual({ label: '（字段已不存在）', value: 't_ghost::f_gone' });
  });

  it('全部已选字段都在目录里：不产出任何占位选项', () => {
    const options = buildWithdrawClearFieldOptions(catalog, ['t_main::f_m1'], '（字段已不存在）');
    expect(options).toHaveLength(2);
  });
});
