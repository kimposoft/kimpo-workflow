<script setup lang="ts">
/**
 * panels/shared/AssigneeSourceList.vue —— 『A 人员来源』清单的通用编辑控件：一行一条来源，
 * 「＋ 添加来源」下拉（NDropdown + NButton）添加，每行可单独删除（NButton quaternary circle），
 * 主表字段行的『匹配方式』用 NSelect。办理/审批/抄送节点共用。全部增删改逻辑在
 * ./assigneeSource.ts 的纯函数里，本文件只做事件绑定与模板渲染。
 *
 * 「主表字段」来源的字段下拉用 panels/shared/MainFieldSelect.vue（props: templateId/modelValue/
 * placeholder/disabled，emits: update:modelValue），本组件不自行调用 host.listTemplateTables/
 * listTemplateFields。
 *
 * 『与上步处理人的关系』不是本组件的来源：「＋添加来源」菜单（ADD_KINDS）不含 'relation'，
 * 关系是节点 config 上独立的 relation_filters 字段，界面在「再缩小范围」卡
 * （shared/RelationFilterCard.vue，由三个属性面板各自在「从哪里选人」卡之后接一行），本组件不
 * 持有任何与关系相关的状态。旧文档打开时会经 model/defaults.ts ensureDocumentShape 自动把
 * relation 来源改记为 relation_filters，因此正常链路下不会收到 kind==='relation' 的来源条目——
 * `describeSource`（./assigneeSource.ts）的 relation 分支只是给未整形的旧数据兜底展示。
 */
import { computed, inject, ref } from 'vue';
import type { HTMLAttributes } from 'vue';
import { NButton, NDropdown, NSelect } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY } from '../../host';
import type { AssigneeMatchBy, AssigneeSource, AssigneeSourceKind } from '../../../model';
import MainFieldSelect from './MainFieldSelect.vue';
import {
  addInitiatorSource,
  addMainFieldSource,
  addPickedSource,
  describeSource,
  removeSourceAt,
  updateMainFieldId,
  updateMatchBy as updateMatchByPure,
  type AssigneeNameCache
} from './assigneeSource';

const props = defineProps<{
  modelValue: AssigneeSource[];
  readOnly?: boolean;
  templateId: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [sources: AssigneeSource[]];
}>();

const injectedHost = inject(DESIGNER_HOST_KEY);
const injectedI18n = inject(DESIGNER_I18N_KEY);
if (!injectedHost || !injectedI18n) {
  throw new Error('[AssigneeSourceList] 缺少 DESIGNER_HOST_KEY/DESIGNER_I18N_KEY 注入，请确认挂载在设计器根组件之下');
}
// 见 ../../expression/V4ExpressionField.vue 同处注释：重新声明为非空局部绑定，避免下面的嵌套
// 函数（labelOf 等）里 TS 控制流窄化失效报"可能是 undefined"。
const host = injectedHost;
const i18n = injectedI18n;

/** 本会话内拾取过的用户/角色/部门展示名缓存（仅供本组件展示用，不落库、不跨会话）：orgTriPicker
 *  确认结果自带 display_name/name，重开设计器后（只剩 id）会退化为数量兜底文案，见 describeSource
 *  分支——同 nodes/handle/index.ts summarizeAssignees() 的既定降级口径，不是缺陷。 */
const nameCache = ref<AssigneeNameCache>({ user: {}, role: {}, department: {} });

function commit(next: AssigneeSource[]): void {
  emit('update:modelValue', next);
}

function removeAt(index: number): void {
  if (props.readOnly) return;
  commit(removeSourceAt(props.modelValue, index));
}

// ── 添加：用户 / 角色 / 部门（同一个宿主三维选择器，按选中的分支落对应 kind 的来源） ──────────
async function addByPicker(kind: 'user' | 'role' | 'department'): Promise<void> {
  if (props.readOnly) return;
  const titleKey =
    kind === 'user' ? 'workflow.designer.assignee.pickUser' : kind === 'role' ? 'workflow.designer.assignee.pickRole' : 'workflow.designer.assignee.pickDepartment';
  // 必须带 host.appId：缺省时选择器「角色」页签只列全局角色、看不到本应用角色
  // （同 OrgTriLine.vue 发起权限的既有口径，见 SDK OrgTriPickerRequest.appId 注释）。
  // initialTab：选择器直接停在与所选来源类别对应的页签（角色→角色页签、部门→部门页签）。
  const initialTab = kind === 'department' ? 'dept' : kind;
  const result = await host.ui.openOrgTriPicker({ appId: host.appId, title: i18n.t(titleKey), initialTab });
  if (!result.confirmed) return;
  if (kind === 'user') {
    for (const u of result.users) nameCache.value.user[u.user_id] = u.display_name;
    commit(addPickedSource(props.modelValue, 'user', result.users.map((u) => u.user_id)));
  } else if (kind === 'role') {
    for (const r of result.roles) nameCache.value.role[r.id] = r.name;
    commit(addPickedSource(props.modelValue, 'role', result.roles.map((r) => r.id)));
  } else {
    for (const d of result.depts) nameCache.value.department[d.id] = d.org_name;
    commit(addPickedSource(props.modelValue, 'department', result.depts.map((d) => d.id)));
  }
}

// ── 添加：主表字段（草稿行，字段留空待设计者在行内选择；不限次数——已添加过仍可再添加） ────────
function addMainField(): void {
  if (props.readOnly) return;
  commit(addMainFieldSource(props.modelValue));
}

function updateMainField(index: number, fieldId: string): void {
  if (props.readOnly) return;
  commit(updateMainFieldId(props.modelValue, index, fieldId));
}

function updateMatchBy(index: number, matchBy: AssigneeMatchBy): void {
  if (props.readOnly) return;
  commit(updateMatchByPure(props.modelValue, index, matchBy));
}

const matchByOptions = computed(() => [
  { label: i18n.t('workflow.designer.assignee.matchBy.display_name'), value: 'display_name' },
  { label: i18n.t('workflow.designer.assignee.matchBy.login_name'), value: 'login_name' }
]);

// ── 添加：发起人（无参数、同一节点最多一条，点选即落库，不
// 弹任何选择器——同 addMainField 一样是"点了就直接生效"的分支，不像用户/角色/部门那样要先经过
// 宿主三维选择器）。是否已存在一条交给 addMenuOptions 的 disabled 判据，本函数只管追加去重。 ────
function addInitiator(): void {
  if (props.readOnly) return;
  commit(addInitiatorSource(props.modelValue));
}

// ── 「＋ 添加来源」下拉分发（NDropdown）。initiator 排在 main_field 之后；菜单不含 relation——
// 『与上步处理人的关系』是独立过滤器，见文件头注释。 ─────────────────────────────────────────
const ADD_KINDS: AssigneeSourceKind[] = ['user', 'role', 'department', 'main_field', 'initiator'];
const addMenuOptions = computed<DropdownOption[]>(() =>
  ADD_KINDS.map((kind) => ({
    key: kind as string,
    label: i18n.t(`workflow.designer.assignee.kind.${kind}`),
    // 发起人同一节点最多一条：已存在时该菜单项置灰，不允许再点出第二条重复来源。其余四档
    // 不限次数（undefined 即不禁用）。
    disabled: kind === 'initiator' ? props.modelValue.some((s) => s.kind === 'initiator') : undefined,
    // naive-ui 的 MenuOptionSharedPart.props 类型是 HTMLAttributes（无索引签名，不认识
    // data-testid），这里按结构未知属性显式二次断言——见 node_modules/naive-ui 的
    // DropdownOption.mjs：该字段会被 mergeProps 原样合入选项渲染出的 DOM 节点属性，data-testid
    // 能正常落到真实 DOM 上，只是 TS 类型层面需要绕过这道检查。
    props: { 'data-testid': `asl-add-${kind}` } as unknown as HTMLAttributes
  }))
);

function onAddSelect(key: string | number): void {
  const kind = key as AssigneeSourceKind;
  if (kind === 'user' || kind === 'role' || kind === 'department') {
    void addByPicker(kind);
  } else if (kind === 'main_field') {
    addMainField();
  } else if (kind === 'initiator') {
    addInitiator();
  }
}

// ── 展示文案 ────────────────────────────────────────────────────────────────────────────
function labelOf(source: AssigneeSource): string {
  const label = describeSource(source, nameCache.value);
  return label ? i18n.t(label.key, label.params) : '';
}

/** 把「用户：张三」这类展示文案按第一个冒号拆成"标签 + 值"两段，供模板分别着色（标签灰、
 *  值黑）。各语言包里这组文案都是"类别 + 冒号 + 内容"的写法（中日文全角冒号、英文半角冒号），
 *  没有冒号的文案（如『与上步处理人的关系』各档）整段当值，不出标签。 */
function labelPartsOf(source: AssigneeSource): { tag: string; value: string } {
  const text = labelOf(source);
  const match = /^([^：:]{1,20}[：:])\s*(.*)$/.exec(text);
  return match ? { tag: match[1], value: match[2] } : { tag: '', value: text };
}
</script>

<template>
  <div class="asl">
    <p v-if="modelValue.length === 0" class="asl__empty">{{ i18n.t('workflow.designer.assignee.empty') }}</p>

    <ul v-else class="asl__list">
      <li v-for="(source, index) in modelValue" :key="index" class="asl__row" :data-testid="`asl-row-${index}`">
        <template v-if="source.kind === 'main_field'">
          <!-- 不再在行首放「表单字段」类别标签：空间全部让给字段下拉，类别语义由占位文案「请选择表单字段」承担 -->
          <MainFieldSelect
            class="asl__main-field"
            menu-auto-width
            :template-id="templateId"
            :model-value="source.main_field_id"
            :placeholder="i18n.t('workflow.designer.assignee.mainFieldPlaceholder')"
            :disabled="readOnly"
            @update:model-value="(fieldId) => updateMainField(index, fieldId ?? '')"
          />
          <NSelect
            class="asl__matchby"
            size="small"
            :value="source.match_by ?? 'display_name'"
            :options="matchByOptions"
            :disabled="readOnly"
            :data-testid="`asl-matchby-${index}`"
            @update:value="(v) => updateMatchBy(index, v as AssigneeMatchBy)"
          />
        </template>
        <template v-else>
          <span class="asl__label"><span v-if="labelPartsOf(source).tag" class="asl__label-tag">{{ labelPartsOf(source).tag }}</span>{{ labelPartsOf(source).value }}</span>
        </template>
        <NButton
          v-if="!readOnly"
          quaternary
          circle
          size="small"
          class="asl__remove"
          :title="i18n.t('workflow.designer.assignee.remove')"
          :aria-label="i18n.t('workflow.designer.assignee.remove')"
          :data-testid="`asl-row-remove-${index}`"
          @click="removeAt(index)"
        >×</NButton>
      </li>
    </ul>

    <NDropdown v-if="!readOnly" trigger="click" :options="addMenuOptions" @select="onAddSelect">
      <NButton dashed type="primary" size="small" class="asl__add" data-testid="asl-add">
        {{ i18n.t('workflow.designer.assignee.addPlaceholder') }}
      </NButton>
    </NDropdown>
  </div>
</template>

<style scoped>
.asl { display: flex; flex-direction: column; gap: 8px; }
.asl__empty { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 12px; }
.asl__list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.asl__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 5px 0 9px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.asl__label { flex: 1; min-width: 0; overflow: hidden; color: rgb(var(--base-text-color, 31 31 31)); text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.asl__label-tag { margin-right: 6px; color: rgb(var(--text-secondary-color, 102 102 102)); }
.asl__main-field { flex: 1; min-width: 0; }
.asl__matchby { flex: 0 0 100px; }
/* 删除钮：18×18 圆形灰底；多写一层 .asl 前缀是为了压过 NButton 自带的尺寸规则。 */
.asl .asl__remove {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  background: rgb(var(--fill-color, 240 242 245));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
}
.asl__remove:hover { color: rgb(var(--danger-color, 224 78 65)); }
/* 「＋添加来源」通栏，与子流程面板「＋添加传递字段」同一形态。 */
.asl__add { width: 100%; }
</style>
