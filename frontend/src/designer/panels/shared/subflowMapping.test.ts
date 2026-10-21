// panels/shared/subflowMapping.test.ts —— 子流程传递字段/等待/处置相关纯函数单测。
import { describe, expect, it } from 'vitest';
import {
  applyWaitToggle,
  compatibleTargets,
  decodeSourceOptionValue,
  detailTableConflicts,
  encodeSourceOptionValue,
  excludeSelf,
  isTerminalSubflow,
  mappingFromSourceKey,
  resolveSourceField,
  resolveTargetField,
  sourceKeyOf
} from './subflowMapping';
import type { CatalogFieldItem, TemplateFieldCatalog } from './templateFieldCatalog';
import type { SubflowFieldMapping, WorkflowDocument, WorkflowLink, WorkflowNode } from '../../../model';

function catalogField(overrides: Partial<CatalogFieldItem> & Pick<CatalogFieldItem, 'fieldId' | 'tableId' | 'isMain'>): CatalogFieldItem {
  return { fieldName: overrides.fieldId, dataType: 'text', tableName: overrides.tableId || 'main', ...overrides };
}

function buildCatalog(fields: CatalogFieldItem[]): TemplateFieldCatalog {
  const byFieldId = new Map(fields.map((f) => [f.fieldId, f]));
  const tableIds = Array.from(new Set(fields.map((f) => f.tableId)));
  return {
    templateId: 'tpl_1',
    tables: tableIds.map((tableId) => ({
      tableId,
      tableName: tableId,
      isMain: fields.find((f) => f.tableId === tableId)!.isMain,
      fields: fields.filter((f) => f.tableId === tableId)
    })),
    byFieldId
  };
}

describe('sourceKeyOf / mappingFromSourceKey：写回口径', () => {
  it('主表字段的写回口径是空串', () => {
    const field = catalogField({ fieldId: 'f_main1', tableId: 't_main', isMain: true });
    expect(sourceKeyOf(field)).toBe('');
  });

  it('扩展表字段的写回口径是该表 tableId', () => {
    const field = catalogField({ fieldId: 'f_d1', tableId: 't_detail', isMain: false });
    expect(sourceKeyOf(field)).toBe('t_detail');
  });

  it('mappingFromSourceKey 组装出完整的 SubflowFieldMapping', () => {
    expect(mappingFromSourceKey('', 'f_main1', 'f_target1')).toEqual({
      source_table_id: '',
      source_field_id: 'f_main1',
      target_field_id: 'f_target1'
    });
    expect(mappingFromSourceKey('t_detail', 'f_d1', 'f_target1')).toEqual({
      source_table_id: 't_detail',
      source_field_id: 'f_d1',
      target_field_id: 'f_target1'
    });
  });
});

describe('encodeSourceOptionValue / decodeSourceOptionValue：NSelect 选项值编解码往返', () => {
  it('主表字段编码后能正确解码回 { sourceTableId: "", fieldId }', () => {
    const field = catalogField({ fieldId: 'f_main1', tableId: 't_main', isMain: true });
    const value = encodeSourceOptionValue(field);
    expect(decodeSourceOptionValue(value)).toEqual({ sourceTableId: '', fieldId: 'f_main1' });
  });

  it('扩展表字段编码后能正确解码回 { sourceTableId: "t_detail", fieldId }', () => {
    const field = catalogField({ fieldId: 'f_d1', tableId: 't_detail', isMain: false });
    const value = encodeSourceOptionValue(field);
    expect(decodeSourceOptionValue(value)).toEqual({ sourceTableId: 't_detail', fieldId: 'f_d1' });
  });

  it('解不出分隔符的野值返回 undefined', () => {
    expect(decodeSourceOptionValue('no-separator-here')).toBeUndefined();
  });
});

describe('resolveSourceField / resolveTargetField：已存字段反查', () => {
  const catalog = buildCatalog([
    catalogField({ fieldId: 'f_main1', tableId: 't_main', isMain: true }),
    catalogField({ fieldId: 'f_d1', tableId: 't_detail', isMain: false })
  ]);

  it('主表字段能按 source_table_id="" 正确反查', () => {
    const mapping: SubflowFieldMapping = { source_table_id: '', source_field_id: 'f_main1', target_field_id: 'x' };
    expect(resolveSourceField(mapping, catalog)?.fieldId).toBe('f_main1');
  });

  it('扩展表字段能按 source_table_id=tableId 正确反查', () => {
    const mapping: SubflowFieldMapping = { source_table_id: 't_detail', source_field_id: 'f_d1', target_field_id: 'x' };
    expect(resolveSourceField(mapping, catalog)?.fieldId).toBe('f_d1');
  });

  it('field_id 在目录里但 source_table_id 与其真实所属表不一致（脏数据）：按"找不到"处理', () => {
    const mapping: SubflowFieldMapping = { source_table_id: 't_other', source_field_id: 'f_main1', target_field_id: 'x' };
    expect(resolveSourceField(mapping, catalog)).toBeUndefined();
  });

  it('field_id 不在目录里（字段已被删除）：返回 undefined', () => {
    const mapping: SubflowFieldMapping = { source_table_id: '', source_field_id: 'f_gone', target_field_id: 'x' };
    expect(resolveSourceField(mapping, catalog)).toBeUndefined();
  });

  it('目录为 null（未加载/加载失败）：返回 undefined', () => {
    const mapping: SubflowFieldMapping = { source_table_id: '', source_field_id: 'f_main1', target_field_id: 'x' };
    expect(resolveSourceField(mapping, null)).toBeUndefined();
  });

  it('resolveTargetField 按 field_id 在目标主表字段清单里查找', () => {
    const targetMainFields = [catalogField({ fieldId: 'f_t1', tableId: 't_target_main', isMain: true })];
    const mapping: SubflowFieldMapping = { source_table_id: '', source_field_id: 'x', target_field_id: 'f_t1' };
    expect(resolveTargetField(mapping, targetMainFields)?.fieldId).toBe('f_t1');
    const missing: SubflowFieldMapping = { source_table_id: '', source_field_id: 'x', target_field_id: 'f_gone' };
    expect(resolveTargetField(missing, targetMainFields)).toBeUndefined();
  });
});

describe('compatibleTargets：目标字段类型兼容过滤', () => {
  const targetMainFields = [
    catalogField({ fieldId: 'f_number', tableId: 't_target_main', isMain: true, dataType: 'number' }),
    catalogField({ fieldId: 'f_text', tableId: 't_target_main', isMain: true, dataType: 'text' }),
    catalogField({ fieldId: 'f_select', tableId: 't_target_main', isMain: true, dataType: 'select' })
  ];

  it('来源未选中时返回空数组', () => {
    expect(compatibleTargets(undefined, targetMainFields)).toEqual([]);
  });

  it('同类型 + 文本类型都算兼容，其余类型不兼容', () => {
    const source = catalogField({ fieldId: 'f_src', tableId: 't_main', isMain: true, dataType: 'number' });
    const result = compatibleTargets(source, targetMainFields).map((f) => f.fieldId);
    expect(result).toEqual(['f_number', 'f_text']);
  });

  it('来源本身就是文本类型：只有目标的文本字段兼容（同类型分支与文本分支重合，不重复）', () => {
    const source = catalogField({ fieldId: 'f_src', tableId: 't_main', isMain: true, dataType: 'text' });
    const result = compatibleTargets(source, targetMainFields).map((f) => f.fieldId);
    expect(result).toEqual(['f_text']);
  });

  it('类型比较大小写不敏感', () => {
    const source = catalogField({ fieldId: 'f_src', tableId: 't_main', isMain: true, dataType: 'NUMBER' });
    const result = compatibleTargets(source, targetMainFields).map((f) => f.fieldId);
    expect(result).toEqual(['f_number', 'f_text']);
  });
});

describe('detailTableConflicts：同表约束', () => {
  it('全部来自主表：无冲突', () => {
    const mappings: SubflowFieldMapping[] = [
      { source_table_id: '', source_field_id: 'f1', target_field_id: 't1' },
      { source_table_id: '', source_field_id: 'f2', target_field_id: 't2' }
    ];
    expect(detailTableConflicts(mappings)).toEqual([]);
  });

  it('主表 + 同一张扩展表混用：无冲突', () => {
    const mappings: SubflowFieldMapping[] = [
      { source_table_id: '', source_field_id: 'f1', target_field_id: 't1' },
      { source_table_id: 't_detail1', source_field_id: 'f2', target_field_id: 't2' },
      { source_table_id: 't_detail1', source_field_id: 'f3', target_field_id: 't3' }
    ];
    expect(detailTableConflicts(mappings)).toEqual([]);
  });

  it('出现第二张扩展表：从第二次出现的那一行起标记冲突', () => {
    const mappings: SubflowFieldMapping[] = [
      { source_table_id: 't_detail1', source_field_id: 'f1', target_field_id: 't1' },
      { source_table_id: 't_detail2', source_field_id: 'f2', target_field_id: 't2' },
      { source_table_id: 't_detail1', source_field_id: 'f3', target_field_id: 't3' }
    ];
    expect(detailTableConflicts(mappings)).toEqual([1]);
  });

  it('第二张扩展表出现之后同一张表的多行都计入冲突', () => {
    const mappings: SubflowFieldMapping[] = [
      { source_table_id: 't_detail1', source_field_id: 'f1', target_field_id: 't1' },
      { source_table_id: 't_detail2', source_field_id: 'f2', target_field_id: 't2' },
      { source_table_id: 't_detail2', source_field_id: 'f3', target_field_id: 't3' }
    ];
    expect(detailTableConflicts(mappings)).toEqual([1, 2]);
  });
});

describe('isTerminalSubflow：末级节点判定', () => {
  function node(id: string, kind: WorkflowNode['kind']): WorkflowNode {
    return { id, kind };
  }
  function link(from: string, to: string): WorkflowLink {
    return { id: `${from}-${to}`, from, to };
  }

  it('没有任何出边：视为末级', () => {
    const doc: Pick<WorkflowDocument, 'nodes' | 'links'> = {
      nodes: [node('n_subflow', 'subflow'), node('n_end', 'end')],
      links: []
    };
    expect(isTerminalSubflow(doc, 'n_subflow')).toBe(true);
  });

  it('唯一出边指向结束节点：视为末级', () => {
    const doc: Pick<WorkflowDocument, 'nodes' | 'links'> = {
      nodes: [node('n_subflow', 'subflow'), node('n_end', 'end')],
      links: [link('n_subflow', 'n_end')]
    };
    expect(isTerminalSubflow(doc, 'n_subflow')).toBe(true);
  });

  it('存在一条出边指向非结束节点：不是末级', () => {
    const doc: Pick<WorkflowDocument, 'nodes' | 'links'> = {
      nodes: [node('n_subflow', 'subflow'), node('n_handle', 'handle'), node('n_end', 'end')],
      links: [link('n_subflow', 'n_handle'), link('n_subflow', 'n_end')]
    };
    expect(isTerminalSubflow(doc, 'n_subflow')).toBe(false);
  });

  it('全部出边都指向结束节点（多条出边场景）：视为末级', () => {
    const doc: Pick<WorkflowDocument, 'nodes' | 'links'> = {
      nodes: [node('n_subflow', 'subflow'), node('n_end1', 'end'), node('n_end2', 'end')],
      links: [link('n_subflow', 'n_end1'), link('n_subflow', 'n_end2')]
    };
    expect(isTerminalSubflow(doc, 'n_subflow')).toBe(true);
  });
});

describe('excludeSelf：目标流程下拉排除自己', () => {
  function def(id: string): { definition_id: string; name: string } {
    return { definition_id: id, name: id };
  }

  it('selfId 命中候选中的一条：过滤掉那一条，其余保留', () => {
    const definitions = [def('d1'), def('d2'), def('d3')];
    expect(excludeSelf(definitions, 'd2').map((d) => d.definition_id)).toEqual(['d1', 'd3']);
  });

  it('selfId 未命中任何候选：原样返回', () => {
    const definitions = [def('d1'), def('d2')];
    expect(excludeSelf(definitions, 'd_other')).toEqual(definitions);
  });

  it('selfId 为空串：视为"未知当前定义 id"，不做任何排除', () => {
    const definitions = [def('d1'), def('d2')];
    expect(excludeSelf(definitions, '')).toEqual(definitions);
  });

  it('selfId 为 undefined（老宿主未升级）：不做任何排除', () => {
    const definitions = [def('d1'), def('d2')];
    expect(excludeSelf(definitions, undefined)).toEqual(definitions);
  });
});

describe('applyWaitToggle：等待方式切换时的处置字段联动', () => {
  it('切到 wait=true：disposition 联动清空（undefined，序列化时随键丢弃）', () => {
    expect(applyWaitToggle({ disposition: 'force_end' }, true)).toEqual({ wait: true, disposition: undefined });
  });

  it('切到 wait=false 且此前没有 disposition：补默认 ignore', () => {
    expect(applyWaitToggle({ disposition: undefined }, false)).toEqual({ wait: false, disposition: 'ignore' });
  });

  it('切到 wait=false 且此前已有 disposition：保留原值，不覆盖成默认 ignore', () => {
    expect(applyWaitToggle({ disposition: 'force_end' }, false)).toEqual({ wait: false, disposition: 'force_end' });
  });
});
