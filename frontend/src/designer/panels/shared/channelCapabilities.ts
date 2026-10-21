/**
 * designer/panels/shared/channelCapabilities.ts —— 取『通知渠道能力』（哪些渠道已在系统里配置、
 * 可以勾选）的共用组合式函数。
 *
 * 抄送节点面板（CcPanel.vue）与节点级通知卡（shared/NotifyCard.vue，经 shared/NotifyChannelList.vue）
 * 需要同一份能力查询，不能各写一份、各发一遍请求——本文件把它收口成一个 composable（同
 * templateFieldCatalog.ts useTemplateFieldCatalog 的做法）。
 *
 * 降级口径：接口失败/尚未返回时按"全部可用"降级（不拦用户操作，技术细节只进 console.error，
 * 不出业务界面），isChannelAvailable 据此判定。
 */
import { inject, onMounted, ref, type Ref } from 'vue';
import { DESIGNER_HOST_KEY, type WorkflowDesignerNotifyChannelCapability } from '../../host';
import type { NotifyChannel } from '../../../model';

export interface ChannelCapabilities {
  /** 接口原样返回的能力清单，尚未返回时为空数组。 */
  capabilities: Ref<WorkflowDesignerNotifyChannelCapability[]>;
  /** 接口是否已经返回过一次（无论成功失败），用于 isAvailable 的降级判定。 */
  loaded: Ref<boolean>;
  /** 某个渠道当前是否可用；接口尚未返回/失败/清单里没提到该渠道，一律按"可用"兜底。 */
  isAvailable(channel: NotifyChannel): boolean;
}

export function useChannelCapabilities(): ChannelCapabilities {
  const host = inject(DESIGNER_HOST_KEY);
  if (!host) {
    throw new Error('[useChannelCapabilities] 缺少 DESIGNER_HOST_KEY 注入，请确认挂载在设计器根组件之下');
  }

  const capabilities = ref<WorkflowDesignerNotifyChannelCapability[]>([]);
  const loaded = ref(false);

  onMounted(async () => {
    try {
      const result = await host.channelCapabilities();
      if (result.data) capabilities.value = result.data.channels;
    } catch (err) {
      // 技术细节只进控制台（硬约束：业务界面不出错误码/JSON 结构）；接口失败按"三档都可勾"降级，
      // 不拦用户操作。
      console.error('[kimpo-workflow] 取通知渠道能力失败', err);
    } finally {
      loaded.value = true;
    }
  });

  function isAvailable(channel: NotifyChannel): boolean {
    if (!loaded.value || capabilities.value.length === 0) return true;
    const found = capabilities.value.find((c) => c.channel === channel);
    return found ? found.available : true;
  }

  return { capabilities, loaded, isAvailable };
}
