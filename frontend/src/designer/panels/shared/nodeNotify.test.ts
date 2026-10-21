// panels/shared/nodeNotify.test.ts —— resolveNotify/pickNotify/toggleNotifySwitch/
// applyNotifyChannels 纯函数单测。
import { describe, expect, it } from 'vitest';
import type { NodeNotify, NotifyChannel } from '../../../model';
import { applyNotifyChannels, pickNotify, resolveNotify, toggleNotifySwitch } from './nodeNotify';

describe('resolveNotify：undefined/部分配置 → 完整显示态', () => {
  it('value 为 undefined：五个开关全部为 true，channels 为 [system]', () => {
    expect(resolveNotify(undefined)).toEqual({
      on_assigned: true,
      on_returned: true,
      on_withdrawn: true,
      on_terminated: true,
      on_ended: true,
      channels: ['system']
    });
  });

  it('value 为 {}（配了 notify 但没配任何键）：同 undefined，全部按默认开处理', () => {
    expect(resolveNotify({})).toEqual({
      on_assigned: true,
      on_returned: true,
      on_withdrawn: true,
      on_terminated: true,
      on_ended: true,
      channels: ['system']
    });
  });

  it('只显式配了部分键：配了的键原样透传，没配的键仍按默认开补齐', () => {
    const value: NodeNotify = { on_assigned: false, channels: ['system', 'email'] };
    expect(resolveNotify(value)).toEqual({
      on_assigned: false,
      on_returned: true,
      on_withdrawn: true,
      on_terminated: true,
      on_ended: true,
      channels: ['system', 'email']
    });
  });

  it('显式 false 才是真正关闭；显式 true 与不配同一效果', () => {
    expect(resolveNotify({ on_returned: false }).on_returned).toBe(false);
    expect(resolveNotify({ on_returned: true }).on_returned).toBe(true);
  });

  it('channels 为空数组：同缺席，按仅 system 处理', () => {
    expect(resolveNotify({ channels: [] }).channels).toEqual(['system']);
  });

  it('返回的 channels 是新数组，不与入参共享引用（防调用方改动泄漏进内部状态）', () => {
    const original: NotifyChannel[] = ['system', 'sms'];
    const value: NodeNotify = { channels: original };
    const resolved = resolveNotify(value);
    expect(resolved.channels).toEqual(original);
    expect(resolved.channels).not.toBe(original);
  });
});

describe('pickNotify：完整显示态 → 只含指定开关键 + channels 的落库对象', () => {
  it('只保留 keys 里点名的开关键，不认识的键不写入', () => {
    const resolved = resolveNotify(undefined);
    const picked = pickNotify(resolved, ['on_returned', 'on_withdrawn', 'on_terminated']);
    expect(picked).toEqual({ on_returned: true, on_withdrawn: true, on_terminated: true, channels: ['system'] });
    expect(Object.prototype.hasOwnProperty.call(picked, 'on_assigned')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(picked, 'on_ended')).toBe(false);
  });

  it('keys 为空数组：只剩 channels 一个键', () => {
    const resolved = resolveNotify(undefined);
    expect(pickNotify(resolved, [])).toEqual({ channels: ['system'] });
  });

  it('显式写 true/false，不靠缺席表达（关闭态的键原样写 false，不是省略）', () => {
    const resolved = resolveNotify({ on_assigned: false });
    const picked = pickNotify(resolved, ['on_assigned', 'on_returned']);
    expect(picked).toEqual({ on_assigned: false, on_returned: true, channels: ['system'] });
  });
});

describe('toggleNotifySwitch：切换单个事件开关', () => {
  it('undefined → 切换 on_returned：写回只含 keys 子集，on_returned 变为 false，其余不写', () => {
    const next = toggleNotifySwitch(undefined, ['on_returned', 'on_withdrawn', 'on_terminated'], 'on_returned');
    expect(next).toEqual({ on_returned: false, on_withdrawn: true, on_terminated: true, channels: ['system'] });
  });

  it('已显式 false 的键再切一次变回 true', () => {
    const value: NodeNotify = { on_assigned: false };
    const next = toggleNotifySwitch(value, ['on_assigned', 'on_returned'], 'on_assigned');
    expect(next.on_assigned).toBe(true);
  });

  it('只切目标键，keys 里其余键的当前值原样保留（不因切了一个键就把别的键也重写成默认值）', () => {
    const value: NodeNotify = { on_assigned: false, on_returned: false };
    const next = toggleNotifySwitch(value, ['on_assigned', 'on_returned'], 'on_returned');
    expect(next).toEqual({ on_assigned: false, on_returned: true, channels: ['system'] });
  });

  it('channels 在切换开关时原样透传，不受影响', () => {
    const value: NodeNotify = { channels: ['system', 'sms'] };
    const next = toggleNotifySwitch(value, ['on_ended'], 'on_ended');
    expect(next.channels).toEqual(['system', 'sms']);
  });
});

describe('applyNotifyChannels：渠道清单变化合回写回对象', () => {
  it('写回只含 keys 子集 + 新 channels，开关键当前值原样保留', () => {
    const value: NodeNotify = { on_ended: false };
    const next = applyNotifyChannels(value, ['on_ended'], ['system', 'email']);
    expect(next).toEqual({ on_ended: false, channels: ['system', 'email'] });
  });

  it('keys 为空（不认识任何开关键的节点类型场景，理论不会出现，边界防御）：只剩 channels', () => {
    expect(applyNotifyChannels(undefined, [], ['sms'])).toEqual({ channels: ['sms'] });
  });
});
