<script setup lang="ts">
import { computed, ref } from 'vue';
import { NInput } from 'naive-ui';
import { KControlSize, type KControlSizeTiers } from '@kimposoft/ui-kit';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import { NODE_ICONS, NODE_SHAPE_FAMILY, derivePalette } from '../../model/node-visual';
import { useCanvasPalette } from '../canvas/use-canvas-palette';
import { STENCIL_GROUPS, STENCIL_ITEMS, type StencilGroup, type StencilItem } from './index';
import { buildNodeDragPreview } from './drag-preview';

const props = withDefaults(
  defineProps<{
    i18n: PluginI18n;
    localeTick?: number;
    disabled?: boolean;
    disabledKeys?: StencilItem['key'][];
    /** disabledKeys 里的条目悬停时显示的说明（如绑定引擎不支持该节点时传「当前引擎不支持」），
     * 取代条目描述；不传时禁用条目照常显示描述。整体 disabled（只读）不受影响。 */
    disabledHint?: string;
    /** 隐藏本组件自带的"节点"标题行——FloatingStencilPanel.vue 的浮动外壳标题栏自己已经显示
     * 同样的标题，避免两层标题叠在一起；本组件
     * 单独挂载（不经浮动外壳）时不传该 prop，标题照常显示，行为不变。 */
    hideTitle?: boolean;
    /** 拖拽预览图的内容来源（预览图画成"节点落到画布上之后的样子"，见 drag-preview.ts 头注释）。落下后显示什么名字（"办理 2"这类带序号的默认名）、第二行摘要写
     * 什么、画布此刻缩放到多少，都取决于当前文档与画布状态——本组件只认识"节点库条目"，不认识
     * 文档也不认识画布，故由消费方（DesignerRoot.vue）按 key 算好交进来。不传（本组件单独挂载）
     * 时退化为：标题用条目类型名、无摘要、按 100% 画。 */
    resolveDragPreview?: (key: StencilItem['key']) => { label: string; summary?: string; scale?: number } | undefined;
  }>(),
  {
    disabled: false,
    disabledKeys: () => [],
    disabledHint: '',
    hideTitle: false,
    resolveDragPreview: undefined
  }
);

/** "快捷创建"：双击某条目 = 在当前选中节点之后顺接一个该类型的新节点。本组件只上报
 * "双击了哪个 key"这个交互事实，是否真的顺接、顺接到哪由消费方（画布壳）判断
 * （同 onDragStart 只管拖拽本身、真正建节点交给消费方的既定分工）。 */
const emit = defineEmits<{ (e: 'dblclick-item', key: StencilItem['key']): void }>();

// StencilItem.key 就是 NodeKind 本身，模板里直接用 item.key 索引 node-visual.ts 的色板/图标/
// 形状家族，没有额外映射层。色板/图标/形状家族的唯一权威来源仍在 ../../model/node-visual.ts（画布
// 同款，见该文件头注释"消除两套配色"）。

/** 设计器画布暗色支持：形状面板色块预览需要跟着宿主主题走——node-visual.ts 的
 * 模块级 NODE_PALETTE 常量恒等于 derivePalette() 缺省值 LIGHT_PALETTE，只有亮色一份取值，不会
 * 随宿主切主题更新。这里改用 useCanvasPalette()（随宿主 documentElement 主题变化自动重新解析，
 * 见 designer/canvas/use-canvas-palette.ts）拿到当前主题下的 CanvasPalette，再喂给
 * derivePalette() 派生出当前主题对应的节点色板；NODE_ICONS/NODE_SHAPE_FAMILY 是图标路径/形状
 * 家族，本就与配色无关，继续用模块级静态导入不受影响。 */
const { palette: canvasPalette } = useCanvasPalette();
const themedNodePalette = computed(() => derivePalette(canvasPalette.value));

const query = ref('');

/**
 * 搜索框尺寸钉定：外框 30 高 / 14px 字（含 1px 边框，宽度撑满面板 220），不在 Naive 默认档位上，
 * 故钉在 medium 档（NInput 不写 size 即 medium）并覆盖该档尺寸。
 * paddingX 取 9，与 ⌕ 前缀图标左距一致（图标位由前缀槽承担）。
 */
const SEARCH_INPUT_TIERS: KControlSizeTiers = { medium: { height: 30, fontSize: 14, paddingX: 9 } };
const itemText = (item: StencilItem, suffix: 'label' | 'description') => {
  void props.localeTick;
  return props.i18n.t(`workflow.designer.stencil.${item.key}.${suffix}`);
};
/** 悬停浮层文案：逐条禁用且给了说明时显示说明，否则显示条目描述。 */
const tooltipText = (item: StencilItem) =>
  props.disabledHint && props.disabledKeys.includes(item.key) ? props.disabledHint : itemText(item, 'description');
const groupTitle = (group: StencilGroup) => {
  void props.localeTick;
  return props.i18n.t(`workflow.designer.stencil.group.${group}`);
};

/** 按分组聚类，搜索命中时跨组过滤（组内条目为空则整组隐藏，不留空标题）。
 *
 * item.hidden 的条目整体不渲染（见 stencil/index.ts StencilItem.hidden 注释）——过滤放在这里而不是从 STENCIL_ITEMS 里删条目：
 * 那份数组同时是 NODE_TYPE_LABELS 的派生源，删掉会让画布上已存在的该类节点丢掉中文名。
 *
 * 末尾 `.filter((entry) => entry.items.length > 0)` 是双保险：即便以后又有人在 StencilGroup
 * 里加了一档暂时没有成员的预留分组，
 * 这里也会把它整组滤掉，面板不会渲染出一个"只有标题、没有任何条目"的空区块——见
 * StencilPanel.static.test.ts 对该断言的锁定。 */
const groupedItems = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const matches = (item: StencilItem) =>
    !keyword || `${itemText(item, 'label')} ${itemText(item, 'description')} ${item.key}`.toLowerCase().includes(keyword);
  return STENCIL_GROUPS.map((group) => ({
    group,
    items: STENCIL_ITEMS.filter((item) => item.group === group && !item.hidden && matches(item))
  })).filter((entry) => entry.items.length > 0);
});

function onDragStart(event: DragEvent, item: StencilItem): void {
  if (props.disabled || props.disabledKeys.includes(item.key)) {
    event.preventDefault();
    return;
  }
  event.dataTransfer?.setData('application/x-kimpo-workflow-stencil', item.key);
  event.dataTransfer?.setData('text/plain', item.key);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  // 拖拽预览图（HTML5 DnD drag image）：画成"该节点落到画布上之后的样子"
  // （白底卡/胶囊 + 图标块 + 标题 + 摘要），指针位于图样正中；不是克隆节点库条目按钮本身。
  // 图样由 drag-preview.ts 在画布之外用 DOM 复刻（几何/配色与画布节点同源，见该文件头注释），
  // 标题/摘要/缩放由消费方经 resolveDragPreview 提供。
  // 仍然必须自己调 setDragImage，不能退回浏览器默认快照：默认快照抓的是"dragstart 瞬间的按钮
  // 实时渲染"，此刻 :hover 未退出，190px 宽的描述气泡（.workflow-stencil__tooltip）会被一并抓进
  // 去（见 StencilPanel.static.test.ts ②）。
  if (event.dataTransfer) {
    const resolved = props.resolveDragPreview?.(item.key);
    const preview = buildNodeDragPreview({
      kind: item.key,
      label: resolved?.label ?? itemText(item, 'label'),
      summary: resolved?.summary,
      scale: resolved?.scale,
      palette: canvasPalette.value
    });
    // 离屏挂载：setDragImage 要求元素在文档里且真实参与渲染（display:none 抓不到图），故用
    // fixed 定位挪到视口外，而不是隐藏。
    const ghost = preview.element;
    ghost.style.position = 'fixed';
    ghost.style.top = '-1000px';
    ghost.style.left = '-1000px';
    document.body.appendChild(ghost);
    // 指针锚在图样正中——与 stencil-drop-placement.ts computeStencilDropPosition"松手后节点
    // 中心对准指针"同一口径，拖动中的图样与落下后的节点位置重合。
    event.dataTransfer.setDragImage(ghost, preview.width / 2, preview.height / 2);
    // 拖拽镜像的捕获在 dragstart 派发过程中同步完成，下一轮宏任务移除节点即可，不影响已经
    // 捕获到的镜像画面。
    window.setTimeout(() => ghost.remove(), 0);
  }
}

function onDoubleClick(item: StencilItem): void {
  if (props.disabled || props.disabledKeys.includes(item.key)) return;
  emit('dblclick-item', item.key);
}
</script>

<template>
  <aside class="workflow-stencil" data-testid="workflow-stencil">
    <div v-if="!hideTitle" class="workflow-stencil__header">
      <strong>{{ i18n.t('workflow.designer.stencil.title') }}</strong>
    </div>
    <!-- 搜索框规格（h30 ⌕ 前缀 #FAFBFC 底）：⌕ 是装饰性前缀图标，走 NInput 的前缀槽；
         data-testid 随 attrs 落在 NInput 根上（内部真正的 input 取 [data-testid="stencil-search"] input）。 -->
    <div class="workflow-stencil__search">
      <KControlSize :tiers="SEARCH_INPUT_TIERS">
        <NInput
          v-model:value="query"
          clearable
          data-testid="stencil-search"
          :placeholder="i18n.t('workflow.designer.stencil.search')"
        >
          <template #prefix>
            <span class="workflow-stencil__search-icon" aria-hidden="true">⌕</span>
          </template>
        </NInput>
      </KControlSize>
    </div>
    <div class="workflow-stencil__groups">
      <section v-for="entry in groupedItems" :key="entry.group" class="workflow-stencil__group" :data-testid="`stencil-group-${entry.group}`">
        <h4 class="workflow-stencil__group-title">{{ groupTitle(entry.group) }}</h4>
        <div class="workflow-stencil__items">
          <button
            v-for="item in entry.items"
            :key="item.key"
            type="button"
            class="workflow-stencil__item"
            :class="{ 'is-disabled': disabled || disabledKeys.includes(item.key) }"
            :disabled="disabled || disabledKeys.includes(item.key)"
            :draggable="!disabled && !disabledKeys.includes(item.key)"
            :data-stencil-key="item.key"
            :data-engine-unsupported="disabledKeys.includes(item.key) ? 'true' : undefined"
            @dragstart="onDragStart($event, item)"
            @dblclick="onDoubleClick(item)"
          >
            <!-- 图标/色块与画布节点同源（themedNodePalette 派生自 NODE_ICONS/NODE_SHAPE_FAMILY
                 同一份 node-visual.ts 权威数据），不是面板自己另起一套 CSS 配色，避免两套配色跑偏。
                 色块只画 iconBg 背景 + iconColor 图标，不画类型色描边（NODE_PALETTE 不提供描边语义）。
                 iconBg/iconColor 随 themedNodePalette 跟随宿主主题变化，见上方 themedNodePalette 定义注释。 -->
            <span
              class="workflow-stencil__shape"
              :class="`family-${NODE_SHAPE_FAMILY[item.key]}`"
              :style="{ background: themedNodePalette[item.key].iconBg }"
            >
              <svg v-if="NODE_ICONS[item.key]" viewBox="0 0 16 16" class="workflow-stencil__icon">
                <path
                  :d="NODE_ICONS[item.key]!.d"
                  :fill="NODE_ICONS[item.key]!.fill ? themedNodePalette[item.key].iconColor : 'none'"
                  :stroke="NODE_ICONS[item.key]!.fill ? 'none' : themedNodePalette[item.key].iconColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <b>{{ itemText(item, 'label') }}</b>
            <!-- hover 态出现"⠿ 拖拽"右侧灰字：与下面的描述浮层是两件独立的
                 hover 反馈——这个是行内右侧的拖拽可用性提示（同一行内，紧跟标签），描述浮层
                 是悬浮在条目右侧的独立气泡（见下方 tooltip），二者不冲突、同时出现。 -->
            <span class="workflow-stencil__drag-hint">⠿ {{ i18n.t('workflow.designer.stencil.dragHintShort') }}</span>
            <!-- 描述默认隐藏，鼠标指向时以浮层展示：用自绘 tooltip 而不是原生
                 title 属性——原生 title 的触发延迟/样式不可控，也不便于 E2E 断言可见性。 -->
            <span class="workflow-stencil__tooltip" role="tooltip">{{ tooltipText(item) }}</span>
          </button>
        </div>
      </section>
    </div>
    <!-- 底部 hint：放在列表下方，文案为"拖拽创建 + 双击顺接"两句合并（i18n key dragHint），
         头部只放标题。 -->
    <p class="workflow-stencil__hint">{{ i18n.t('workflow.designer.stencil.dragHint') }}</p>
  </aside>
</template>

<style scoped>
.workflow-stencil {
  /* 节点库由 FloatingStencilPanel.vue 浮动外壳承载（宽度固定在外壳的 __panel 上），本组件不自己
     定宽——width:100% 撑满外壳内容区，box-sizing:border-box 让自身的 padding/border 计入这个 100%，
     不会把外壳撑宽出现横向溢出。 */
  box-sizing: border-box;
  width: 100%;
  padding: 12px;
  /* 文字/描边/填充与品牌蓝统一走宿主配色 token（宿主 CSS 变量），不写死颜色 */
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 8px;
  background: rgb(var(--container-bg-color, 255 255 255));
  overflow: hidden;
}
.workflow-stencil__header { display: flex; align-items: baseline; margin-bottom: 10px; }
.workflow-stencil__header strong { font-size: 14px; }
/* 搜索框（h30 ⌕ 前缀）：⌕ 图标放在 NInput 前缀槽里，宽 15 + 槽自带右距 4，使文字起点仍约在 28px。 */
.workflow-stencil__search-icon {
  display: inline-block;
  width: 15px;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 13px;
  line-height: 1;
}
/* 横向滚动条根因修复：.workflow-stencil__tooltip（hover 描述气泡）常驻布局——只用
   visibility/opacity 隐藏，不是 display:none——其 left: calc(100% + 8px) + width:190px
   远超本容器宽度，构成横向可滚动溢出；本容器若只声明 overflow-y，按 CSS 规范，
   overflow-x 为默认值 visible 时会因 overflow-y 非 visible 被隐式计算成 auto（两者联动，
   见 MDN overflow-x 说明），于是渲染出一条底部看不出内容、纯属误报的横向滚动条。
   显式声明 overflow-x: hidden 掐断这条隐式联动——气泡本就因外层
   .workflow-stencil 的 overflow: hidden 而无法渲染到面板外，这里只是去掉多余滚动条，
   不改变任何现有可见效果。 */
.workflow-stencil__groups { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; max-height: calc(100% - 106px); overflow-y: auto; overflow-x: hidden; }
/* 底部 hint（位于列表下方），视觉同其余面板的既定"次要说明文字"样式。 */
.workflow-stencil__hint {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
.workflow-stencil__group-title { margin: 0 0 6px; padding: 0 2px; color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.workflow-stencil__items { display: grid; gap: 6px; }
.workflow-stencil__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgb(var(--fill-lighter-color, 250 250 250));
  text-align: left;
  cursor: grab;
}
.workflow-stencil__item:hover { border-color: rgb(var(--primary-color, 100 108 255) / 60%); background: rgb(var(--primary-color, 100 108 255) / 8%); }
.workflow-stencil__item.is-disabled { cursor: not-allowed; opacity: 0.45; }
.workflow-stencil__item b { flex: 1; color: rgb(var(--base-text-color, 31 31 31)); font-size: 13px; font-weight: 500; }
/* hover 态"⠿ 拖拽"右侧灰字：常驻占位（opacity 切换，不抖动布局），紧跟在
   label（flex:1）之后自然贴右；与下方描述浮层（另一个独立的 hover 反馈）互不遮挡。 */
.workflow-stencil__drag-hint {
  flex: 0 0 auto;
  opacity: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  white-space: nowrap;
  transition: opacity 0.12s ease;
}
.workflow-stencil__item:hover .workflow-stencil__drag-hint,
.workflow-stencil__item:focus-visible .workflow-stencil__drag-hint {
  opacity: 1;
}
/* 色块 22×22 r6，不画描边——纯色图标块，不是"类型色描边的迷你节点卡"（NODE_PALETTE 不提供描边语义）。 */
.workflow-stencil__shape {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border-radius: 6px;
  box-sizing: border-box;
}
.workflow-stencil__shape.family-capsule { border-radius: 11px; }
.workflow-stencil__shape.family-structure { width: 20px; height: 20px; margin: 0 3px; border-radius: 2px; transform: rotate(45deg); }
.workflow-stencil__icon { width: 12px; height: 12px; }
.workflow-stencil__shape.family-structure .workflow-stencil__icon { transform: rotate(-45deg); }
/* 描述浮层：默认隐藏（visibility+opacity 双控，避免 hidden 态仍占用交互层挡住拖拽），
   hover/focus 时定位在条目右侧展示，配色走宿主 --tooltip-bg-color/--container-bg-color token
   （随宿主主题自动翻转，不是固定明亮配色），z-index 盖过画布同级元素。 */
.workflow-stencil__tooltip {
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  z-index: 20;
  width: 190px;
  padding: 6px 8px;
  transform: translateY(-50%);
  visibility: hidden;
  opacity: 0;
  border-radius: 6px;
  background: rgb(var(--tooltip-bg-color, 16 24 40));
  color: rgb(var(--container-bg-color, 255 255 255));
  font-size: 11px;
  line-height: 1.4;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.workflow-stencil__item:hover .workflow-stencil__tooltip,
.workflow-stencil__item:focus-visible .workflow-stencil__tooltip {
  visibility: visible;
  opacity: 1;
}
</style>
