/**
 * designer/panels/shared/subflowMapping.ts —— 子流程节点属性面板的纯函数部分：传递字段（source→target）的写回口径 / NSelect 选项值编解码 /
 * 已存字段反查 / 类型兼容过滤 / 同表约束 / 末级节点判定 / 等待档切换时的处置字段
 * 联动。抽成纯函数是本插件既定手法（本插件前端未装 @vue/test-utils，见 ./ccSections.ts 同处
 * 注释与 ../ApprovePanel.vue 头注释）。
 */
import type { CatalogFieldItem, TemplateFieldCatalog } from './templateFieldCatalog';
import type { NodeKind, SubflowConfig, SubflowFieldMapping, WorkflowDocument } from '../../../model';

// ── 写回口径：主表字段落空串，扩展表字段落该表 tableId ────────────────────────────────

/**
 * 传递字段『来源』写回 SubflowFieldMapping.source_table_id 的口径：主表字段落空串 `''`；扩展表字段落该表的 tableId。本函数是这条口径的唯一
 * 权威实现，本文件与消费方（MappingRows.vue）都只应经它写这个字段，不各自散落一份 isMain 判断。
 */
export function sourceKeyOf(field: CatalogFieldItem): string {
  return field.isMain ? '' : field.tableId;
}

/** 由「来源字段 + 目标字段」组装一条完整的传递字段映射。 */
export function mappingFromSourceKey(sourceTableId: string, sourceFieldId: string, targetFieldId: string): SubflowFieldMapping {
  return { source_table_id: sourceTableId, source_field_id: sourceFieldId, target_field_id: targetFieldId };
}

// ── NSelect『来源字段』下拉选项值编解码（分组下拉需要跨表唯一的 value，field_id 单独作 value 在
// 理论上足够唯一，但为了防御同 field_id 出现在不同模板/历史脏数据里的极端情况，仍按"表标识+字段
// id"编码，同 ../ApprovePanel.vue encodeClearFieldKey 的既定手法，分隔符同款 `::`） ───────────────

const SOURCE_OPTION_SEP = '::';

/** 编码 NSelect 选项 value：`sourceKeyOf(field) + '::' + field.fieldId`（主表字段前缀为空串，
 *  编码结果形如 `::f_xxx`，与扩展表字段 `t_detail::f_xxx` 在字符串层面天然不冲突）。 */
export function encodeSourceOptionValue(field: CatalogFieldItem): string {
  return `${sourceKeyOf(field)}${SOURCE_OPTION_SEP}${field.fieldId}`;
}

/** 解码 NSelect 选项 value；解不出（不含分隔符的野值）返回 undefined，调用方按"这次选择丢弃"
 *  处理，不抛错。 */
export function decodeSourceOptionValue(value: string): { sourceTableId: string; fieldId: string } | undefined {
  const idx = value.indexOf(SOURCE_OPTION_SEP);
  if (idx < 0) return undefined;
  return { sourceTableId: value.slice(0, idx), fieldId: value.slice(idx + SOURCE_OPTION_SEP.length) };
}

// ── 已存字段反查："字段已不存在"占位判定 ───────────────────────────────────────────────────

/** 按写回口径反查一条映射的来源字段：先按 field_id 在目录里查到字段，再校验它所属表的
 *  sourceKeyOf 是否与映射记录的 source_table_id 一致（防御脏数据——例如字段被删除后又在别的表
 *  重建出同名 id 的极端场景，不一致时按"找不到"处理，不冒用一个来源不对的字段）。目录为 null
 *  （尚未加载/加载失败）时统一返回 undefined，调用方按"目录未就绪"与"字段真的不存在"合并展示
 *  为同一种占位（消费方另按 catalog 是否为 null 决定是显示加载态还是"字段已不存在"）。 */
export function resolveSourceField(mapping: SubflowFieldMapping, catalog: TemplateFieldCatalog | null): CatalogFieldItem | undefined {
  const field = catalog?.byFieldId.get(mapping.source_field_id);
  if (!field) return undefined;
  return sourceKeyOf(field) === mapping.source_table_id ? field : undefined;
}

/** 按 field_id 在目标模板『主表字段』清单里反查一条映射的目标字段；找不到（字段已不存在/已不是
 *  主表字段）返回 undefined。 */
export function resolveTargetField(mapping: SubflowFieldMapping, targetMainFields: CatalogFieldItem[]): CatalogFieldItem | undefined {
  return targetMainFields.find((f) => f.fieldId === mapping.target_field_id);
}

// ── 目标字段类型兼容过滤 ────────────────────────────────────────────────────────────────

/** data_type 归一化比较（大小写不敏感，同 templateFieldCatalog.ts isRetiredFieldDataType 的既定
 *  口径）。 */
function normalizedType(dataType: string): string {
  return dataType.trim().toLowerCase();
}

/** 目标字段候选：只列「与来源同类型」或「文本类型」的目标主表字段。
 *  来源未选中（sourceField 为 undefined）时返回空数组，调用方据此把目标下拉置灰。 */
export function compatibleTargets(sourceField: CatalogFieldItem | undefined, targetMainFields: CatalogFieldItem[]): CatalogFieldItem[] {
  if (!sourceField) return [];
  const sourceType = normalizedType(sourceField.dataType);
  return targetMainFields.filter((f) => {
    const targetType = normalizedType(f.dataType);
    return targetType === sourceType || targetType === 'text';
  });
}

// ── 同表约束：所有来源必须来自主表和同一张扩展表 ───────────────────────────────────────

/**
 * 找出违反"传递字段只能来自主表和同一张明细表"的行下标：按 mappings 顺序扫描，第一个
 * 出现的非空 source_table_id（即第一张被引用到的扩展表）定为"允许的那张扩展表"，之后任何
 * source_table_id 非空且与它不同的行都计入冲突清单；主表字段（source_table_id===''）恒不冲突。
 * 只做提示、不拦保存（发布期由后端 N6_MAPPING_MULTI_TABLE 校验兜底），因此返回值只是下标清单，
 * 不是布尔拦截结果。
 */
export function detailTableConflicts(mappings: SubflowFieldMapping[]): number[] {
  let allowedDetailTableId: string | undefined;
  const conflicts: number[] = [];
  mappings.forEach((mapping, index) => {
    const tableId = mapping.source_table_id;
    if (!tableId) return; // 主表字段，不参与"同一张扩展表"约束。
    if (allowedDetailTableId === undefined) {
      allowedDetailTableId = tableId;
      return;
    }
    if (tableId !== allowedDetailTableId) conflicts.push(index);
  });
  return conflicts;
}

// ── 末级节点判定：本节点全部出边都指向结束节点，或没有出边 ────────────────────────────

/**
 * 判定子流程节点是否处于"末级"位置（末级节点只能选『不等待』）：该节点全部出边（links 里
 * from===nodeId 的记录）的终点都是 kind==='end' 的节点，或者该节点没有任何出边——两种情况都视为
 * "往后走不出主线分支"，等价于末级。只要存在至少一条出边指向非 end 节点，就不是末级。
 */
export function isTerminalSubflow(doc: Pick<WorkflowDocument, 'nodes' | 'links'>, nodeId: string): boolean {
  const outgoing = doc.links.filter((link) => link.from === nodeId);
  if (outgoing.length === 0) return true;
  const kindOf = new Map<string, NodeKind>(doc.nodes.map((n) => [n.id, n.kind]));
  return outgoing.every((link) => kindOf.get(link.to) === 'end');
}

// ── 目标流程下拉排除自己（输入来自 host.ts DesignerHost.definitionId） ─────────────────────

/**
 * 从『目标流程』候选里排除当前正在设计的这条流程自己（避免设计中的流程把自己设为子流程目标、
 * 造成自环）。selfId 为空（未知当前定义 id：新建尚未保存过的流程、老宿主未升级 hostContext 不带
 * 这个键）时原样返回、不做任何排除——没有 id 可比较，"排除自己"无从谈起，不能把整份候选清空。
 */
export function excludeSelf<T extends { definition_id: string }>(definitions: T[], selfId: string | undefined): T[] {
  if (!selfId) return definitions;
  return definitions.filter((d) => d.definition_id !== selfId);
}

// ── 等待方式切换时的处置字段联动 ────────────────────────────────────────────────────────────

/**
 * 切换『是否等待』时的 disposition 联动：
 *   - 切到 wait=true（等待）：disposition 在 wait===true 时没有意义，联动清空（写 undefined，
 *     JSON.stringify 序列化时会连键一并丢弃——见 SubflowConfig.disposition 是可选字段，不要求
 *     "未配置"落 null，与 CCConfig 那两个必填表达式槽是两种不同的 wire 口径，不能混用）；
 *   - 切到 wait=false（不等待）：补默认 'ignore'（若已有值则保留，避免覆盖用户此前设置过的
 *     'force_end'——例如先设过一次不等待+强制结束，切去等待又切回来，应该记得原先的选择）。
 */
export function applyWaitToggle(config: Pick<SubflowConfig, 'disposition'>, wait: boolean): Partial<SubflowConfig> {
  if (wait) {
    return { wait: true, disposition: undefined };
  }
  return { wait: false, disposition: config.disposition ?? 'ignore' };
}
