// designer/stencil/index.test.ts —— STENCIL_ITEMS 由节点类型注册表派生的形状单测：只列 canAddFromStencil
// 的类型、NODE_TYPE_LABELS 仍覆盖全部 NodeKind、createHandleNodeAt/createEndNodeAt 的默认配置
// 与 registry 保持同一份数据源。
import { describe, expect, it } from 'vitest';
import { getNodeTypeDefinition } from '../nodes/registry';
import { createEndNodeAt, createHandleNodeAt, NODE_TYPE_LABELS, STENCIL_ITEMS } from './index';

describe('STENCIL_ITEMS：由节点类型注册表派生', () => {
  it('包含 approve/cc/end/handle/subflow 五项（start 的 canAddFromStencil===false，不在目录里）', () => {
    const keys = STENCIL_ITEMS.map((item) => item.key).sort();
    expect(keys).toEqual(['approve', 'cc', 'end', 'handle', 'subflow']);
  });

  it('每一项都带有分组信息（human/aux/control），不出现未分组条目', () => {
    for (const item of STENCIL_ITEMS) {
      expect(item.group).toBeTruthy();
    }
  });

  it('approve 归入 human 组，cc/subflow 归入新增的 aux（辅助节点）组', () => {
    const byKey = Object.fromEntries(STENCIL_ITEMS.map((item) => [item.key, item.group]));
    expect(byKey.approve).toBe('human');
    expect(byKey.cc).toBe('aux');
    expect(byKey.subflow).toBe('aux');
  });
});

describe('NODE_TYPE_LABELS：覆盖全部 NodeKind', () => {
  it('包含全部六类节点', () => {
    const kinds = Object.keys(NODE_TYPE_LABELS).sort();
    expect(kinds).toEqual(['approve', 'cc', 'end', 'handle', 'start', 'subflow']);
  });
});

describe('createHandleNodeAt / createEndNodeAt：默认配置与 registry 同源', () => {
  it('createHandleNodeAt 的 config 与 handle 类型定义的 createDefaultConfig() 逐字段相同', () => {
    const { node } = createHandleNodeAt(0);
    expect(node.config).toEqual(getNodeTypeDefinition('handle')!.createDefaultConfig());
    expect(node.kind).toBe('handle');
    expect(node.name).toBeUndefined();
  });

  it('createEndNodeAt 的 config 与 end 类型定义的 createDefaultConfig() 逐字段相同', () => {
    const { node } = createEndNodeAt(0);
    expect(node.config).toEqual(getNodeTypeDefinition('end')!.createDefaultConfig());
    expect(node.kind).toBe('end');
  });

  it('位置按 index 递增偏移，互不重叠', () => {
    const first = createHandleNodeAt(0).position;
    const second = createHandleNodeAt(1).position;
    expect(second.y).toBeGreaterThan(first.y);
  });
});
