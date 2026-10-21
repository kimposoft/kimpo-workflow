<script setup lang="ts">
/**
 * panels/shared/RelationPills.vue —— 『与上步处理人的关系』五档多选胶囊，纯展示 + 事件
 * 转发，不持有状态。
 *
 * 『关系』对应节点 config 上独立的 relation_filters 字段，本组件挂载在「再缩小范围」卡
 * （shared/RelationFilterCard.vue）里，增删逻辑在 ./relationFilters.ts toggleRelationFilter。
 * data-testid 为 `relation-filter-<relation>`；目前只有 RelationFilterCard.vue 一处消费者，直接
 * 写字面量，不需要像 shared/NotifyChannelList.vue 那样引入 testidPrefix 前缀 prop。
 *
 * 无障碍：每个胶囊 role="checkbox" + aria-checked，可用 Tab 聚焦、Space/Enter 切换，与鼠标点击
 * 走同一个 onActivate（同 V4ExpressionField.vue token 区 openEdit/onBoxActivate 的既定手法：
 * 两个入口、一个行为）。文案由调用方经默认作用域插槽传入（本组件不 inject i18n），保持与业务文案
 * 完全解耦。
 */
import type { AssigneeRelation } from '../../../model';

const props = defineProps<{
  relations: readonly AssigneeRelation[];
  isChecked: (relation: AssigneeRelation) => boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ toggle: [relation: AssigneeRelation] }>();

function onActivate(relation: AssigneeRelation): void {
  if (props.disabled) return;
  emit('toggle', relation);
}
</script>

<template>
  <div class="rp">
    <span
      v-for="r in relations"
      :key="r"
      class="rp__pill"
      :class="{ 'rp__pill--checked': isChecked(r), 'rp__pill--disabled': disabled }"
      role="checkbox"
      :aria-checked="isChecked(r)"
      :aria-disabled="disabled"
      :tabindex="disabled ? -1 : 0"
      :data-testid="`relation-filter-${r}`"
      @click="onActivate(r)"
      @keydown.enter.prevent="onActivate(r)"
      @keydown.space.prevent="onActivate(r)"
    ><slot :relation="r" /></span>
  </div>
</template>

<style scoped>
.rp { display: flex; flex-wrap: wrap; gap: 6px; }
.rp__pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 12px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 12px;
  line-height: 22px;
  cursor: pointer;
  user-select: none;
}
.rp__pill:focus-visible { outline: 2px solid rgb(var(--primary-color, 24 160 88) / 40%); outline-offset: 1px; }
.rp__pill--checked {
  border-color: rgb(var(--primary-color, 24 160 88));
  background: rgb(var(--primary-color, 24 160 88) / 10%);
  color: rgb(var(--primary-color, 24 160 88));
}
.rp__pill--disabled { cursor: not-allowed; opacity: 0.6; }
</style>
