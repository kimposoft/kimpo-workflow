// engine-capabilities.test.ts —— 按绑定引擎能力收窄设计器。
import { describe, expect, it } from 'vitest';
import { NO_ENGINE_RESTRICTIONS, loadEngineRestrictions, resolveEngineRestrictions } from './engine-capabilities';
import type { WorkflowEngineInfo } from './host';

const officialInfo: WorkflowEngineInfo = {
  enginePluginId: 'com.kimposoft.workflow',
  displayName: '流程引擎',
  available: true,
  documentSchemas: ['workflow/1'],
  nodeKinds: ['START', 'HANDLE', 'APPROVE', 'CC', 'SUBFLOW', 'END'],
  features: ['withdraw', 'back', 'resume_incident', 'subflow', 'auto_handle', 'ratio_pass']
};

describe('resolveEngineRestrictions', () => {
  it('官方引擎声明全部节点与能力：不禁用任何节点、可编辑', () => {
    expect(resolveEngineRestrictions(officialInfo)).toEqual({ unavailable: false, unsupportedKinds: [], displayName: '流程引擎' });
  });

  it('最小引擎（START / APPROVE / END）：办理、抄送、子流程被禁用', () => {
    const r = resolveEngineRestrictions({ ...officialInfo, nodeKinds: ['START', 'APPROVE', 'END'], features: [] });
    expect(r.unsupportedKinds).toEqual(['handle', 'cc', 'subflow']);
    expect(r.unavailable).toBe(false);
  });

  it('声明了 SUBFLOW 节点但没声明 subflow 能力：子流程仍视为不支持', () => {
    const r = resolveEngineRestrictions({ ...officialInfo, features: ['withdraw', 'back'] });
    expect(r.unsupportedKinds).toEqual(['subflow']);
  });

  it('引擎不可用：只读', () => {
    expect(resolveEngineRestrictions({ ...officialInfo, available: false }).unavailable).toBe(true);
  });

  it('取不到引擎信息：不限制', () => {
    expect(resolveEngineRestrictions(undefined)).toBe(NO_ENGINE_RESTRICTIONS);
    expect(resolveEngineRestrictions(null)).toBe(NO_ENGINE_RESTRICTIONS);
  });
});

describe('loadEngineRestrictions', () => {
  it('旧宿主没有 getEngineInfo：不限制', async () => {
    await expect(loadEngineRestrictions({})).resolves.toBe(NO_ENGINE_RESTRICTIONS);
  });

  it('宿主返回错误或抛错：不限制（不因查询失败锁死设计器）', async () => {
    await expect(loadEngineRestrictions({ getEngineInfo: async () => ({ error: { code: 'X', message: 'boom' } }) })).resolves.toBe(NO_ENGINE_RESTRICTIONS);
    await expect(
      loadEngineRestrictions({
        getEngineInfo: async () => {
          throw new Error('network');
        }
      })
    ).resolves.toBe(NO_ENGINE_RESTRICTIONS);
  });

  it('宿主返回引擎能力：按声明收窄', async () => {
    const r = await loadEngineRestrictions({ getEngineInfo: async () => ({ data: { ...officialInfo, nodeKinds: ['START', 'END'], available: false } }) });
    expect(r.unavailable).toBe(true);
    expect(r.unsupportedKinds).toEqual(['handle', 'approve', 'cc', 'subflow']);
  });
});
