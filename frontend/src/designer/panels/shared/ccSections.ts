/**
 * designer/panels/shared/ccSections.ts —— 抄送节点属性面板的纯函数部分：通知渠道多选的"至少保留一种"互斥逻辑 + 通知标题/正文表达式槽的写回
 * 归一化，抽成纯函数是本插件既定手法（本插件前端未装 @vue/test-utils，组件级挂载测试做不了，
 * 能测的部分一律抽成不依赖 Vue/DOM 的纯函数，同 ../ApprovePanel.vue 头注释、../shared/
 * templateFieldCatalog.ts 等既有文件的分工）。
 */
import type { NotifyChannel, V4ExpressionDocumentEnvelope } from '../../../model';

/** 三档通知渠道的固定展示/落库顺序（系统通知 / 短信 / 邮件，系统通知默认选中）。
 *  toggleChannel 归一化输出恒按此顺序排列，不随点击顺序改变，保证 UI 与落库两侧渲染/diff 稳定。 */
export const CC_CHANNEL_ORDER: readonly NotifyChannel[] = ['system', 'sms', 'email'];

/**
 * 切换单个通知渠道的勾选态：
 *   - 该渠道当前已选中：若这是清单里最后一种渠道（长度 1），**拒绝**——原样返回入参数组的同一个
 *     引用（调用方据此判定"没有变化=被拒绝"，据此弹出"至少要保留一种通知渠道"提示，不静默丢弃）；
 *     否则移除该渠道。
 *   - 该渠道未选中：加入该渠道。
 * 输出恒按 CC_CHANNEL_ORDER 排序去重，不保留入参里可能存在的乱序/重复脏数据。
 */
export function toggleChannel(channels: NotifyChannel[] | undefined, channel: NotifyChannel): NotifyChannel[] {
  const current = channels ?? [];
  const hasIt = current.includes(channel);
  if (hasIt && current.length <= 1) {
    // 唯一一种渠道，拒绝移除：返回同一个引用，调用方按"引用未变"判定为拒绝。
    return current;
  }
  const next = new Set(current);
  if (hasIt) {
    next.delete(channel);
  } else {
    next.add(channel);
  }
  return CC_CHANNEL_ORDER.filter((c) => next.has(c));
}

/**
 * 通知标题/正文两个表达式槽的写回归一化：V4ExpressionField 清空时 emit `update:modelValue(undefined)`
 * （见 ../../expression/V4ExpressionField.vue 头注释与其 static test），但 CCConfig.title_expr /
 * content_expr 在 wire 协议上"未配置"唯一合法的表达是字面量 `null`（键必须出现，见
 * ../../nodes/cc/index.ts createDefaultConfig 同处注释、model/document.ts CCConfig.title_expr
 * 注释）——本函数把组件层的 `undefined` 归一化成落库要求的 `null`，有值时原样透传。
 */
export function normalizeExprSlot(value: V4ExpressionDocumentEnvelope | undefined | null): V4ExpressionDocumentEnvelope | null {
  return value ?? null;
}
