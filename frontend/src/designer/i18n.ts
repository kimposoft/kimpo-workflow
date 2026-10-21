/**
 * designer/i18n.ts —— 设计器插件 i18n 的唯一装配点。
 *
 * 薄包一层 @kimposoft/plugin-sdk 的 createPluginI18n（四级查找链参考实现，见该文件头注释）：
 * namespace 固定为 manifest.json 里声明的 i18n.namespace（'com.kimposoft.workflow'），
 * messages 直接 import 本插件随构建打包的四份语言包（frontend/locales/*.json，扁平点分 key），
 * defaultLocale 对齐 manifest.json 的 i18n.default_locale（'zh-CN'）。
 *
 * host 参数缺省（未注入宿主 HostI18n）时 createPluginI18n 内部自动降级为纯本地①③④三级链
 * （见其头注释），不会崩，只是拿不到"宿主中央包补 locale"那一级——本文件因此对 host 不做任何
 * 判空防御，原样透传即可。
 *
 * 产出的 PluginI18n 实例即整个设计器壳（DesignerRoot 及其子组件 TopBar/IssuesBadge/PropsPanel/
 * StencilPanel/DesignerCanvas）统一消费的 i18n——大家一律调用 `i18n.t(key, params?)`，不各自
 * 另起一份查找逻辑，也不直接绕开本文件 import SDK 的 createPluginI18n。
 */
import { createPluginI18n, type HostI18n, type PluginI18n } from '@kimposoft/plugin-sdk';
import enUS from '../../locales/en-US.json';
import jaJP from '../../locales/ja-JP.json';
import zhCN from '../../locales/zh-CN.json';
import zhTW from '../../locales/zh-TW.json';

/** 与 manifest.json `capabilities.frontend`（隐式）+ `i18n.namespace` 保持一致，见其文件头。 */
const NAMESPACE = 'com.kimposoft.workflow';
/** 与 manifest.json `i18n.default_locale` 保持一致。 */
const DEFAULT_LOCALE = 'zh-CN';

/** 创建本插件设计器 surface 消费的 PluginI18n 实例；host 缺省时纯本地链兜底（开发/单测场景）。 */
export function createDesignerI18n(host?: HostI18n): PluginI18n {
  return createPluginI18n({
    messages: {
      'zh-CN': zhCN,
      'zh-TW': zhTW,
      'en-US': enUS,
      'ja-JP': jaJP
    },
    defaultLocale: DEFAULT_LOCALE,
    host,
    namespace: NAMESPACE
  });
}
