<script setup lang="ts">
/**
 * designer/issues/IssuesBar.vue —— 发布期检查项清单条，由
 * shell/IssuesBadge.vue 的弹层承载：本组件只管"怎么展示 + 怎么翻页"，检查项数据经
 * inject(DESIGNER_ISSUES_KEY) 直接拿 useIssues.ts 组合式实例（同 host/state/i18n 三个既有注入键
 * 的手法，见 useIssues.ts 头注释"跨越 TopBar→IssuesBadge→IssuesBar 三层的横切状态，逐层 props
 * 转发只会让中间层认识一份自己不关心的数据形状"）。
 *
 * 按「节点 / 连线 / 整体」三组分区列出业务话文案（{node} 占位在本组件求值——本组件是持有文档展示态 nodes + i18n 的那个调用方，见 model/validate-map.ts 头注释）；
 * 头部「共 n 项需要处理」+ 上一条 / 下一条按钮；零项时显示空态文案。点具体一条：定位并关闭外层
 * 弹层（emit 'picked'，由 IssuesBadge.vue 收起 NPopover）；点上一条/下一条：只翻页定位，不收起
 * 弹层（可以连续翻看），依赖 NPopover 默认的"点击外部关闭"处理弹层收起。
 */
import { computed, inject } from 'vue';
import { NButton, NTag } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { GraphNodeView } from '../../graph';
import type { MappedIssue } from '../../model/validate-map';
import { DESIGNER_ISSUES_KEY } from './useIssues';

const props = defineProps<{
  i18n: PluginI18n;
  localeTick?: number;
  nodes: GraphNodeView[];
}>();

const emit = defineEmits<{ (e: 'picked'): void }>();

const injectedIssuesApi = inject(DESIGNER_ISSUES_KEY);
if (!injectedIssuesApi) {
  throw new Error('[IssuesBar] 缺少 useIssues 注入，请确认挂载在设计器根组件之下（DesignerRoot 须 provide(DESIGNER_ISSUES_KEY, ...)）');
}
// 重新声明为非空局部绑定，避免下面几个函数声明（pick/goNext/goPrev）里 TS 控制流窄化失效报
// "可能是 undefined"（同 ../panels/SubflowPanel.vue 同处注释的既定手法）。
const issuesApi = injectedIssuesApi;

function nodeLabel(nodeId: string): string {
  return props.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
}

interface DisplayItem {
  index: number;
  text: string;
}

interface DisplaySection {
  key: 'node' | 'link' | 'global';
  titleKey: string;
  items: DisplayItem[];
}

/** 把 issuesApi.issues（节点 → 连线 → 全局的展平清单）重新按分区归类展示，同时记住每一条在
 *  展平清单里的原始下标——data-testid 与 focusAt() 都按这个下标定位，分区只是展示层的再分组，
 *  不改变底层数据结构（issuesApi.grouped 已经是分组形态，这里不复用它是因为还需要"原始下标"这个
 *  额外信息，见下方 focusAt 调用）。 */
const sections = computed<DisplaySection[]>(() => {
  void props.localeTick;
  const nodeItems: DisplayItem[] = [];
  const linkItems: DisplayItem[] = [];
  const globalItems: DisplayItem[] = [];
  issuesApi.issues.value.forEach((issue: MappedIssue, index: number) => {
    const params = issue.nodeId ? { ...issue.params, node: nodeLabel(issue.nodeId) } : issue.params;
    const text = props.i18n.t(issue.textKey, params);
    const item: DisplayItem = { index, text };
    if (issue.nodeId) nodeItems.push(item);
    else if (issue.linkId) linkItems.push(item);
    else globalItems.push(item);
  });
  const all: DisplaySection[] = [
    { key: 'node', titleKey: 'workflow.designer.issues.groupNode', items: nodeItems },
    { key: 'link', titleKey: 'workflow.designer.issues.groupLink', items: linkItems },
    { key: 'global', titleKey: 'workflow.designer.issues.groupGlobal', items: globalItems }
  ];
  return all.filter((section) => section.items.length > 0);
});

function pick(index: number): void {
  issuesApi.focusAt(index);
  emit('picked');
}

function goNext(): void {
  issuesApi.next();
}

function goPrev(): void {
  issuesApi.prev();
}
</script>

<template>
  <div class="wf-issues-bar" data-testid="workflow-issues-bar">
    <div class="wf-issues-bar__header">
      <span class="wf-issues-bar__summary">{{ i18n.t('workflow.designer.issues.summary', { count: issuesApi.count.value }) }}</span>
      <div class="wf-issues-bar__nav">
        <NButton size="small" text :disabled="issuesApi.count.value === 0" data-testid="workflow-issues-prev" @click="goPrev">
          {{ i18n.t('workflow.designer.issues.prev') }}
        </NButton>
        <NButton size="small" text :disabled="issuesApi.count.value === 0" data-testid="workflow-issues-next" @click="goNext">
          {{ i18n.t('workflow.designer.issues.next') }}
        </NButton>
      </div>
    </div>

    <p v-if="issuesApi.count.value === 0" class="wf-issues-bar__empty" data-testid="workflow-issues-empty">
      {{ i18n.t('workflow.designer.issues.empty') }}
    </p>

    <div v-else class="wf-issues-bar__sections">
      <div v-for="section in sections" :key="section.key" class="wf-issues-bar__section">
        <NTag size="small" :bordered="false" class="wf-issues-bar__group-tag">{{ i18n.t(section.titleKey) }}</NTag>
        <button
          v-for="item in section.items"
          :key="item.index"
          type="button"
          class="wf-issues-bar__item"
          :class="{ 'is-current': item.index === issuesApi.cursor.value }"
          :data-testid="`workflow-issues-item-${item.index}`"
          @click="pick(item.index)"
        >{{ item.text }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-issues-bar {
  display: grid;
  width: 280px;
  max-height: 360px;
  gap: 6px;
}
.wf-issues-bar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 6px;
  border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237));
}
.wf-issues-bar__summary { color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.wf-issues-bar__nav { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.wf-issues-bar__empty { margin: 10px 2px; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 12px; text-align: center; }
.wf-issues-bar__sections { display: grid; gap: 8px; overflow-y: auto; max-height: 300px; padding: 0 2px 2px; }
.wf-issues-bar__section { display: grid; gap: 2px; }
.wf-issues-bar__group-tag { justify-self: start; margin-bottom: 2px; }
.wf-issues-bar__item {
  padding: 7px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: rgb(var(--base-text-color, 31 31 31));
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}
.wf-issues-bar__item:hover { background: rgb(var(--fill-color, 240 242 245)); }
.wf-issues-bar__item.is-current {
  background: rgb(var(--primary-color, 100 108 255) / 10%);
  color: rgb(var(--primary-color, 100 108 255));
}
</style>
