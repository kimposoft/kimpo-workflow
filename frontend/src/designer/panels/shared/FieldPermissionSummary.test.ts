/**
 * designer/panels/shared/FieldPermissionSummary.test.ts —— 字段权限摘要 + 设置入口单测。
 *
 * 「计数正确 + 参数占位真的被替换」三条用例用轻量 mount() 手法：只
 * provide DESIGNER_I18N_KEY，不 provide DESIGNER_STATE_KEY——本组件对 state 缺席做了 `state?.`
 * 全程可选链兜底，不会因此报错，只是"设置字段权限"按钮会因为取不到目标模板而置灰，不影响这三条
 * 用例原本要断言的文案/计数）。
 *
 * 其余用例用 ../panel-test-helpers.ts 的 mountPanel/fakeHost/fakeState（同 ApprovePanel.test.ts
 * 既定手法）：需要一份带发起节点 target_template_id 的真实文档，才能让"设置字段权限"按钮可点、
 * 对话框内部 useTemplateFieldCatalog 取到字段目录。
 *
 * 字段权限对话框是 KDialog（NModal 传送到 document.body），对话框内的节点从 document.body 查询；
 * 页脚按钮用 KDialogFooter 的 data-kdlf="confirm|cancel" 定位。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createDefaultDocument } from '../../../model/defaults';
import type { FieldPermission, StartConfig } from '../../../model';
import FieldPermissionSummary from './FieldPermissionSummary.vue';
import { DESIGNER_I18N_KEY } from '../../host';
import { createDesignerI18n } from '../../i18n';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

let app: App | undefined;
let el: HTMLElement | undefined;

afterEach(() => {
  app?.unmount();
  el?.remove();
  app = undefined;
  el = undefined;
});

function mount(modelValue: Array<{ table_id: string; field_id: string; grade: string }> | undefined): HTMLElement {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(FieldPermissionSummary, { modelValue });
  app.provide(DESIGNER_I18N_KEY, createDesignerI18n());
  app.mount(el);
  return el;
}

describe('FieldPermissionSummary：计数', () => {
  it('未配置（undefined）：显示"继承模板"', () => {
    const host = mount(undefined);
    expect(host.textContent).toContain('继承模板');
  });

  it('空数组：同样显示"继承模板"（长度 0 与未配置同义）', () => {
    const host = mount([]);
    expect(host.textContent).toContain('继承模板');
  });

  it('有 3 条：显示"已单独设置 3 项"，占位符真的被替换成 3', () => {
    const host = mount([
      { table_id: 't1', field_id: 'f1', grade: 'edit' },
      { table_id: 't1', field_id: 'f2', grade: 'readonly' },
      { table_id: 't1', field_id: 'f3', grade: 'hidden' }
    ] as never);
    expect(host.textContent).toContain('已单独设置 3 项');
    expect(host.textContent).not.toContain('{n}');
  });
});

// ── 按钮/分档小计/取不到模板置灰/打开·确定·取消·回写 ──────────────────────────────────────

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 一份带目标表单的文档（同 ApprovePanel.test.ts buildDocWithApproveNode 既定手法），
 *  hasTargetTemplate=false 时发起节点 target_template_id 留空，供"未选目标表单"用例复用。 */
function buildDocWithTemplate(hasTargetTemplate = true) {
  const doc = createDefaultDocument('测试流程');
  const startNode = doc.nodes.find((n) => n.kind === 'start')!;
  startNode.config = {
    target_template_id: hasTargetTemplate ? 'tpl_x' : '',
    allow_manual_start: true,
    no_route_hint: '',
    start_permission: {}
  } satisfies StartConfig;
  return doc;
}

let mounted: MountedPanel<typeof FieldPermissionSummary> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('FieldPermissionSummary：分档小计', () => {
  it('可编辑型：三档全给出（只读/隐藏/可编辑）', () => {
    const el2 = mount([
      { table_id: 't1', field_id: 'f1', grade: 'edit' },
      { table_id: 't1', field_id: 'f2', grade: 'edit' },
      { table_id: 't1', field_id: 'f3', grade: 'readonly' },
      { table_id: 't1', field_id: 'f4', grade: 'hidden' }
    ] as never);
    expect(el2.textContent).toContain('只读 1');
    expect(el2.textContent).toContain('隐藏 1');
    expect(el2.textContent).toContain('可编辑 2');
  });

  it('零项时保持"继承模板"原文案，不出现分档小计', () => {
    const el2 = mount([]);
    expect(el2.textContent).toContain('继承模板');
    expect(el2.textContent).not.toContain('只读');
  });
});

describe('FieldPermissionSummary：按钮 + 目标模板置灰', () => {
  it('还没有选目标表单时，"设置字段权限"按钮置灰', async () => {
    const doc = buildDocWithTemplate(false);
    mounted = mountPanel(FieldPermissionSummary, { modelValue: [] }, { host: fakeHost(), state: fakeState(doc), i18n: fakeI18n() });
    await flush();
    const btn = mounted.el.querySelector('[data-testid="fp-summary-open"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('已选目标表单时，按钮可点，点击后打开对话框', async () => {
    const doc = buildDocWithTemplate(true);
    const host = fakeHost({
      listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
      listTemplateFields: async () => ({ data: { items: [{ field_id: 'f1', field_name: '姓名', data_type: 'text' }] } })
    });
    mounted = mountPanel(FieldPermissionSummary, { modelValue: [] }, { host, state: fakeState(doc), i18n: fakeI18n() });
    await flush();
    const btn = mounted.el.querySelector('[data-testid="fp-summary-open"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(document.body.querySelector('[data-testid="fpd-root"]')).toBeFalsy();

    btn.click();
    await flush();
    expect(document.body.querySelector('[data-testid="fpd-root"]')).toBeTruthy();
  });
});

describe('FieldPermissionSummary：对话框确定回写 update:modelValue', () => {
  it('打开 → 设一个字段为只读 → 确定：emit update:modelValue 带出新清单，对话框关闭', async () => {
    const doc = buildDocWithTemplate(true);
    const host = fakeHost({
      listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
      listTemplateFields: async () => ({ data: { items: [{ field_id: 'f1', field_name: '姓名', data_type: 'text' }] } })
    });
    let emitted: FieldPermission[] | undefined;
    mounted = mountPanel(
      FieldPermissionSummary,
      { modelValue: [], 'onUpdate:modelValue': (v: FieldPermission[]) => { emitted = v; } },
      { host, state: fakeState(doc), i18n: fakeI18n() }
    );
    await flush();
    (mounted.el.querySelector('[data-testid="fp-summary-open"]') as HTMLButtonElement).click();
    await flush(12);

    const radio = document.body.querySelector('[data-testid="fpd-grade-f1-readonly"] input[type="radio"]') as HTMLInputElement;
    expect(radio).toBeTruthy();
    radio.click();
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    (document.body.querySelector('[data-kdlf="confirm"]') as HTMLButtonElement).click();
    await flush();

    expect(emitted).toEqual([{ table_id: 'dt1', field_id: 'f1', grade: 'readonly' }]);
    expect(document.body.querySelector('[data-testid="fpd-root"]')).toBeFalsy();
  });

  it('取消：不 emit update:modelValue，对话框关闭', async () => {
    const doc = buildDocWithTemplate(true);
    const host = fakeHost({
      listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
      listTemplateFields: async () => ({ data: { items: [{ field_id: 'f1', field_name: '姓名', data_type: 'text' }] } })
    });
    let emitted: FieldPermission[] | undefined;
    mounted = mountPanel(
      FieldPermissionSummary,
      { modelValue: [], 'onUpdate:modelValue': (v: FieldPermission[]) => { emitted = v; } },
      { host, state: fakeState(doc), i18n: fakeI18n() }
    );
    await flush();
    (mounted.el.querySelector('[data-testid="fp-summary-open"]') as HTMLButtonElement).click();
    await flush(12);
    (document.body.querySelector('[data-kdlf="cancel"]') as HTMLButtonElement).click();
    await flush();
    expect(emitted).toBeUndefined();
    expect(document.body.querySelector('[data-testid="fpd-root"]')).toBeFalsy();
  });
});

describe('FieldPermissionSummary：父层未监听 update:modelValue 时不报错（向后兼容 HandlePanel/CcPanel 暂未接线）', () => {
  it('不传 onUpdate:modelValue，点击打开、点击确定全程不抛异常，按钮仍正常显示', async () => {
    const doc = buildDocWithTemplate(true);
    const host = fakeHost({
      listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
      listTemplateFields: async () => ({ data: { items: [{ field_id: 'f1', field_name: '姓名', data_type: 'text' }] } })
    });
    mounted = mountPanel(FieldPermissionSummary, { modelValue: [] }, { host, state: fakeState(doc), i18n: fakeI18n() });
    await flush();
    expect(() => (mounted!.el.querySelector('[data-testid="fp-summary-open"]') as HTMLButtonElement).click()).not.toThrow();
    await flush(12);
    expect(document.body.querySelector('[data-kdlf="confirm"]')).toBeTruthy();
    expect(() => (document.body.querySelector('[data-kdlf="confirm"]') as HTMLButtonElement).click()).not.toThrow();
  });
});

describe('FieldPermissionSummary：disabled 透传', () => {
  it('disabled 时对话框内确定按钮不渲染（只看不改）', async () => {
    const doc = buildDocWithTemplate(true);
    const host = fakeHost({
      listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
      listTemplateFields: async () => ({ data: { items: [{ field_id: 'f1', field_name: '姓名', data_type: 'text' }] } })
    });
    mounted = mountPanel(FieldPermissionSummary, { modelValue: [], disabled: true }, { host, state: fakeState(doc), i18n: fakeI18n() });
    await flush();
    (mounted.el.querySelector('[data-testid="fp-summary-open"]') as HTMLButtonElement).click();
    await flush(12);
    expect(document.body.querySelector('[data-kdlf="confirm"]')).toBeFalsy();
    expect(document.body.querySelector('[data-kdlf="cancel"]')).toBeTruthy();
  });
});
