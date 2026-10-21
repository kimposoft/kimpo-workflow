/**
 * panels/shared/NotifyChannelList.test.ts —— 通知渠道三档竖排勾选清单组件测试：
 * 默认渲染、勾选/取消写回、「至少保留
 * 一种」拒绝、不可用渠道置灰 + 标签、只读态禁用、testidPrefix 默认值与自定义值。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../../model/defaults';
import type { NotifyChannel } from '../../../model';
import type { DesignerHost } from '../../host';
import NotifyChannelList from './NotifyChannelList.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await nextTick();
}

let mounted: MountedPanel<typeof NotifyChannelList> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountList(
  value: NotifyChannel[] | undefined,
  opts: {
    readOnly?: boolean;
    testidPrefix?: string;
    onUpdate?: (v: NotifyChannel[]) => void;
    channelCapabilities?: DesignerHost['channelCapabilities'];
  } = {}
): MountedPanel<typeof NotifyChannelList> {
  const doc = createDefaultDocument('测试流程');
  const host = fakeHost(opts.channelCapabilities ? { channelCapabilities: opts.channelCapabilities } : {});
  return mountPanel(
    NotifyChannelList,
    {
      modelValue: value,
      readOnly: opts.readOnly ?? false,
      testidPrefix: opts.testidPrefix,
      'onUpdate:modelValue': opts.onUpdate
    },
    { host, state: fakeState(doc), i18n: fakeI18n() }
  );
}

describe('NotifyChannelList：默认渲染', () => {
  it('三档都渲染，testidPrefix 缺省时用 cc-channel-<channel>（CcPanel 抽取后 testid 不变）', async () => {
    mounted = mountList(['system']);
    await flush();
    for (const channel of ['system', 'sms', 'email']) {
      expect(mounted.el.querySelector(`[data-testid="cc-channel-${channel}"]`), `应渲染 cc-channel-${channel}`).toBeTruthy();
    }
  });

  it('testidPrefix 传 notify 时渲染出 notify-channel-<channel>', async () => {
    mounted = mountList(['system'], { testidPrefix: 'notify' });
    await flush();
    for (const channel of ['system', 'sms', 'email']) {
      expect(mounted.el.querySelector(`[data-testid="notify-channel-${channel}"]`), `应渲染 notify-channel-${channel}`).toBeTruthy();
    }
    expect(mounted.el.querySelector('[data-testid="cc-channel-system"]'), '不应再渲染默认前缀').toBeFalsy();
  });

  it('modelValue 为 undefined 时按空数组处理，三档都未勾选', async () => {
    mounted = mountList(undefined);
    await flush();
    const box = mounted.el.querySelector('[data-testid="cc-channel-system"]') as HTMLElement;
    expect(box.className).not.toContain('n-checkbox--checked');
  });
});

describe('NotifyChannelList：勾选/取消写回', () => {
  it('勾选未选中的渠道：emit 追加后的清单（按固定顺序）', async () => {
    let emitted: NotifyChannel[] | undefined;
    mounted = mountList(['system'], { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="cc-channel-email"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual(['system', 'email']);
  });

  it('取消已选中且不是唯一一种的渠道：emit 移除后的清单', async () => {
    let emitted: NotifyChannel[] | undefined;
    mounted = mountList(['system', 'sms'], { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="cc-channel-sms"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual(['system']);
  });
});

describe('NotifyChannelList：至少保留一种渠道', () => {
  it('试图取消最后一个渠道：不 emit，显示提示', async () => {
    let emitted: NotifyChannel[] | undefined;
    mounted = mountList(['system'], { onUpdate: (v) => { emitted = v; } });
    await flush();
    expect(mounted.el.textContent).not.toContain('至少要保留一种通知渠道');
    (mounted.el.querySelector('[data-testid="cc-channel-system"]') as HTMLElement).click();
    await flush();
    expect(emitted).toBeUndefined();
    expect(mounted.el.textContent).toContain('至少要保留一种通知渠道');
  });
});

describe('NotifyChannelList：不可用渠道置灰且带标签', () => {
  it('接口回传某渠道不可用：未勾选时禁用，且常显「服务未配置」标签 + 悬停说明', async () => {
    mounted = mountList(['system'], {
      channelCapabilities: async () => ({
        data: { channels: [{ channel: 'system', available: true }, { channel: 'sms', available: false }, { channel: 'email', available: true }] }
      })
    });
    await flush();
    const smsBox = mounted.el.querySelector('[data-testid="cc-channel-sms"]') as HTMLElement;
    expect(smsBox.className).toContain('n-checkbox--disabled');
    expect(mounted.el.textContent).toContain('服务未配置');
  });

  it('已勾选的不可用渠道保留显示且仍允许主动取消（不困住用户）', async () => {
    let emitted: NotifyChannel[] | undefined;
    mounted = mountList(['system', 'sms'], {
      onUpdate: (v) => { emitted = v; },
      channelCapabilities: async () => ({
        data: { channels: [{ channel: 'system', available: true }, { channel: 'sms', available: false }, { channel: 'email', available: true }] }
      })
    });
    await flush();
    const smsBox = mounted.el.querySelector('[data-testid="cc-channel-sms"]') as HTMLElement;
    // 已勾选：不应处于禁用态（允许取消）。
    expect(smsBox.className).not.toContain('n-checkbox--disabled');
    smsBox.click();
    await flush();
    expect(emitted).toEqual(['system']);
  });
});

describe('NotifyChannelList：只读态', () => {
  it('只读态下全部渠道禁用，点击不产生写操作', async () => {
    let emitted: NotifyChannel[] | undefined;
    mounted = mountList(['system'], { readOnly: true, onUpdate: (v) => { emitted = v; } });
    await flush();
    const emailBox = mounted.el.querySelector('[data-testid="cc-channel-email"]') as HTMLElement;
    expect(emailBox.className).toContain('n-checkbox--disabled');
    emailBox.click();
    await flush();
    expect(emitted).toBeUndefined();
  });
});
