// panels/shared/relationFilters.test.ts —— 『与上步处理人的关系』过滤器纯函数单测。
// 覆盖 normalizeRelationConfig 的全部分支
// （抽取/去重/保序/幂等/不改入参/畸形条目不丢）与 toggleRelationFilter/isRelationFilterChecked
// 的薄逻辑层。
import { describe, expect, it } from 'vitest';
import {
  RELATION_OPTIONS,
  isRelationFilterChecked,
  normalizeRelationConfig,
  toggleRelationFilter
} from './relationFilters';
import type { AssigneeRelation, AssigneeSource } from '../../../model';

describe('RELATION_OPTIONS：直接转出 assigneeSource.ts 的同名常量，不另写一份', () => {
  it('五档固定顺序稳定', () => {
    expect(RELATION_OPTIONS).toEqual(['same_department', 'parent_department', 'child_department', 'department_manager', 'parent_department_manager']);
  });
});

describe('normalizeRelationConfig：来源里的 relation 条目摘出并入 filters', () => {
  it('来源里有一条 relation：摘出、来源清单删掉这一条、filters 收到这一档', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }, { kind: 'relation', relation: 'same_department' }];
    const { sources: nextSources, filters } = normalizeRelationConfig(sources, undefined);
    expect(nextSources).toEqual([{ kind: 'user', user_ids: ['u1'] }]);
    expect(filters).toEqual(['same_department']);
  });

  it('来源里有多条 relation：全部摘出，按来源清单里出现的顺序并入 filters', () => {
    const sources: AssigneeSource[] = [
      { kind: 'relation', relation: 'department_manager' },
      { kind: 'user', user_ids: ['u1'] },
      { kind: 'relation', relation: 'same_department' }
    ];
    const { sources: nextSources, filters } = normalizeRelationConfig(sources, undefined);
    expect(nextSources).toEqual([{ kind: 'user', user_ids: ['u1'] }]);
    expect(filters).toEqual(['department_manager', 'same_department']);
  });

  it('已有 filters 时：来源里新摘出的按"首次出现顺序"追加在已有 filters 之后，已存在的不重复加', () => {
    const sources: AssigneeSource[] = [
      { kind: 'relation', relation: 'same_department' }, // 与既有 filters 重复，不应再加一遍
      { kind: 'relation', relation: 'child_department' }
    ];
    const { filters } = normalizeRelationConfig(sources, ['same_department']);
    expect(filters).toEqual(['same_department', 'child_department']);
  });

  it('没有 relation 值的畸形来源条目：不静默丢弃，原样保留在来源清单里', () => {
    const malformed = { kind: 'relation' } as unknown as AssigneeSource;
    const sources: AssigneeSource[] = [malformed];
    const { sources: nextSources, filters } = normalizeRelationConfig(sources, undefined);
    expect(nextSources).toEqual([malformed]);
    expect(filters).toEqual([]);
  });

  it('来源里没有任何 relation 条目：sources 内容不变（幂等安全），filters 原样透传', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }, { kind: 'department', department_ids: ['d1'] }];
    const { sources: nextSources, filters } = normalizeRelationConfig(sources, ['same_department']);
    expect(nextSources).toEqual(sources);
    expect(filters).toEqual(['same_department']);
  });

  it('sources/filters 均为 undefined：返回两个空数组，不抛错', () => {
    expect(normalizeRelationConfig(undefined, undefined)).toEqual({ sources: [], filters: [] });
  });

  it('幂等：对已经是新形状的结果再调用一次，逐字段不变', () => {
    const sources: AssigneeSource[] = [
      { kind: 'user', user_ids: ['u1'] },
      { kind: 'relation', relation: 'same_department' },
      { kind: 'relation', relation: 'child_department' }
    ];
    const first = normalizeRelationConfig(sources, undefined);
    const second = normalizeRelationConfig(first.sources, first.filters);
    expect(second).toEqual(first);
  });

  it('不改入参：原始 sources/filters 数组内容不变', () => {
    const sources: AssigneeSource[] = [{ kind: 'relation', relation: 'same_department' }];
    const filtersArr: AssigneeRelation[] = ['child_department'];
    normalizeRelationConfig(sources, filtersArr);
    expect(sources).toEqual([{ kind: 'relation', relation: 'same_department' }]);
    expect(filtersArr).toEqual(['child_department']);
  });
});

describe('toggleRelationFilter：未勾选时追加、已勾选时移除', () => {
  it('未勾选时追加到末尾', () => {
    expect(toggleRelationFilter(undefined, 'same_department')).toEqual(['same_department']);
    expect(toggleRelationFilter(['child_department'], 'same_department')).toEqual(['child_department', 'same_department']);
  });

  it('已勾选时移除该档，其余保留', () => {
    expect(toggleRelationFilter(['same_department', 'child_department'], 'same_department')).toEqual(['child_department']);
  });

  it('不改入参，返回新数组', () => {
    const filters: AssigneeRelation[] = ['same_department'];
    const next = toggleRelationFilter(filters, 'child_department');
    expect(next).not.toBe(filters);
    expect(filters).toEqual(['same_department']);
  });
});

describe('isRelationFilterChecked：反映当前清单里是否已有该档', () => {
  it('命中返回 true，未命中返回 false，undefined 视为空清单', () => {
    expect(isRelationFilterChecked(['same_department'], 'same_department')).toBe(true);
    expect(isRelationFilterChecked(['same_department'], 'child_department')).toBe(false);
    expect(isRelationFilterChecked(undefined, 'same_department')).toBe(false);
  });
});
