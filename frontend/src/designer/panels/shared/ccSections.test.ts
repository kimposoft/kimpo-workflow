// panels/shared/ccSections.test.ts —— toggleChannel / normalizeExprSlot 纯函数单测。
import { describe, expect, it } from 'vitest';
import { CC_CHANNEL_ORDER, normalizeExprSlot, toggleChannel } from './ccSections';
import type { V4ExpressionDocumentEnvelope } from '../../../model';

describe('toggleChannel', () => {
  it('未选中时加入该渠道，并按固定顺序排列（不管点击顺序）', () => {
    expect(toggleChannel(['system'], 'email')).toEqual(['system', 'email']);
    // 先加邮件、再加短信：输出仍按 system/sms/email 固定顺序，不是加入顺序。
    const step1 = toggleChannel(['system'], 'email');
    const step2 = toggleChannel(step1, 'sms');
    expect(step2).toEqual(['system', 'sms', 'email']);
  });

  it('已选中且不是唯一一种时移除该渠道', () => {
    expect(toggleChannel(['system', 'sms'], 'sms')).toEqual(['system']);
  });

  it('已选中且是唯一一种渠道时拒绝移除：返回同一个数组引用', () => {
    const current: ('system' | 'sms' | 'email')[] = ['system'];
    const next = toggleChannel(current, 'system');
    expect(next).toBe(current);
  });

  it('channels 缺省（undefined）时按空数组处理：加入即成为唯一一项', () => {
    expect(toggleChannel(undefined, 'sms')).toEqual(['sms']);
  });

  it('入参含乱序/重复脏数据：输出仍按固定顺序去重', () => {
    // 直接构造违反正常写入路径的脏数据，验证归一化不依赖调用方守规矩。
    const dirty = ['email', 'system', 'email'] as ('system' | 'sms' | 'email')[];
    expect(toggleChannel(dirty, 'sms')).toEqual(['system', 'sms', 'email']);
  });

  it('CC_CHANNEL_ORDER 固定为 系统/短信/邮件 三档，供组件层渲染选项复用', () => {
    expect(CC_CHANNEL_ORDER).toEqual(['system', 'sms', 'email']);
  });
});

describe('normalizeExprSlot', () => {
  const doc: V4ExpressionDocumentEnvelope = {
    schema_version: 'kimpo.report-expression/v4',
    mode: 'value',
    expression: { expression_id: 'e1', purpose: 'output', source_text: 'x', refs: [] }
  };

  it('undefined（V4ExpressionField 清空时的 emit 值）归一化为 null', () => {
    expect(normalizeExprSlot(undefined)).toBeNull();
  });

  it('null 原样保持 null', () => {
    expect(normalizeExprSlot(null)).toBeNull();
  });

  it('有值时原样透传，不做任何拷贝/改写', () => {
    expect(normalizeExprSlot(doc)).toBe(doc);
  });
});
