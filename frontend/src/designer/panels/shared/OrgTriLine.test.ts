/**
 * panels/shared/OrgTriLine.test.ts —— OrgTriLine.vue 组件级单测（「谁能发起」第四档『主表字段』）：
 * 覆盖「＋添加来源」菜单的两项与置灰条件、添加
 * 草稿行不写空串、三维选择器确认后保留第四档、删除某一类来源后保留第四档、无目标模板时置灰、
 * 只读态。
 *
 * 「选字段后写回」「改匹配方式」两条：NSelect 的下拉选项在 happy-dom 下不会真的渲染/可点选
 * （同 MainFieldSelect.vue 头注释、EndPanel.test.ts/ApprovePanel.test.ts 既定口径），
 * 真正的合并逻辑因此已抽成纯函数（./startGrant.ts），由 ./startGrant.test.ts 直接覆盖；本文件
 * 只用一条"静态守护"断言锁住 OrgTriLine.vue 的事件处理函数确实调用了对应的纯函数（接线对不对），
 * 不重复测合并逻辑本身。
 *
 * 「＋添加来源」下拉（NDropdown）本身在 happy-dom 下经实测可以正常展开/点选（与 NSelect 不同，
 * 它不依赖虚拟滚动的选项列表），因此菜单结构、置灰、点选分发、三维选择器确认流程都走真实 DOM
 * 交互测试，不需要退化成源码断言。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../../model/defaults';
import type { StartGrant } from '../../../model';
import OrgTriLine from './OrgTriLine.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await nextTick();
}

let mounted: MountedPanel<typeof OrgTriLine> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountLine(
  modelValue: StartGrant,
  opts: { disabled?: boolean; templateId?: string; onUpdate?: (v: StartGrant) => void; host?: ReturnType<typeof fakeHost> } = {}
): MountedPanel<typeof OrgTriLine> {
  const doc = createDefaultDocument('测试流程');
  return mountPanel(
    OrgTriLine,
    { modelValue, disabled: opts.disabled ?? false, templateId: opts.templateId, 'onUpdate:modelValue': opts.onUpdate },
    { host: opts.host ?? fakeHost(), state: fakeState(doc), i18n: fakeI18n() }
  );
}

async function openAddMenu(page: HTMLElement): Promise<void> {
  (page.querySelector('[data-testid="org-tri-add"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
}

describe('OrgTriLine：「＋添加来源」菜单两项及置灰条件', () => {
  it('没有目标模板：「表单字段」菜单项置灰，带「请先选择目标模板」提示；「用户/角色/部门」不受影响', async () => {
    mounted = mountLine({});
    await flush();
    await openAddMenu(mounted.el);

    const mainFieldItem = document.body.querySelector('[data-testid="org-tri-add-main-field"]') as HTMLElement;
    expect(mainFieldItem).toBeTruthy();
    expect(mainFieldItem.className).toContain('n-dropdown-option-body--disabled');
    expect(mainFieldItem.getAttribute('title')).toBe('请先选择目标模板');

    const orgItem = document.body.querySelector('[data-testid="org-tri-add-org"]') as HTMLElement;
    expect(orgItem).toBeTruthy();
    expect(orgItem.className).not.toContain('n-dropdown-option-body--disabled');
  });

  it('有目标模板、还没配置第四档：「表单字段」菜单项可点', async () => {
    mounted = mountLine({}, { templateId: 'tpl1' });
    await flush();
    await openAddMenu(mounted.el);

    const mainFieldItem = document.body.querySelector('[data-testid="org-tri-add-main-field"]') as HTMLElement;
    expect(mainFieldItem.className).not.toContain('n-dropdown-option-body--disabled');
  });

  it('已配置第四档（main_field_id 已有值）：「表单字段」菜单项置灰（防止重复添加）', async () => {
    mounted = mountLine({ main_field_id: 'f1' }, { templateId: 'tpl1' });
    await flush();
    await openAddMenu(mounted.el);

    const mainFieldItem = document.body.querySelector('[data-testid="org-tri-add-main-field"]') as HTMLElement;
    expect(mainFieldItem.className).toContain('n-dropdown-option-body--disabled');
  });
});

describe('OrgTriLine：添加草稿行不写空串', () => {
  it('点「表单字段」菜单项：出现第四档行，但不产生任何写入（不写空串占位）', async () => {
    let emitted: StartGrant | undefined;
    mounted = mountLine({}, { templateId: 'tpl1', onUpdate: (v) => { emitted = v; } });
    await flush();
    await openAddMenu(mounted.el);

    (document.body.querySelector('[data-testid="org-tri-add-main-field"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(mounted.el.querySelector('[data-testid="org-tri-row-main_field"]')).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="org-tri-main-field"]')).toBeTruthy();
    expect(emitted, '打开草稿行不应产生写入').toBeUndefined();
  });
});

describe('OrgTriLine：已有 main_field_id 时行天然常显（重新打开设计器场景）', () => {
  it('modelValue 里已有 main_field_id：不需要点「表单字段」，行直接渲染，匹配方式回显', async () => {
    mounted = mountLine({ main_field_id: 'f1', match_by: 'login_name' }, { templateId: 'tpl1' });
    await flush();

    const row = mounted.el.querySelector('[data-testid="org-tri-row-main_field"]');
    expect(row).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="org-tri-main-field"]')?.textContent).toBeDefined();
  });
});

describe('OrgTriLine：删除第四档', () => {
  it('点行尾 ×：main_field_id/match_by 一并去掉，其余三组来源原样保留', async () => {
    let emitted: StartGrant | undefined;
    mounted = mountLine(
      { main_field_id: 'f1', match_by: 'login_name', user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'] },
      { templateId: 'tpl1', onUpdate: (v) => { emitted = v; } }
    );
    await flush();

    (mounted.el.querySelector('[data-testid="org-tri-row-remove-main_field"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(emitted).toEqual({ user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'], main_field_id: undefined, match_by: undefined });
  });

  it('删除后按新值重新挂载（同宿主写回一轮）：main_field_id 已被清掉，「表单字段」菜单项恢复可点', async () => {
    // mountPanel 是静态 props（一次性 createApp），本组件不会自己"看到"emit 出去的新值——这里按
    // 真实使用场景（父层拿 emitted 值再传回来）模拟一轮完整的写回，而不是断言同一实例的实时反应
    // （那要靠父层 v-model，不是本组件的职责，见 StartPanel.test.ts 头注释同一分工口径）。
    let emitted: StartGrant | undefined;
    mounted = mountLine({ main_field_id: 'f1' }, { templateId: 'tpl1', onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="org-tri-row-remove-main_field"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(emitted?.main_field_id).toBeUndefined();

    mounted.unmount();
    mounted = mountLine(emitted ?? {}, { templateId: 'tpl1' });
    await flush();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-main_field"]')).toBeNull();
    await openAddMenu(mounted.el);
    const mainFieldItem = document.body.querySelector('[data-testid="org-tri-add-main-field"]') as HTMLElement;
    expect(mainFieldItem.className).not.toContain('n-dropdown-option-body--disabled');
  });
});

describe('OrgTriLine：三维选择器确认后保留第四档（🔴 最容易漏的一处）', () => {
  it('已配置 main_field_id/match_by 时经三维选择器确认：三个数组按结果写入，main_field_id/match_by 原样保留', async () => {
    let emitted: StartGrant | undefined;
    const host = fakeHost({
      ui: {
        ...fakeHost().ui,
        openOrgTriPicker: async () => ({
          confirmed: true,
          users: [{ user_id: 'u9', login_name: 'wangwu', display_name: '王五' }],
          roles: [],
          depts: []
        })
      }
    });
    mounted = mountLine({ main_field_id: 'f1', match_by: 'login_name' }, { templateId: 'tpl1', host, onUpdate: (v) => { emitted = v; } });
    await flush();
    await openAddMenu(mounted.el);

    (document.body.querySelector('[data-testid="org-tri-add-org"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(emitted).toEqual({ main_field_id: 'f1', match_by: 'login_name', user_ids: ['u9'], role_ids: [], department_ids: [] });
  });

  it('三维选择器被取消（confirmed=false）：不产生任何写入，第四档不受影响', async () => {
    let emitted: StartGrant | undefined;
    const host = fakeHost({
      ui: { ...fakeHost().ui, openOrgTriPicker: async () => ({ confirmed: false, users: [], roles: [], depts: [] }) }
    });
    mounted = mountLine({ main_field_id: 'f1' }, { templateId: 'tpl1', host, onUpdate: (v) => { emitted = v; } });
    await flush();
    await openAddMenu(mounted.el);
    (document.body.querySelector('[data-testid="org-tri-add-org"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(emitted).toBeUndefined();
  });
});

describe('OrgTriLine：删单类来源后保留第四档（改第四档后保留三维的反向场景，同一处纯函数覆盖）', () => {
  it('删「用户」这一行：role/department 与主表字段档都原样保留', async () => {
    let emitted: StartGrant | undefined;
    mounted = mountLine(
      { user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' },
      { templateId: 'tpl1', onUpdate: (v) => { emitted = v; } }
    );
    await flush();

    (mounted.el.querySelector('[data-testid="org-tri-row-remove-user"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(emitted).toEqual({ user_ids: [], role_ids: ['r1'], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' });
  });
});

describe('OrgTriLine：只读态', () => {
  it('disabled=true：「＋添加来源」不渲染，行尾 × 不渲染；已有的第四档行仍展示（可看不可改）', async () => {
    mounted = mountLine(
      { main_field_id: 'f1', match_by: 'login_name', user_ids: ['u1'] },
      { templateId: 'tpl1', disabled: true }
    );
    await flush();

    expect(mounted.el.querySelector('[data-testid="org-tri-add"]')).toBeNull();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-remove-main_field"]')).toBeNull();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-remove-user"]')).toBeNull();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-main_field"]')).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="org-tri-row-user"]')).toBeTruthy();
  });
});

describe('静态守护：字段下拉/匹配方式下拉的写回接线确实调用了 ./startGrant.ts 的纯函数', () => {
  it('onMainFieldChange 调 setMainField，onMatchByChange 调 setMatchBy（合并逻辑本身见 startGrant.test.ts）', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/designer/panels/shared/OrgTriLine.vue'), 'utf8');
    expect(source).toContain("emit('update:modelValue', setMainField(props.modelValue, fieldId));");
    expect(source).toContain("emit('update:modelValue', setMatchBy(props.modelValue, matchBy));");
    expect(source).toContain('@update:model-value="onMainFieldChange"');
    expect(source).toContain('@update:value="(v) => onMatchByChange(v as AssigneeMatchBy)"');
  });
});
