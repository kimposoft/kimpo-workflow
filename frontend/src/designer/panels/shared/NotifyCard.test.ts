/**
 * panels/shared/NotifyCard.test.ts —— 四类主线节点共用『通知』卡组件测试：回显（undefined/部分配置）、写回对象只含传入的开关键、只读禁用、渠道勾选
 * 经共享子组件 NotifyChannelList 正确合回写回对象。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../../model/defaults';
import type { NodeNotify } from '../../../model';
import NotifyCard, { type NotifyCardSwitch } from './NotifyCard.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await nextTick();
}

// 发起节点认的三个开关键（同 StartPanel.vue 接线），业务话文案在本文件写死，不依赖真实四语包。
const START_SWITCHES: NotifyCardSwitch[] = [
  { key: 'on_returned', label: '被退回到发起人时通知发起人' },
  { key: 'on_withdrawn', label: '提交被撤回时通知下一步处理人' },
  { key: 'on_terminated', label: '流程被管理员终止时通知当前处理人' }
];

let mounted: MountedPanel<typeof NotifyCard> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountCard(
  value: NodeNotify | undefined,
  switches: NotifyCardSwitch[],
  opts: { readOnly?: boolean; onUpdate?: (v: NodeNotify) => void } = {}
): MountedPanel<typeof NotifyCard> {
  const doc = createDefaultDocument('测试流程');
  return mountPanel(
    NotifyCard,
    { modelValue: value, switches, readOnly: opts.readOnly ?? false, 'onUpdate:modelValue': opts.onUpdate },
    { host: fakeHost(), state: fakeState(doc), i18n: fakeI18n() }
  );
}

describe('NotifyCard：回显', () => {
  it('modelValue 为 undefined：全部开关渲染为开，渠道只勾系统通知', async () => {
    mounted = mountCard(undefined, START_SWITCHES);
    await flush();
    for (const sw of START_SWITCHES) {
      const el = mounted.el.querySelector(`[data-testid="notify-switch-${sw.key}"]`) as HTMLElement;
      expect(el, `应渲染 notify-switch-${sw.key}`).toBeTruthy();
      expect(el.className).toContain('n-switch--active');
    }
    expect((mounted.el.querySelector('[data-testid="notify-channel-system"]') as HTMLElement).className).toContain('n-checkbox--checked');
    expect((mounted.el.querySelector('[data-testid="notify-channel-sms"]') as HTMLElement).className).not.toContain('n-checkbox--checked');
    expect((mounted.el.querySelector('[data-testid="notify-channel-email"]') as HTMLElement).className).not.toContain('n-checkbox--checked');
  });

  it('部分配置：显式 false 的开关渲染为关，其余按默认开显示', async () => {
    mounted = mountCard({ on_withdrawn: false }, START_SWITCHES);
    await flush();
    expect((mounted.el.querySelector('[data-testid="notify-switch-on_returned"]') as HTMLElement).className).toContain('n-switch--active');
    expect((mounted.el.querySelector('[data-testid="notify-switch-on_withdrawn"]') as HTMLElement).className).not.toContain('n-switch--active');
    expect((mounted.el.querySelector('[data-testid="notify-switch-on_terminated"]') as HTMLElement).className).toContain('n-switch--active');
  });

  it('开关行文案按 switches[].label 原样渲染（调用方翻译好传入，本组件不持有业务 i18n key）', async () => {
    mounted = mountCard(undefined, START_SWITCHES);
    await flush();
    for (const sw of START_SWITCHES) {
      expect(mounted.el.textContent).toContain(sw.label);
    }
  });
});

describe('NotifyCard：写回对象只含传入的开关键', () => {
  it('切换某个开关：写回对象只含 switches 里的三个键 + channels，不出现 on_assigned/on_ended', async () => {
    let emitted: NodeNotify | undefined;
    mounted = mountCard(undefined, START_SWITCHES, { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="notify-switch-on_returned"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual({ on_returned: false, on_withdrawn: true, on_terminated: true, channels: ['system'] });
    expect(Object.prototype.hasOwnProperty.call(emitted, 'on_assigned')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(emitted, 'on_ended')).toBe(false);
  });

  it('两类节点各自只认自己的开关键：办理节点只传 on_assigned/on_returned 两个 switches', async () => {
    const HANDLE_SWITCHES: NotifyCardSwitch[] = [
      { key: 'on_assigned', label: '有新待办时通知处理人' },
      { key: 'on_returned', label: '被退回到这一步时通知处理人' }
    ];
    let emitted: NodeNotify | undefined;
    mounted = mountCard(undefined, HANDLE_SWITCHES, { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="notify-switch-on_assigned"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual({ on_assigned: false, on_returned: true, channels: ['system'] });
  });

  it('渠道勾选变化：经 NotifyChannelList 合回写回对象，开关键当前值原样保留', async () => {
    let emitted: NodeNotify | undefined;
    mounted = mountCard({ on_returned: false }, START_SWITCHES, { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="notify-channel-email"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual({ on_returned: false, on_withdrawn: true, on_terminated: true, channels: ['system', 'email'] });
  });
});

describe('NotifyCard：只读禁用', () => {
  it('只读态：开关与渠道均禁用，点击不产生写操作', async () => {
    let emitted: NodeNotify | undefined;
    mounted = mountCard(undefined, START_SWITCHES, { readOnly: true, onUpdate: (v) => { emitted = v; } });
    await flush();
    const switchEl = mounted.el.querySelector('[data-testid="notify-switch-on_returned"]') as HTMLElement;
    expect(switchEl.className).toContain('n-switch--disabled');
    switchEl.click();
    const channelEl = mounted.el.querySelector('[data-testid="notify-channel-email"]') as HTMLElement;
    expect(channelEl.className).toContain('n-checkbox--disabled');
    channelEl.click();
    await flush();
    expect(emitted).toBeUndefined();
  });
});

describe('NotifyCard：渠道「至少保留一种」拒绝（经 NotifyChannelList 内部处理，逐层透传）', () => {
  it('只剩系统通知一种时试图取消：不 emit', async () => {
    let emitted: NodeNotify | undefined;
    mounted = mountCard(undefined, START_SWITCHES, { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="notify-channel-system"]') as HTMLElement).click();
    await flush();
    expect(emitted).toBeUndefined();
  });
});
