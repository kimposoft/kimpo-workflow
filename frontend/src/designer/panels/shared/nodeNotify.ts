/**
 * designer/panels/shared/nodeNotify.ts —— 节点级通知配置（NodeNotify）的纯函数部分：由"可能 undefined / 只配了部分键"的存储态归一化成"每个事件
 * 键都有确定 true/false、channels 有确定数组"的完整显示态、切换单个事件开关、把渠道清单的变化
 * 合回写回对象——三件事都不依赖 Vue/DOM，抽成纯函数是本插件既定手法（本插件前端未装
 * @vue/test-utils，能测的部分一律抽成纯函数覆盖，同 ./ccSections.ts 头注释、../ApprovePanel.vue
 * 顶部 <script> 块头注释等既有文件的分工）。
 *
 * 与 ./ccSections.ts 的分工：渠道"至少保留一种"的互斥逻辑（toggleChannel）与固定展示顺序
 * （CC_CHANNEL_ORDER）已在那份文件实现，抄送渠道与本文件的节点级通知渠道是同一件事的两处入口，
 * 本文件直接复用，不重复实现第二份。
 */
import type { NodeNotify, NotifyChannel, NotifyEventKey } from '../../../model';

// NotifyEventKey（五个事件开关键，与后端 NotifyKeyAssigned 等常量逐字对齐）定义在
// model/document.ts，本文件与 shared/NotifyCard.vue 均直接从那里 import，不在此处重新导出
// 第二份——哪类节点认哪几个键由调用方通过 NotifyCard.vue 的 `switches` prop 决定，本文件不关心
// 节点类型。

/** 归一化后的"完整显示态"：五个事件开关键都有确定的 true/false，channels 有确定的非空数组。
 *  即使调用方（某一类节点面板）只关心其中几个键，这里也统一算出全部五个——比按 keys 收窄成
 *  更窄的类型（Pick）多算几个布尔值的成本可以忽略，换来一份不需要泛型的简单形状，调用方按需
 *  读取自己认的那几个字段即可。 */
export interface ResolvedNodeNotify {
  on_assigned: boolean;
  on_returned: boolean;
  on_withdrawn: boolean;
  on_terminated: boolean;
  on_ended: boolean;
  channels: NotifyChannel[];
}

const DEFAULT_CHANNELS: NotifyChannel[] = ['system'];

/**
 * resolveNotify —— undefined/部分配置 → 完整显示态。事件开关缺席（value 为 undefined，或配了
 * notify 但没配这个键）一律按"开"处理（同后端 NodeNotify.Enabled 语义：键缺席 = 默认开，显式
 * false 才是真正关闭）；channels 缺席或空数组按仅 system 处理（同后端 ChannelsOrDefault）。
 */
export function resolveNotify(value: NodeNotify | undefined): ResolvedNodeNotify {
  return {
    on_assigned: value?.on_assigned ?? true,
    on_returned: value?.on_returned ?? true,
    on_withdrawn: value?.on_withdrawn ?? true,
    on_terminated: value?.on_terminated ?? true,
    on_ended: value?.on_ended ?? true,
    channels: value?.channels && value.channels.length > 0 ? [...value.channels] : [...DEFAULT_CHANNELS]
  };
}

/**
 * pickNotify —— 把一份完整显示态收窄成"只含调用方认的那几个开关键 + channels"的落库对象，
 * 显式写 true/false（不靠缺席表达，便于阅读与对拍）。不认识的键
 * （该类节点不关心的开关）不写入，保持落库形状干净。
 */
export function pickNotify(resolved: ResolvedNodeNotify, keys: readonly NotifyEventKey[]): NodeNotify {
  const out: NodeNotify = { channels: [...resolved.channels] };
  for (const key of keys) out[key] = resolved[key];
  return out;
}

/**
 * toggleNotifySwitch —— 切换单个事件开关：基于当前完整显示态把目标键取反，写回只含 keys 子集
 * + channels 的完整对象。
 */
export function toggleNotifySwitch(value: NodeNotify | undefined, keys: readonly NotifyEventKey[], key: NotifyEventKey): NodeNotify {
  const resolved = resolveNotify(value);
  return pickNotify({ ...resolved, [key]: !resolved[key] }, keys);
}

/**
 * applyNotifyChannels —— 把渠道清单的最新值（由 shared/NotifyChannelList.vue 内部经 toggleChannel
 * 算出，已经处理过"至少保留一种"的拒绝逻辑）合回写回对象，同样只含 keys 子集 + channels。
 */
export function applyNotifyChannels(value: NodeNotify | undefined, keys: readonly NotifyEventKey[], channels: NotifyChannel[]): NodeNotify {
  const resolved = resolveNotify(value);
  return pickNotify({ ...resolved, channels }, keys);
}
