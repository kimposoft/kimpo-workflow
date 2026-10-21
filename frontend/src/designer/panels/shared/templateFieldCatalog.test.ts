// panels/shared/templateFieldCatalog.test.ts —— 共享「模板字段目录」取数件单测。只覆盖纯函数/取数逻辑（loadTemplateFieldCatalog / getTemplateFieldCatalog 及其缓存
// 行为 / mainTableOf / detailTablesOf / fieldsOfType），不挂载 Vue 组件——本插件前端未装
// @vue/test-utils，且这批测试用例本身都落在与 Vue 无关的数据变换/缓存逻辑上（同 assigneeSource
// .test.ts 头注释的既定分工）。
import { describe, expect, it } from 'vitest';
import {
  RETIRED_FIELD_DATA_TYPES,
  detailTablesOf,
  fieldsOfType,
  getTemplateFieldCatalog,
  invalidateTemplateFieldCatalog,
  loadTemplateFieldCatalog,
  mainTableOf,
  type TemplateFieldCatalogHost
} from './templateFieldCatalog';
import type { WorkflowDesignerTemplateField, WorkflowDesignerTemplateTable } from '../../host';

/** 手写假 host：只实现 TemplateFieldCatalogHost 要求的两个方法，逐表按 dataTableId 分派字段
 *  响应；fieldsByTableId 某张表缺省/显式传 'error' 都会让该表的 listTemplateFields 回 error 信封
 *  （用于覆盖"任一请求失败整体 null"）。同时记调用次数，供并发去重/缓存类用例断言"只发了几轮
 *  请求"。 */
function buildFakeHost(
  tables: WorkflowDesignerTemplateTable[],
  fieldsByTableId: Record<string, WorkflowDesignerTemplateField[] | 'error'>,
  options: { tablesError?: boolean } = {}
): { host: TemplateFieldCatalogHost; calls: { listTemplateTables: number; listTemplateFields: number } } {
  const calls = { listTemplateTables: 0, listTemplateFields: 0 };
  const host: TemplateFieldCatalogHost = {
    listTemplateTables: async () => {
      calls.listTemplateTables++;
      if (options.tablesError) return { error: { message: 'boom' } };
      return { data: { items: tables } };
    },
    listTemplateFields: async (_templateId, dataTableId) => {
      calls.listTemplateFields++;
      const fields = fieldsByTableId[dataTableId];
      if (fields === undefined || fields === 'error') {
        return { error: { message: 'boom' } };
      }
      return { data: { items: fields } };
    }
  };
  return { host, calls };
}

function field(id: string, name: string, dataType: string): WorkflowDesignerTemplateField {
  return { field_id: id, field_name: name, data_type: dataType };
}

describe('loadTemplateFieldCatalog', () => {
  it('主表排第一：宿主返回顺序是 [扩展表, 主表]，目录里主表被挪到 tables[0]', async () => {
    const { host } = buildFakeHost(
      [
        { data_table_id: 't_detail', table_name: '扩展表', table_role: 'detail' },
        { data_table_id: 't_main', table_name: '主表', table_role: 'main' }
      ],
      {
        t_detail: [field('f_d1', '扩展字段', 'text')],
        t_main: [field('f_m1', '主表字段', 'text')]
      }
    );
    const catalog = await loadTemplateFieldCatalog(host, 'tpl_1');
    expect(catalog).not.toBeNull();
    expect(catalog!.tables.map((t) => t.tableId)).toEqual(['t_main', 't_detail']);
    expect(catalog!.tables[0]!.isMain).toBe(true);
    expect(catalog!.tables[1]!.isMain).toBe(false);
  });

  it('扩展表字段 isMain=false 且带正确 tableName', async () => {
    const { host } = buildFakeHost(
      [
        { data_table_id: 't_main', table_name: '主表', table_role: 'main' },
        { data_table_id: 't_detail', table_name: '明细表A', table_role: 'detail' }
      ],
      {
        t_main: [field('f_m1', '主表字段', 'text')],
        t_detail: [field('f_d1', '明细字段', 'text')]
      }
    );
    const catalog = await loadTemplateFieldCatalog(host, 'tpl_1');
    const detailField = catalog!.byFieldId.get('f_d1')!;
    expect(detailField.isMain).toBe(false);
    expect(detailField.tableName).toBe('明细表A');
    expect(detailField.tableId).toBe('t_detail');
  });

  it('已退役字段类型（boolean/date）被滤掉，不出现在表的 fields 里也不进 byFieldId', async () => {
    const { host } = buildFakeHost(
      [{ data_table_id: 't_main', table_name: '主表', table_role: 'main' }],
      {
        t_main: [field('f_text', '文本字段', 'text'), field('f_bool', '布尔字段', 'boolean'), field('f_date', '日期字段', 'date')]
      }
    );
    const catalog = await loadTemplateFieldCatalog(host, 'tpl_1');
    expect(catalog!.tables[0]!.fields.map((f) => f.fieldId)).toEqual(['f_text']);
    expect(catalog!.byFieldId.has('f_bool')).toBe(false);
    expect(catalog!.byFieldId.has('f_date')).toBe(false);
    expect(RETIRED_FIELD_DATA_TYPES).toEqual(['boolean', 'date']);
  });

  it('任一表的 listTemplateFields 失败（error 信封）→ 整体返回 null', async () => {
    const { host } = buildFakeHost(
      [
        { data_table_id: 't_main', table_name: '主表', table_role: 'main' },
        { data_table_id: 't_detail', table_name: '扩展表', table_role: 'detail' }
      ],
      {
        t_main: [field('f_m1', '主表字段', 'text')],
        t_detail: 'error'
      }
    );
    const catalog = await loadTemplateFieldCatalog(host, 'tpl_1');
    expect(catalog).toBeNull();
  });

  it('listTemplateTables 本身失败（error 信封）→ 整体返回 null', async () => {
    const host: TemplateFieldCatalogHost = {
      listTemplateTables: async () => ({ error: { message: 'boom' } }),
      listTemplateFields: async () => ({ data: { items: [] } })
    };
    const catalog = await loadTemplateFieldCatalog(host, 'tpl_1');
    expect(catalog).toBeNull();
  });

  it('templateId 为空串/纯空白 → 直接 null，不发任何请求', async () => {
    const { host, calls } = buildFakeHost([], {});
    expect(await loadTemplateFieldCatalog(host, '')).toBeNull();
    expect(await loadTemplateFieldCatalog(host, '   ')).toBeNull();
    expect(calls.listTemplateTables).toBe(0);
    expect(calls.listTemplateFields).toBe(0);
  });

  it('主表判定大小写不敏感（MAIN / 前后带空白的 Main）', async () => {
    const { host } = buildFakeHost(
      [
        { data_table_id: 't_a', table_name: '表A', table_role: 'MAIN' },
        { data_table_id: 't_b', table_name: '表B', table_role: ' Main ' }
      ],
      { t_a: [], t_b: [] }
    );
    // 两张表都判成主表也不报错——只断言判定口径本身大小写/空白不敏感，不断言"恰好一张主表"
    // 这种业务约束（那属于发布期后端校验，不是本取数件的职责）。
    const catalog = await loadTemplateFieldCatalog(host, 'tpl_1');
    expect(catalog!.tables.every((t) => t.isMain)).toBe(true);
  });
});

describe('getTemplateFieldCatalog 缓存', () => {
  it('并发两次同键调用只发一轮请求（复用同一个进行中的 Promise）', async () => {
    invalidateTemplateFieldCatalog();
    const { host, calls } = buildFakeHost([{ data_table_id: 't_main', table_name: '主表', table_role: 'main' }], { t_main: [] });
    const [a, b] = await Promise.all([getTemplateFieldCatalog(host, 'tpl_dup'), getTemplateFieldCatalog(host, 'tpl_dup')]);
    expect(a).toBe(b); // 同一个目录对象（同一个 Promise resolve 出来的）。
    expect(calls.listTemplateTables).toBe(1);
  });

  it('失败（null）的结果不进缓存：第二次调用会重新发请求', async () => {
    invalidateTemplateFieldCatalog();
    const { host, calls } = buildFakeHost([], {}, { tablesError: true });
    const first = await getTemplateFieldCatalog(host, 'tpl_fail');
    expect(first).toBeNull();
    const second = await getTemplateFieldCatalog(host, 'tpl_fail');
    expect(second).toBeNull();
    expect(calls.listTemplateTables).toBe(2); // 两次都真正发了请求，说明失败结果没有被缓存钉住。
  });

  it('invalidateTemplateFieldCatalog 后重新取：成功结果原本会命中缓存，失效后再次调用会重新发请求', async () => {
    invalidateTemplateFieldCatalog();
    const { host, calls } = buildFakeHost([{ data_table_id: 't_main', table_name: '主表', table_role: 'main' }], { t_main: [] });
    await getTemplateFieldCatalog(host, 'tpl_inv');
    await getTemplateFieldCatalog(host, 'tpl_inv');
    expect(calls.listTemplateTables).toBe(1); // 命中缓存，第二次没有真的再发请求。

    invalidateTemplateFieldCatalog('tpl_inv');
    await getTemplateFieldCatalog(host, 'tpl_inv');
    expect(calls.listTemplateTables).toBe(2); // 失效后重新发了一轮。
  });
});

describe('mainTableOf / detailTablesOf / fieldsOfType', () => {
  async function buildSampleCatalog() {
    const { host } = buildFakeHost(
      [
        { data_table_id: 't_main', table_name: '主表', table_role: 'main' },
        { data_table_id: 't_detail', table_name: '明细表', table_role: 'detail' }
      ],
      {
        t_main: [field('f_m_text', '主表文本', 'text'), field('f_m_number', '主表数值', 'number')],
        t_detail: [field('f_d_text', '明细文本', 'text')]
      }
    );
    return loadTemplateFieldCatalog(host, 'tpl_sample');
  }

  it('mainTableOf 取到主表；catalog 为 null 时返回 undefined', async () => {
    const catalog = await buildSampleCatalog();
    expect(mainTableOf(catalog)?.tableId).toBe('t_main');
    expect(mainTableOf(null)).toBeUndefined();
  });

  it('detailTablesOf 只回扩展表；catalog 为 null 时返回空数组', async () => {
    const catalog = await buildSampleCatalog();
    expect(detailTablesOf(catalog).map((t) => t.tableId)).toEqual(['t_detail']);
    expect(detailTablesOf(null)).toEqual([]);
  });

  it("fieldsOfType(..., 'text', { mainOnly: true }) 只回主表文本字段，不含明细表的同类型字段", async () => {
    const catalog = await buildSampleCatalog();
    const result = fieldsOfType(catalog, 'text', { mainOnly: true });
    expect(result.map((f) => f.fieldId)).toEqual(['f_m_text']);
  });

  it("fieldsOfType(..., 'text') 不传 mainOnly 时跨表返回", async () => {
    const catalog = await buildSampleCatalog();
    const result = fieldsOfType(catalog, 'text');
    expect(result.map((f) => f.fieldId).sort()).toEqual(['f_d_text', 'f_m_text']);
  });

  it('fieldsOfType(null, ...) 返回空数组', () => {
    expect(fieldsOfType(null, 'text')).toEqual([]);
  });
});
