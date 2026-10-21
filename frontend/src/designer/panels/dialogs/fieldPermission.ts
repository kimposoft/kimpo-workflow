/**
 * panels/dialogs/fieldPermission.ts —— 字段权限对话框的纯函数层（可编辑型四档 / 只看型
 * 三档）。
 *
 * 同 ApprovePanel.vue 顶部普通 <script> 块的既定手法：把"值怎么编码/解码/合并"这件事抽成不依赖
 * Vue 的纯函数，单测直接覆盖；FieldPermissionDialog.vue 只负责"把数据画出来、接宿主取字段目录/
 * 限制对照"，两者职责分离。
 *
 * 🔴 草稿 Map 的 value 是 { tableId, grade } 二元组（FieldGradeEntry），而不是单纯的 FieldGrade：
 * "目录里已不存在的字段原样保留在清单末尾（不静默丢）"要求保留该字段原来的 table_id（目录里已经
 * 找不到它所在的表，没有别的地方能补出来）。语义仍是"fieldId → 当前档位"的草稿态，多带的
 * table_id 供孤儿字段写回时不至于丢失。
 */
import type { FieldGrade, FieldPermission } from '../../../model';
import type { CatalogFieldItem, TemplateFieldCatalog } from '../shared/templateFieldCatalog';
import type { WorkflowDesignerFieldRestriction } from '../../host';

/** 草稿态一条记录：所属表 id + 当前档位。永远不会存 'inherit'——'inherit' 等价于"没有这一条"，
 *  见 fromGradeMap/toGradeMap 的处理。 */
export interface FieldGradeEntry {
  tableId: string;
  grade: FieldGrade;
}

/** 草稿态：fieldId → FieldGradeEntry。只存"偏离继承"的字段，未出现在 Map 里的字段按 'inherit'
 *  处理（草稿态与已保存清单同一口径）。 */
export type FieldGradeMap = Map<string, FieldGradeEntry>;

/** 档位可选集合：可编辑型四档；只看型不出「可编辑」——这类节点
 *  不改内容，继承到模板"编辑"档时按只读生效，界面上就不该让设计者选一个不会生效的档位。 */
export function gradesFor(readonlyOnly: boolean): FieldGrade[] {
  return readonlyOnly ? ['inherit', 'readonly', 'hidden'] : ['inherit', 'edit', 'readonly', 'hidden'];
}

/**
 * 已保存清单 → 草稿 Map。Map 的插入顺序＝入参清单的"首次出现顺序"（JS Map 语义：对已存在的 key
 * 再次 set() 只更新 value，不改变其在迭代顺序里的位置），这恰好同时满足"去重（后写覆盖）"与
 * "顺序稳定"两条要求，不需要额外写一段稳定排序逻辑。
 */
export function toGradeMap(perms: FieldPermission[] | undefined): FieldGradeMap {
  const map: FieldGradeMap = new Map();
  for (const p of perms ?? []) {
    map.set(p.field_id, { tableId: p.table_id, grade: p.grade });
  }
  return map;
}

/**
 * 草稿 Map → 待写回清单。两段拼接：
 *   1) 按目录顺序（主表在前，见 templateFieldCatalog.ts）遍历目录里"当前仍存在"的字段，命中草稿
 *      且非 'inherit' 才入清单——这保证了"清单只存偏离继承的项"与"输出顺序按目录顺序、不产生
 *      无意义 diff"两条要求；
 *   2) 草稿里"目录已经没有这个字段"的记录（用户此前设置过、后来字段被删/表被删）原样追加在末尾，
 *      按草稿 Map 的迭代顺序（=原清单顺序，不静默丢）。
 * catalog 为 null（目录取失败/尚在加载）时第 1 段跳过，全部草稿记录都落进第 2 段——这是保守选择：
 * 目录取不到时不应该把用户已经设置过的东西当成"已不存在"擅自清空。
 */
export function fromGradeMap(map: FieldGradeMap, catalog: TemplateFieldCatalog | null): FieldPermission[] {
  const result: FieldPermission[] = [];
  const consumedFieldIds = new Set<string>();

  if (catalog) {
    for (const table of catalog.tables) {
      for (const field of table.fields) {
        consumedFieldIds.add(field.fieldId);
        const entry = map.get(field.fieldId);
        if (!entry || entry.grade === 'inherit') continue;
        result.push({ table_id: table.tableId, field_id: field.fieldId, grade: entry.grade });
      }
    }
  }

  for (const [fieldId, entry] of map) {
    if (consumedFieldIds.has(fieldId)) continue;
    if (entry.grade === 'inherit') continue; // 理论不会发生（'inherit' 从不写进草稿），防御性处理
    result.push({ table_id: entry.tableId, field_id: fieldId, grade: entry.grade });
  }

  return result;
}

/**
 * 只看型兼容：草稿里若有 'edit' 档（历史数据，或从可编辑型节点复制配置带过来的），在只看型对话框
 * 里一律按"只读"显示——只看型的口径是"继承到编辑档时按只读生效"，这里推广到"哪怕本节点
 * 自己显式设了 edit，一样按只读处理"，保证只看型对话框里不会出现一个渲染不出来（gradesFor(true)
 * 里没有这个选项）的选中值。返回新 Map，不修改入参（纯函数）。
 */
export function normalizeForReadonlyOnly(map: FieldGradeMap): FieldGradeMap {
  const result: FieldGradeMap = new Map();
  for (const [fieldId, entry] of map) {
    result.set(fieldId, entry.grade === 'edit' ? { ...entry, grade: 'readonly' } : entry);
  }
  return result;
}

/** 模板限制对照口径：本字段在挂着的模板授权项里是否已被设过隐藏/只读——用于对话框「模板限制
 *  对照列」与"设为编辑不会生效"的冲突提示。 */
export type FieldRestrictionKind = 'none' | 'templateHidden' | 'templateReadonly';

export interface FieldPermissionHint {
  kind: FieldRestrictionKind;
  /** true＝当前档位与模板限制冲突（模板已隐藏/只读，本步骤却设为"可编辑"，不会生效）。 */
  warn: boolean;
}

/** restriction 为 undefined（取不到限制对照，或该字段未命中任何限制）时按"无限制"处理；hidden
 *  优先于 readonly（同一字段两者都命中时，隐藏是更强的限制，对照列展示更强的那一档）。 */
export function effectiveHint(grade: FieldGrade, restriction: WorkflowDesignerFieldRestriction | undefined): FieldPermissionHint {
  if (!restriction || (!restriction.hidden && !restriction.readonly)) {
    return { kind: 'none', warn: false };
  }
  const kind: FieldRestrictionKind = restriction.hidden ? 'templateHidden' : 'templateReadonly';
  return { kind, warn: grade === 'edit' };
}

/**
 * 批量设档：对 fieldIds 逐个写入 grade（'inherit' 等价于从草稿里删除该条）。newTableIdOf 用于
 * 给"此前不在草稿里的字段"补上 table_id（草稿新增记录必须带 table_id，见 FieldGradeEntry）——
 * 调用方（对话框组件）传目录的 byFieldId 反查函数；查不到时（理论不会发生：批量操作的候选恒来自
 * 目录本身）落空串兜底，不抛异常。返回新 Map，不修改入参。
 */
export function applyBulk(map: FieldGradeMap, fieldIds: string[], grade: FieldGrade, newTableIdOf: (fieldId: string) => string | undefined): FieldGradeMap {
  const result: FieldGradeMap = new Map(map);
  for (const fieldId of fieldIds) {
    if (grade === 'inherit') {
      result.delete(fieldId);
      continue;
    }
    const tableId = newTableIdOf(fieldId) ?? result.get(fieldId)?.tableId ?? '';
    result.set(fieldId, { tableId, grade });
  }
  return result;
}

/** 按字段名不区分大小写包含匹配；空关键字（含纯空白）视为"全部命中"。 */
export function matchKeyword(field: Pick<CatalogFieldItem, 'fieldName'>, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return field.fieldName.toLowerCase().includes(kw);
}

/** 三档计数（只统计 edit/readonly/hidden，'inherit' 不计——清单本就不存 inherit 记录）：供摘要
 *  组件"已单独设置 N 项"下方的分档小计使用。 */
export interface FieldGradeCounts {
  edit: number;
  readonly: number;
  hidden: number;
}

export function gradeCounts(perms: FieldPermission[] | undefined): FieldGradeCounts {
  const counts: FieldGradeCounts = { edit: 0, readonly: 0, hidden: 0 };
  for (const p of perms ?? []) {
    if (p.grade === 'edit') counts.edit++;
    else if (p.grade === 'readonly') counts.readonly++;
    else if (p.grade === 'hidden') counts.hidden++;
  }
  return counts;
}
