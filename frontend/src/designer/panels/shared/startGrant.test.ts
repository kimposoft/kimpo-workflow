/**
 * panels/shared/startGrant.test.ts —— OrgTriLine.vue 主表字段档写回纯逻辑单测：
 * 选字段写回 / 清空不写空串 / 改匹配方式 / 删除清掉两个字段 / 三维
 * 选择器确认后保留第四档 / 改第四档后保留三维——同 ./assigneeSource.test.ts 既定分工（NSelect
 * 的下拉选项在 happy-dom 下无法真正点选，见 startGrant.ts 头注释），不依赖挂载真实组件。
 */
import { describe, expect, it } from 'vitest';
import type { StartGrant } from '../../../model';
import { clearMainField, clearOrgKind, mergeOrgPickerResult, setMainField, setMatchBy } from './startGrant';

describe('setMainField：选字段写回 / 清空不写空串', () => {
  it('选中字段：写回 main_field_id，match_by 缺省按用户名（display_name）', () => {
    const next = setMainField({}, 'f1');
    expect(next).toEqual({ main_field_id: 'f1', match_by: 'display_name' });
  });

  it('已有 match_by 时选中另一个字段：match_by 保持不变', () => {
    const next = setMainField({ main_field_id: 'f1', match_by: 'login_name' }, 'f2');
    expect(next).toEqual({ main_field_id: 'f2', match_by: 'login_name' });
  });

  it('清空字段（fieldId 为 undefined）：main_field_id/match_by 都置 undefined，不写空串', () => {
    const next = setMainField({ main_field_id: 'f1', match_by: 'login_name' }, undefined);
    expect(next.main_field_id).toBeUndefined();
    expect(next.match_by).toBeUndefined();
    // 不写空串：不是 main_field_id === ''。
    expect(Object.prototype.hasOwnProperty.call(next, 'main_field_id')).toBe(true);
    expect(next.main_field_id).not.toBe('');
  });

  it('不改动其余三组来源', () => {
    const grant: StartGrant = { user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'] };
    const next = setMainField(grant, 'f1');
    expect(next.user_ids).toEqual(['u1']);
    expect(next.role_ids).toEqual(['r1']);
    expect(next.department_ids).toEqual(['d1']);
  });

  it('不改变入参（纯函数）', () => {
    const grant: StartGrant = { main_field_id: 'f1' };
    const snapshot = { ...grant };
    setMainField(grant, 'f2');
    expect(grant).toEqual(snapshot);
  });
});

describe('setMatchBy：改匹配方式', () => {
  it('写回 match_by，不影响 main_field_id 与其余来源', () => {
    const grant: StartGrant = { main_field_id: 'f1', match_by: 'display_name', user_ids: ['u1'] };
    const next = setMatchBy(grant, 'login_name');
    expect(next).toEqual({ main_field_id: 'f1', match_by: 'login_name', user_ids: ['u1'] });
  });
});

describe('clearMainField：删除第四档', () => {
  it('main_field_id 与 match_by 一并去掉，其余三组来源原样保留', () => {
    const grant: StartGrant = { main_field_id: 'f1', match_by: 'login_name', user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'] };
    const next = clearMainField(grant);
    expect(next.main_field_id).toBeUndefined();
    expect(next.match_by).toBeUndefined();
    expect(next.user_ids).toEqual(['u1']);
    expect(next.role_ids).toEqual(['r1']);
    expect(next.department_ids).toEqual(['d1']);
  });
});

describe('mergeOrgPickerResult：三维选择器确认后保留第四档（🔴 最容易漏的一处）', () => {
  it('三个数组按弹窗结果整体替换，main_field_id/match_by 原样保留', () => {
    const grant: StartGrant = { main_field_id: 'f1', match_by: 'login_name' };
    const next = mergeOrgPickerResult(grant, ['u1'], ['r1'], ['d1']);
    expect(next).toEqual({ main_field_id: 'f1', match_by: 'login_name', user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'] });
  });

  it('没有配置过第四档时（main_field_id/match_by 均缺席）：结果里也不出现这两个键', () => {
    const next = mergeOrgPickerResult({}, ['u1'], [], []);
    expect(Object.prototype.hasOwnProperty.call(next, 'main_field_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(next, 'match_by')).toBe(false);
  });
});

describe('clearOrgKind：改第四档后保留三维（反之亦然，覆盖单类清空场景）', () => {
  it('清空 user：role/department 与主表字段档都原样保留', () => {
    const grant: StartGrant = { user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' };
    const next = clearOrgKind(grant, 'user');
    expect(next).toEqual({ user_ids: [], role_ids: ['r1'], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' });
  });

  it('清空 role：user/department 与主表字段档都原样保留', () => {
    const grant: StartGrant = { user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' };
    const next = clearOrgKind(grant, 'role');
    expect(next).toEqual({ user_ids: ['u1'], role_ids: [], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' });
  });

  it('清空 department：user/role 与主表字段档都原样保留', () => {
    const grant: StartGrant = { user_ids: ['u1'], role_ids: ['r1'], department_ids: ['d1'], main_field_id: 'f1', match_by: 'display_name' };
    const next = clearOrgKind(grant, 'department');
    expect(next).toEqual({ user_ids: ['u1'], role_ids: ['r1'], department_ids: [], main_field_id: 'f1', match_by: 'display_name' });
  });
});
