/**
 * panels/shared/startGrant.ts —— OrgTriLine.vue 主表字段档（StartGrant.main_field_id/match_by）
 * 的纯逻辑层：与 Vue 组件（事件绑定/模板）分离，供
 * 单测直接覆盖——同 ./assigneeSource.ts「AssigneeSourceList.vue 的纯逻辑层」既定分工（NSelect
 * 的下拉选项在 happy-dom 下无法真正弹出/点选，见 MainFieldSelect.vue 头注释与
 * EndPanel.test.ts/ApprovePanel.test.ts 既定口径；本模块把"值怎么合并/覆盖"这件事抽成纯函数，
 * 绕开这条测不到的路径，组件层只保留一行透传）。
 *
 * 所有函数都不改入参，返回新对象（同 assigneeSource.ts 的既定风格），且都先展开 `...grant` 再
 * 覆盖具体字段——这是最容易漏的一处：OrgTriLine.vue 整对象
 * 覆盖写回 StartGrant 时，若不先展开原值，会把当前没在改的那几组来源（三维选择器的三个数组，或
 * 主表字段档自己的 main_field_id/match_by）互相冲掉。
 */
import type { AssigneeMatchBy, StartGrant } from '../../../model';

/** 选中/清空主表字段：选中（fieldId 非空）才写回 main_field_id，match_by 缺省按用户名（同『人员
 *  来源』里主表字段来源的默认口径）；清空（fieldId 为空/undefined，如 NSelect 的清除图标）时把
 *  main_field_id/match_by 一并置 undefined，不写空串——是否保留"这一行还开着"的草稿态是
 *  OrgTriLine.vue 自己的本地 UI 状态（mainFieldDraftOpen），本函数只管 modelValue 本身。 */
export function setMainField(grant: StartGrant, fieldId: string | undefined): StartGrant {
  if (!fieldId) return { ...grant, main_field_id: undefined, match_by: undefined };
  return { ...grant, main_field_id: fieldId, match_by: grant.match_by ?? 'display_name' };
}

/** 改匹配方式（按用户名 / 按登录名）；不影响其余任何字段。 */
export function setMatchBy(grant: StartGrant, matchBy: AssigneeMatchBy): StartGrant {
  return { ...grant, match_by: matchBy };
}

/** 删除主表字段档（行尾 ×）：main_field_id 与 match_by 一并去掉，用户/角色/部门三组来源不动。 */
export function clearMainField(grant: StartGrant): StartGrant {
  return { ...grant, main_field_id: undefined, match_by: undefined };
}

/** 三维选择器（用户/角色/部门）确认后整体写回：user_ids/role_ids/department_ids 三组按弹窗结果
 *  整体替换，main_field_id/match_by 必须原样保留（🔴 最容易漏的一处，见文件头注释——
 *  直接用弹窗结果整体覆盖会丢掉 modelValue 里除三个数组外的字段）。 */
export function mergeOrgPickerResult(grant: StartGrant, userIds: string[], roleIds: string[], departmentIds: string[]): StartGrant {
  return { ...grant, user_ids: userIds, role_ids: roleIds, department_ids: departmentIds };
}

/** 删掉用户/角色/部门某一类来源（来源列表某一行的行尾 ×）：只清空这一类，其余两类与主表字段档
 *  （main_field_id/match_by）都保留。 */
export function clearOrgKind(grant: StartGrant, kind: 'user' | 'role' | 'department'): StartGrant {
  return {
    ...grant,
    user_ids: kind === 'user' ? [] : (grant.user_ids ?? []),
    role_ids: kind === 'role' ? [] : (grant.role_ids ?? []),
    department_ids: kind === 'department' ? [] : (grant.department_ids ?? [])
  };
}
