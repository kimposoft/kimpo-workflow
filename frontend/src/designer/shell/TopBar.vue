<script setup lang="ts">
/**
 * shell/TopBar.vue —— 设计器顶栏：流程名称（可点击就地改名）/
 * 「草稿 · 基于 v{n}」或「草稿 · 尚未发布」版本徽标 / 检查角标（IssuesBadge）/ 只读说明 /
 * 保存 · 发布按钮。
 *
 * 本组件不持有 WorkflowDocumentState，只读展示态 props + 向上 emit 用户意图（改名/保存/发布），
 * 写入文档、调用宿主保存/发布接口的职责全在 DesignerRoot.vue（同 DesignerCanvas"画布本身不直接
 * 改 store，只上报用户意图"的既定分工）。检查项清单不经本组件转发——IssuesBadge 经
 * inject(DESIGNER_ISSUES_KEY) 直接拿 useIssues.ts 组合式实例，本组件只透传 nodes（{node} 占位
 * 求值要用的节点展示名清单，详见 IssuesBadge.vue 头注释）。上次保存时间由底部状态栏
 * shell/DesignerStatusBar.vue 显示，顶栏不显示——保存状态属于"当前是什么情况"这类横切信息，
 * 统一放在状态栏，不在顶栏重复一份。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { NInput, type InputInst } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { GraphNodeView } from '../../graph';
import IssuesBadge from './IssuesBadge.vue';

const props = withDefaults(
  defineProps<{
    i18n: PluginI18n;
    localeTick?: number;
    name: string;
    /** 最新已发布版本号，0 = 从未发布，用于"基于 v{n}"徽标。 */
    latestVersionNo: number;
    nodes: GraphNodeView[];
    readOnly?: boolean;
    /** 只读原因是「绑定的流程引擎不可用」：顶栏改说引擎不可用，不再误报「正由他人编辑」。 */
    engineUnavailable?: boolean;
    saving?: boolean;
    publishing?: boolean;
  }>(),
  { readOnly: false, engineUnavailable: false, saving: false, publishing: false }
);

const emit = defineEmits<{
  (e: 'update:name', name: string): void;
  (e: 'save'): void;
  (e: 'publish'): void;
}>();

// ── 名称就地编辑 ────────────────────────────────────────────────────────────────────────
const editingName = ref(false);
const nameDraft = ref(props.name);
const nameInputRef = ref<InputInst | null>(null);

/**
 * 名称就地编辑框尺寸钉定：外框 26 高 / 14px 字 / 左右内边距 6，不在 Naive 默认档位上，
 * 钉在 small 档（宽度 240 由 class 保持）。
 */
const NAME_INPUT_TIERS: KControlSizeTiers = { small: { height: 26, fontSize: 14, paddingX: 6 } };

watch(
  () => props.name,
  (next) => {
    if (!editingName.value) nameDraft.value = next;
  }
);

function startEdit(): void {
  if (props.readOnly) return;
  nameDraft.value = props.name;
  editingName.value = true;
  void nextTick(() => {
    nameInputRef.value?.focus();
    nameInputRef.value?.select();
  });
}

function commitEdit(): void {
  if (!editingName.value) return;
  editingName.value = false;
  const next = nameDraft.value.trim();
  if (next && next !== props.name) emit('update:name', next);
  else nameDraft.value = props.name;
}

function cancelEdit(): void {
  editingName.value = false;
  nameDraft.value = props.name;
}

/** 名称输入框键盘处理：回车提交、Esc 取消。组件上同一事件只挂一条监听、内部按 key 分支（同 PanelHeader.vue 口径）。 */
function onNameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') commitEdit();
  else if (event.key === 'Escape' || event.key === 'Esc') cancelEdit();
}

// ── 版本徽标 ────────────────────────────────────────────────────────────────────────────
const statusText = computed(() => {
  void props.localeTick;
  return props.latestVersionNo > 0
    ? props.i18n.t('workflow.designer.topbar.draftBasedOn', { n: props.latestVersionNo })
    : props.i18n.t('workflow.designer.topbar.draftUnpublished');
});

</script>

<template>
  <header class="wf-topbar" data-testid="workflow-designer-topbar">
    <div class="wf-topbar__name">
      <KControlSize v-if="editingName" :tiers="NAME_INPUT_TIERS">
        <NInput
          ref="nameInputRef"
          v-model:value="nameDraft"
          size="small"
          class="wf-topbar__name-input"
          data-testid="workflow-designer-name-input"
          @keydown="onNameKeydown"
          @blur="commitEdit"
        />
      </KControlSize>
      <button
        v-else
        type="button"
        class="wf-topbar__name-button"
        data-testid="workflow-designer-name-button"
        :disabled="readOnly"
        @click="startEdit"
      >{{ name || i18n.t('workflow.designer.topbar.namePlaceholder') }}</button>
      <span class="wf-topbar__status">{{ statusText }}</span>
    </div>

    <div class="wf-topbar__right">
      <span v-if="readOnly" class="wf-topbar__readonly">{{
        i18n.t(engineUnavailable ? 'workflow.designer.topbar.readOnlyEngineUnavailable' : 'workflow.designer.topbar.readOnlyNotice')
      }}</span>
      <IssuesBadge :i18n="i18n" :locale-tick="localeTick" :nodes="nodes" />
      <button
        type="button"
        class="wf-topbar__btn"
        data-testid="workflow-designer-save"
        :disabled="readOnly || saving"
        @click="emit('save')"
      >{{ i18n.t('workflow.designer.topbar.save') }}</button>
      <button
        type="button"
        class="wf-topbar__btn wf-topbar__btn--primary"
        data-testid="workflow-designer-publish"
        :disabled="readOnly || publishing"
        @click="emit('publish')"
      >{{ i18n.t('workflow.designer.topbar.publish') }}</button>
    </div>
  </header>
</template>

<style scoped>
.wf-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237));
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-topbar__name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.wf-topbar__name-button {
  max-width: 320px;
  overflow: hidden;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: rgb(var(--base-text-color, 31 31 31));
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.wf-topbar__name-button:hover:not(:disabled) { border-color: rgb(var(--border-dark-color, 212 215 222)); background: rgb(var(--fill-lighter-color, 250 250 250)); }
.wf-topbar__name-button:disabled { cursor: default; }
.wf-topbar__name-input {
  width: 240px;
}
/* 名称加粗与按钮态一致（原生 input 时代即为 600） */
.wf-topbar__name-input :deep(input) {
  font-weight: 600;
}
.wf-topbar__status { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; white-space: nowrap; }
.wf-topbar__right { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.wf-topbar__readonly { color: rgb(var(--warning-color, 240 160 32)); font-size: 12px; }
.wf-topbar__btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  cursor: pointer;
}
.wf-topbar__btn:hover:not(:disabled) { background: rgb(var(--fill-color, 240 242 245)); }
.wf-topbar__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.wf-topbar__btn--primary {
  border-color: rgb(var(--primary-color, 100 108 255));
  background: rgb(var(--primary-color, 100 108 255));
  color: #fff;
}
.wf-topbar__btn--primary:hover:not(:disabled) { background: rgb(var(--primary-color, 100 108 255) / 88%); }
</style>
