<script setup lang="ts">
/**
 * designer/panels/shared/OrgTriLine.vue —— 用户 / 角色 / 部门三维选择的来源列表（一类一行、行尾
 * × 删除这一类）+ 通栏「＋添加来源」入口（与「人员来源」/「发起权限」同一套选择内核）。
 *
 * 名字缓存的已知限制（务必先读）：StartGrant（本组件的 modelValue）对齐后端 model.StartGrant，
 * 只落 user_ids/role_ids/department_ids 三组 id，**不落显示名**——与
 * designer/nodes/*​/index.ts summarize() 面对同一处境（没有名字目录）时的既定退化手法一致
 * （见 nodes/types.ts SummarizeContext 头注释）：重新打开设计器时只有 id、没有名字可显示，
 * 本组件此时退化为"已选择 N 个用户 / 角色 / 部门"计数文案；只有用户在**本次会话**内经由
 * 「选择」按钮打开过一次选择器、选择器带着真实姓名回填之后，才会把姓名缓存在组件内部状态
 * 里、后续在这次会话中改显示真实姓名（不落 modelValue，也不持久化）——这不是遗漏，是当前
 * DesignerHost 尚未提供"按 id 批量反查用户/角色/部门展示名"的能力（宿主侧也没有这条通用
 * 接口），属已知的架构缺口，日后视需要补一条只读的名字反查接口。
 *
 * 「选择」调 host.ui.openOrgTriPicker，带上 host.appId：该服务的 appId 决定「角色」页签里
 * 「本应用角色」这一个分组是否可见（缺省时角色页签只显示全局角色，见 SDK ui.ts
 * OrgTriPickerRequest.appId 注释）——DesignerHost.appId 由宿主 hostContext.appId 经
 * surfaces/index.ts 转入（见 ../../host.ts DesignerHost.appId 注释），本组件按需读取即可，不
 * 需要另外从 props 或别处再取一份。
 *
 * 三行摘要的 i18n key 复用自 shared/assigneeSource.ts describeSource() 已在用的那一组
 * （workflow.designer.assignee.label.<kind>/<kind>Count）——语义完全相同（有名字逗号连接展示，
 * 没名字退化为计数），不为 StartGrant 另起一套重复翻译。
 *
 * 第四档来源『主表字段』语义与『A 人员来源』的主表字段档完全相同（字段内容按英文逗号拆成多个值，
 * 按 match_by 匹配人）。「＋添加来源」是 NDropdown 菜单（做法同 AssigneeSourceList.vue 的
 * addMenuOptions/onAddSelect）：一项打开三维选择器（用户/角色/部门），一项添加主表字段这一行——
 * 已配置或没有目标模板时置灰。字段候选经 `templateId` prop 交给 MainFieldSelect（内部走
 * useTemplateFieldCatalog，同 AssigneeSourceList.vue 既定取数口径，本组件不自己发请求）。
 *
 * 主表字段行是「草稿 + 选中才写回」：刚点「表单字段」菜单项时字段还没选，本组件用内部状态
 * `mainFieldDraftOpen` 记住"这一行已经打开"，**不**把空串写进 modelValue.main_field_id（同
 * assigneeSource.ts addMainFieldSource 的既定口径相反——那里允许写 `main_field_id: ''` 占位，
 * 是因为 AssigneeSource[] 是数组、多一条空来源不影响其它行；StartGrant.main_field_id 是单值
 * 字段，写空串会被发布期校验当成"配置了但值为空"，与"这一档根本没配"混淆，因此这里改用组件
 * 内部状态区分两种态）。选中字段后才真正写回 main_field_id；点行尾 × 删除时把 main_field_id
 * 与 match_by 一并去掉、关闭草稿态。换目标模板（templateId 变化）时草稿态一并收起，避免残留
 * 一行指向旧模板字段的草稿。
 *
 * 真正的"值怎么合并/覆盖"逻辑（选字段写回/改匹配方式/删除/三维选择器确认后保留第四档/删单类
 * 来源后保留第四档）都在 ./startGrant.ts 的纯函数里，供单测直接覆盖——同 ./assigneeSource.ts
 * 既定分工（NSelect 的下拉选项在 happy-dom 下无法真正点选，本组件的 `<script setup>` 只做事件
 * 绑定 + 一行透传）。
 */
import { computed, inject, reactive, ref, watch } from 'vue';
import type { HTMLAttributes } from 'vue';
import { NButton, NDropdown, NSelect } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { OrgTriPickedUser, PickedDeptRef, PickedRoleRef } from '@kimposoft/plugin-sdk';
import type { AssigneeMatchBy, StartGrant } from '../../../model';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY } from '../../host';
import MainFieldSelect from './MainFieldSelect.vue';
import { clearMainField, clearOrgKind, mergeOrgPickerResult, setMainField, setMatchBy } from './startGrant';

const props = defineProps<{
  modelValue: StartGrant;
  disabled?: boolean;
  /** 目标模板 id：主表字段行的字段候选来源，由 StartPanel.vue 传入
   *  `config.target_template_id`；未选目标模板时「表单字段」菜单项置灰。 */
  templateId?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', value: StartGrant): void }>();

const host = inject(DESIGNER_HOST_KEY);
const i18n = inject(DESIGNER_I18N_KEY) as PluginI18n;

/** 本会话名字缓存，见文件头注释。 */
const nameCache = reactive({
  users: new Map<string, string>(),
  roles: new Map<string, string>(),
  depts: new Map<string, string>()
});

/** 求一行的展示文案：复用同批 shared/assigneeSource.ts describeSource() 已经用过的一组 i18n
 * key（workflow.designer.assignee.label.<kind>/<kind>Count）——语义与它完全相同（有名字连逗号
 * 连接展示，没名字退化为计数），不另起一套重复翻译；分隔符 '、' 同该文件既定用法。 */
function summaryLine(ids: string[] | undefined, cache: Map<string, string>, nameKey: string, countKey: string): string {
  const list = ids ?? [];
  if (list.length === 0) return '';
  const names = list.map((id) => cache.get(id)).filter((n): n is string => Boolean(n));
  if (names.length === list.length) return i18n.t(nameKey, { names: names.join('、') });
  return i18n.t(countKey, { count: list.length });
}

const usersLine = computed(() =>
  summaryLine(props.modelValue.user_ids, nameCache.users, 'workflow.designer.assignee.label.user', 'workflow.designer.assignee.label.userCount')
);
const rolesLine = computed(() =>
  summaryLine(props.modelValue.role_ids, nameCache.roles, 'workflow.designer.assignee.label.role', 'workflow.designer.assignee.label.roleCount')
);
const deptsLine = computed(() =>
  summaryLine(props.modelValue.department_ids, nameCache.depts, 'workflow.designer.assignee.label.department', 'workflow.designer.assignee.label.departmentCount')
);

// ── 主表字段行：草稿态见文件头注释——mainFieldDraftOpen 记「这一行已经
// 打开」，modelValue.main_field_id 只在真正选中字段后才落值。已有持久化的 main_field_id 时
// （重新打开设计器）行天然常显，不需要用户重新点一次「表单字段」。 ───────────────────────────
const mainFieldDraftOpen = ref(false);
const hasMainFieldRow = computed(() => mainFieldDraftOpen.value || !!props.modelValue.main_field_id);

// 换目标模板：旧字段引用已失效，草稿态一并收起（真正的 main_field_id/match_by 清空由
// StartPanel.vue pickTemplate 负责，本组件只管自己的本地 UI 状态）。
watch(
  () => props.templateId,
  () => {
    mainFieldDraftOpen.value = false;
  }
);

const matchByOptions = computed(() => [
  { label: i18n.t('workflow.designer.assignee.matchBy.display_name'), value: 'display_name' },
  { label: i18n.t('workflow.designer.assignee.matchBy.login_name'), value: 'login_name' }
]);

function addMainFieldDraft(): void {
  if (props.disabled) return;
  mainFieldDraftOpen.value = true;
}

/** 字段下拉选中/清空：选中才写回 main_field_id（不写空串，见文件头注释）；清空时保留草稿态，
 *  允许设计者重新选择，不等同点了行尾 ×。合并逻辑见 ./startGrant.ts setMainField。 */
function onMainFieldChange(fieldId: string | undefined): void {
  if (props.disabled) return;
  emit('update:modelValue', setMainField(props.modelValue, fieldId));
}

function onMatchByChange(matchBy: AssigneeMatchBy): void {
  if (props.disabled) return;
  emit('update:modelValue', setMatchBy(props.modelValue, matchBy));
}

/** 删除主表字段行：关闭草稿态，main_field_id 与 match_by 一并去掉（./startGrant.ts
 *  clearMainField）。 */
function removeMainField(): void {
  if (props.disabled) return;
  mainFieldDraftOpen.value = false;
  emit('update:modelValue', clearMainField(props.modelValue));
}

const hasAny = computed(
  () =>
    (props.modelValue.user_ids?.length ?? 0) > 0 ||
    (props.modelValue.role_ids?.length ?? 0) > 0 ||
    (props.modelValue.department_ids?.length ?? 0) > 0 ||
    hasMainFieldRow.value
);

function toInitialUsers(): OrgTriPickedUser[] {
  return (props.modelValue.user_ids ?? []).map((id) => ({
    user_id: id,
    login_name: '',
    display_name: nameCache.users.get(id) ?? id
  }));
}
function toInitialRoles(): PickedRoleRef[] {
  return (props.modelValue.role_ids ?? []).map((id) => ({ id, name: nameCache.roles.get(id) ?? id, scope: 'instance' as const }));
}
function toInitialDepts(): PickedDeptRef[] {
  return (props.modelValue.department_ids ?? []).map((id) => ({
    id,
    org_name: nameCache.depts.get(id) ?? id,
    path_name: nameCache.depts.get(id) ?? id
  }));
}

async function openPicker(): Promise<void> {
  if (!host || props.disabled) return;
  try {
    const result = await host.ui.openOrgTriPicker({
      appId: host.appId,
      title: i18n.t('workflow.designer.panel.orgTri.pickerTitle'),
      initial: { users: toInitialUsers(), roles: toInitialRoles(), depts: toInitialDepts() }
    });
    if (!result.confirmed) return;
    nameCache.users.clear();
    for (const u of result.users) nameCache.users.set(u.user_id, u.display_name);
    nameCache.roles.clear();
    for (const r of result.roles) nameCache.roles.set(r.id, r.name);
    nameCache.depts.clear();
    for (const d of result.depts) nameCache.depts.set(d.id, d.path_name || d.org_name);
    // 🔴（最容易漏的一处）mergeOrgPickerResult 先展开
    // ...props.modelValue 再覆盖三个数组，把三维选择器不关心的 main_field_id/match_by 原样带
    // 过去，否则会把第四档冲掉——单测 startGrant.test.ts 钉住这一处。
    emit(
      'update:modelValue',
      mergeOrgPickerResult(
        props.modelValue,
        result.users.map((u) => u.user_id),
        result.roles.map((r) => r.id),
        result.depts.map((d) => d.id)
      )
    );
  } catch (err) {
    // 未接线/宿主拒绝时统一业务话兜底提示，技术细节进控制台（硬约束）。
    console.error('[kimpo-workflow] 打开用户/角色/部门选择器失败', err);
    window.$message?.error?.(i18n.t('workflow.designer.panel.orgTri.openFailed'));
  }
}

// ── 「＋添加来源」下拉分发（NDropdown，替换原来的单一按钮，照抄 AssigneeSourceList.vue
// addMenuOptions/onAddSelect 的写法）：两项，「用户 / 角色 / 部门」打开既有三维选择器；「表单
// 字段」已配置或没有目标模板时置灰，后者额外给 title 说明原因。 ───────────────────────────────
const addMenuOptions = computed<DropdownOption[]>(() => [
  {
    key: 'org',
    label: i18n.t('workflow.designer.panel.orgTri.addOrgOption'),
    props: { 'data-testid': 'org-tri-add-org' } as unknown as HTMLAttributes
  },
  {
    key: 'main_field',
    label: i18n.t('workflow.designer.assignee.kind.main_field'),
    disabled: hasMainFieldRow.value || !props.templateId,
    props: {
      'data-testid': 'org-tri-add-main-field',
      title: props.templateId ? undefined : i18n.t('workflow.designer.panel.orgTri.addMainFieldNeedsTemplate')
    } as unknown as HTMLAttributes
  }
]);

function onAddSelect(key: string | number): void {
  if (key === 'org') void openPicker();
  else if (key === 'main_field') addMainFieldDraft();
}

/** 来源列表的一行：用户 / 角色 / 部门各占一行（有选才出），与后续节点的人员来源列表同一形态。
 *  展示文案按第一个冒号拆成"标签 + 值"两段分别着色，拆法同
 *  AssigneeSourceList.vue labelPartsOf（各语言包这组文案都是"类别 + 冒号 + 内容"）。 */
type GrantKind = 'user' | 'role' | 'department';
const rows = computed(() => {
  const all: { kind: GrantKind; text: string }[] = [
    { kind: 'user', text: usersLine.value },
    { kind: 'role', text: rolesLine.value },
    { kind: 'department', text: deptsLine.value }
  ];
  return all
    .filter((row) => row.text)
    .map((row) => {
      const match = /^([^：:]{1,20}[：:])\s*(.*)$/.exec(row.text);
      return { kind: row.kind, tag: match ? match[1] : '', value: match ? match[2] : row.text };
    });
});

/** 删掉一行 = 清空这一类来源（其余两类、以及主表字段档均不动，./startGrant.ts clearOrgKind）。 */
function removeKind(kind: GrantKind): void {
  if (props.disabled) return;
  if (kind === 'user') nameCache.users.clear();
  else if (kind === 'role') nameCache.roles.clear();
  else nameCache.depts.clear();
  emit('update:modelValue', clearOrgKind(props.modelValue, kind));
}
</script>

<template>
  <div class="wf-org-tri-line">
    <!-- 来源列表形态：一类来源一行、行尾 × 删除这一类，下面一个通栏「＋添加来源」；
         主表字段行（第四档）紧随用户/角色/部门三行之后，同样计入 hasAny。 -->
    <ul v-if="hasAny" class="wf-org-tri-line__rows">
      <li v-for="row in rows" :key="row.kind" class="wf-org-tri-line__row" :data-testid="`org-tri-row-${row.kind}`">
        <span class="wf-org-tri-line__label"><span v-if="row.tag" class="wf-org-tri-line__label-tag">{{ row.tag }}</span>{{ row.value }}</span>
        <NButton
          v-if="!disabled"
          quaternary
          circle
          size="small"
          class="wf-org-tri-line__remove"
          :title="i18n.t('workflow.designer.assignee.remove')"
          :aria-label="i18n.t('workflow.designer.assignee.remove')"
          :data-testid="`org-tri-row-remove-${row.kind}`"
          @click="removeKind(row.kind)"
        >×</NButton>
      </li>
      <!-- 主表字段行：左侧灰色标签 + 中间字段下拉 + 右侧匹配
           方式，行尾 × 删除——排布参照 AssigneeSourceList.vue 的 main_field 行（同一份控件基线：
           小档 28 高 / 12 字 / 圆角 4）。 -->
      <li v-if="hasMainFieldRow" class="wf-org-tri-line__row" data-testid="org-tri-row-main_field">
        <span class="wf-org-tri-line__tag">{{ i18n.t('workflow.designer.assignee.kind.main_field') }}</span>
        <MainFieldSelect
          class="wf-org-tri-line__main-field"
          :template-id="templateId"
          :model-value="modelValue.main_field_id"
          :placeholder="i18n.t('workflow.designer.assignee.mainFieldPlaceholder')"
          :disabled="disabled"
          data-testid="org-tri-main-field"
          @update:model-value="onMainFieldChange"
        />
        <NSelect
          class="wf-org-tri-line__matchby"
          size="small"
          :value="modelValue.match_by ?? 'display_name'"
          :options="matchByOptions"
          :disabled="disabled"
          data-testid="org-tri-matchby"
          @update:value="(v) => onMatchByChange(v as AssigneeMatchBy)"
        />
        <NButton
          v-if="!disabled"
          quaternary
          circle
          size="small"
          class="wf-org-tri-line__remove"
          :title="i18n.t('workflow.designer.assignee.remove')"
          :aria-label="i18n.t('workflow.designer.assignee.remove')"
          data-testid="org-tri-row-remove-main_field"
          @click="removeMainField"
        >×</NButton>
      </li>
    </ul>
    <p v-else class="wf-org-tri-line__empty">{{ i18n.t('workflow.designer.panel.orgTri.empty') }}</p>
    <!-- 「＋添加来源」下拉菜单：class="wf-org-tri-line__btn" 与 data-testid="org-tri-add"
         是端到端选择器的定位钩子，不要改。 -->
    <NDropdown v-if="!disabled" trigger="click" :options="addMenuOptions" @select="onAddSelect">
      <NButton dashed type="primary" size="small" class="wf-org-tri-line__btn" data-testid="org-tri-add">
        {{ i18n.t('workflow.designer.assignee.addPlaceholder') }}
      </NButton>
    </NDropdown>
  </div>
</template>

<style scoped>
.wf-org-tri-line {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 行样式与 AssigneeSourceList.vue 的 .asl__row 同一套数值（30 高、标签灰值黑、圆形灰底删除钮），
   两处视觉必须一致；各自 scoped，不共用选择器。 */
.wf-org-tri-line__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wf-org-tri-line__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 5px 0 9px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-org-tri-line__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.wf-org-tri-line__label-tag { margin-right: 6px; color: rgb(var(--text-secondary-color, 102 102 102)); }
/* 主表字段行：标签 + 字段下拉（flex 1）+ 匹配方式（固定宽）三段，数值照抄
   AssigneeSourceList.vue 的 .asl__main-field/.asl__matchby（办理人来源那边已去掉行首标签，见该文件）——同一条控件基线，面板宽
   312、卡片正文内边距 10 时这一行（标签 + 字段下拉 + 匹配方式 + 删除钮）排得下。 */
.wf-org-tri-line__tag {
  flex: 0 0 auto;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  white-space: nowrap;
}
.wf-org-tri-line__main-field { flex: 1; min-width: 0; }
.wf-org-tri-line__matchby { flex: 0 0 100px; }
.wf-org-tri-line .wf-org-tri-line__remove {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  background: rgb(var(--fill-color, 240 242 245));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
}
.wf-org-tri-line__remove:hover { color: rgb(var(--danger-color, 224 78 65)); }
.wf-org-tri-line__btn { width: 100%; }
.wf-org-tri-line__empty {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 12px;
}
</style>
