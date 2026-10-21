/**
 * designer/expression/v4Scope.ts —— 把 V4 表达式作用域收窄到「只有主表」（步骤摘要与引导线条件
 * 的可引用范围都只到本报表主表，不含扩展表/明细表；条件不填即无条件，恒可走）。
 *
 * 本文件只做两件与「主表」相关的事，供 V4ExpressionField.vue 与办理人来源里的「主表字段」来源
 * 共同复用（不各写一份取主表字段的逻辑）：
 *   ① mainTemplateIdOf —— 从当前文档的发起节点配置里取「目标模板」，这是本文档唯一的目标模板，
 *      也是「主表」概念的锚点（发起节点未配置目标模板时，本文档还没有主表可言，返回空串）。
 *   ② useMainTableScope —— 按 templateId 向宿主要主表 + 主表字段，组装出两种下游都要用的形状：
 *      - formTables：喂 AdvancedExpressionPanel 的 formTables prop（表达式编辑器的字段树/⊞ 拾取）；
 *      - toHostScope()：喂 AliceV4Host.setScope 的入参——sources 与非主表来源恒不下发，作用域外的
 *        字段天然在编辑器里引用不到，不需要在 UI 层另做一次「只允许选主表」的过滤。
 */
import { shallowRef, watch, type Ref } from 'vue';
import {
  reportInstanceId,
  type AliceV4Host,
  type FormTableLite,
  type TemplateDataTable,
  type TemplateField,
  type V4HostScope
} from '@kimposoft/expression-editor';
import type { StartConfig, WorkflowDocument } from '../../model';
import type { DesignerHost, WorkflowDesignerTemplateField, WorkflowDesignerTemplateTable } from '../host';

/** 从文档的发起节点配置取「目标模板」id；发起节点尚未配置目标模板（或文档还没有发起节点，理论
 *  上不会发生，Decode 校验恒有且只有一个 start）时返回空串——调用方按空串＝「本文档尚无主表可
 *  引用」处理（禁用表达式编辑入口）。 */
export function mainTemplateIdOf(doc: WorkflowDocument | undefined): string {
  const start = doc?.nodes.find((n) => n.kind === 'start');
  const config = start?.config as StartConfig | undefined;
  return config?.target_template_id ?? '';
}

/** 主表信息 + 已组装好的 formTables（恒单元素数组：只有主表）。 */
export interface MainTableScope {
  table: WorkflowDesignerTemplateTable;
  fields: WorkflowDesignerTemplateField[];
  formTables: FormTableLite[];
}

/** 把 MainTableScope 翻成 AliceV4Host.setScope 的入参：来源表（sources）恒空，本报表来源只放主表
 *  一张，table_role 恒 'main'（本文件只处理主表，不存在别的档）。instance_id 走共享包
 *  reportInstanceId 的确定性派生，与取数/条件分支等既有链路同一口径（见其头注释）。 */
export function toHostScope(scope: MainTableScope): V4HostScope {
  return {
    sources: [],
    report_sources: [
      {
        instance_id: reportInstanceId({ alias: scope.table.table_name, data_table_id: scope.table.data_table_id }),
        table_id: scope.table.data_table_id,
        table_role: 'main',
        alias: scope.table.table_name
      }
    ]
  };
}

/** WorkflowDesignerTemplateField（本插件设计面窄类型）→ 共享包 TemplateField：只有 field_id/
 *  field_name/data_type 是真实数据，其余字段共享包类型要求但运行时不消费（见 rawSerialize.ts
 *  fieldName() 只读 field_id/field_name），占位即可，不影响任何已知渲染/序列化路径。 */
function toPackageField(field: WorkflowDesignerTemplateField): TemplateField {
  return {
    field_id: field.field_id,
    field_code: field.field_id,
    field_name: field.field_name,
    data_type: field.data_type,
    display_style: '',
    sort_no: 0,
    is_searchable: false,
    is_filterable: false,
    is_sortable: false,
    is_list_visible: true
  };
}

/** WorkflowDesignerTemplateTable → 共享包 TemplateDataTable，占位字段同上（table_code/
 *  physical_table_name/version_no 共享包类型要求但运行时不消费，见 v4Scope.ts 头注释）。 */
function toPackageTable(table: WorkflowDesignerTemplateTable, fieldCount: number): TemplateDataTable {
  return {
    data_table_id: table.data_table_id,
    table_code: table.data_table_id,
    table_name: table.table_name,
    physical_table_name: '',
    table_role: table.table_role,
    sort_no: 0,
    field_count: fieldCount,
    version_no: 0
  };
}

/**
 * useMainTableScope —— 按 templateId（Ref，变化时自动重取）向宿主要主表 + 主表字段，组装
 * MainTableScope。拉取中/模板未发布或查不到主表/请求失败时 scope.value 为 undefined，调用方据此
 * 禁用表达式编辑入口（同「模板未发布」的既定降级口径，见 host.ts WorkflowDesignerTemplateDetail
 * 头注释）。templateId 在请求进行中又变化时，丢弃过期请求的结果，不回填陈旧数据。
 */
export function useMainTableScope(host: DesignerHost, templateId: Ref<string>): { scope: Ref<MainTableScope | undefined> } {
  const scope = shallowRef<MainTableScope | undefined>(undefined);
  watch(
    templateId,
    async (id) => {
      scope.value = undefined;
      if (!id) return;
      try {
        const tablesRes = await host.listTemplateTables(id);
        if (templateId.value !== id) return;
        const mainTable = tablesRes.data?.items.find((t) => t.table_role === 'main');
        if (!mainTable) return;

        const fieldsRes = await host.listTemplateFields(id, mainTable.data_table_id);
        if (templateId.value !== id) return;
        const fields = fieldsRes.data?.items ?? [];

        const formTable: FormTableLite = {
          table: toPackageTable(mainTable, fields.length),
          fields: fields.map(toPackageField),
          alias: 'bt0'
        };
        scope.value = { table: mainTable, fields, formTables: [formTable] };
      } catch {
        // 静默降级：调用方按 scope 缺席（模板未发布/表目录暂不可用）禁用编辑入口，不额外报错打扰。
        scope.value = undefined;
      }
    },
    { immediate: true }
  );
  return { scope };
}
