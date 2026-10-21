// panels/shared/assigneeSource.test.ts —— 『A 人员来源』各种来源的增删改与展示文案求值单测。
// AssigneeSourceList.vue 只是这些纯函数的薄包装（事件
// 绑定/模板渲染），本文件覆盖真正的数据变换逻辑（见 assigneeSource.ts 头注释：本插件前端未装
// @vue/test-utils，纯函数是能被真正单测覆盖的唯一路径）。
//
// 『与上步处理人的关系』是独立过滤器，增删/勾选逻辑单测见 ./relationFilters.test.ts；本文件只
// 保留 RELATION_OPTIONS（转出复用给 ./relationFilters.ts）的单测。
import { describe, expect, it } from 'vitest';
import {
  RELATION_OPTIONS,
  addInitiatorSource,
  addMainFieldSource,
  addPickedSource,
  describeSource,
  removeSourceAt,
  updateMainFieldId,
  updateMatchBy,
  type AssigneeNameCache
} from './assigneeSource';
import type { AssigneeSource } from '../../../model';

const EMPTY_CACHE: AssigneeNameCache = { user: {}, role: {}, department: {} };

describe('addPickedSource：用户 / 角色 / 部门', () => {
  it('用户：追加一条 kind=user 的来源，user_ids 为选中的 id 列表', () => {
    const next = addPickedSource([], 'user', ['u1', 'u2']);
    expect(next).toEqual([{ kind: 'user', user_ids: ['u1', 'u2'] }]);
  });

  it('角色：追加一条 kind=role 的来源', () => {
    const next = addPickedSource([], 'role', ['r1']);
    expect(next).toEqual([{ kind: 'role', role_ids: ['r1'] }]);
  });

  it('部门：追加一条 kind=department 的来源', () => {
    const next = addPickedSource([], 'department', ['d1']);
    expect(next).toEqual([{ kind: 'department', department_ids: ['d1'] }]);
  });

  it('ids 为空数组时不产生变更（原样返回同一份清单）', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }];
    expect(addPickedSource(sources, 'user', [])).toBe(sources);
  });

  it('不修改入参数组，返回新数组（同 document-state.ts 既定风格）', () => {
    const sources: AssigneeSource[] = [];
    const next = addPickedSource(sources, 'user', ['u1']);
    expect(next).not.toBe(sources);
    expect(sources).toEqual([]);
  });
});

describe('主表字段来源：新增 / 改字段 / 改匹配依据', () => {
  it('addMainFieldSource：追加一条草稿行，字段留空、匹配依据默认按用户名', () => {
    const next = addMainFieldSource([]);
    expect(next).toEqual([{ kind: 'main_field', main_field_id: '', match_by: 'display_name' }]);
  });

  it('updateMainFieldId：只改目标下标那一行的 main_field_id', () => {
    const sources: AssigneeSource[] = [
      { kind: 'main_field', main_field_id: '', match_by: 'display_name' },
      { kind: 'user', user_ids: ['u1'] }
    ];
    const next = updateMainFieldId(sources, 0, 'field-employee');
    expect(next[0]).toEqual({ kind: 'main_field', main_field_id: 'field-employee', match_by: 'display_name' });
    expect(next[1]).toEqual(sources[1]);
  });

  it('updateMainFieldId：下标不是 main_field 行时原样返回，不误改其它类型的行', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }];
    expect(updateMainFieldId(sources, 0, 'field-x')).toBe(sources);
  });

  it('updateMatchBy：改按登录名匹配', () => {
    const sources: AssigneeSource[] = [{ kind: 'main_field', main_field_id: 'field-employee', match_by: 'display_name' }];
    const next = updateMatchBy(sources, 0, 'login_name');
    expect(next[0]).toEqual({ kind: 'main_field', main_field_id: 'field-employee', match_by: 'login_name' });
  });
});

describe('RELATION_OPTIONS：五档固定顺序（转出复用给 ./relationFilters.ts）', () => {
  it('恰好五档，顺序一致', () => {
    expect(RELATION_OPTIONS).toEqual(['same_department', 'parent_department', 'child_department', 'department_manager', 'parent_department_manager']);
  });
});

describe('发起人来源：无参数、同一节点最多一条', () => {
  it('addInitiatorSource：未配置过时追加一条 { kind: initiator }', () => {
    const next = addInitiatorSource([]);
    expect(next).toEqual([{ kind: 'initiator' }]);
  });

  it('addInitiatorSource：已存在一条时原样返回，不产生重复行', () => {
    const sources: AssigneeSource[] = [{ kind: 'initiator' }];
    expect(addInitiatorSource(sources)).toBe(sources);
  });

  it('addInitiatorSource：与其它来源混配时，追加在末尾，不影响已有来源', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }];
    const next = addInitiatorSource(sources);
    expect(next).toEqual([{ kind: 'user', user_ids: ['u1'] }, { kind: 'initiator' }]);
  });
});

describe('removeSourceAt：删除', () => {
  it('删除中间一条，其余顺序不变', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }, { kind: 'role', role_ids: ['r1'] }, { kind: 'department', department_ids: ['d1'] }];
    const next = removeSourceAt(sources, 1);
    expect(next).toEqual([{ kind: 'user', user_ids: ['u1'] }, { kind: 'department', department_ids: ['d1'] }]);
  });

  it('下标越界时原样返回', () => {
    const sources: AssigneeSource[] = [{ kind: 'user', user_ids: ['u1'] }];
    expect(removeSourceAt(sources, 5)).toBe(sources);
    expect(removeSourceAt(sources, -1)).toBe(sources);
  });
});

describe('describeSource：展示文案（i18n key + params，不直接拼中文）', () => {
  it('user：名字缓存里有对应展示名时，用「姓名列表」文案；缓存为空（重开设计器场景）退回数量兜底', () => {
    const source: AssigneeSource = { kind: 'user', user_ids: ['u1', 'u2'] };
    const withCache = describeSource(source, { user: { u1: '张三' }, role: {}, department: {} });
    expect(withCache).toEqual({ key: 'workflow.designer.assignee.label.user', params: { names: '张三' } });

    const withoutCache = describeSource(source, EMPTY_CACHE);
    expect(withoutCache).toEqual({ key: 'workflow.designer.assignee.label.userCount', params: { count: 2 } });
  });

  it('role / department 同 user 的口径（缓存命中显示名字，未命中显示数量）', () => {
    expect(describeSource({ kind: 'role', role_ids: ['r1'] }, { user: {}, role: { r1: '采购经理' }, department: {} })).toEqual({
      key: 'workflow.designer.assignee.label.role',
      params: { names: '采购经理' }
    });
    expect(describeSource({ kind: 'department', department_ids: ['d1'] }, EMPTY_CACHE)).toEqual({
      key: 'workflow.designer.assignee.label.departmentCount',
      params: { count: 1 }
    });
  });

  it('relation：直接映射到对应档的固定 key，不看名字缓存', () => {
    expect(describeSource({ kind: 'relation', relation: 'department_manager' }, EMPTY_CACHE)).toEqual({
      key: 'workflow.designer.assignee.relation.department_manager'
    });
  });

  it('main_field：不产出文案（Vue 层直接渲染下拉展示当前选中字段，不经本函数）', () => {
    expect(describeSource({ kind: 'main_field', main_field_id: 'f1', match_by: 'display_name' }, EMPTY_CACHE)).toBeUndefined();
  });

  it('initiator：直接映射到固定 key，不看名字缓存、不需要参数', () => {
    expect(describeSource({ kind: 'initiator' }, EMPTY_CACHE)).toEqual({ key: 'workflow.designer.assignee.label.initiator' });
  });
});
