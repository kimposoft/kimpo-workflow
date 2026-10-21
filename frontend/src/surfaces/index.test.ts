/**
 * surfaces/index.test.ts —— createSurface('workflow-designer') 分发逻辑单测：四项必需能力齐全时正确挂载 DesignerRoot 并透传 props；任一必需能力缺失时显式抛错；
 * 未声明的 surfaceType 显式抛错。不涉及真实挂载/渲染，只调用 createSurface 本身。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SurfaceCreateInput } from '@kimposoft/plugin-sdk/surface';
import DesignerRoot from '../designer/DesignerRoot.vue';
import { createSurface } from './index';

function baseHostBridge() {
  return {
    interactiveSession: { markDirty: vi.fn(), snapshot: {}, onChange: vi.fn(), requestEdit: vi.fn(), adminRelease: vi.fn(), close: vi.fn() },
    'domain:workflow-designer': { getDefinition: vi.fn() },
    'domain:alice-v4': vi.fn(),
    'domain:expression': vi.fn(),
    i18n: undefined
  };
}

function baseInput(overrides: Partial<SurfaceCreateInput> = {}): SurfaceCreateInput {
  return {
    surfaceType: 'workflow-designer',
    hostCaps: [],
    hostContext: { appId: 'app-1', definitionId: 'def-1', readOnly: false },
    runtime: {},
    props: {},
    hostBridge: baseHostBridge(),
    ...overrides
  };
}

describe("createSurface('workflow-designer')", () => {
  it('四项必需能力齐全时挂载 DesignerRoot，并透传 host/i18n/readOnly 三个 props', () => {
    const result = createSurface(baseInput());
    expect(result.component).toBe(DesignerRoot);
    expect(result.props?.host).toBeDefined();
    expect(typeof (result.props?.host as { getDefinition?: unknown })?.getDefinition).toBe('function');
    // ui/aliceV4/expression 也应该在组装出的 host 上（见 host.ts createDesignerHost）。
    expect(typeof (result.props?.host as { ui?: unknown })?.ui).toBe('object');
    expect(typeof (result.props?.host as { aliceV4?: unknown })?.aliceV4).toBe('function');
    expect(typeof (result.props?.host as { expression?: unknown })?.expression).toBe('function');
    expect(result.props?.i18n).toBeDefined();
    expect(result.props?.readOnly).toBe(false);
  });

  it('hostContext.readOnly=true 时原样透传 true', () => {
    const result = createSurface(baseInput({ hostContext: { appId: 'a', definitionId: 'd', readOnly: true } }));
    expect(result.props?.readOnly).toBe(true);
  });

  it('hostContext.readOnly 缺省时透传 false（不是 undefined）', () => {
    const result = createSurface(baseInput({ hostContext: { appId: 'a', definitionId: 'd' } }));
    expect(result.props?.readOnly).toBe(false);
  });

  const requiredKeys = ['interactiveSession', 'domain:workflow-designer', 'domain:alice-v4', 'domain:expression'] as const;
  for (const key of requiredKeys) {
    it(`缺 hostBridge['${key}'] 时显式抛错，不静默降级`, () => {
      const hostBridge = baseHostBridge() as Record<string, unknown>;
      delete hostBridge[key];
      expect(() => createSurface(baseInput({ hostBridge }))).toThrow();
    });
  }

  it('i18n 缺省（老宿主未注入 HostI18n）时不抛错，仍能挂载（createDesignerI18n 纯本地链兜底）', () => {
    const hostBridge = baseHostBridge() as Record<string, unknown>;
    delete hostBridge.i18n;
    expect(() => createSurface(baseInput({ hostBridge }))).not.toThrow();
  });

  it('未声明的 surfaceType 显式抛错', () => {
    expect(() => createSurface(baseInput({ surfaceType: 'designer' as SurfaceCreateInput['surfaceType'] }))).toThrow();
  });
});
