<script setup lang="ts">
/**
 * shell/DesignerStatusBar.vue —— 设计器底部状态栏：`.wf-designer-body` 之后的
 * 32px 高状态条，作为 DesignerRoot 三段式布局（TopBar → 画布区 → 状态栏）里"当前是什么情况"的
 * 唯一常驻展示位（保存时间、节点数/连线数等）。
 *
 * 从左到右：检查项计数 / 节点与连线数 / 保存状态（脏态 + 上次保存相对时间）；右端：缩放滑块 +
 * 全屏按钮。
 *
 * 分工同 shell/TopBar.vue、shell/CanvasToolbar.vue 既定的"本组件不持有文档/画布状态"：
 *   - 检查项计数不经 props 转发——同 IssuesBadge.vue 既定手法，直接 inject(DESIGNER_ISSUES_KEY)
 *     拿 useIssues.ts 组合式实例（见其头注释"TopBar 本身完全不消费 issuesApi"，本组件同理）。
 *   - 节点/连线数、脏态、上次保存时刻、缩放百分比、是否处于全屏，全部由 DesignerRoot.vue 以
 *     只读 props 传入；本组件只 emit 用户意图（拖动滑块 → 'zoom'；点击全屏按钮 → 'toggle-
 *     fullscreen'），具体调用 canvasRef.zoomToPercent()/element.requestFullscreen() 的职责仍在
 *     DesignerRoot——这样 fullscreenchange 事件监听、document.fullscreenElement 判断这类
 *     DOM 级细节只在一处维护，本组件不重复订阅。
 *
 * 上次保存的相对时间（"3 分钟前"这类文案，30s 定时器刷新）只在本组件显示，顶栏不显示——文案键
 * 用 workflow.designer.statusbar.savedJustNow/savedMinutesAgo。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { NSlider } from 'naive-ui';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import { DESIGNER_ISSUES_KEY } from '../issues/useIssues';

const props = defineProps<{
  i18n: PluginI18n;
  localeTick?: number;
  /** 当前文档节点数——只读展示值，由 DesignerRoot 经 docSnapshot 算出并转手传入，本组件不持有
   *  文档状态、更不读 state.doc（每次访问都会深拷贝整份文档，见 model/document-state.ts）。 */
  nodeCount: number;
  linkCount: number;
  /** 是否存在未保存改动——DesignerRoot 用 changeTick 把 state.isDirty() 这个命令式查询桥接成
   *  的 computed，本组件只展示，不重新判断脏态。 */
  dirty: boolean;
  /** 上次保存时刻（epoch ms）；undefined 表示本次会话还没有已知的保存时间。 */
  savedAt?: number;
  /** 当前缩放百分比，唯一权威是 DesignerRoot 持有的 toolbarZoomPercent（订阅画布 zoom-change
   *  emit 维持），本组件只展示 + 拖动时 emit 意图，不自己再建一份缩放状态。 */
  zoomPercent: number;
  /** 是否处于浏览器全屏态，由 DesignerRoot 监听 document 的 fullscreenchange 事件维持。 */
  isFullscreen: boolean;
}>();

const emit = defineEmits<{
  /** 拖动缩放滑块——DesignerRoot 收到后调用 canvasRef.value?.zoomToPercent(percent)，画布内部
   *  会把值钳在 20~400（见 x6-adapter.ts zoomToPercent 注释），本组件不重复钳值。 */
  (e: 'zoom', percent: number): void;
  (e: 'toggle-fullscreen'): void;
}>();

// ── 检查项计数：同 IssuesBadge.vue 既定手法，直接 inject，不经 TopBar/DesignerRoot 转发。 ──────
const issuesApi = inject(DESIGNER_ISSUES_KEY);
if (!issuesApi) {
  throw new Error('[DesignerStatusBar] 缺少 useIssues 注入，请确认挂载在设计器根组件之下（DesignerRoot 须 provide(DESIGNER_ISSUES_KEY, ...)）');
}

const issuesText = computed(() => {
  void props.localeTick;
  const count = issuesApi.count.value;
  return count > 0
    ? props.i18n.t('workflow.designer.statusbar.issues', { count })
    : props.i18n.t('workflow.designer.statusbar.issuesNone');
});
const hasIssues = computed(() => issuesApi.count.value > 0);

// ── 节点/连线计数文案。 ──────────────────────────────────────────────────────────────────
const countsText = computed(() => {
  void props.localeTick;
  return props.i18n.t('workflow.designer.statusbar.counts', { nodes: props.nodeCount, links: props.linkCount });
});

// ── 保存状态：脏/净文案 + 上次保存相对时间（每 30s 刷新一次，从 TopBar.vue 整套迁移过来）。 ────
const dirtyText = computed(() => {
  void props.localeTick;
  return props.dirty ? props.i18n.t('workflow.designer.statusbar.dirty') : props.i18n.t('workflow.designer.statusbar.clean');
});

const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 30000);
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});

const savedText = computed(() => {
  void props.localeTick;
  if (!props.savedAt) return '';
  const minutes = Math.max(0, Math.floor((now.value - props.savedAt) / 60000));
  return minutes < 1
    ? props.i18n.t('workflow.designer.statusbar.savedJustNow')
    : props.i18n.t('workflow.designer.statusbar.savedMinutesAgo', { minutes });
});

// ── 缩放 / 全屏文案。 ────────────────────────────────────────────────────────────────────
const zoomLabel = computed(() => {
  void props.localeTick;
  return props.i18n.t('workflow.designer.statusbar.zoom');
});
const fullscreenLabel = computed(() => {
  void props.localeTick;
  return props.isFullscreen
    ? props.i18n.t('workflow.designer.statusbar.exitFullscreen')
    : props.i18n.t('workflow.designer.statusbar.fullscreen');
});

/** NSlider 拖动即 emit——本组件不做本地暂存值，直接把用户手势原样上抛，DesignerRoot 调用
 *  canvasRef.zoomToPercent() 后画布会经 zoom-change emit 把新值回灌成 zoomPercent prop，
 *  滑块下一帧显示的仍然是权威值（同 CanvasToolbar.vue 的 −/+ 按钮既定数据流向）。 */
function onSliderUpdate(value: number): void {
  emit('zoom', value);
}
</script>

<template>
  <footer class="wf-statusbar" data-testid="workflow-designer-statusbar">
    <div class="wf-statusbar__left">
      <span
        class="wf-statusbar__issues"
        :class="{ 'has-issues': hasIssues }"
        data-testid="workflow-designer-statusbar-issues"
      >{{ issuesText }}</span>
      <span class="wf-statusbar__divider" aria-hidden="true" />
      <span class="wf-statusbar__counts" data-testid="workflow-designer-statusbar-counts">{{ countsText }}</span>
      <span class="wf-statusbar__divider" aria-hidden="true" />
      <span
        class="wf-statusbar__dirty"
        :class="{ 'is-dirty': dirty }"
        data-testid="workflow-designer-statusbar-dirty"
      >{{ dirtyText }}</span>
      <span v-if="savedText" class="wf-statusbar__saved" data-testid="workflow-designer-statusbar-saved">{{ savedText }}</span>
    </div>

    <div class="wf-statusbar__right">
      <span class="wf-statusbar__zoom-label">{{ zoomLabel }}</span>
      <NSlider
        class="wf-statusbar__zoom-slider"
        :value="zoomPercent"
        :min="20"
        :max="400"
        :step="1"
        :tooltip="false"
        data-testid="workflow-designer-statusbar-zoom-slider"
        @update:value="onSliderUpdate"
      />
      <span class="wf-statusbar__zoom-percent" data-testid="workflow-designer-statusbar-zoom-percent">{{ zoomPercent }}%</span>
      <button
        type="button"
        class="wf-statusbar__fullscreen-btn"
        :title="fullscreenLabel"
        :aria-label="fullscreenLabel"
        data-testid="workflow-designer-statusbar-fullscreen"
        @click="emit('toggle-fullscreen')"
      ><span aria-hidden="true">{{ isFullscreen ? '⤡' : '⤢' }}</span></button>
    </div>
  </footer>
</template>

<style scoped>
.wf-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  height: 32px;
  padding: 0 14px;
  border-top: 1px solid rgb(var(--border-light-color, 228 231 237));
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
}
.wf-statusbar__left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.wf-statusbar__right { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.wf-statusbar__divider {
  width: 1px;
  height: 14px;
  background: rgb(var(--border-light-color, 228 231 237));
}
.wf-statusbar__issues { white-space: nowrap; }
.wf-statusbar__issues.has-issues { color: rgb(var(--warning-color, 240 160 32)); }
.wf-statusbar__counts { white-space: nowrap; }
.wf-statusbar__dirty { white-space: nowrap; }
.wf-statusbar__dirty.is-dirty { color: rgb(var(--warning-color, 240 160 32)); }
.wf-statusbar__saved { color: rgb(var(--text-hint-color, 153 153 153)); white-space: nowrap; }
.wf-statusbar__zoom-label { white-space: nowrap; }
.wf-statusbar__zoom-slider { width: 100px; }
.wf-statusbar__zoom-percent { min-width: 34px; white-space: nowrap; }
.wf-statusbar__fullscreen-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.wf-statusbar__fullscreen-btn:hover { background: rgb(var(--fill-color, 240 242 245)); }
</style>
