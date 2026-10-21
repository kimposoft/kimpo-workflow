<script setup lang="ts">
/**
 * shell/CanvasToolbar.vue —— 画布工具栏：TopBar 与画布之间的 40px 高
 * 工具条，把 DesignerCanvas defineExpose 的一整排能力接到界面上——缩放（zoomIn/zoomOut/
 * zoomTo100/zoomToFit）、网格/吸附/参考线三个开关、对齐/分布，见 DesignerCanvas.vue 的
 * defineExpose 块与其头部注释。
 *
 * 本组件不持有任何画布/文档状态：缩放百分比、三个开关当前值、撤销/重做是否可用、小地图是否
 * 展开，全部由 DesignerRoot.vue 以 props 形式传入；本组件只负责渲染 + 向上 emit 用户意图，具体
 * 调用 canvasRef.xxx() / state.xxx() 的职责仍在 DesignerRoot——同 shell/TopBar.vue"本组件不持有
 * WorkflowDocumentState......写入职责全在 DesignerRoot.vue"的既定分工，本组件照抄。
 *
 * 常规态（选中节点数 < 2）：撤销/重做 → 缩放（−/百分比/+）→ 视图（适应画布/实际大小）→ 三个
 * 开关（网格/吸附/参考线）→ 小地图，从左到右。
 * 多选态（选中节点数 >= 2）：整行替换为"已选中 N 个节点 | 左对齐/水平居中/右对齐 | 顶部对齐/
 * 垂直居中/底部对齐 | 横向等距/纵向等距 | 删除"，对应画布层 alignSelection 六档对齐与
 * distributeSelection 双向分布。
 *
 * 六档按轴命名：'center' 是横向水平居中、'middle' 是纵向垂直居中，两者语义不同不可混用（若
 * "水平居中"按钮绑成 'middle'，点下去节点会在纵向跳动），见下方按钮处注释与
 * CanvasToolbar.static.test.ts 里钉死这条的断言。
 *
 * 刻意不做"复制"按钮（没有现成入口就不放，也不为此去 DesignerCanvas 加 emit）：
 *   DesignerRoot 层没有可复用的复制入口：画布键盘层的 Ctrl/Cmd+C 只是把选中
 *   节点 id 记到 X6GraphAdapter 内部的 clipboard 字段（见 x6-adapter.ts graph.bindKey(['ctrl+c',
 *   'meta+c'], ...)），没有对外 emit 任何事件；Ctrl/Cmd+V 虽然 emit 了 'paste'
 *   （DesignerCanvas.vue defineEmits 里的 (e: 'paste', nodeIds: string[])），但 DesignerRoot.vue
 *   的 <DesignerCanvas> 模板未绑定 @paste——这条链路在接线层面就是断的，不是"藏在别处"。
 */
import { computed } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';

const props = withDefaults(
  defineProps<{
    i18n: PluginI18n;
    localeTick?: number;
    readOnly?: boolean;
    /** 当前选中的节点数量；>= 2 时整行切换为多选态工具栏（对齐/分布/删除）。 */
    selectedCount: number;
    /** 当前缩放百分比。唯一权威是 DesignerCanvas 内部的 zoomPercent（120ms 定时器 + 各 zoom*
     *  方法维持），本组件只展示 DesignerRoot 转发来的值，不自己查询画布。 */
    zoomPercent: number;
    canUndo: boolean;
    canRedo: boolean;
    /** 三个开关的当前展示值——UI 的唯一真值源是 DesignerRoot 持有的本地 ref，不是画布的
     *  isGridVisible()/isSnapToGridEnabled()/isSnaplineEnabled() 查询方法：那几个方法读的是
     *  DOM 背景图、且与 Alt 精细对齐存在耦合（见 x6-adapter.ts 对应方法头注释"🔴 三开关拆分后
     *  的副作用"），不适合当界面持续状态源。本组件只是纯展示，具体由谁充当真值源不是本组件的
     *  职责边界，但仍在此写明，避免后来者把这几个 prop 名字误当作可以随手换成查询调用。 */
    gridVisible: boolean;
    snapEnabled: boolean;
    snaplineEnabled: boolean;
    /** 小地图是否处于展开态（!collapsed），由 DesignerRoot 经 useMinimapCollapsed() 与画布内嵌
     *  的折叠胶囊共享同一份状态传入（见 canvas/minimap-collapse.ts 头注释"一处状态两处入口"）。 */
    minimapVisible: boolean;
  }>(),
  { readOnly: false }
);

const emit = defineEmits<{
  (e: 'undo'): void;
  (e: 'redo'): void;
  (e: 'zoom-out'): void;
  (e: 'zoom-in'): void;
  (e: 'zoom-fit'): void;
  (e: 'zoom-actual'): void;
  (e: 'toggle-grid'): void;
  (e: 'toggle-snap'): void;
  (e: 'toggle-snapline'): void;
  (e: 'toggle-minimap'): void;
  /** mode 六档同 x6-adapter.ts alignSelection：横向三档（left/center/right）只碰 x，
   *  纵向三档（top/middle/bottom）只碰 y，不允许混用——'center' 是水平居中，'middle' 是垂直
   *  居中，两者不是同义词。 */
  (e: 'align', mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void;
  /** 分布用同一个事件带方向参数，直接对应 X6GraphAdapter.distributeSelection(mode) 的签名，不为
   *  每个方向各开一个事件名。 */
  (e: 'distribute', mode: 'horizontal' | 'vertical'): void;
  (e: 'delete-selection'): void;
}>();

/** 多选态判据：selectedCount >= 2 才整行替换——只选中 1 个节点时谈不上"对齐/分布"，仍显示
 *  常规工具栏（撤销/重做/缩放/开关/小地图）。 */
const isMultiSelect = computed(() => props.selectedCount >= 2);

/** 本组件用到的全部文案统一收在一个 computed 里，内部 void 一次 localeTick 强制语言切换时
 *  整体重新求值——同 issues/IssuesBar.vue sections 计算属性的既定手法（i18n.t() 本身是普通函数
 *  调用，不天然具备 Vue 响应性）。 */
const labels = computed(() => {
  void props.localeTick;
  const i18n = props.i18n;
  return {
    undo: i18n.t('workflow.designer.toolbar.undo'),
    redo: i18n.t('workflow.designer.toolbar.redo'),
    zoomOut: i18n.t('workflow.designer.toolbar.zoomOut'),
    zoomIn: i18n.t('workflow.designer.toolbar.zoomIn'),
    zoomFit: i18n.t('workflow.designer.toolbar.zoomFit'),
    zoomActual: i18n.t('workflow.designer.toolbar.zoomActual'),
    grid: i18n.t('workflow.designer.toolbar.grid'),
    snap: i18n.t('workflow.designer.toolbar.snap'),
    snapline: i18n.t('workflow.designer.toolbar.snapline'),
    minimap: i18n.t('workflow.designer.toolbar.minimap'),
    alignLeft: i18n.t('workflow.designer.toolbar.alignLeft'),
    alignCenter: i18n.t('workflow.designer.toolbar.alignCenter'),
    alignRight: i18n.t('workflow.designer.toolbar.alignRight'),
    alignTop: i18n.t('workflow.designer.toolbar.alignTop'),
    alignMiddle: i18n.t('workflow.designer.toolbar.alignMiddle'),
    alignBottom: i18n.t('workflow.designer.toolbar.alignBottom'),
    distributeHorizontal: i18n.t('workflow.designer.toolbar.distributeHorizontal'),
    distributeVertical: i18n.t('workflow.designer.toolbar.distributeVertical'),
    remove: i18n.t('workflow.designer.toolbar.delete'),
    selectedCount: i18n.t('workflow.designer.toolbar.selectedCount', { count: props.selectedCount })
  };
});
</script>

<template>
  <div class="wf-canvas-toolbar" data-testid="workflow-designer-canvas-toolbar">
    <template v-if="isMultiSelect">
      <!-- 多选态：整行替换，不是在常规态里叠加一排常驻灰按钮。 -->
      <span class="wf-canvas-toolbar__selected" data-testid="workflow-designer-toolbar-selected-count">{{ labels.selectedCount }}</span>
      <span class="wf-canvas-toolbar__divider" aria-hidden="true" />
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.alignLeft"
        :aria-label="labels.alignLeft"
        data-testid="workflow-designer-toolbar-align-left"
        @click="emit('align', 'left')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><line x1="2" y1="1" x2="2" y2="15" stroke="currentColor" stroke-width="1.4" /><rect x="4" y="4" width="10" height="3" rx="0.5" fill="currentColor" /><rect x="4" y="9" width="6" height="3" rx="0.5" fill="currentColor" /></svg></span>{{ labels.alignLeft }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.alignCenter"
        :aria-label="labels.alignCenter"
        data-testid="workflow-designer-toolbar-align-center"
        @click="emit('align', 'center')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><line x1="8" y1="1" x2="8" y2="15" stroke="currentColor" stroke-width="1.4" /><rect x="3" y="4" width="10" height="3" rx="0.5" fill="currentColor" /><rect x="5" y="9" width="6" height="3" rx="0.5" fill="currentColor" /></svg></span>{{ labels.alignCenter }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.alignRight"
        :aria-label="labels.alignRight"
        data-testid="workflow-designer-toolbar-align-right"
        @click="emit('align', 'right')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><line x1="14" y1="1" x2="14" y2="15" stroke="currentColor" stroke-width="1.4" /><rect x="2" y="4" width="10" height="3" rx="0.5" fill="currentColor" /><rect x="6" y="9" width="6" height="3" rx="0.5" fill="currentColor" /></svg></span>{{ labels.alignRight }}</button>
      <span class="wf-canvas-toolbar__divider" aria-hidden="true" />
      <!-- 顶部对齐/垂直居中/底部对齐：纵向三档只碰 y，与上面横向三档只碰 x
           相对——图标画成横向长条堆叠 + 一条竖向基准线的 90° 镜像（横向档是竖线+横条，纵向档是
           横线+竖条），一眼能分清"横向对齐"与"纵向对齐"两组，不是把横向图标复制粘贴了事。 -->
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.alignTop"
        :aria-label="labels.alignTop"
        data-testid="workflow-designer-toolbar-align-top"
        @click="emit('align', 'top')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><line x1="1" y1="3" x2="15" y2="3" stroke="currentColor" stroke-width="1.4" /><rect x="3" y="5" width="3" height="8" rx="0.5" fill="currentColor" /><rect x="10" y="5" width="3" height="5" rx="0.5" fill="currentColor" /></svg></span>{{ labels.alignTop }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.alignMiddle"
        :aria-label="labels.alignMiddle"
        data-testid="workflow-designer-toolbar-align-middle"
        @click="emit('align', 'middle')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.4" /><rect x="4" y="3" width="3" height="10" rx="0.5" fill="currentColor" /><rect x="9" y="5" width="3" height="6" rx="0.5" fill="currentColor" /></svg></span>{{ labels.alignMiddle }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.alignBottom"
        :aria-label="labels.alignBottom"
        data-testid="workflow-designer-toolbar-align-bottom"
        @click="emit('align', 'bottom')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><line x1="1" y1="13" x2="15" y2="13" stroke="currentColor" stroke-width="1.4" /><rect x="3" y="3" width="3" height="8" rx="0.5" fill="currentColor" /><rect x="10" y="6" width="3" height="5" rx="0.5" fill="currentColor" /></svg></span>{{ labels.alignBottom }}</button>
      <span class="wf-canvas-toolbar__divider" aria-hidden="true" />
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.distributeHorizontal"
        :aria-label="labels.distributeHorizontal"
        data-testid="workflow-designer-toolbar-distribute-horizontal"
        @click="emit('distribute', 'horizontal')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="2" width="2.6" height="12" rx="0.5" fill="currentColor" /><rect x="6.7" y="2" width="2.6" height="12" rx="0.5" fill="currentColor" /><rect x="11.4" y="2" width="2.6" height="12" rx="0.5" fill="currentColor" /></svg></span>{{ labels.distributeHorizontal }}</button>
      <!-- 纵向等距：图标是横向等距图标（三个竖条横向排开）的 90° 镜像
           （三个横条纵向排开），语义上一眼可辨"横向/纵向"。 -->
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :disabled="readOnly"
        :title="labels.distributeVertical"
        :aria-label="labels.distributeVertical"
        data-testid="workflow-designer-toolbar-distribute-vertical"
        @click="emit('distribute', 'vertical')"
      ><span class="wf-canvas-toolbar__align-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="2" width="12" height="2.6" rx="0.5" fill="currentColor" /><rect x="2" y="6.7" width="12" height="2.6" rx="0.5" fill="currentColor" /><rect x="2" y="11.4" width="12" height="2.6" rx="0.5" fill="currentColor" /></svg></span>{{ labels.distributeVertical }}</button>
      <span class="wf-canvas-toolbar__spacer" />
      <button
        type="button"
        class="wf-canvas-toolbar__btn wf-canvas-toolbar__btn--danger"
        :disabled="readOnly"
        :title="labels.remove"
        data-testid="workflow-designer-toolbar-delete"
        @click="emit('delete-selection')"
      >{{ labels.remove }}</button>
    </template>
    <template v-else>
      <button
        type="button"
        class="wf-canvas-toolbar__icon-btn"
        :disabled="readOnly || !canUndo"
        :title="labels.undo"
        :aria-label="labels.undo"
        data-testid="workflow-designer-toolbar-undo"
        @click="emit('undo')"
      ><span aria-hidden="true">↶</span></button>
      <button
        type="button"
        class="wf-canvas-toolbar__icon-btn"
        :disabled="readOnly || !canRedo"
        :title="labels.redo"
        :aria-label="labels.redo"
        data-testid="workflow-designer-toolbar-redo"
        @click="emit('redo')"
      ><span aria-hidden="true">↷</span></button>

      <span class="wf-canvas-toolbar__divider" aria-hidden="true" />

      <!-- 缩放：−/百分比/+ 连成一组（视图规格"连成一组"），三者共享同一圈边框、内部用竖线分隔，
           而不是三个各自独立描边的按钮。缩放是纯视图操作，只读态下仍然可用，不绑 :disabled。 -->
      <div class="wf-canvas-toolbar__zoom-group">
        <button
          type="button"
          class="wf-canvas-toolbar__zoom-btn"
          :title="labels.zoomOut"
          :aria-label="labels.zoomOut"
          data-testid="workflow-designer-toolbar-zoom-out"
          @click="emit('zoom-out')"
        >−</button>
        <span class="wf-canvas-toolbar__zoom-percent" data-testid="workflow-designer-toolbar-zoom-percent">{{ zoomPercent }}%</span>
        <button
          type="button"
          class="wf-canvas-toolbar__zoom-btn"
          :title="labels.zoomIn"
          :aria-label="labels.zoomIn"
          data-testid="workflow-designer-toolbar-zoom-in"
          @click="emit('zoom-in')"
        >+</button>
      </div>

      <span class="wf-canvas-toolbar__divider" aria-hidden="true" />

      <!-- 视图：适应画布 / 实际大小——纯视图操作，只读态下仍然可用。 -->
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :title="labels.zoomFit"
        data-testid="workflow-designer-toolbar-zoom-fit"
        @click="emit('zoom-fit')"
      >{{ labels.zoomFit }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn"
        :title="labels.zoomActual"
        data-testid="workflow-designer-toolbar-zoom-actual"
        @click="emit('zoom-actual')"
      >{{ labels.zoomActual }}</button>

      <span class="wf-canvas-toolbar__divider" aria-hidden="true" />

      <!-- 网格 / 吸附 / 参考线：三个独立可切换按钮，激活态靠 is-active 类区分（同
           DesignerRoot.vue .wf-designer-right.is-collapsed 既定的修饰类命名手法）。同样是纯视图
           操作，只读态下仍然可用。 -->
      <button
        type="button"
        class="wf-canvas-toolbar__btn wf-canvas-toolbar__btn--toggle"
        :class="{ 'is-active': gridVisible }"
        :title="labels.grid"
        data-testid="workflow-designer-toolbar-grid"
        @click="emit('toggle-grid')"
      >{{ labels.grid }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn wf-canvas-toolbar__btn--toggle"
        :class="{ 'is-active': snapEnabled }"
        :title="labels.snap"
        data-testid="workflow-designer-toolbar-snap"
        @click="emit('toggle-snap')"
      >{{ labels.snap }}</button>
      <button
        type="button"
        class="wf-canvas-toolbar__btn wf-canvas-toolbar__btn--toggle"
        :class="{ 'is-active': snaplineEnabled }"
        :title="labels.snapline"
        data-testid="workflow-designer-toolbar-snapline"
        @click="emit('toggle-snapline')"
      >{{ labels.snapline }}</button>

      <span class="wf-canvas-toolbar__spacer" />

      <!-- 小地图：右端，同样纯视图操作，只读态下仍然可用。 -->
      <button
        type="button"
        class="wf-canvas-toolbar__btn wf-canvas-toolbar__btn--toggle"
        :class="{ 'is-active': minimapVisible }"
        :title="labels.minimap"
        data-testid="workflow-designer-toolbar-minimap"
        @click="emit('toggle-minimap')"
      >{{ labels.minimap }}</button>
    </template>
  </div>
</template>

<style scoped>
.wf-canvas-toolbar {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  height: 40px;
  padding: 0 14px;
  gap: 6px;
  border-bottom: 1px solid rgb(var(--border-light-color, 228 231 237));
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-canvas-toolbar__divider {
  width: 1px;
  height: 20px;
  margin: 0 2px;
  background: rgb(var(--border-light-color, 228 231 237));
}
.wf-canvas-toolbar__spacer { flex: 1; }
.wf-canvas-toolbar__selected {
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  white-space: nowrap;
}

/* 常规文字按钮（视图/开关/多选态对齐分布删除，同 TopBar.vue .wf-topbar__btn 既定样式）。 */
.wf-canvas-toolbar__btn {
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.wf-canvas-toolbar__btn:hover:not(:disabled) { background: rgb(var(--fill-color, 240 242 245)); }
.wf-canvas-toolbar__btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* 多选态对齐/分布八个按钮的图标：与文案之间留 4px 间距，颜色跟随按钮文字色
   （currentColor），禁用态随 .wf-canvas-toolbar__btn:disabled 的 opacity 一起变淡，不需要单独
   写禁用样式。 */
.wf-canvas-toolbar__align-icon {
  display: inline-flex;
  align-items: center;
  margin-right: 4px;
}
.wf-canvas-toolbar__btn--toggle.is-active {
  border-color: rgb(var(--primary-color, 100 108 255));
  background: rgb(var(--primary-color, 100 108 255) / 12%);
  color: rgb(var(--primary-color, 100 108 255));
}
.wf-canvas-toolbar__btn--danger:hover:not(:disabled) {
  border-color: rgb(var(--error-color, 220 38 38));
  color: rgb(var(--error-color, 220 38 38));
}

/* 撤销/重做：图标按钮，正方形。 */
.wf-canvas-toolbar__icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.wf-canvas-toolbar__icon-btn:hover:not(:disabled) { background: rgb(var(--fill-color, 240 242 245)); }
.wf-canvas-toolbar__icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 缩放三元组：共享一圈边框，内部用按钮自身的左右边框充当分隔线，视觉上连成一组。 */
.wf-canvas-toolbar__zoom-group {
  display: flex;
  align-items: center;
  height: 26px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 4px;
  overflow: hidden;
}
.wf-canvas-toolbar__zoom-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 100%;
  border: none;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.wf-canvas-toolbar__zoom-btn:hover { background: rgb(var(--fill-color, 240 242 245)); }
.wf-canvas-toolbar__zoom-percent {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 100%;
  padding: 0 4px;
  border-left: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-right: 1px solid rgb(var(--border-light-color, 228 231 237));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  white-space: nowrap;
}
</style>
