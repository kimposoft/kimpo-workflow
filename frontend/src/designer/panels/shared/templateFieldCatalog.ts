/**
 * designer/panels/shared/templateFieldCatalog.ts —— 共享「模板字段目录」取数件。
 *
 * 背景：办理节点「回退时清空字段」、子流程「传递字段」、字段权限对话框三处面板都需要整份模板的
 * 字段目录（主表 + 全部扩展表），其中子流程还要再取「目标模板」的目录。本文件把 listTemplateTables +
 * 逐表 listTemplateFields 的取数、已退役字段类型过滤、模板级缓存统一收口，避免三处面板各写
 * 一遍、各发一遍请求。
 *
 * 主表判定口径沿用 MainFieldSelect.vue：`(table_role ?? '').trim().toLowerCase() === 'main'`
 * （大小写不敏感，对齐后端 TableRoleMain 用 strings.EqualFold 比较）。
 *
 * 空态/失败口径（同 MainFieldSelect.vue 既定风格）：templateId 为空/纯空白不发请求；任一请求
 * error 或无 data → 整体返回 null，技术细节只进 console.error，不抛异常。本件不产出任何界面
 * 文案（不出四语 key），空态提示由消费方面板卡自行决定怎么说。
 */
import { inject, ref, watch, type Ref } from 'vue';
import { DESIGNER_HOST_KEY, type DesignerHost, type WorkflowDesignerTemplateField, type WorkflowDesignerTemplateTable } from '../../host';

/**
 * 已退役字段类型：宿主已退役 boolean / date 两档字段类型（只禁新建与作为变更目标，读兼容保留），
 * 新链路不得把这两档纳入可引用或可换算范围。逐表拉字段时直接滤掉，消费方面板拿到的目录里天然
 * 不会出现这两档，不需要各自再判一遍。权威判定在宿主后端（插件不能引用宿主实现），这里按两个
 * 取值字面量比较，与宿主判据在语义上对齐。
 */
export const RETIRED_FIELD_DATA_TYPES: readonly string[] = ['boolean', 'date'];

/** 目录里的单个字段——在 host wire 字段基础上叠加它所属表的信息，供跨表铺平（byFieldId）后仍能
 *  区分来源表；isMain 与所属 CatalogTable.isMain 保持一致，冗余存一份是为了按字段反查时不用再
 *  绕回 tableId 查表。 */
export interface CatalogFieldItem {
  fieldId: string;
  fieldName: string;
  dataType: string;
  tableId: string;
  tableName: string;
  isMain: boolean;
}

/** 目录里的单张表及其（已滤掉退役类型的）字段列表。 */
export interface CatalogTable {
  tableId: string;
  tableName: string;
  isMain: boolean;
  fields: CatalogFieldItem[];
}

/** 整份模板字段目录：tables 主表恒排第一、其余保持宿主 listTemplateTables 返回顺序；byFieldId 是
 *  跨表铺平后的 field_id → 字段项映射，供按 id 直接反查字段名/类型/所属表（子流程「传递字段」、
 *  字段权限对话框按 id 回显等场景的常见需求）。 */
export interface TemplateFieldCatalog {
  templateId: string;
  tables: CatalogTable[];
  byFieldId: Map<string, CatalogFieldItem>;
}

/** loadTemplateFieldCatalog / getTemplateFieldCatalog 只用得到宿主这两个方法，收窄成 Pick 类型
 *  而不要求整份 DesignerHost——测试用手写假对象即可，不需要拼一份 fakeHost() 的全部方法；真实
 *  调用方直接传 DesignerHost 实例，结构兼容。 */
export type TemplateFieldCatalogHost = Pick<DesignerHost, 'listTemplateTables' | 'listTemplateFields'>;

/** 主表判定：与 MainFieldSelect.vue 同一口径（大小写不敏感）。 */
function isMainTable(table: WorkflowDesignerTemplateTable): boolean {
  return (table.table_role ?? '').trim().toLowerCase() === 'main';
}

/** 已退役字段类型判定：data_type 命中 RETIRED_FIELD_DATA_TYPES 即视为退役（大小写不敏感兜底）。 */
function isRetiredFieldDataType(dataType: string): boolean {
  return RETIRED_FIELD_DATA_TYPES.includes(dataType.trim().toLowerCase());
}

function toCatalogField(field: WorkflowDesignerTemplateField, table: WorkflowDesignerTemplateTable, tableIsMain: boolean): CatalogFieldItem {
  return {
    fieldId: field.field_id,
    fieldName: field.field_name,
    dataType: field.data_type,
    tableId: table.data_table_id,
    tableName: table.table_name,
    isMain: tableIsMain
  };
}

/**
 * 取整份模板字段目录（不带缓存的底层实现，缓存包装见 getTemplateFieldCatalog）：
 *   1) host.listTemplateTables(templateId) 取表清单；
 *   2) 对每张表并发 host.listTemplateFields(templateId, tableId)；
 *   3) 任一请求 error/无 data → 整体 null；
 *   4) 已退役字段类型（boolean/date）被滤掉；
 *   5) 主表排第一，其余保持宿主返回顺序（Array.prototype.sort 自 ES2019 起规范保证稳定，不需要
 *      额外手写稳定排序）。
 * templateId 为空/纯空白 → 直接 null，不发任何请求（同 MainFieldSelect.vue「还没有可用的目标
 * 表单」空态口径）。
 */
export async function loadTemplateFieldCatalog(host: TemplateFieldCatalogHost, templateId: string): Promise<TemplateFieldCatalog | null> {
  if (!templateId.trim()) return null;

  try {
    const tablesResult = await host.listTemplateTables(templateId);
    if (tablesResult.error || !tablesResult.data) {
      return null;
    }
    const wireTables = tablesResult.data.items;

    // 逐表并发取字段；Promise.all 对逐个 await 也是"取不到就整体判失败"（各 listTemplateFields
    // 内部按 HostApiResult 信封回错误而不是 reject，因此这里不依赖 Promise.all 的 fail-fast
    // reject 语义，而是取全部结果后统一检查 error/data）。
    const fieldsResults = await Promise.all(wireTables.map((table) => host.listTemplateFields(templateId, table.data_table_id)));
    if (fieldsResults.some((r) => r.error || !r.data)) {
      return null;
    }

    const byFieldId = new Map<string, CatalogFieldItem>();
    const tables: CatalogTable[] = wireTables.map((table, idx) => {
      const tableIsMain = isMainTable(table);
      const fields = fieldsResults[idx]!
        .data!.items.filter((f) => !isRetiredFieldDataType(f.data_type))
        .map((f) => toCatalogField(f, table, tableIsMain));
      for (const field of fields) byFieldId.set(field.fieldId, field);
      return { tableId: table.data_table_id, tableName: table.table_name, isMain: tableIsMain, fields };
    });

    // 稳定排序把主表挪到最前，其余表之间的相对顺序不变。
    tables.sort((a, b) => Number(b.isMain) - Number(a.isMain));

    return { templateId, tables, byFieldId };
  } catch (err) {
    // 技术细节只进控制台（硬约束：业务界面不出错误码/JSON 结构），网络异常等非 HostApiResult
    // 信封内的失败也走这里统一兜底成 null。
    console.error('[kimpo-workflow] templateFieldCatalog 取模板字段目录失败', err);
    return null;
  }
}

// ── 模块级缓存：键为 templateId，值为进行中/已完成的目录 Promise ──────────────────────────
// 失败（resolve 成 null）的结果不留在缓存里，见 getTemplateFieldCatalog 内的处理——下次再取要
// 能重试，不能让一次网络抖动把这个 templateId 永久钉在"取不到"上。
const catalogCache = new Map<string, Promise<TemplateFieldCatalog | null>>();

/** 失效缓存；不传 templateId 清空全部（模板列表整体刷新等场景），传了只清那一个模板。 */
export function invalidateTemplateFieldCatalog(templateId?: string): void {
  if (templateId === undefined) {
    catalogCache.clear();
    return;
  }
  catalogCache.delete(templateId);
}

/** 带缓存的目录入口：命中缓存直接复用同一个 Promise（含"进行中"的 Promise，保证并发两次同键
 *  调用只发一轮请求）；结果为 null（失败）时不留在缓存里，供下次调用重试。 */
export function getTemplateFieldCatalog(host: TemplateFieldCatalogHost, templateId: string): Promise<TemplateFieldCatalog | null> {
  const cached = catalogCache.get(templateId);
  if (cached) return cached;

  const pending = loadTemplateFieldCatalog(host, templateId).then((catalog) => {
    if (catalog === null) {
      catalogCache.delete(templateId);
    }
    return catalog;
  });
  catalogCache.set(templateId, pending);
  return pending;
}

/** 目录里的主表（至多一张，找不到时 undefined——理论上正常发布的模板恒有一张主表，但目录可能是
 *  取失败留下的 null，调用方按 catalog 判空即可）。 */
export function mainTableOf(catalog: TemplateFieldCatalog | null): CatalogTable | undefined {
  return catalog?.tables.find((t) => t.isMain);
}

/** 目录里的全部扩展表（非主表），保持目录里的顺序。 */
export function detailTablesOf(catalog: TemplateFieldCatalog | null): CatalogTable[] {
  return catalog?.tables.filter((t) => !t.isMain) ?? [];
}

/** 按 data_type 筛字段；options.mainOnly 为 true 时只在主表范围内找（如「回退时清空字段」等只
 *  允许挂主表字段的场景）。catalog 为 null 时返回空数组，调用方不需要额外判空。 */
export function fieldsOfType(catalog: TemplateFieldCatalog | null, dataType: string, options?: { mainOnly?: boolean }): CatalogFieldItem[] {
  if (!catalog) return [];
  const tables = options?.mainOnly ? catalog.tables.filter((t) => t.isMain) : catalog.tables;
  return tables.flatMap((t) => t.fields.filter((f) => f.dataType === dataType));
}

// ── Vue 组合式：带 loading/failed 状态 + 防陈旧回写的响应式包装 ────────────────────────────

/** templateId 来源：可以是一个 Ref（父组件直接绑定 props.templateId），也可以是一个取值函数
 *  （父组件想从多个字段拼一个"当前应联动的模板 id"时更灵活）。 */
export type TemplateIdSource = Ref<string | undefined> | (() => string | undefined);

function resolveTemplateId(source: TemplateIdSource): string | undefined {
  return typeof source === 'function' ? source() : source.value;
}

export interface UseTemplateFieldCatalogResult {
  catalog: Ref<TemplateFieldCatalog | null>;
  loading: Ref<boolean>;
  failed: Ref<boolean>;
  reload: () => Promise<void>;
}

/**
 * 供面板卡直接消费的组合式函数：watch templateId（immediate），经 getTemplateFieldCatalog 带缓存
 * 取目录，暴露 catalog/loading/failed 三个响应式状态 + reload()（先失效本键缓存再重取，用于用户
 * 主动刷新/模板重新发布后的显式重拉）。
 *
 * 防陈旧回写：templateId 在请求途中变化时，旧请求晚到达也不得覆盖新请求已经写回的结果——用一个
 * 递增序号判定，只有发起时序号仍是"当前最新"的那次响应才写回 catalog/loading/failed（子流程
 * 「目标模板」下拉这类场景比 MainFieldSelect.vue 服务的单表场景更容易触发用户快速切换）。
 */
export function useTemplateFieldCatalog(templateId: TemplateIdSource): UseTemplateFieldCatalogResult {
  const host = inject(DESIGNER_HOST_KEY);
  const catalog = ref<TemplateFieldCatalog | null>(null) as Ref<TemplateFieldCatalog | null>;
  const loading = ref(false);
  const failed = ref(false);

  let requestSeq = 0;

  async function run(id: string | undefined): Promise<void> {
    const mySeq = ++requestSeq;
    catalog.value = null;
    failed.value = false;
    if (!host || !id?.trim()) {
      return;
    }

    loading.value = true;
    try {
      const result = await getTemplateFieldCatalog(host, id);
      if (mySeq !== requestSeq) return; // 陈旧响应：期间 templateId 又变了，丢弃不写回。
      catalog.value = result;
      failed.value = result === null;
    } finally {
      if (mySeq === requestSeq) loading.value = false;
    }
  }

  watch(() => resolveTemplateId(templateId), (next) => void run(next), { immediate: true });

  async function reload(): Promise<void> {
    const id = resolveTemplateId(templateId);
    if (id?.trim()) invalidateTemplateFieldCatalog(id);
    await run(id);
  }

  return { catalog, loading, failed, reload };
}
