<script setup lang="ts">
/**
 * panels/shared/NotifyChannelList.vue —— 通知渠道三档竖排勾选清单（系统通知/短信/邮件）。
 *
 * 抄送节点面板（通知渠道）与四类主线节点的『通知』卡（shared/NotifyCard.vue，
 * StartPanel/HandlePanel/ApprovePanel/EndPanel 各一份）用的是同一套渠道 UI 与"至少保留一种"
 * 互斥规则，由本组件统一实现，两处都调用本组件。渠道能力查询同理抽到 ./channelCapabilities.ts useChannelCapabilities，
 * "至少保留一种"的互斥判定复用 ./ccSections.ts 既有的 toggleChannel 纯函数（不重复实现）。
 *
 * data-testid：`${testidPrefix}-channel-${channel}`，默认前缀 'cc'——CcPanel.vue 不传这个 prop
 * 时渲染出 `cc-channel-system` 等（e2e 依赖这批 testid）；NotifyCard.vue 传
 * `testid-prefix="notify"`，渲染出 `notify-channel-system` 等。
 *
 * props：
 *   - modelValue：当前渠道清单，undefined 按空数组处理（同 CcPanel.vue `config.channels ?? []`
 *     口径）。
 *   - readOnly：只读态下渠道复选框全部禁用（不可用渠道原本就禁用，只读态叠加一次即可，即
 *     `:disabled="readOnly || !isChannelChecked(opt.value)"`）。
 *   - testidPrefix：见上。
 * emit：`update:modelValue`——只在真正发生变化（未被"至少保留一种"拒绝）时触发；拒绝时不 emit，
 * 只在组件内部置一个"已拒绝"提示位（channelToggleRejected），不需要调用方处理拒绝态。
 */
import { inject, ref } from 'vue';
import { NCheckbox, NTooltip } from 'naive-ui';
import { DESIGNER_I18N_KEY } from '../../host';
import type { NotifyChannel } from '../../../model';
import { useChannelCapabilities } from './channelCapabilities';
import { toggleChannel } from './ccSections';

const props = withDefaults(
  defineProps<{
    modelValue: NotifyChannel[] | undefined;
    readOnly?: boolean;
    testidPrefix?: string;
  }>(),
  { testidPrefix: 'cc' }
);

const emit = defineEmits<{ (e: 'update:modelValue', value: NotifyChannel[]): void }>();

// 同 AssigneeSourceList.vue 既定手法：直接 inject i18n（不经 usePanelHost()——那个 composable
// 同时要求 DESIGNER_STATE_KEY 注入，本组件是纯展示件，不需要文档状态）。
const injectedI18n = inject(DESIGNER_I18N_KEY);
if (!injectedI18n) {
  throw new Error('[NotifyChannelList] 缺少 DESIGNER_I18N_KEY 注入，请确认挂载在设计器根组件之下');
}
const i18n = injectedI18n;
const { isAvailable } = useChannelCapabilities();

/** 三档固定顺序（系统通知/短信/邮件，系统通知默认选中），同抄送节点属性；标签/不可用
 *  提示走既有 `workflow.designer.cc.*` 前缀键——这组 key 名带 `cc.` 前缀但现在被本共享组件
 *  复用，保留原 key 不改名（渠道名/服务未配置这类概念天然与"抄送"还是"节点级
 *  通知"无关，不值得为了名字"看起来更通用"而改一遍四语文件）。 */
const CHANNEL_OPTIONS: { value: NotifyChannel; labelKey: string; unavailableHintKey: string }[] = [
  { value: 'system', labelKey: 'workflow.designer.cc.channel.system', unavailableHintKey: 'workflow.designer.cc.channelUnavailable.system' },
  { value: 'sms', labelKey: 'workflow.designer.cc.channel.sms', unavailableHintKey: 'workflow.designer.cc.channelUnavailable.sms' },
  { value: 'email', labelKey: 'workflow.designer.cc.channel.email', unavailableHintKey: 'workflow.designer.cc.channelUnavailable.email' }
];

function isChecked(channel: NotifyChannel): boolean {
  return (props.modelValue ?? []).includes(channel);
}

const rejected = ref(false);
function onToggle(channel: NotifyChannel): void {
  if (props.readOnly) return;
  const current = props.modelValue ?? [];
  const next = toggleChannel(current, channel);
  if (next === current) {
    // toggleChannel 拒绝了这次操作（试图取消唯一一种渠道）：不 emit、只置提示位。
    rejected.value = true;
    return;
  }
  rejected.value = false;
  emit('update:modelValue', next);
}
</script>

<template>
  <div class="wf-notify-channels">
    <div class="wf-notify-channels__list">
      <template v-for="opt in CHANNEL_OPTIONS" :key="opt.value">
        <!-- 渠道当前不可用：未勾选时不许再勾；已勾选的保留并标橙，且允许设计者主动取消（不能把
             人困在一个取消不掉的渠道上）。 -->
        <NTooltip v-if="!isAvailable(opt.value)" trigger="hover">
          <template #trigger>
            <!-- 未接通的渠道后面常显一枚灰色「服务未配置」标签，不再只靠悬停才知道原因。 -->
            <span class="wf-notify-channels__row">
              <NCheckbox
                size="small"
                :data-testid="`${testidPrefix}-channel-${opt.value}`"
                :checked="isChecked(opt.value)"
                :class="{ 'wf-notify-channels__channel--warn': isChecked(opt.value) }"
                :disabled="readOnly || !isChecked(opt.value)"
                @update:checked="onToggle(opt.value)"
              >{{ i18n.t(opt.labelKey) }}</NCheckbox>
              <span class="wf-notify-channels__tag">{{ i18n.t('workflow.designer.cc.channelNotConfigured') }}</span>
            </span>
          </template>
          {{ i18n.t(opt.unavailableHintKey) }}
        </NTooltip>
        <NCheckbox
          v-else
          size="small"
          :data-testid="`${testidPrefix}-channel-${opt.value}`"
          :checked="isChecked(opt.value)"
          :disabled="readOnly"
          @update:checked="onToggle(opt.value)"
        >{{ i18n.t(opt.labelKey) }}</NCheckbox>
      </template>
    </div>
    <p class="wf-notify-channels__hint">{{ i18n.t('workflow.designer.cc.channelHelp') }}</p>
    <p v-if="rejected" class="wf-notify-channels__hint wf-notify-channels__hint--warn">{{ i18n.t('workflow.designer.cc.channelMinRequired') }}</p>
  </div>
</template>

<style scoped>
.wf-notify-channels { display: flex; flex-direction: column; gap: 6px; }
/* 渠道竖排，一行一个。 */
.wf-notify-channels__list { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.wf-notify-channels__row { display: inline-flex; align-items: center; gap: 8px; }
.wf-notify-channels__tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(var(--fill-color, 240 242 245));
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 11px;
  white-space: nowrap;
}
.wf-notify-channels__channel--warn :deep(.n-checkbox__label) { color: rgb(var(--warning-color, 240 160 32)); }
.wf-notify-channels__hint { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
.wf-notify-channels__hint--warn { color: rgb(var(--warning-color, 240 160 32)); }
</style>
