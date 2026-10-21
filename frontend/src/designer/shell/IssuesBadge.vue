<script setup lang="ts">
/**
 * shell/IssuesBadge.vue —— 顶栏"检查角标"：纯触发器 + NPopover 承载清单。
 *
 * 本组件只做"角标本身"这件事：展示当前问题总条数（经 inject(DESIGNER_ISSUES_KEY) 直接拿
 * useIssues.ts 组合式实例的 count，不由 DesignerRoot 逐层转发 GroupedIssues props）；"问题清单
 * 怎么分组展示 / 怎么翻页"在 ../issues/IssuesBar.vue，本组件不持有 issues/nodes 之外的展示逻辑。
 *
 * 取舍：清单内容用 NPopover 承载（`trigger="click"`），不是画布上方的常驻
 * 可折叠条——理由：①检查项是"发布前需要处理"的临时性提示，不是随时都要看的常驻信息，点开即查、
 * 点掉即走，NPopover 的"点击外部自动收起"正好匹配这个使用节奏；②画布上方另起一条常驻栏会挤占
 * 画布纵向空间、还要在 DesignerRoot 的三栏布局里另开一段插槽，改动面明显更大，也会搬动既有布局。
 */
import { computed, inject, ref } from 'vue';
import { NPopover } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { GraphNodeView } from '../../graph';
import { DESIGNER_ISSUES_KEY } from '../issues/useIssues';
import IssuesBar from '../issues/IssuesBar.vue';

const props = defineProps<{
  i18n: PluginI18n;
  localeTick?: number;
  nodes: GraphNodeView[];
}>();

const issuesApi = inject(DESIGNER_ISSUES_KEY);
if (!issuesApi) {
  throw new Error('[IssuesBadge] 缺少 useIssues 注入，请确认挂载在设计器根组件之下（DesignerRoot 须 provide(DESIGNER_ISSUES_KEY, ...)）');
}

const count = computed(() => {
  void props.localeTick;
  return issuesApi.count.value;
});

/** NPopover 展开态受控（v-model:show）：点击外部/再点一次 trigger 走 NPopover 自带的关闭逻辑
 *  （既有 onUpdateShow 回传），额外一条是 IssuesBar 内选中某条具体问题时（'picked'）主动收起——
 *  "上一条/下一条"翻页不触发这个事件，允许连续翻看，见 IssuesBar.vue 头注释。 */
const open = ref(false);
</script>

<template>
  <NPopover v-model:show="open" trigger="click" placement="bottom-end" :show-arrow="false" :disabled="count === 0">
    <template #trigger>
      <button
        type="button"
        class="wf-issues-badge__trigger"
        :class="{ 'has-issues': count > 0 }"
        :disabled="count === 0"
        data-testid="workflow-issues-badge"
      >
        <span v-if="count > 0" class="wf-issues-badge__count">{{ count }}</span>
        <span>{{ count > 0 ? i18n.t('workflow.designer.topbar.issuesCount', { count }) : i18n.t('workflow.designer.topbar.issuesNone') }}</span>
      </button>
    </template>
    <IssuesBar :i18n="i18n" :locale-tick="localeTick" :nodes="nodes" @picked="open = false" />
  </NPopover>
</template>

<style scoped>
.wf-issues-badge__trigger {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 13px;
  background: rgb(var(--fill-lighter-color, 250 250 250));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  cursor: pointer;
}
.wf-issues-badge__trigger:disabled { cursor: default; }
.wf-issues-badge__trigger.has-issues {
  border-color: rgb(var(--warning-color, 240 160 32) / 50%);
  background: rgb(var(--warning-color, 240 160 32) / 10%);
  color: rgb(var(--warning-color, 240 160 32));
  cursor: pointer;
}
.wf-issues-badge__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgb(var(--warning-color, 240 160 32));
  color: #fff;
  font-size: 11px;
  line-height: 16px;
}
</style>
