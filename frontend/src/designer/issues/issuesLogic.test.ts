/**
 * designer/issues/issuesLogic.test.ts —— issuesLogic.ts 纯函数单测。
 */
import { describe, expect, it } from 'vitest';
import type { GroupedIssues, MappedIssue } from '../../model/validate-map';
import { cycleCursor, flattenGroupedIssues, issueCountOf, issueTargetOf } from './issuesLogic';

function issue(partial: Partial<MappedIssue>): MappedIssue {
  return { textKey: 'workflow.designer.issue.unknown', ...partial };
}

describe('flattenGroupedIssues', () => {
  it('按节点 → 连线 → 全局的顺序展平，组内保持原有顺序', () => {
    const n1a = issue({ nodeId: 'n1', textKey: 'a' });
    const n1b = issue({ nodeId: 'n1', textKey: 'b' });
    const n2a = issue({ nodeId: 'n2', textKey: 'c' });
    const l1a = issue({ linkId: 'l1', textKey: 'd' });
    const g1 = issue({ textKey: 'e' });
    const grouped: GroupedIssues = {
      byNode: { n1: [n1a, n1b], n2: [n2a] },
      byLink: { l1: [l1a] },
      global: [g1]
    };
    expect(flattenGroupedIssues(grouped)).toEqual([n1a, n1b, n2a, l1a, g1]);
  });

  it('空分组返回空清单', () => {
    expect(flattenGroupedIssues({ byNode: {}, byLink: {}, global: [] })).toEqual([]);
  });
});

describe('issueCountOf', () => {
  it('节点 id 命中 byNode 时返回该组条数', () => {
    const grouped: GroupedIssues = { byNode: { n1: [issue({}), issue({})] }, byLink: {}, global: [] };
    expect(issueCountOf(grouped, 'n1')).toBe(2);
  });
  it('连线 id 命中 byLink 时返回该组条数', () => {
    const grouped: GroupedIssues = { byNode: {}, byLink: { l1: [issue({})] }, global: [] };
    expect(issueCountOf(grouped, 'l1')).toBe(1);
  });
  it('未命中任何分组时返回 0（不是 undefined，调用方不用再做一次判空）', () => {
    const grouped: GroupedIssues = { byNode: {}, byLink: {}, global: [] };
    expect(issueCountOf(grouped, 'missing')).toBe(0);
  });
});

describe('issueTargetOf', () => {
  it('挂节点的问题返回 { nodeId }', () => {
    expect(issueTargetOf(issue({ nodeId: 'n1' }))).toEqual({ nodeId: 'n1' });
  });
  it('挂连线的问题返回 { linkId }', () => {
    expect(issueTargetOf(issue({ linkId: 'l1' }))).toEqual({ linkId: 'l1' });
  });
  it('两者皆无（文档级全局问题）返回 undefined，调用方据此不触发定位', () => {
    expect(issueTargetOf(issue({}))).toBeUndefined();
  });

  // 属性面板分区（tab）透传，供"定位到节点后再切到对应分区"用。
  it('挂节点且登记了分区的问题：tab 随 target 一起透传', () => {
    expect(issueTargetOf(issue({ nodeId: 'n1', tab: 'approveRule' }))).toEqual({ nodeId: 'n1', tab: 'approveRule' });
  });
  it('挂节点但未登记分区的问题：tab 为 undefined（不瞎跳分区）', () => {
    expect(issueTargetOf(issue({ nodeId: 'n1' }))).toEqual({ nodeId: 'n1', tab: undefined });
  });
  it('挂连线的问题不带 tab（连线没有属性面板分区）', () => {
    expect(issueTargetOf(issue({ linkId: 'l1', tab: 'basic' }))).toEqual({ linkId: 'l1' });
  });
});

describe('cycleCursor', () => {
  it('清单为空（length<=0）恒返回 -1', () => {
    expect(cycleCursor(-1, 0, 1)).toBe(-1);
    expect(cycleCursor(0, 0, -1)).toBe(-1);
  });
  it('尚未选中任何一条（current=-1）：next 从第 0 条开始', () => {
    expect(cycleCursor(-1, 3, 1)).toBe(0);
  });
  it('尚未选中任何一条（current=-1）：prev 从最后一条开始', () => {
    expect(cycleCursor(-1, 3, -1)).toBe(2);
  });
  it('末尾再 next 回卷到第 0 条', () => {
    expect(cycleCursor(2, 3, 1)).toBe(0);
  });
  it('第 0 条再 prev 回卷到最后一条', () => {
    expect(cycleCursor(0, 3, -1)).toBe(2);
  });
  it('中间正常前进/后退', () => {
    expect(cycleCursor(1, 3, 1)).toBe(2);
    expect(cycleCursor(1, 3, -1)).toBe(0);
  });
  it('current 越界（清单变短后残留的旧游标）按"未选中"处理', () => {
    expect(cycleCursor(5, 3, 1)).toBe(0);
    expect(cycleCursor(5, 3, -1)).toBe(2);
  });
});
