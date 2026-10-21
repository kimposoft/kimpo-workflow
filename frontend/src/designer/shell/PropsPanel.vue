<script setup lang="ts">
/**
 * shell/PropsPanel.vue —— 属性面板容器壳。
 *
 * 本组件只做"壳"：容器 + 按选中项分发 + 空态。具体每种节点类型的配置分区卡片（样式惯例：分区
 * 卡片、圆角 4px、PanelSection 组件）由各节点类型自己提供——designer/nodes/<kind> 的
 * NodeTypeDefinition 上带一个可选 `panel` 字段（该节点类型的属性面板 Vue 组件），本组件按
 * host.ts 的 NodeTypeDefinitionWithPanel 鸭子类型读取并动态渲染，新增节点面板不需要改本文件
 * （见 ../host.ts 该类型的头注释）。
 *
 * 分发口径：
 *   - 恰好选中一个节点 且 该节点类型已登记 panel 组件 —— 渲染该组件，透传 node/readOnly 两个 prop；
 *   - 恰好选中一个节点 但未登记 panel 组件 —— "该节点暂无可配置项"占位；
 *   - 恰好选中一条连线 —— 渲染 EdgePanel（引导线条件），透传
 *     link/readOnly 两个 prop；
 *   - 恰好选中一条连线 但该连线已不在文档里（悬空引用）—— "该连线暂无可配置项"占位；
 *   - 其余情况（未选中任何项、多选节点、多选连线、节点与连线混选）—— 不渲染任何占位内容。
 *
 * 属性面板是浮在画布上的浮层（见 shell/FloatingPropsPanel.vue）：外层浮动外壳只在"恰好选中 1 个
 * 节点"或"恰好选中 1 条连线"时显示（见其 hasSingleSelectionTarget 消费处），空选/多选/混选整体
 * 隐藏（v-show）——画布工具条已有"已选中 N 个节点"提示，浮层不再弹占位文案。外壳的显示判据与
 * 本组件上面四条分支逐一对应：只要外层浮层可见，必落在前四条分支之一，因此本组件不为空选/多选
 * 渲染任何兜底内容。PropsPanel 只在 shell/FloatingPropsPanel.vue 一处被挂载。
 */
import { computed, type Component } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { DocumentSelection } from '../../model/document-state';
import type { WorkflowDocument, WorkflowLink, WorkflowNode } from '../../model';
import { getNodeTypeDefinition } from '../nodes/registry';
import type { NodeTypeDefinitionWithPanel } from '../host';
import EdgePanel from '../panels/EdgePanel.vue';

const props = withDefaults(
  defineProps<{
    i18n: PluginI18n;
    localeTick?: number;
    doc?: WorkflowDocument;
    selection: DocumentSelection;
    readOnly?: boolean;
    /** 隐藏本组件自带的"属性面板"标题行——shell/FloatingPropsPanel.vue 的浮动外壳标题栏自己
     * 已经显示浮层标题，两层标题叠在一起会重复；同 stencil/StencilPanel.vue 的 hideTitle prop
     * 是同一套解法。本组件单独挂载（不经浮动外壳）时不传该 prop，标题照常显示。 */
    hideTitle?: boolean;
  }>(),
  { hideTitle: false }
);

const selectedNode = computed<WorkflowNode | undefined>(() => {
  if (props.selection.nodeIds.length !== 1 || props.selection.linkIds.length !== 0) return undefined;
  return props.doc?.nodes.find((n) => n.id === props.selection.nodeIds[0]);
});

const isSingleEdgeSelected = computed(
  () => props.selection.nodeIds.length === 0 && props.selection.linkIds.length === 1
);

const selectedLink = computed<WorkflowLink | undefined>(() => {
  if (!isSingleEdgeSelected.value) return undefined;
  return props.doc?.links.find((l) => l.id === props.selection.linkIds[0]);
});

const nodePanelComponent = computed<Component | undefined>(() => {
  const node = selectedNode.value;
  if (!node) return undefined;
  const def = getNodeTypeDefinition(node.kind) as NodeTypeDefinitionWithPanel | undefined;
  return def?.panel;
});
</script>

<template>
  <section class="wf-props-panel" data-testid="workflow-props-panel">
    <header v-if="!hideTitle" class="wf-props-panel__header">{{ i18n.t('workflow.designer.panel.title') }}</header>
    <div class="wf-props-panel__body">
      <component
        :is="nodePanelComponent"
        v-if="selectedNode && nodePanelComponent"
        :node="selectedNode"
        :read-only="readOnly"
      />
      <p v-else-if="selectedNode" class="wf-props-panel__empty">{{ i18n.t('workflow.designer.panel.noConfigurable') }}</p>
      <EdgePanel v-else-if="selectedLink" :link="selectedLink" :read-only="readOnly" />
      <p v-else-if="isSingleEdgeSelected" class="wf-props-panel__empty">{{ i18n.t('workflow.designer.panel.noConfigurableEdge') }}</p>
      <!-- 无兜底分支：外层 shell/FloatingPropsPanel.vue 只在"恰好选中 1 个节点"或"恰好选中 1 条
           连线"时才显示浮层，上面四条分支已穷尽这两种情况，走到这里说明外层浮层此刻并不可见，
           不需要渲染占位内容（见本文件头注释）。 -->
    </div>
  </section>
</template>

<style scoped>
.wf-props-panel {
  display: flex;
  flex-direction: column;
  /* 宽度由外层浮动外壳（shell/FloatingPropsPanel.vue，312px）决定，本层只管填满——不自带
     固定宽度与边框圆角，否则套进外壳后会叠成两层框。 */
  width: 100%;
  min-width: 0;
  /* 不能写 height:100%：父层（shell/FloatingPropsPanel.vue 的 .workflow-props-floating__body）
     浮动态只给了 max-height（钉住态才有真正的 height:100%），CSS 规范里百分比高度只认"祖先有
     显式 height"，max-height 不算数，于是浮动态这条 100% 会退化成 auto，本组件直接撑到内容的
     真实高度，超出部分被 __body 的 max-height 硬切且够不着（如子流程节点四个分区卡片撑爆浮层，
     最后一块被浮层底边切掉，滚不动）。用 flex:1 + min-height:0，让本组件成为外壳 __body（声明了
     display:flex;flex-direction:column，见其定义处注释）的一个真正的 flex 子项——不论父层的
     实际高度是来自钉住态的显式 height 还是浮动态的 max-height 强算出的高度，flex:1 都会让本组件
     精确填满父层给出的那个高度，不依赖百分比继承这条容易踩坑的路径。填满之后，真正的纵向滚动
     发生在下面 .wf-props-panel__body（flex:1;min-height:0;overflow-y:auto，前提是上面这一层先
     压出一个比内容矮的真实高度）。 */
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-props-panel__header {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-bottom: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 13px;
  font-weight: 600;
}
.wf-props-panel__body {
  flex: 1;
  min-height: 0;
  /* 不留内边距：身份头（PanelHeader）与分区标签条（PanelTabs）要贴边连成一整块白底，10px
     内边距由各面板的正文区自己给（PanelTabs 的内容区 / 不分区面板的 __body 容器）。 */
  padding: 0;
  overflow-y: auto;
  background: rgb(var(--fill-lightest-color, 247 249 252));
}
.wf-props-panel__empty {
  margin: 24px 12px 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
}
</style>
