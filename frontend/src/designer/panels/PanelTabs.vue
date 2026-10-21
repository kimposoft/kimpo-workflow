<script setup lang="ts">
/**
 * designer/panels/PanelTabs.vue —— 属性面板内的分区切换条。
 *
 * 面板内容按分区（tab）组织，避免配一个审批节点要上下滚好几屏；第一个分区一律叫「基本」，见
 * ../../../locales 各语言包 `workflow.designer.panel.tabs.*`。本组件只负责"分区切换条"本身，
 * 不负责按分区切换正文内容的显隐——由调用方在放进默认插槽的各个 PanelSection 外面套 v-show，
 * 条件是调用方自己持有的 active 状态。
 *
 * 受控接口是硬要求：`active` prop + `update:active` emit（v-model:active），组件内部不自己持有
 * "当前选中分区"这份状态。原因——"点检查清单里的一条 → 画布聚焦到出问题的节点 + 面板
 * 自动切到该问题所属的分区"：这要求外部（消费该检查清单的上层组件）能够单方面把 active 改到
 * 目标分区并让本组件立刻反映出来。如果做成非受控（如同目录 PanelSection.vue 的 `open`
 * ——那里 `open` 只决定初始展开态，用户点击产生的变化不会被外部传入的新 prop 值覆盖，属于"内部
 * 持有真状态、prop 只管初值"的非受控设计），外部这次单方面指定分区就会失效。
 *
 * 底层复用 NaiveUI 的 `NTabs`/`NTab`——`NTab` 是"无内容面板"的裸标签（区别于会自带内容区切换
 * 的 `NTabPane`），恰好对应"只做标签条、内容显隐交给调用方"的定位；`NTabs` 的 `value`/
 * `update:value` 本身就是受控写法，这里原样转发成本组件的 `active`/`update:active`，不额外
 * 包一层内部状态。
 *
 * data-testid 命名约定：本组件与 PanelHeader.vue 一律只用 `data-testid` 定位，见
 * PanelHeader.vue 头注释「data-testid 命名约定」一节。
 */
import { NTab, NTabs } from 'naive-ui';

/** 单个分区条目：key 是分区标识（与 active 的值域一致），label 是调用方已经过 i18n 处理好的
 *  显示文案（本组件不做任何 i18n 查表，纯展示）。 */
export interface PanelTabItem {
  key: string;
  label: string;
  /** 该分区下是否存在待处理的检查项（预留：供"检查清单联动"在分区标签旁点一个小圆点，
   *  恒为 false/undefined 时不渲染圆点）。 */
  hasPendingIssues?: boolean;
}

const props = defineProps<{
  tabs: PanelTabItem[];
  active: string;
  /** 预留：当前仅影响视觉呈现（见下方样式 `is-read-only`），不阻止分区切换——浏览其余分区的
   *  只读内容是一种"查看"而非"编辑"，与六个 *Panel.vue 里"只读态禁止输入"的既有口径（禁止的
   *  是改动业务数据，不是禁止导航）保持一致，未强行把只读态与"不能切 tab"划等号。 */
  readOnly?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:active', key: string): void }>();

function onUpdateActive(value: string | number): void {
  emit('update:active', String(value));
}
</script>

<template>
  <div class="wf-panel-tabs" data-testid="panel-tabs" :class="{ 'is-read-only': readOnly }">
    <NTabs
      class="wf-panel-tabs__bar"
      type="line"
      size="small"
      :value="active"
      @update:value="onUpdateActive"
    >
      <NTab v-for="tab in tabs" :key="tab.key" :name="tab.key" :data-testid="`panel-tab-${tab.key}`">
        <span class="wf-panel-tabs__label">{{ tab.label }}</span>
        <span v-if="tab.hasPendingIssues" class="wf-panel-tabs__dot" data-testid="panel-tab-pending-dot" aria-hidden="true" />
      </NTab>
    </NTabs>
    <div class="wf-panel-tabs__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.wf-panel-tabs {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
/* 下划线式标签条：白底、高 34、左右各留 10px，各标签等宽居中，选中项蓝字加粗 +
   2px 蓝下划线（下划线颜色走 NaiveUI 主题主色，不写死）。NTabs 的内部节点不在本组件作用域内，
   必须用 :deep 才能命中。 */
.wf-panel-tabs__bar {
  flex: 0 0 auto;
  padding: 0 10px;
  border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237));
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-panel-tabs__bar :deep(.n-tabs-nav-scroll-content) { border-bottom: 0; }
.wf-panel-tabs__bar :deep(.n-tabs-wrapper) { display: flex; width: 100%; }
.wf-panel-tabs__bar :deep(.n-tabs-tab-wrapper) { flex: 1 1 0; min-width: 0; justify-content: center; }
.wf-panel-tabs__bar :deep(.n-tabs-tab-pad) { display: none; }
.wf-panel-tabs__bar :deep(.n-tabs-tab) {
  justify-content: center;
  width: 100%;
  height: 33px;
  padding: 0;
  color: rgb(var(--text-secondary-color, 90 100 114));
  font-size: 12px;
}
.wf-panel-tabs__bar :deep(.n-tabs-tab--active) { font-weight: 600; }
/* 最多 3 个分区、面板宽约 300px：标签文案（尤其英文，如 "Handling Rules"）可能撑不下，
   单行省略 + 原生 title 兜底完整文案（自绘 tooltip 在这种"文字很短、只是偶尔超宽"的场景
   收益不大，反而增加复杂度，未采用 StencilPanel.vue 那种自绘气泡）。 */
.wf-panel-tabs__label {
  display: inline-block;
  overflow: hidden;
  max-width: 100%;
  vertical-align: bottom;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.wf-panel-tabs__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 4px;
  vertical-align: middle;
  border-radius: 50%;
  background: rgb(var(--warning-color, 217 141 0));
}
.wf-panel-tabs__content {
  min-height: 0;
  flex: 1;
  /* 正文区内边距 10：外层 PropsPanel 的 __body 已不留白边，由这里统一给。 */
  padding: 10px;
}
.wf-panel-tabs.is-read-only .wf-panel-tabs__bar {
  opacity: 0.9;
}
</style>
