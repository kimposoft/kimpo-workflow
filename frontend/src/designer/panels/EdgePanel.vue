<script setup lang="ts">
/**
 * panels/EdgePanel.vue —— 选中引导线时的属性面板：连线名称 + 一个条件框，条件框空即「无条件，
 * 恒可走」。由 ../shell/PropsPanel.vue 的连线分支挂载。
 *
 * props 是 `{ link, readOnly }` 不是 `{ node, readOnly }`，不适用公共头部 ../PanelHeader.vue
 * （其接口只接节点），因此本文件自绘身份头；inject host/i18n/state + changeTick 桥接走
 * usePanelHost()。
 *
 * 🔴「连线名称」`WorkflowLink.name` 是设计者自己填的一段文本，至多 20 字、可空，只用于画布中点
 * 珠子标识这条线（不参与选路，见 model/document.ts WorkflowLink.name 注释），与身份头「起点名 →
 * 终点名」（两端节点的展示名拼接，不可编辑）是完全独立的两个东西。
 */
import { computed, ref, watch } from 'vue';
import { NInput } from 'naive-ui';
import type { WorkflowLink } from '../../model';
import { nodeTypeLabel } from '../../model/node-naming';
import { mainTemplateIdOf } from '../expression/v4Scope';
import V4ExpressionField from '../expression/V4ExpressionField.vue';
import PanelSection from './PanelSection.vue';
import { usePanelHost } from './usePanelHost';

const props = defineProps<{
  link: WorkflowLink;
  readOnly?: boolean;
}>();

const { i18n, state, changeTick } = usePanelHost();

const templateId = computed(() => {
  void changeTick.value;
  return mainTemplateIdOf(state.value?.doc);
});

/** 身份头第二行「起点名 → 终点名」：用两端节点的展示名拼（与可选的连线名称无关）；节点没有
 *  自定义名时退回类型名，节点已不在文档里（悬空引用）时该端留空，不编造。 */
const endpointsLabel = computed(() => {
  void changeTick.value;
  const nodes = state.value?.doc?.nodes ?? [];
  const nameOf = (id: string): string => {
    const node = nodes.find((n) => n.id === id);
    return node ? node.name || nodeTypeLabel(i18n, node.kind) : '';
  };
  return `${nameOf(props.link.from)} → ${nameOf(props.link.to)}`;
});

// ── 连线名称：草稿值 + 失焦/回车提交（照抄 ../PanelHeader.vue 改名草稿手法，见该文件头注释）——
// 不像节点改名那样有「点击进入编辑态」的切换，这里的 NInput 本就是分区正文的常驻控件，因此没有
// editing 标志位，直接拿 nameDraft 双向绑定即可；不逐字符调 updateLinkName 进撤销栈，只在失焦/
// 回车时提交一次。 ──────────────────────────────────────────────────────────────────────────
const nameDraft = ref(props.link.name ?? '');

// 选中另一条连线时（同类型面板复用同一个 EdgePanel 实例，不会随选中项切换而重新挂载）按新连线
// 的名字重置草稿，不残留上一条线未提交的编辑态——同 PanelHeader.vue watch(() => props.node.id, …)
// 既定处理。
watch(
  () => props.link.id,
  () => {
    nameDraft.value = props.link.name ?? '';
  }
);
// 同一条线的 name 在别处发生变化时（本组件自己提交后文档状态回灌 / 撤销重做）同步草稿——不需要
// 像 PanelHeader 那样加 `!editing` 判空守卫：本输入框只在失焦/回车才写回，没有"用户正在打字、
// 外部变化不该打断"的冲突窗口（提交前 props.link.name 不会变化）。
watch(
  () => props.link.name,
  (next) => {
    nameDraft.value = next ?? '';
  }
);

/** 提交连线名称（失焦/回车触发）：去空白/截断到 20 字/空串转 undefined 的规则全部在
 *  model/document-state.ts updateLinkName 里，本层只透传草稿值，不重复实现一遍规则。 */
function commitName(): void {
  if (props.readOnly) return;
  state.value?.updateLinkName(props.link.id, nameDraft.value);
}

function onNameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') commitName();
}

function onConditionUpdate(doc: WorkflowLink['condition_doc']): void {
  if (props.readOnly) return;
  state.value?.updateLinkCondition(props.link.id, doc);
}
</script>

<template>
  <div class="ep">
    <!-- 身份头：形态与节点面板的 PanelHeader.vue 一致（徽标 + 类型名 + 展示名），这里展示的是
         「起点名 → 终点名」拼接（endpointsLabel，见脚本区注释），不是下面「连线名称」分区那个
         设计者自填字段，语义不同、不能合并，因此不复用 PanelHeader（其接口只接节点、且改的是
         节点自身名字），这里仍是只读展示。 -->
    <div class="ep__header" data-testid="edge-panel-header">
      <span class="ep__badge">
        <svg viewBox="0 0 16 16" class="ep__badge-icon" aria-hidden="true"><path d="M2.5 8h10M9 4.5L12.5 8 9 11.5" /></svg>
      </span>
      <div class="ep__header-text">
        <span class="ep__type">{{ i18n.t('workflow.designer.panel.header.edgeKind') }}</span>
        <span class="ep__name" :title="endpointsLabel">{{ endpointsLabel }}</span>
      </div>
    </div>
    <!-- 连线名称：设计者自己填的一段文本，只用于画布中点珠子标识
         这条线，不参与选路，留空不画珠、线照常可走——帮助语把这句话直接告诉设计者，不藏进 ⓘ
         悬停气泡（同 EndPanel.vue「说明常显在输入框下」的既定手法）。 -->
    <PanelSection :title="i18n.t('workflow.designer.panel.section.linkName')">
      <NInput
        v-model:value="nameDraft"
        size="small"
        :maxlength="20"
        show-count
        :disabled="readOnly"
        :placeholder="i18n.t('workflow.designer.panel.linkNamePlaceholder')"
        @blur="commitName"
        @keydown="onNameKeydown"
      />
      <p class="ep__name-hint">{{ i18n.t('workflow.designer.panel.linkNameHint') }}</p>
    </PanelSection>
    <PanelSection :title="i18n.t('workflow.designer.panel.section.condition')" :info="i18n.t('workflow.designer.panel.conditionHint')">
      <V4ExpressionField
        :model-value="link.condition_doc"
        mode="condition"
        :expression-id="link.id"
        :template-id="templateId"
        :disabled="readOnly"
        :placeholder="i18n.t('workflow.designer.panel.conditionPlaceholder')"
        @update:model-value="onConditionUpdate"
      />
    </PanelSection>
  </div>
</template>

<style scoped>
.ep { display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px; }
/* 不分区面板：分区卡片自己左右各留 10px，身份头贴边（同 EndPanel.vue 同名规则处注释）。 */
.ep > .wf-panel-section { margin: 0 10px; }
.ep__header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px;
  border-bottom: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  background: rgb(var(--container-bg-color, 255 255 255));
}
.ep__badge {
  display: flex;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: rgb(var(--fill-color, 240 242 245));
  color: rgb(var(--text-secondary-color, 102 102 102));
}
.ep__badge-icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ep__header-text { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 1px; }
.ep__type { color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.4; }
.ep__name {
  overflow: hidden;
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* 连线名称分区下的帮助语（同 EndPanel.vue .wf-end-panel__hint / CcPanel.vue .wf-cc-panel__hint
   既定风格：次要文字色 + 11px + 1.5 行高）。 */
.ep__name-hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
</style>
