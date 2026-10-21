<script setup lang="ts">
/**
 * designer/panels/PanelSection.vue —— 属性面板"分区卡片"的唯一权威组件。
 *
 * 样式约定：白底卡 + 浅填充标题条，圆角统一 4px；同一面板内多张卡之间的纵向间距（10px）
 * 由消费方（各面板 .vue 的外层容器）负责，本组件只管卡片自身。
 *
 * 约定用法（新增分区一律走本组件，不各自起 div）：
 *   - `title`：标题条文字（必填）。
 *   - `icon`：可选，原样 v-html 注入的一段 SVG 字符串（小图标，14×14），无则不占位。
 *   - `info`：可选，"整行静态解释文案"收进标题行的 ⓘ 气泡（hover 原生 title 提示），不再在
 *     卡片正文里另起一行说明，减少正文视觉噪音。
 *   - `required`：可选（默认 false）：标题文字后追加一颗红星，标记"这个分区是
 *     发布前必填项"。**红星必须与发布期校验真正拦截的项严格一一对应**（校验真拦才画星），
 *     具体哪些分区该传 true 由调用方（各 *Panel.vue）按其节点类型的发布期 Validate 逐条核对
 *     后决定，本组件自己不做这层判断。
 *   - `requiredLabel`：`required` 为 true 时必须传入——红星的无障碍文案，由调用方用自己持有的
 *     i18n 实例，按键名 workflow.designer.panel.requiredMark 翻译出"必填"字样后传入。本组件是
 *     "纯结构组件"（同 title/info 两个既有 prop 同样的手法：文本经 props 传入已翻译好的字面量，
 *     自身不 inject i18n、不持有任何 i18n key 字面量——见 start-end-flow-panels-locale-keys
 *     .static.test.ts 对本文件"不含任何 i18n key 字面量"的反向断言；该断言按文本正则扫描整份
 *     源码含注释，本段注释故意不写出"翻译方法调用"那种字面语法，只写键名，避免连注释都触发它），
 *     因此红星本身不能自己去取值，必须由调用方喂译好的文案进来。
 *   - `collapsible`/`open`：是否可折叠 + 初始展开态；本组件是"非受控 + 事件通知"（同
 *     designer/canvas/minimap-collapse.ts useMinimapCollapsed 的既定手法）：内部持有真正的
 *     展开态，`open` 只影响初始值，父层想跟随后续变化需要监听 `toggle` 事件自行处理，不是
 *     v-model 双向绑定。
 *   - `aside` 具名插槽：标题行右侧的次级内容（典型如"决定整段有无意义的开关"），
 *     内部点击自动 `stopPropagation`，不会连带触发标题行的折叠点击。
 *   - 默认插槽：卡片正文。
 */
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 原样 v-html 注入的 SVG 字符串；调用方需自行保证内容可信（不接受用户输入拼接）。 */
    icon?: string;
    info?: string;
    collapsible?: boolean;
    open?: boolean;
    /** 是否发布前必填（标题后画一颗红星），见本文件头注释"required"一段。 */
    required?: boolean;
    /** 红星的无障碍文案，`required` 为 true 时调用方应传入，见本文件头注释"requiredLabel"一段。 */
    requiredLabel?: string;
  }>(),
  { collapsible: false, open: true, required: false }
);

const emit = defineEmits<{ (e: 'toggle', open: boolean): void }>();

// 非受控：内部真正持有展开态，`open` prop 只决定初始值；后续 prop 变化（如父层重置）仍会
// 同步下来，但用户点击产生的变化不会被 prop 的旧值覆盖（watch 只在 prop 真的变了的那一刻同步）。
const isOpen = ref(props.open);
watch(
  () => props.open,
  (next) => {
    if (next !== undefined) isOpen.value = next;
  }
);

function onHeaderClick(): void {
  if (!props.collapsible) return;
  isOpen.value = !isOpen.value;
  emit('toggle', isOpen.value);
}
</script>

<template>
  <section class="wf-panel-section">
    <header
      class="wf-panel-section__header"
      :class="{ 'is-clickable': collapsible }"
      @click="onHeaderClick"
    >
      <span v-if="icon" class="wf-panel-section__icon" v-html="icon" />
      <span class="wf-panel-section__title">{{ title }}</span>
      <span v-if="info" class="wf-panel-section__info" :title="info" @click.stop>ⓘ</span>
      <span class="wf-panel-section__spacer" />
      <!-- 装饰性红星：放在标题条最右端，不紧跟标题文字。role="img" + aria-label 把
           "*"从可读文本里摘掉，屏幕阅读器读到的是 requiredLabel（"必填"），不是孤零零一个星号；
           同 info 气泡一样用原生 title 兜底 hover 提示。 -->
      <span
        v-if="required"
        class="wf-panel-section__required"
        role="img"
        :aria-label="requiredLabel"
        :title="requiredLabel"
      >*</span>
      <span v-if="$slots.aside" class="wf-panel-section__aside" @click.stop>
        <slot name="aside" />
      </span>
      <span v-if="collapsible" class="wf-panel-section__chevron">{{ isOpen ? '⌄' : '⌃' }}</span>
    </header>
    <!-- 没传默认插槽（如「允许人工发起」只有标题条 + 右侧复选框）时不渲染卡身，否则标题条下会
         多出一条空白卡身。 -->
    <div v-if="$slots.default" v-show="!collapsible || isOpen" class="wf-panel-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.wf-panel-section {
  overflow: hidden;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-panel-section__header {
  display: flex;
  align-items: center;
  gap: 5px;
  /* 标题条高 30；用 min-height 而不是 height，右侧 aside 放较高控件时不被压扁。 */
  min-height: 30px;
  padding: 0 10px;
  border-bottom: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  background: rgb(var(--fill-light-color, 245 247 250));
}
/* 没有卡身时标题条就是整张卡，底边线会与卡片自身边框叠成双线，去掉。 */
.wf-panel-section__header:last-child { border-bottom: 0; }
.wf-panel-section__header.is-clickable { cursor: pointer; }
.wf-panel-section__icon {
  display: inline-flex;
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
}
.wf-panel-section__title {
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}
/* 必填红星：走既有错误/危险色 token（同目录 AssigneeSourceList.vue/ApprovalButtonList.vue/
   V4ExpressionField.vue 一致的 --danger-color 惯例），不写死十六进制；只做明亮模式。 */
.wf-panel-section__required {
  flex: 0 0 auto;
  color: rgb(var(--danger-color, 224 78 65));
  font-size: 12px;
  line-height: 1.4;
  cursor: help;
}
.wf-panel-section__info {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 12px;
  cursor: help;
}
.wf-panel-section__spacer { flex: 1; min-width: 4px; }
.wf-panel-section__aside {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.wf-panel-section__chevron {
  flex: 0 0 auto;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
}
.wf-panel-section__body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
