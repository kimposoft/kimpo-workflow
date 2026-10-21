// model/node-naming.test.ts —— "类型名 + 序号" 默认命名规则纯函数单测。
// 覆盖 nodeTypeLabel/nextOrdinalForKind/typeOrdinalName/defaultNameForNodeAt 四个纯
// 函数各自的行为，以及"没有注入 i18n 时退回 zh-CN"这条既有约束。
import { describe, expect, it } from 'vitest';
import type { WorkflowNode } from './document';
import { defaultNameForNodeAt, nextOrdinalForKind, nodeTypeLabel, typeOrdinalName } from './node-naming';

function node(id: string, kind: WorkflowNode['kind'], name?: string): WorkflowNode {
  return { id, kind, name, config: {} };
}

describe('nodeTypeLabel', () => {
  it('没有 i18n 时退回 zh-CN 文案', () => {
    expect(nodeTypeLabel(undefined, 'handle')).toBe('办理');
    expect(nodeTypeLabel(undefined, 'approve')).toBe('审批');
    expect(nodeTypeLabel(undefined, 'cc')).toBe('抄送');
    expect(nodeTypeLabel(undefined, 'subflow')).toBe('子流程');
    expect(nodeTypeLabel(undefined, 'start')).toBe('发起');
    expect(nodeTypeLabel(undefined, 'end')).toBe('结束');
  });

  it('注入 i18n 时按其 .t() 生成（不是恒定 zh-CN）', () => {
    const fakeI18n = { t: (key: string) => `[EN]${key}` };
    expect(nodeTypeLabel(fakeI18n, 'handle')).toBe('[EN]workflow.designer.node.handle');
  });
});

describe('nextOrdinalForKind', () => {
  it('空数组：序号为 1', () => {
    expect(nextOrdinalForKind([], 'handle')).toBe(1);
  });

  it('按类型分别计数，不跨类型累加', () => {
    const nodes = [node('s', 'start'), node('h1', 'handle'), node('a1', 'approve')];
    expect(nextOrdinalForKind(nodes, 'handle')).toBe(2);
    expect(nextOrdinalForKind(nodes, 'approve')).toBe(2);
    expect(nextOrdinalForKind(nodes, 'cc')).toBe(1);
  });

  it('已有 2 个同类型节点时序号为 3', () => {
    const nodes = [node('h1', 'handle'), node('h2', 'handle')];
    expect(nextOrdinalForKind(nodes, 'handle')).toBe(3);
  });
});

describe('typeOrdinalName', () => {
  it('拼接"类型名 + 空格 + 序号"', () => {
    expect(typeOrdinalName(undefined, 'handle', 1)).toBe('办理 1');
    expect(typeOrdinalName(undefined, 'approve', 2)).toBe('审批 2');
  });
});

describe('defaultNameForNodeAt', () => {
  it('发起节点恒不带序号（全图唯一，对齐 createDefaultStartNode）', () => {
    const nodes = [node('s', 'start'), node('h1', 'handle'), node('e1', 'end')];
    expect(defaultNameForNodeAt(nodes, 's', undefined)).toBe('发起');
  });

  it('唯一/第一个结束节点（序号 1）不带序号，对齐 e2e 校准夹具字面值"结束"', () => {
    const nodes = [node('s', 'start'), node('e1', 'end')];
    expect(defaultNameForNodeAt(nodes, 'e1', undefined)).toBe('结束');
  });

  it('第二个结束节点（序号 2）按通用"类型名+序号"规则', () => {
    const nodes = [node('s', 'start'), node('e1', 'end'), node('e2', 'end')];
    expect(defaultNameForNodeAt(nodes, 'e2', undefined)).toBe('结束 2');
  });

  it('可重复节点（办理/审批/抄送/子流程）按数组位置从 1 计数', () => {
    const nodes = [node('s', 'start'), node('h1', 'handle'), node('h2', 'handle'), node('e1', 'end')];
    expect(defaultNameForNodeAt(nodes, 'h1', undefined)).toBe('办理 1');
    expect(defaultNameForNodeAt(nodes, 'h2', undefined)).toBe('办理 2');
  });

  it('节点 id 不存在时返回 undefined（防御性兜底）', () => {
    const nodes = [node('s', 'start')];
    expect(defaultNameForNodeAt(nodes, 'not-exist', undefined)).toBeUndefined();
  });

  it('已被冻结的旧序号不影响新计算：删除靠前节点后，剩余节点的"当前默认名"按新位置重算', () => {
    // 对齐 toGraphNodes() 的既有语义：这是"重新算一次默认名"这个纯函数本身的行为，不代表
    // WorkflowDocumentState 会自动帮已存在节点改名——调用方（各 *Panel.vue 的 onNameBlur）只在
    // 设计者主动清空名称、失焦这一刻才会调用它。
    const afterDeleteFirstHandle = [node('s', 'start'), node('h2', 'handle', '办理 2'), node('e1', 'end')];
    expect(defaultNameForNodeAt(afterDeleteFirstHandle, 'h2', undefined)).toBe('办理 1');
  });
});
