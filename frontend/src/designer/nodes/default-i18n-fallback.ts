/**
 * designer/nodes/default-i18n-fallback.ts —— 节点默认配置生成时的 i18n 兜底（默认按钮的名称
 * 与结果标识按设计者当前语言生成）。
 *
 * createDefaultConfig() 在绝大多数真实路径下都拿得到调用方注入的设计器 i18n 实例（形状面板
 * 拖拽/双击新建节点，见 DesignerRoot.vue onStencilDrop/onStencilDblClick 把 props.i18n 转手
 * 传给 WorkflowDocumentState.addNode → createDefaultConfig）；但接口上这个参数是可选的（单测
 * 直接调用 createDefaultConfig()、或 model/defaults.ts 构造空白文档时都不持有 i18n，同
 * document-state.ts 头注释"本层不认识当前语言"的既定分工）。没有注入时，本函数直接落到
 * manifest.json 声明的默认语言 zh-CN 的文案——不是另起一份硬编码中文字面量，唯一事实源仍是
 * locales/zh-CN.json，两处不会走漂。
 */
import zhCN from '../../../locales/zh-CN.json';
import type { DefaultConfigI18n } from './types';

const ZH_CN_FALLBACK: Record<string, string> = zhCN;

/**
 * 按当前设计器语言取一段默认文案；没有 i18n 时退回 zh-CN 文案；两者都取不到 key（理论不应
 * 发生，防御性兜底）时原样返回 key 本身——好过生成一个空字符串那种更难排查的坏默认值。
 */
export function resolveDefaultText(i18n: DefaultConfigI18n | undefined, key: string): string {
  if (i18n) return i18n.t(key);
  return ZH_CN_FALLBACK[key] ?? key;
}
