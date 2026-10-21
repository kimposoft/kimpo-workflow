<script setup lang="ts">
/**
 * panels/shared/NotifyCard.vue —— 四类主线节点（发起/办理/审批/结束）共用的『通知』卡正文：通知开关
 * 配在节点级，各节点面板在所在分区
 * 最后一张卡里嵌入本组件，卡片自身的 `<PanelSection :title="...">` 外壳由调用方提供——本组件
 * 只是分区正文，不持有任何业务 i18n key（同 PanelSection.vue"文本经 props 传入已翻译好的字面量"
 * 的既定手法，见其头注释）：`switches[].label` 由调用方按当前语言翻译好传入，本组件只负责按
 * `switches` 清单渲染开关行 + 复用 NotifyChannelList.vue 渲染渠道勾选。
 *
 * 形态：每个开关一行——左边文字、右边 NSwitch size="small"；开关下面是渠道勾选（同
 * ./NotifyChannelList.vue，testidPrefix 固定传 'notify'，渲染出 `notify-channel-<channel>`）。
 *
 * 回显：`modelValue` 为 undefined 时，所有开关显示为开、渠道显示为只勾系统通知（同后端
 * NodeNotify.Enabled/ChannelsOrDefault 语义，纯函数在 ./nodeNotify.ts resolveNotify）。
 *
 * 写回：任何一次操作（切换某个开关、切换某个渠道）都经 emit('update:modelValue', ...) 写回一个
 * 只含 `switches` 里那几个开关键 + channels 的完整对象，显式 true/false，不靠缺席表达——纯逻辑在
 * ./nodeNotify.ts（toggleNotifySwitch/applyNotifyChannels），本组件只负责事件绑定与渲染。
 *
 * data-testid：开关 `notify-switch-<key>`，渠道 `notify-channel-<channel>`（后者由
 * NotifyChannelList.vue 按 testidPrefix 渲染）。
 */
import { computed } from 'vue';
import { NSwitch } from 'naive-ui';
import type { NodeNotify, NotifyChannel, NotifyEventKey } from '../../../model';
import NotifyChannelList from './NotifyChannelList.vue';
import { applyNotifyChannels, resolveNotify, toggleNotifySwitch } from './nodeNotify';

/** 单个开关行的定义：`key` 决定读写 NodeNotify 的哪个字段，`label` 是调用方已翻译好的业务话
 *  文案（见文件头注释）。 */
export interface NotifyCardSwitch {
  key: NotifyEventKey;
  label: string;
}

const props = defineProps<{
  modelValue: NodeNotify | undefined;
  switches: NotifyCardSwitch[];
  readOnly?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: NodeNotify): void }>();

/** 本组件认的开关键清单（从 switches 派生，供纯函数收窄写回对象）。 */
const keys = computed<NotifyEventKey[]>(() => props.switches.map((s) => s.key));

/** 完整显示态：undefined/部分配置一律归一化成确定的 true/false + channels 数组。 */
const resolved = computed(() => resolveNotify(props.modelValue));

function isChecked(key: NotifyEventKey): boolean {
  return resolved.value[key];
}

function onSwitchToggle(key: NotifyEventKey): void {
  if (props.readOnly) return;
  emit('update:modelValue', toggleNotifySwitch(props.modelValue, keys.value, key));
}

function onChannelsUpdate(channels: NotifyChannel[]): void {
  if (props.readOnly) return;
  emit('update:modelValue', applyNotifyChannels(props.modelValue, keys.value, channels));
}
</script>

<template>
  <div class="wf-notify-card">
    <div class="wf-notify-card__switches">
      <div v-for="sw in switches" :key="sw.key" class="wf-notify-card__switch-row">
        <span class="wf-notify-card__switch-label">{{ sw.label }}</span>
        <NSwitch
          size="small"
          :value="isChecked(sw.key)"
          :disabled="readOnly"
          :data-testid="`notify-switch-${sw.key}`"
          @update:value="() => onSwitchToggle(sw.key)"
        />
      </div>
    </div>
    <NotifyChannelList
      :model-value="resolved.channels"
      :read-only="readOnly"
      testid-prefix="notify"
      @update:model-value="onChannelsUpdate"
    />
  </div>
</template>

<style scoped>
.wf-notify-card { display: flex; flex-direction: column; gap: 10px; }
.wf-notify-card__switches { display: flex; flex-direction: column; gap: 8px; }
.wf-notify-card__switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wf-notify-card__switch-label { color: rgb(var(--base-text-color, 31 31 31)); font-size: 12px; }
</style>
