/**
 * host.test.ts —— createDesignerHost 组装 + 三个 provide/inject 注入键的最小单测。
 * 纯 TS 对象拼装，不涉及 Vue 挂载。
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostUi, InteractiveSessionHandle } from '@kimposoft/plugin-sdk';
import { createDesignerHost, DESIGNER_HOST_KEY, DESIGNER_I18N_KEY, DESIGNER_STATE_KEY, type WorkflowDesignerHostApi } from './host';

function fakeHostApi(): WorkflowDesignerHostApi {
  return {
    getDefinition: vi.fn(),
    saveDraft: vi.fn(),
    validate: vi.fn(),
    publish: vi.fn(),
    setEnabled: vi.fn(),
    listAppTemplates: vi.fn(),
    getTemplate: vi.fn(),
    listTemplateTables: vi.fn(),
    listTemplateFields: vi.fn()
  } as unknown as WorkflowDesignerHostApi;
}

describe('createDesignerHost', () => {
  it('原样铺开 hostApi 的全部设计面方法，并叠加 ui/interactiveSession/aliceV4/expression 四项', () => {
    const hostApi = fakeHostApi();
    const ui = { has: vi.fn() } as unknown as HostUi;
    const interactiveSession = { markDirty: vi.fn() } as unknown as InteractiveSessionHandle;
    const aliceV4 = vi.fn();
    const expression = vi.fn();

    const host = createDesignerHost({ hostApi, appId: 'app_test', definitionId: 'def_test', ui, interactiveSession, aliceV4, expression });

    // 设计面方法：同一引用，不是重新包一层——host.ts 头注释"单纯的对象拼装，不做任何裁剪/取用判断"。
    expect(host.getDefinition).toBe(hostApi.getDefinition);
    expect(host.saveDraft).toBe(hostApi.saveDraft);
    expect(host.validate).toBe(hostApi.validate);
    expect(host.publish).toBe(hostApi.publish);
    expect(host.setEnabled).toBe(hostApi.setEnabled);
    expect(host.listAppTemplates).toBe(hostApi.listAppTemplates);
    expect(host.getTemplate).toBe(hostApi.getTemplate);
    expect(host.listTemplateTables).toBe(hostApi.listTemplateTables);
    expect(host.listTemplateFields).toBe(hostApi.listTemplateFields);

    // 叠加的四项 + appId + definitionId（见 host.ts DesignerHost.definitionId 注释）。
    expect(host.appId).toBe('app_test');
    expect(host.definitionId).toBe('def_test');
    expect(host.ui).toBe(ui);
    expect(host.interactiveSession).toBe(interactiveSession);
    expect(host.aliceV4).toBe(aliceV4);
    expect(host.expression).toBe(expression);
  });

  it('不传 definitionId 时落 undefined（老宿主 hostContext 不带这个键的场景，不强行落空串）', () => {
    const hostApi = fakeHostApi();
    const ui = { has: vi.fn() } as unknown as HostUi;
    const interactiveSession = { markDirty: vi.fn() } as unknown as InteractiveSessionHandle;
    const host = createDesignerHost({ hostApi, appId: 'app_test', ui, interactiveSession, aliceV4: vi.fn(), expression: vi.fn() });
    expect(host.definitionId).toBeUndefined();
  });
});

describe('provide/inject 注入键', () => {
  it('DESIGNER_HOST_KEY / DESIGNER_STATE_KEY / DESIGNER_I18N_KEY 是三个互不相同的 symbol', () => {
    expect(typeof DESIGNER_HOST_KEY).toBe('symbol');
    expect(typeof DESIGNER_STATE_KEY).toBe('symbol');
    expect(typeof DESIGNER_I18N_KEY).toBe('symbol');
    const keys = new Set<symbol>([DESIGNER_HOST_KEY as symbol, DESIGNER_STATE_KEY as symbol, DESIGNER_I18N_KEY as symbol]);
    expect(keys.size).toBe(3);
  });
});
