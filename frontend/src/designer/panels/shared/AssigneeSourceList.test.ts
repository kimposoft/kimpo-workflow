/**
 * designer/panels/shared/AssigneeSourceList.test.ts —— 『A 人员来源』清单唤起宿主三维选择器时
 * 必须带上 host.appId（办理/审批/抄送三个面板共用本组件）。
 *
 * 缺省 appId 时宿主选择器的「角色」页签只列全局角色、看不到本应用角色（SDK
 * OrgTriPickerRequest.appId 注释）；本用例钉住这条透传，防止再次回归为只能选全局角色。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import AssigneeSourceList from './AssigneeSourceList.vue';
import { createDefaultDocument } from '../../../model/defaults';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let mounted: MountedPanel<typeof AssigneeSourceList> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('AssigneeSourceList 唤起三维选择器', () => {
  it('添加「角色」来源时把 host.appId 传给 openOrgTriPicker（否则只能选到全局角色）', async () => {
    const openOrgTriPicker = vi.fn().mockResolvedValue({ confirmed: true, users: [], roles: [{ id: 'r_app', name: '本应用角色' }], depts: [] });
    const host = fakeHost({ appId: 'app_42', ui: { openOrgTriPicker } as never });
    const onUpdate = vi.fn();
    mounted = mountPanel(
      AssigneeSourceList,
      { modelValue: [], templateId: 'tpl_x', 'onUpdate:modelValue': onUpdate },
      { host, state: fakeState(createDefaultDocument('测试流程')), i18n: fakeI18n() }
    );
    (mounted.el.querySelector('[data-testid="asl-add"]') as HTMLElement).click();
    await flush();
    (document.querySelector('[data-testid="asl-add-role"]') as HTMLElement).click();
    await flush();

    expect(openOrgTriPicker).toHaveBeenCalledTimes(1);
    expect(openOrgTriPicker.mock.calls[0][0]).toMatchObject({ appId: 'app_42' });
    expect(onUpdate).toHaveBeenCalledWith([{ kind: 'role', role_ids: ['r_app'] }]);
  });

  // 选「角色」/「部门」/「用户」来源时，选择器要直接停在对应页签（initialTab）。
  it.each([
    ['user', 'user'],
    ['role', 'role'],
    ['department', 'dept']
  ])('添加「%s」来源时 initialTab=%s', async (kind, tab) => {
    const openOrgTriPicker = vi.fn().mockResolvedValue({ confirmed: false, users: [], roles: [], depts: [] });
    const host = fakeHost({ appId: 'app_42', ui: { openOrgTriPicker } as never });
    mounted = mountPanel(
      AssigneeSourceList,
      { modelValue: [], templateId: 'tpl_x' },
      { host, state: fakeState(createDefaultDocument('测试流程')), i18n: fakeI18n() }
    );
    (mounted.el.querySelector('[data-testid="asl-add"]') as HTMLElement).click();
    await flush();
    (document.querySelector(`[data-testid="asl-add-${kind}"]`) as HTMLElement).click();
    await flush();

    expect(openOrgTriPicker.mock.calls[0][0]).toMatchObject({ initialTab: tab });
  });
});
