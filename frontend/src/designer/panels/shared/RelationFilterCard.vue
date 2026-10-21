<script setup lang="ts">
/**
 * panels/shared/RelationFilterCard.vue —— 『再缩小范围』卡：办理/审批/抄送三类节点属性面板『基本』分区共用的
 * 独立过滤器卡，紧接在『从哪里选人』卡之后——HandlePanel.vue/ApprovePanel.vue 还要求它出现在
 * 『步骤摘要』卡之前，CcPanel.vue 的『基本』分区没有步骤摘要，直接接在收件人卡之后即可。
 *
 * 『与上步处理人的关系』五档对应节点 config 上独立的 relation_filters 字段（"在已选出的人里再筛
 * 一道，只留下与上步处理人满足关系的人"，见 model/document.ts HandleConfig.relation_filters
 * 注释），不属于『人员来源』清单，因此本组件独立成一张卡（自带 <PanelSection> 外壳，不同于 AssigneeSourceList.vue"正文经调用方包一层
 * PanelSection"的既定分工：本组件是"整张卡"，供调用方一行接线，不是"卡片正文"）。
 *
 * 五档胶囊沿用既有 ./RelationPills.vue（纯展示 + 事件转发，见其头注释），本组件是"配置文案 +
 * 事件转发 + 归一化写回"的薄壳：真正的勾选/取消逻辑在 ./relationFilters.ts
 * toggleRelationFilter/isRelationFilterChecked。
 *
 * 写回：任一档切换都经 toggleRelationFilter 计算新数组，全部取消时统一写回 undefined（不写空
 * 数组），保持文档干净——同 CcPanel.vue ccSections.ts normalizeExprSlot"emit
 * 前先归一化"的既定风格。
 *
 * i18n：本组件直接 inject DESIGNER_I18N_KEY（同 shared/NotifyChannelList.vue 既定手法——它是
 * 纯展示件，不需要 usePanelHost() 额外要求的 DESIGNER_STATE_KEY 注入）。
 *
 * 只读态：整卡禁用，胶囊不可点（透传给 RelationPills 的 disabled）。
 */
import { inject } from 'vue';
import { DESIGNER_I18N_KEY } from '../../host';
import type { AssigneeRelation } from '../../../model';
import PanelSection from '../PanelSection.vue';
import RelationPills from './RelationPills.vue';
import { RELATION_OPTIONS, isRelationFilterChecked, toggleRelationFilter } from './relationFilters';

const props = defineProps<{
  modelValue: AssigneeRelation[] | undefined;
  readOnly?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: AssigneeRelation[] | undefined] }>();

const injectedI18n = inject(DESIGNER_I18N_KEY);
if (!injectedI18n) {
  throw new Error('[RelationFilterCard] 缺少 DESIGNER_I18N_KEY 注入，请确认挂载在设计器根组件之下');
}
const i18n = injectedI18n;

function checked(relation: AssigneeRelation): boolean {
  return isRelationFilterChecked(props.modelValue, relation);
}

function onToggle(relation: AssigneeRelation): void {
  if (props.readOnly) return;
  const next = toggleRelationFilter(props.modelValue, relation);
  // 全部取消时写回 undefined 而不是空数组，保持文档干净（见文件头注释）。
  emit('update:modelValue', next.length > 0 ? next : undefined);
}
</script>

<template>
  <PanelSection :title="i18n.t('workflow.designer.panel.section.relationFilters')">
    <span class="rfc__label">{{ i18n.t('workflow.designer.assignee.relationFilterLabel') }}</span>
    <RelationPills :relations="RELATION_OPTIONS" :is-checked="checked" :disabled="readOnly" @toggle="onToggle">
      <template #default="{ relation }">{{ i18n.t(`workflow.designer.assignee.relation.${relation}`) }}</template>
    </RelationPills>
    <p class="rfc__help">{{ i18n.t('workflow.designer.assignee.relationFilterHelp') }}</p>
  </PanelSection>
</template>

<style scoped>
.rfc__label { display: block; margin-bottom: 6px; color: rgb(var(--text-secondary-color, 102 102 102)); font-size: 12px; }
.rfc__help { margin: 6px 0 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
</style>
