<script setup lang="ts">
/**
 * panels/CcPanel.vue —— 抄送节点（N4）属性面板。
 *
 * 面板按分区（tab）组织，节点改名由公共头部 PanelHeader 就地完成。三个分区固定：基本（basic：
 * 收件人 + 再缩小范围）/ 通知（notify：通知渠道、通知标题、通知正文）/ 表单（form：字段权限）
 * ——抄送节点没有无路提示/步骤摘要/自动办理条件这三项，与 ApprovePanel.vue 不一样。
 *
 * 通知渠道三档（系统通知/短信/邮件，系统通知默认选中）挂 host.channelCapabilities()：不可用的
 * 渠道置灰 + Tooltip 说明原因；wire 类型 WorkflowDesignerNotifyChannelCapability 只有
 * `{channel, available}` 两个字段（见 ../host.ts），没有单独的"原因"字段，因此三档各自的置灰
 * 提示文案是按渠道写死的通用一句（"XX 服务尚未配置"），不是从接口回传的动态原因。
 *
 * 渠道勾选清单（复选框渲染、能力查询、"至少保留一种"互斥逻辑）由共享组件
 * ./shared/NotifyChannelList.vue + ./shared/channelCapabilities.ts useChannelCapabilities 提供，
 * 节点级通知卡（shared/NotifyCard.vue）复用同一套 UI。data-testid 为 `cc-channel-<channel>`
 * （testidPrefix 默认值即 'cc'，不需要显式传参）。至少保留一种渠道的互斥逻辑纯函数在
 * ./shared/ccSections.ts toggleChannel（NotifyChannelList.vue 内部调用）。
 *
 * 通知标题/正文两个表达式槽：CCConfig.title_expr/content_expr 在 wire 协议上要求键恒存在、
 * "未配置"用字面量 null 表达（不能省略键，见 model/document.ts CCConfig 注释）；
 * V4ExpressionField 清空时 emit undefined，写回前经 ./shared/ccSections.ts normalizeExprSlot
 * 归一化成 null（纯函数单测覆盖）。
 *
 * 『与上步处理人的关系』是独立过滤器（不是人员来源），basic 分区在收件人卡之后放『再缩小范围』卡
 * （shared/RelationFilterCard.vue，与 HandlePanel.vue/ApprovePanel.vue 同一套接线），写回
 * config.relation_filters。
 */
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { CCConfig, V4ExpressionDocumentEnvelope, WorkflowNode } from '../../model';
import { mainTemplateIdOf } from '../expression/v4Scope';
import V4ExpressionField from '../expression/V4ExpressionField.vue';
import AssigneeSourceList from './shared/AssigneeSourceList.vue';
import FieldPermissionSummary from './shared/FieldPermissionSummary.vue';
import NotifyChannelList from './shared/NotifyChannelList.vue';
import RelationFilterCard from './shared/RelationFilterCard.vue';
import PanelHeader from './PanelHeader.vue';
import PanelSection from './PanelSection.vue';
import PanelTabs, { type PanelTabItem } from './PanelTabs.vue';
import { usePanelHost } from './usePanelHost';
import { normalizeExprSlot } from './shared/ccSections';

const props = defineProps<{ node: WorkflowNode; readOnly?: boolean }>();

// inject host/i18n/state + 订阅 changeTick 统一经 usePanelHost()（见其头注释）。不解构 host——
// 渠道能力查询在 shared/NotifyChannelList.vue 内部自行 inject，本文件不直接调用 host 的任何方法。
const { i18n, state, changeTick } = usePanelHost();

/** 节点 config 理论上不该缺席（addNode 恒用 createDefaultConfig 兜底），这里只是给类型系统一个
 *  兜底占位（同 HandlePanel.vue EMPTY_HANDLE_CONFIG 既定手法）。 */
const EMPTY_CC_CONFIG: CCConfig = { recipients: [], channels: ['system'], title_expr: null, content_expr: null, field_permissions: [] };

const templateId = computed(() => {
  void changeTick.value;
  return mainTemplateIdOf(state.value?.doc);
});

const config = computed<CCConfig>(() => (props.node.config as CCConfig | undefined) ?? EMPTY_CC_CONFIG);

function patchConfig(patch: Partial<CCConfig>): void {
  if (props.readOnly) return;
  state.value?.updateNodeConfig(props.node.id, patch as Record<string, unknown>);
}

// ── 分区（tab） ─────────────────────────────────────────────────────────────────────────
// 三个分区固定 key（与 PanelTabs.vue/usePanelHost.ts 约定的文案键一致，见文件头注释）；
// 切换到另一个抄送节点时重置回「基本」，不残留上一个节点停留的分区（同 PanelHeader.vue
// 「选中项从一个节点切到另一个节点时不能让上一个节点的编辑态残留」同一理由）。
const activeTab = ref('basic');
watch(
  () => props.node.id,
  () => {
    activeTab.value = 'basic';
  }
);
const tabs = computed<PanelTabItem[]>(() => [
  { key: 'basic', label: i18n.t('workflow.designer.panel.tabs.basic') },
  { key: 'notify', label: i18n.t('workflow.designer.panel.tabs.notify') },
  { key: 'form', label: i18n.t('workflow.designer.panel.tabs.form') }
]);

// ── 收件人（同『A』） ───────────────────────────────────────────────────────────────────
function onRecipientsUpdate(sources: CCConfig['recipients']): void {
  patchConfig({ recipients: sources });
}

// ── 再缩小范围：与上步处理人的关系（过滤器，不是来源，同 HandlePanel.vue 同名函数既定接线） ──
function onRelationFiltersUpdate(value: CCConfig['relation_filters']): void {
  patchConfig({ relation_filters: value });
}

// ── 通知渠道：渲染/能力查询/互斥逻辑在 shared/NotifyChannelList.vue，本文件只负责写回
// channels 字段（见文件头注释）。 ─────────────────────────────────────────────────────────
function onChannelsUpdate(channels: CCConfig['channels']): void {
  patchConfig({ channels });
}

// ── 通知标题 / 正文（V4 取值表达式，必填但类型允许 null，见头注释） ───────────────────
function onTitleChange(value: V4ExpressionDocumentEnvelope | undefined): void {
  patchConfig({ title_expr: normalizeExprSlot(value) });
}
function onContentChange(value: V4ExpressionDocumentEnvelope | undefined): void {
  patchConfig({ content_expr: normalizeExprSlot(value) });
}
</script>

<template>
  <div class="wf-cc-panel">
    <PanelHeader :node="node" :read-only="readOnly" />

    <PanelTabs :tabs="tabs" :active="activeTab" :read-only="readOnly" @update:active="activeTab = $event">
      <!-- 分区『基本』：收件人 + 再缩小范围（抄送节点没有无路提示/步骤摘要/自动办理条件，
           见文件头注释） -->
      <div v-show="activeTab === 'basic'" class="wf-cc-panel__tab-pane" data-testid="cc-tab-basic">
        <PanelSection
          :title="i18n.t('workflow.designer.panel.section.recipients')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <AssigneeSourceList
            :model-value="config.recipients ?? []"
            :read-only="readOnly"
            :template-id="templateId"
            @update:model-value="onRecipientsUpdate"
          />
        </PanelSection>

        <RelationFilterCard :model-value="config.relation_filters" :read-only="readOnly" @update:model-value="onRelationFiltersUpdate" />
      </div>

      <!-- 分区『通知』：通知渠道、通知标题、通知正文 -->
      <div v-show="activeTab === 'notify'" class="wf-cc-panel__tab-pane" data-testid="cc-tab-notify">
        <!-- 通知渠道：cc.go Validate 里 len(cfg.Channels) == 0 即 N4_CHANNEL_REQUIRED 拒绝发布，
             因此标必填。渲染/能力查询/互斥逻辑在 shared/NotifyChannelList.vue，本文件只提供分区外壳
             + 写回，不传 testid-prefix（复用默认值 'cc'）。 -->
        <PanelSection
          :title="i18n.t('workflow.designer.panel.section.channels')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <NotifyChannelList :model-value="config.channels" :read-only="readOnly" @update:model-value="onChannelsUpdate" />
        </PanelSection>

        <PanelSection
          :title="i18n.t('workflow.designer.panel.section.notifyTitle')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <V4ExpressionField
            data-testid="cc-title"
            :model-value="config.title_expr ?? undefined"
            mode="value"
            :expression-id="`${node.id}:cc-title`"
            :template-id="templateId"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.cc.titlePlaceholder')"
            @update:model-value="onTitleChange"
          />
          <p v-if="!config.title_expr" class="wf-cc-panel__hint wf-cc-panel__hint--warn">{{ i18n.t('workflow.designer.cc.titleRequiredHint') }}</p>
        </PanelSection>

        <PanelSection
          :title="i18n.t('workflow.designer.panel.section.notifyContent')"
          required
          :required-label="i18n.t('workflow.designer.panel.requiredMark')"
        >
          <V4ExpressionField
            data-testid="cc-content"
            :model-value="config.content_expr ?? undefined"
            mode="value"
            :expression-id="`${node.id}:cc-content`"
            :template-id="templateId"
            :disabled="readOnly"
            :placeholder="i18n.t('workflow.designer.cc.contentPlaceholder')"
            @update:model-value="onContentChange"
          />
          <p v-if="!config.content_expr" class="wf-cc-panel__hint wf-cc-panel__hint--warn">{{ i18n.t('workflow.designer.cc.contentRequiredHint') }}</p>
        </PanelSection>
      </div>

      <!-- 分区『表单』：字段权限 -->
      <div v-show="activeTab === 'form'" class="wf-cc-panel__tab-pane" data-testid="cc-tab-form">
        <PanelSection :title="i18n.t('workflow.designer.panel.section.fieldPermission')">
          <!-- 抄送节点是只看型（三档）；对话框确定后的清单在这里回写。 -->
          <FieldPermissionSummary :model-value="config.field_permissions" :readonly-only="true" :disabled="readOnly" @update:model-value="(v) => patchConfig({ field_permissions: v })" />
        </PanelSection>
      </div>
    </PanelTabs>
  </div>
</template>

<style scoped>
/* 根容器不留 gap：身份头与分区标签条连成一块白底（同 ApprovePanel.vue .ap 处注释）。 */
.wf-cc-panel {
  display: flex;
  flex-direction: column;
}
.wf-cc-panel__tab-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 渠道相关样式在 shared/NotifyChannelList.vue 自己的 scoped style 里；下面 .wf-cc-panel__hint(--warn)
   两条用于通知标题/正文的必填提示。 */
.wf-cc-panel__hint { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
.wf-cc-panel__hint--warn { color: rgb(var(--warning-color, 240 160 32)); }
</style>
