/**
 * panels/dialogs/fieldPermission.test.ts —— 字段权限对话框纯函数单测。
 */
import { describe, expect, it } from 'vitest';
import type { FieldPermission } from '../../../model';
import type { TemplateFieldCatalog } from '../shared/templateFieldCatalog';
import {
  applyBulk,
  effectiveHint,
  fromGradeMap,
  gradeCounts,
  gradesFor,
  matchKeyword,
  normalizeForReadonlyOnly,
  toGradeMap
} from './fieldPermission';

/** 一份两表目录：主表 t1（f1/f2）+ 扩展表 t2（f3），供多数用例共用。 */
function buildCatalog(): TemplateFieldCatalog {
  const byFieldId = new Map();
  const t1Fields = [
    { fieldId: 'f1', fieldName: '姓名', dataType: 'text', tableId: 't1', tableName: '主表', isMain: true },
    { fieldId: 'f2', fieldName: '金额', dataType: 'number', tableId: 't1', tableName: '主表', isMain: true }
  ];
  const t2Fields = [{ fieldId: 'f3', fieldName: '备注', dataType: 'text', tableId: 't2', tableName: '明细表', isMain: false }];
  for (const f of [...t1Fields, ...t2Fields]) byFieldId.set(f.fieldId, f);
  return {
    templateId: 'tpl1',
    tables: [
      { tableId: 't1', tableName: '主表', isMain: true, fields: t1Fields },
      { tableId: 't2', tableName: '明细表', isMain: false, fields: t2Fields }
    ],
    byFieldId
  };
}

describe('gradesFor：三档/四档', () => {
  it('可编辑型：四档，含 edit', () => {
    expect(gradesFor(false)).toEqual(['inherit', 'edit', 'readonly', 'hidden']);
  });
  it('只看型：三档，不含 edit', () => {
    expect(gradesFor(true)).toEqual(['inherit', 'readonly', 'hidden']);
    expect(gradesFor(true)).not.toContain('edit');
  });
});

describe('toGradeMap / fromGradeMap：清单 ↔ 草稿 Map 往返', () => {
  it('inherit 不入清单：草稿里没有 inherit 记录（本就不会有），非 inherit 记录正常往返', () => {
    const perms: FieldPermission[] = [
      { table_id: 't1', field_id: 'f1', grade: 'readonly' },
      { table_id: 't2', field_id: 'f3', grade: 'hidden' }
    ];
    const map = toGradeMap(perms);
    expect(map.size).toBe(2);
    const out = fromGradeMap(map, buildCatalog());
    expect(out).toEqual(perms);
  });

  it('去重：同一字段出现两次，后写覆盖，位置按首次出现', () => {
    const perms: FieldPermission[] = [
      { table_id: 't1', field_id: 'f1', grade: 'readonly' },
      { table_id: 't1', field_id: 'f2', grade: 'hidden' },
      { table_id: 't1', field_id: 'f1', grade: 'edit' } // 覆盖第一条
    ];
    const map = toGradeMap(perms);
    expect(map.size).toBe(2);
    expect(map.get('f1')).toEqual({ tableId: 't1', grade: 'edit' });
    const out = fromGradeMap(map, buildCatalog());
    // 目录顺序：f1（主表）先于 f2（主表）；两个都在主表，按目录内字段原有顺序，f1 排前面。
    expect(out).toEqual([
      { table_id: 't1', field_id: 'f1', grade: 'edit' },
      { table_id: 't1', field_id: 'f2', grade: 'hidden' }
    ]);
  });

  it('目录顺序稳定：清单原始顺序打乱，写回按目录顺序（主表在前）重新排列', () => {
    const perms: FieldPermission[] = [
      { table_id: 't2', field_id: 'f3', grade: 'hidden' },
      { table_id: 't1', field_id: 'f2', grade: 'readonly' },
      { table_id: 't1', field_id: 'f1', grade: 'edit' }
    ];
    const map = toGradeMap(perms);
    const out = fromGradeMap(map, buildCatalog());
    expect(out.map((p) => p.field_id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('不存在字段保留在末尾：目录里已经没有 f9，写回时原样追加在按目录排好的记录之后', () => {
    const perms: FieldPermission[] = [
      { table_id: 't9', field_id: 'f9', grade: 'hidden' }, // 目录里已不存在
      { table_id: 't1', field_id: 'f1', grade: 'readonly' }
    ];
    const map = toGradeMap(perms);
    const out = fromGradeMap(map, buildCatalog());
    expect(out).toEqual([
      { table_id: 't1', field_id: 'f1', grade: 'readonly' },
      { table_id: 't9', field_id: 'f9', grade: 'hidden' }
    ]);
  });

  it('catalog 为 null（目录取失败）时不擅自清空：全部草稿记录原样按原顺序落进"末尾段"', () => {
    const perms: FieldPermission[] = [
      { table_id: 't1', field_id: 'f1', grade: 'readonly' },
      { table_id: 't2', field_id: 'f3', grade: 'hidden' }
    ];
    const map = toGradeMap(perms);
    const out = fromGradeMap(map, null);
    expect(out).toEqual(perms);
  });
});

describe('normalizeForReadonlyOnly：只看型把 edit 归一成 readonly', () => {
  it('edit → readonly，其余档位不变，不修改入参', () => {
    const map = toGradeMap([
      { table_id: 't1', field_id: 'f1', grade: 'edit' },
      { table_id: 't1', field_id: 'f2', grade: 'hidden' }
    ]);
    const normalized = normalizeForReadonlyOnly(map);
    expect(normalized.get('f1')).toEqual({ tableId: 't1', grade: 'readonly' });
    expect(normalized.get('f2')).toEqual({ tableId: 't1', grade: 'hidden' });
    // 入参未被修改（纯函数）。
    expect(map.get('f1')).toEqual({ tableId: 't1', grade: 'edit' });
  });
});

describe('effectiveHint：模板限制对照 + 冲突提示', () => {
  it('无限制（restriction 缺席）：kind=none，不 warn', () => {
    expect(effectiveHint('edit', undefined)).toEqual({ kind: 'none', warn: false });
  });
  it('无限制（restriction 存在但 hidden/readonly 都为 false）：kind=none', () => {
    expect(effectiveHint('readonly', { field_id: 'f1', hidden: false, readonly: false, no_export: true })).toEqual({ kind: 'none', warn: false });
  });
  it('模板已隐藏 + 本步骤设为可编辑：冲突 warn', () => {
    expect(effectiveHint('edit', { field_id: 'f1', hidden: true, readonly: false, no_export: false })).toEqual({ kind: 'templateHidden', warn: true });
  });
  it('模板已只读 + 本步骤设为可编辑：冲突 warn', () => {
    expect(effectiveHint('edit', { field_id: 'f1', hidden: false, readonly: true, no_export: false })).toEqual({ kind: 'templateReadonly', warn: true });
  });
  it('模板已只读 + 本步骤设为只读：不冲突，仅展示对照', () => {
    expect(effectiveHint('readonly', { field_id: 'f1', hidden: false, readonly: true, no_export: false })).toEqual({ kind: 'templateReadonly', warn: false });
  });
  it('hidden 与 readonly 同时命中：kind 取更强的 templateHidden', () => {
    expect(effectiveHint('edit', { field_id: 'f1', hidden: true, readonly: true, no_export: false }).kind).toBe('templateHidden');
  });
});

describe('applyBulk：批量设档', () => {
  it('批量设为只读：多个字段一次写入', () => {
    const map = toGradeMap([]);
    const next = applyBulk(map, ['f1', 'f2'], 'readonly', (id) => (id === 'f1' ? 't1' : 't1'));
    expect(next.get('f1')).toEqual({ tableId: 't1', grade: 'readonly' });
    expect(next.get('f2')).toEqual({ tableId: 't1', grade: 'readonly' });
    expect(map.size).toBe(0); // 入参未被修改
  });
  it('批量设为 inherit：等价于从草稿里删除', () => {
    const map = toGradeMap([
      { table_id: 't1', field_id: 'f1', grade: 'readonly' },
      { table_id: 't1', field_id: 'f2', grade: 'hidden' }
    ]);
    const next = applyBulk(map, ['f1'], 'inherit', () => 't1');
    expect(next.has('f1')).toBe(false);
    expect(next.get('f2')).toEqual({ tableId: 't1', grade: 'hidden' });
  });
  it('newTableIdOf 查不到时兜底空串，不抛异常', () => {
    const map = toGradeMap([]);
    const next = applyBulk(map, ['fx'], 'hidden', () => undefined);
    expect(next.get('fx')).toEqual({ tableId: '', grade: 'hidden' });
  });
});

describe('matchKeyword：字段名不区分大小写包含匹配', () => {
  const field = { fieldName: 'Order Amount' };
  it('空关键字：全部命中', () => {
    expect(matchKeyword(field, '')).toBe(true);
    expect(matchKeyword(field, '   ')).toBe(true);
  });
  it('大小写不敏感包含匹配', () => {
    expect(matchKeyword(field, 'order')).toBe(true);
    expect(matchKeyword(field, 'AMOUNT')).toBe(true);
    expect(matchKeyword(field, 'xyz')).toBe(false);
  });
});

describe('gradeCounts：三档计数', () => {
  it('按 edit/readonly/hidden 分别计数', () => {
    const perms: FieldPermission[] = [
      { table_id: 't1', field_id: 'f1', grade: 'edit' },
      { table_id: 't1', field_id: 'f2', grade: 'edit' },
      { table_id: 't1', field_id: 'f3', grade: 'readonly' },
      { table_id: 't1', field_id: 'f4', grade: 'hidden' }
    ];
    expect(gradeCounts(perms)).toEqual({ edit: 2, readonly: 1, hidden: 1 });
  });
  it('undefined/空数组：三档均为 0', () => {
    expect(gradeCounts(undefined)).toEqual({ edit: 0, readonly: 0, hidden: 0 });
    expect(gradeCounts([])).toEqual({ edit: 0, readonly: 0, hidden: 0 });
  });
});
