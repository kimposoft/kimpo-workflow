<script setup lang="ts">
/**
 * designer/panels/EndPanel.vue —— 结束节点（N5）属性面板。
 * 由 shell/PropsPanel.vue 按节点类型注册表（designer/nodes/end/index.ts 的 panel 字段）分发，
 * 恰好选中一个 kind==='end' 的节点时渲染，接收 `node`/`readOnly` 两个 prop。
 *
 * 「标识写入字段」的主表字段目录需要知道"目标表单"——EndConfig 自身不带 template_id（一条
 * 流程恒只有一个目标表单，挂在发起节点 StartConfig.target_template_id 上），因此本组件经
 * usePanelHost() 拿到的文档状态 state 读整份文档、找出唯一的 start 节点取其
 * target_template_id，不是从本节点自己的 config 上取（那里没有这个字段）。
 *
 * 节点改名由公共头部 ../PanelHeader.vue 就地完成，本面板不另设名称分区；host/i18n/state 三件套
 * 的注入与订阅经 usePanelHost() 取得（见该文件头注释）。
 *
 * 通知开关是节点级配置，本面板（不分区，平铺一屏）在最后放『通知』卡（shared/NotifyCard.vue），
 * 结束节点只认一个开关键 on_ended（流程结束时通知发起人）。
 */
import { computed } from 'vue';
import { NInput } from 'naive-ui';
import type { EndConfig, StartConfig, WorkflowNode } from '../../model';
import PanelHeader from './PanelHeader.vue';
import PanelSection from './PanelSection.vue';
import MainFieldSelect from './shared/MainFieldSelect.vue';
import NotifyCard, { type NotifyCardSwitch } from './shared/NotifyCard.vue';
import { usePanelHost } from './usePanelHost';

const props = defineProps<{ node: WorkflowNode; readOnly?: boolean }>();

const { i18n, state } = usePanelHost();

const config = computed<EndConfig>(() => (props.node.config as EndConfig | undefined) ?? { end_flag: '' });

/** 本流程唯一发起节点绑定的目标表单 id；文档正常情况下恒有一个 start 节点（后端 Decode 校验），
 * 取不到时退化为空字符串——MainFieldSelect 对空 templateId 有自己的业务话空态，本组件不需要
 * 再单独处理。 */
const targetTemplateId = computed(() => {
  const doc = state?.value?.doc;
  const startNode = doc?.nodes.find((n) => n.kind === 'start');
  return (startNode?.config as StartConfig | undefined)?.target_template_id ?? '';
});

function patchConfig(patch: Partial<EndConfig>): void {
  if (props.readOnly) return;
  state?.value?.updateNodeConfig(props.node.id, patch as Record<string, unknown>);
}

function onEndFlagInput(value: string): void {
  patchConfig({ end_flag: value });
}

function onWriteFieldChange(value: string | undefined): void {
  patchConfig({ write_field_id: value });
}

// ── 通知：结束节点只认『流程结束时通知发起人』一个开关键。 ──
const notifySwitches = computed<NotifyCardSwitch[]>(() => [{ key: 'on_ended', label: i18n.t('workflow.designer.panel.end.notifyOnEnded') }]);
function onNotifyChange(value: EndConfig['notify']): void {
  patchConfig({ notify: value });
}
</script>

<template>
  <div class="wf-end-panel">
    <PanelHeader :node="node" :read-only="readOnly" />

    <PanelSection
      :title="i18n.t('workflow.designer.panel.end.flagTitle')"
      required
      :required-label="i18n.t('workflow.designer.panel.requiredMark')"
    >
      <NInput
        class="wf-end-panel__text-input"
        size="small"
        :value="config.end_flag"
        :disabled="readOnly"
        :placeholder="i18n.t('workflow.designer.panel.end.flagPlaceholder')"
        @update:value="onEndFlagInput"
      />
      <!-- 说明常显在输入框下，不收进标题旁的 ⓘ 悬停。 -->
      <p class="wf-end-panel__hint">{{ i18n.t('workflow.designer.panel.end.flagInfo') }}</p>
      <p v-if="!config.end_flag" class="wf-end-panel__hint">{{ i18n.t('workflow.designer.panel.end.flagEmptyHint') }}</p>
    </PanelSection>

    <PanelSection :title="i18n.t('workflow.designer.panel.end.writeFieldTitle')" :info="i18n.t('workflow.designer.panel.end.writeFieldInfo')">
      <MainFieldSelect
        data-testid="end-write-field"
        :template-id="targetTemplateId"
        :model-value="config.write_field_id"
        data-type="text"
        :disabled="readOnly"
        @update:model-value="onWriteFieldChange"
      />
    </PanelSection>

    <!-- 通知：固定放在最后（本面板不分区）。 -->
    <PanelSection :title="i18n.t('workflow.designer.panel.section.notify')">
      <NotifyCard :model-value="config.notify" :switches="notifySwitches" :read-only="readOnly" @update:model-value="onNotifyChange" />
    </PanelSection>
  </div>
</template>

<style scoped>
.wf-end-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 10px;
}
/* 本面板不分区，没有分区标签条那层内容区来给内边距：分区卡片自己左右各留 10px，身份头仍贴边。
   （子组件根节点带着父级的作用域标记，所以这条选择器不需要 :deep。） */
.wf-end-panel > .wf-panel-section { margin: 0 10px; }
.wf-end-panel__hint {
  margin: 0;
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.5;
}
</style>
