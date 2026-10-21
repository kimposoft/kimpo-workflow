/**
 * model/design-tokens.ts —— 设计器画布视觉唯一色板权威源。
 *
 * 节点卡视觉语言：白底 + 中性灰描边 + 彩色图标块。本文件是这套视觉语言的**唯一数据源**，画布、
 * 面板、条件珠等都基于本文件产出的 token 取值，不得各自另起一份颜色字面量。
 *
 * 为什么是 TS 常量、不是 CSS 变量：X6 节点渲染走的是 SVG attrs（fill/stroke 等直接赋成字符串
 * 交给 setAttribute），不经过 CSSOM 级联，`var(--xxx)` 这种 CSS 自定义属性对 X6 attrs 不生效——
 * 因此 TS 是唯一能同时喂给"X6 画布"与"Vue 模板/CSS"两侧的事实源。`tokenCssVariables()` 只是把
 * 这份 TS 数据在运行时投影成一份 CSS 自定义属性字典，供非 X6 的普通 DOM 元素（面板 CSS）用
 * `var(--kwf-xxx)` 消费——投影是单向的、只读的，不会反过来产生第二份颜色定义，因此不存在两侧
 * 漂移的可能。
 *
 * 消费方（画布/面板视觉三件套的唯一权威链路）：
 *   - model/node-visual.ts：NODE_PALETTE 直接基于本文件 NODE_TYPE_TOKENS 派生；
 *   - graph/x6-adapter.ts：画布节点卡/连线/端口/预览线配色；
 *   - graph/svg-adapter.ts：progress 只读画布（V1 最小实现）同款配色，防两块画布视觉跑偏；
 *   - designer/stencil/StencilPanel.vue：形状面板色块预览；
 *   - designer/DesignerRoot.vue：根元素用 tokenCssVariables() 注入 CSS 变量，供面板 scoped
 *     style 消费。
 */
import type { DesignNodeType } from './index';

/** 品牌蓝——唯一一档：连线、端口描边、预览线、已配置态文字等所有蓝色统一只用这一个值。 */
export const PRIMARY_COLOR = '#1464E0';

/**
 * 节点选中态外圈光环的半透明主色：PRIMARY_COLOR #1464E0 = rgb(20, 100, 224)，45% 不透明度。
 * 随本调色板一起产出、由 x6-adapter.ts 以 SVG attrs 内联消费（见 CanvasPalette.selectionGlow
 * 字段注释与 x6-adapter.ts applyNodeVisual 消费处），不依赖宿主 CSS 变量，避免与画布自身的
 * CanvasPalette 主题系统脱节。45% 足够看得出，同时仍读作柔光而非实描边；观感需要调整只改这里。
 */
export const SELECTION_GLOW = 'rgba(20, 100, 224, .45)';

/**
 * 六类节点的图标块配色（宿主设计规范色板，逐字取值）：iconBg=26×26 圆角图标块底色（浅色调），
 * iconColor=块内图标 path 的 fill/stroke 色（对应深色调）。
 *
 * 覆盖 V2 六类节点（见 model/document.ts NodeKind）。
 *
 * Record 覆盖 DesignNodeType 全部六个取值（TypeScript 穷举检查保证漏填直接报错，同
 * model/node-visual.ts 既有 NODE_SHAPE_FAMILY/NODE_PALETTE 的既定手法）。
 */
export const NODE_TYPE_TOKENS: Record<DesignNodeType, { iconBg: string; iconColor: string }> = {
  start: { iconBg: '#E8F7F0', iconColor: '#22A06B' },
  approve: { iconBg: '#EAF2FF', iconColor: '#1464E0' },
  handle: { iconBg: '#F4EEFF', iconColor: '#7C4DFF' },
  cc: { iconBg: '#E6F7F4', iconColor: '#0E9384' },
  subflow: { iconBg: '#EAF7EC', iconColor: '#16A34A' },
  end: { iconBg: '#F0F2F5', iconColor: '#5A6472' }
};

/**
 * 中性灰阶（宿主设计规范通用色板）：节点卡描边、正文/次要文字、画布底色、网格点阵、连线默认色。
 * 新视觉语言"仅靠图标块着色区分类型"的前提是这些中性色在全部节点类型间恒定不变——不像旧
 * NODE_PALETTE 那样按类型各有一档描边色。
 */
export const NEUTRAL = {
  /** 节点卡描边（白底卡唯一描边色，1.5px），不按类型着色。 */
  border: '#D8DCE2',
  /** 主文字（节点标题/标签，13px/600）。 */
  textPrimary: '#1F2329',
  /** 次要文字（摘要行/说明文案，11px）。 */
  textSecondary: '#8F959E',
  /** 画布底色。 */
  canvasBg: '#FAFBFC',
  /** 网格点阵色。 */
  gridDot: '#DDE0E5',
  /** 连线默认色（非条件边）。 */
  edge: '#7A828E'
} as const;

/** 语义色（成功/警告/危险）：与九类节点的"业务分类色"是两套不同语义，不得混用——校验错误态
 * 目前仍固定使用既有的 #ff4d4f（见 graph/x6-adapter.ts applyNodeVisual/applyEdgeVisual 头注释
 * "hasIssues 红 #ff4d4f 保留"），这里的 danger 是给未来状态类展示（非"校验错误"语境）预留的
 * 语义色位，当前没有消费方，不是漏接。 */
export const SEMANTIC = {
  success: '#16A34A',
  warning: '#F59E0B',
  danger: '#E5484D'
} as const;

/**
 * 条件珠三态配色：fx 珠（已配置/未配置）与「默」珠统一为白底 + 描边 + 文字三色配置
 * （22×22 正圆），收进唯一色板权威源。
 *
 * 三态均为白底（fill 不随态变化，见 x6-adapter.ts buildMarkerLabelConfig 里的字面量 '#ffffff'，
 * 因此本组只需 stroke/text 两个会变化的字段，不必再重复声明恒定的 fill）。
 *
 * 🔴 按钮名连线标签的 'button' 档：白底胶囊描边 + 文字色（边 #E1E4E9 / 文字 #4E5561），
 * 同 condition/else 两态一样收在唯一色板权威源，不在本地另起一份颜色字面量。语义色圆点（按钮 color 枚举）不在这里，
 * 见下方 BUTTON_DOT_COLORS——圆点色随每个按钮的 color 配置变化，与本组"珠子壳恒定配色"是两件
 * 不同的事。
 */
export const MARKER_TOKENS: Record<'conditionConfigured' | 'conditionUnconfigured' | 'else' | 'button', { stroke: string; text: string }> = {
  // fx 珠（已配置）：品牌蓝描边 + 品牌蓝文字，唯一蓝色档 PRIMARY_COLOR。
  conditionConfigured: { stroke: PRIMARY_COLOR, text: PRIMARY_COLOR },
  // fx 珠（未配置）：沿用既有"待配置"橙色警示语义（同 applyNodeVisual 摘要橙 #fa8c16 同一色相）。
  conditionUnconfigured: { stroke: '#FFD591', text: '#D46B08' },
  // 默认（兜底）路线珠：中性灰描边 + 次要文字色，文字复用 NEUTRAL.textSecondary（不重复定义）。
  else: { stroke: '#C9CDD4', text: NEUTRAL.textSecondary },
  // 按钮流转珠：中性灰壳，不随按钮语义色变化——语义色只体现在珠子内的 6×6 圆点。
  button: { stroke: '#E1E4E9', text: '#4E5561' }
};

/**
 * BUTTON_DOT_COLORS —— 按钮名连线标签的按钮语义色圆点配色：ButtonConfig.color 五档
 * （primary/success/danger/warning/neutral，见 model/index.ts ButtonColor 注释；五档必须齐全，
 * 缺档时消费方会取到 undefined 色值）到画布 6×6 圆点色值的
 * 映射。primary 复用唯一品牌蓝档 PRIMARY_COLOR，success/danger 复用 SEMANTIC 组，neutral 复用
 * NEUTRAL.textSecondary——与 designer/panels/ApprovalPanel.vue SEMANTIC_COLOR_HEX.neutral
 * （#8f959e）精确同源，两处配色不跑偏（该面板的按钮色点预览与画布上的连线圆点必须视觉一致）。
 *
 * 只覆盖"按钮显式设置了 color"这一支；未设置（空串/缺省）时的"按 resultKey 猜测"回退规则
 * （approved 绿/rejected 红/其余中性灰，同 ApprovalPanel.vue buttonDotColor 既定逻辑）由消费方
 * designer/node-summary.ts resolveEdgeButtonLabel 直接复用 SEMANTIC/MARKER_TOKENS 现成色值处理，
 * 不需要在本表里再列一档"未设置"。
 */
export const BUTTON_DOT_COLORS: Record<'primary' | 'success' | 'danger' | 'warning' | 'neutral', string> = {
  primary: PRIMARY_COLOR,
  success: SEMANTIC.success,
  danger: SEMANTIC.danger,
  warning: SEMANTIC.warning,
  neutral: NEUTRAL.textSecondary
};

/**
 * 把上述 TS 常量投影成 CSS 自定义属性字典（键形如 `--kwf-xxx`），供 DesignerRoot.vue 根元素
 * `:style` 注入——非 X6 的普通 DOM 元素（面板 scoped CSS）用 `var(--kwf-xxx)` 消费。TS 常量
 * 是唯一事实源，本函数只是运行时投影，不重复定义任何颜色值，因此不会产生"改了 TS 忘改 CSS"
 * 的漂移（本文件文件头"为什么是 TS 常量"一节的落地）。
 */
export function tokenCssVariables(): Record<string, string> {
  return {
    '--kwf-primary': PRIMARY_COLOR,
    '--kwf-border': NEUTRAL.border,
    '--kwf-text-primary': NEUTRAL.textPrimary,
    '--kwf-text-secondary': NEUTRAL.textSecondary,
    '--kwf-canvas-bg': NEUTRAL.canvasBg,
    '--kwf-grid-dot': NEUTRAL.gridDot,
    '--kwf-edge': NEUTRAL.edge,
    '--kwf-success': SEMANTIC.success,
    '--kwf-warning': SEMANTIC.warning,
    '--kwf-danger': SEMANTIC.danger
  };
}

/* ============================================================================================
 * 画布暗色支持：把上面这些亮色字面量收敛成一份"可按主题解析的色板"（CanvasPalette），并提供 buildPalette（纯函数）/
 * resolvePalette（DOM 入口）两个函数、外加消费方 composable（../designer/canvas/
 * use-canvas-palette.ts）。
 *
 * 本节不替代上面任何既有导出——NEUTRAL/PRIMARY_COLOR/SEMANTIC/NODE_TYPE_TOKENS/
 * MARKER_TOKENS/BUTTON_DOT_COLORS/tokenCssVariables() 仍是各自既有消费方（x6-adapter.ts/
 * svg-adapter.ts/StencilPanel.vue/DesignerRoot.vue……）的唯一事实源，本节只是在它们之上再包
 * 一层"主题感知"的视图，不产生第二份颜色定义（同文件头"为什么是 TS 常量"一节的既定纪律）。
 *
 * 本节只做数据层（CanvasPalette/LIGHT_PALETTE/buildPalette/resolvePalette），由
 * x6-adapter.ts 与 DOM 侧面板经 use-canvas-palette.ts 消费。
 * ============================================================================================
 */

/** 画布主题模式。'light' 是唯一权威亮色——buildPalette 在该分支下直接返回 LIGHT_PALETTE 本体，
 * 不读取任何宿主 CSS 变量，这是"亮色零漂移"硬指标最直接的实现方式：哪怕宿主亮色 token 未来
 * 变化，画布亮色也不会跟着漂移。只有 'dark' 分支才会尝试读宿主 token。 */
export type CanvasThemeMode = 'light' | 'dark';

/**
 * readVar 签名：入参是宿主 CSS 自定义属性名（含前导 `--`），出参是该变量在宿主当前主题下的
 * 原始字符串值，读不到时返回空字符串/null/undefined（由调用方决定回落）。
 *
 * 🔴 关键坑：宿主这套变量存的值是 **RGB 三元组**（形如 `"18 18 18"`，三个数字空格分隔），
 * 不是 `#hex`、也不带 `rgb()` 外壳——直接把它当颜色字符串用是非法 CSS。本文件内部一律先用
 * wrapRgbTriple() 包装成 `rgb(18 18 18)` 再往下传，buildPalette 的返回值拿到的永远是可以
 * 直接当颜色字符串使用的合法值，消费方不需要再自己包一层。
 */
export type ReadCssVar = (name: string) => string | null | undefined;

/** 把宿主 RGB 三元组包成合法 CSS 颜色值：`"18 18 18"` -> `"rgb(18 18 18)"`（见上方 ReadCssVar
 * 注释"关键坑"）。 */
function wrapRgbTriple(triple: string): string {
  return `rgb(${triple.trim()})`;
}

/**
 * CanvasPalette —— 画布可按主题解析的完整色板形状。字段分三组：
 *   1. primary：品牌主色，亮暗恒定（见 buildPalette 里的硬规则说明，不映射宿主
 *      --primary-color）；
 *   2. 中性灰阶七项（border/textPrimary/textSecondary/canvasBg/gridDot/edge/surface）：前六项
 *      字段名与 NEUTRAL 完全对应，surface 是本次新增的第七项（节点卡 body、标记珠圆/胶囊
 *      body、端口圆点、选中手柄的白底，唯一权威取值）；
 *   3. semantic/nodeTypes/shadow：既有 SEMANTIC/NODE_TYPE_TOKENS 的主题感知视图，以及阴影
 *      （见下方 SURFACE_WHITE/NODE_SHADOW 两个常量注释）。
 */
export interface CanvasPalette {
  primary: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  canvasBg: string;
  gridDot: string;
  edge: string;
  surface: string;
  semantic: { success: string; warning: string; danger: string };
  /** 九类节点图标块配色：iconColor 亮暗保持同一色相（硬规则）；iconBg 暗色下是 iconColor 与
   * surface 按 16%/84% 预合成出的具体实色（见 mixIconBg）。 */
  nodeTypes: Record<DesignNodeType, { iconBg: string; iconColor: string }>;
  /** 标记珠（fx/else/button 三态）的 drop-shadow 阴影色（X6 SVG attrs 场景不能用 CSS var()）。
   * 🔴 节点选中光晕不消费这个字段，走下方 selectionGlow 字段（见 SELECTION_GLOW 常量注释），
   * 与本字段是两个不同的颜色概念（本字段是中性深色阴影，selectionGlow 是主色半透明光环），不要混用。 */
  shadow: string;
  /** 节点选中态外圈光环——drop-shadow 半透明主色，见 SELECTION_GLOW 常量注释（随本调色板一起
   * 产出、SVG attrs 内联消费，见 graph/x6-adapter.ts applyNodeVisual 消费处）。primary 亮暗恒定（下方硬规则），
   * 本字段随之亮暗同值，不是遗漏。 */
  selectionGlow: string;
  /** 节点选中态卡片底色——比 surface 轻微偏主色的着色（选中时"整张卡都在告诉你被选中了"，
   * 不止描边一圈）。用 mixIconBg(PRIMARY_COLOR, surface, 极小
   * 比例) 按主题各自的 surface 混出，因此暗色下也是"暗色 surface 偏一点点蓝"而不是生硬的
   * 固定色值，见 mixIconBg 消费处。 */
  selectedFill: string;
  /**
   * 校验错误红：x6-adapter.ts 里 hasIssues 态节点卡/连线/分支结构块的描边色，
   * 取值 '#ff4d4f'。🔴 与上方 SEMANTIC.danger（'#E5484D'）是历史遗留的两个不同色值（见
   * SEMANTIC 常量注释"校验错误态目前仍固定使用既有的 #ff4d4f"），此处原样保留、暂不统一。
   */
  validationError: string;
  /**
   * 待配置摘要橙：x6-adapter.ts applyNodeVisual 里 needsConfig 态摘要文字色，
   * 取值 '#fa8c16'。与 MARKER_TOKENS.conditionUnconfigured（橙色系但不同值）、SEMANTIC.warning
   * 是三个独立橙色档位并存的现状，此处原样保留、不做统一。
   */
  pendingConfig: string;
  /**
   * 标记珠三态配色——MARKER_TOKENS 的主题感知视图，形状与其完全一致
   * （见该常量类型定义），供 x6-adapter.ts buildMarkerLabelConfig 按当前主题取值。
   */
  markers: typeof MARKER_TOKENS;
}

/** 卡片/面白底——节点卡 body、标记珠圆/胶囊 body、端口圆点 fill、选中手柄 fill 四处消费点
 * 的唯一权威值。 */
export const SURFACE_WHITE = '#ffffff';

/** 标记珠（fx/else/button 三态）与节点选中光晕共用的 drop-shadow 阴影值（x6-adapter.ts
 * buildMarkerLabelConfig 两处 `style.filter`）。 */
export const NODE_SHADOW = 'rgba(15, 23, 42, .14)';

/** 校验错误红（供 CanvasPalette.validationError，见该字段注释"与 SEMANTIC.danger 不一致"）。 */
export const VALIDATION_ERROR_RED = '#ff4d4f';

/** 待配置摘要橙（供 CanvasPalette.pendingConfig，见该字段注释）。 */
export const PENDING_CONFIG_ORANGE = '#fa8c16';

/** 节点选中态卡片底色的主色混合占比：比 iconBg 的 16%（见 mixIconBg
 * 注释）明显更小——这是"整张卡轻微着色"而不是"图标块这种本就该显眼的色块"，数值越大着色越
 * 明显，越小越接近 surface 原色。 */
const SELECTED_FILL_TINT_RATIO = 0.06;

/** LIGHT_PALETTE —— 亮色权威色板，逐字段引用（不重新书写）上面已有的 NEUTRAL/PRIMARY_COLOR/
 * SEMANTIC/NODE_TYPE_TOKENS 与本节新增的 SURFACE_WHITE/NODE_SHADOW——保证"亮色零漂移"硬指标：
 * 任何既有字面量只要还是从同一个常量读出来，就不可能在本文件内部产生第二份不一致的拷贝。 */
export const LIGHT_PALETTE: CanvasPalette = {
  primary: PRIMARY_COLOR,
  ...NEUTRAL,
  surface: SURFACE_WHITE,
  semantic: { ...SEMANTIC },
  nodeTypes: NODE_TYPE_TOKENS,
  shadow: NODE_SHADOW,
  // 选中态外圈光环——SELECTION_GLOW 亮暗恒定（同 primary 硬规则），见该常量注释。
  selectionGlow: SELECTION_GLOW,
  // 选中态卡片底色——PRIMARY_COLOR 与亮色 surface（纯白）按 6% 混出的极浅蓝，见
  // SELECTED_FILL_TINT_RATIO 注释。
  selectedFill: mixIconBg(PRIMARY_COLOR, SURFACE_WHITE, SELECTED_FILL_TINT_RATIO),
  validationError: VALIDATION_ERROR_RED,
  pendingConfig: PENDING_CONFIG_ORANGE,
  markers: MARKER_TOKENS
};

/** 暗色回落实色表：读不到对应宿主 CSS 变量时使用。 */
const DARK_FALLBACK = {
  canvasBg: 'rgb(18 18 18)',
  border: 'rgb(76 76 76)',
  textPrimary: 'rgb(224 224 224)',
  textSecondary: 'rgb(176 176 176)',
  gridDot: 'rgb(56 56 56)',
  edge: 'rgb(130 130 130)',
  surface: 'rgb(28 28 28)'
} as const;

/** 上表对应的宿主 CSS 变量名。 */
const HOST_VAR: Record<keyof typeof DARK_FALLBACK, string> = {
  canvasBg: '--layout-bg-color',
  border: '--border-color',
  textPrimary: '--base-text-color',
  textSecondary: '--text-secondary-color',
  gridDot: '--border-lighter-color',
  edge: '--text-hint-color',
  surface: '--container-bg-color'
};

/** 解析单个中性灰阶字段的暗色取值：优先读宿主同名 CSS 变量（RGB 三元组，见 ReadCssVar 注释
 * "关键坑"），读不到（变量未定义/空串）时回落到 DARK_FALLBACK 对应实色。 */
function resolveDarkNeutral(key: keyof typeof DARK_FALLBACK, readVar: ReadCssVar): string {
  const raw = readVar(HOST_VAR[key])?.trim();
  return raw ? wrapRgbTriple(raw) : DARK_FALLBACK[key];
}

/** 把颜色字符串统一解析成 [r, g, b]——支持本文件内部实际会出现的两种形式：`#rrggbb` 十六进制
 * （NODE_TYPE_TOKENS.iconColor 恒为此形式）与 `rgb(r g b)`/`rgb(r, g, b)`（resolveDarkNeutral
 * 的返回值）。只服务本文件内部的颜色混合计算，不是通用颜色解析工具，因此没有覆盖 rgba()/
 * 简写 3 位 hex 等本文件不会产出的形式。 */
function parseColor(color: string): [number, number, number] {
  const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hexMatch) {
    const int = Number.parseInt(hexMatch[1], 16);
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }
  const rgbMatch = /rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  // 不应发生（调用方只会传本文件内部产出的 hex/rgb 字符串）；兜底黑色而不是抛异常，避免一个
  // 解析不出的颜色值让整份色板计算失败。
  return [0, 0, 0];
}

/**
 * mixIconBg —— 节点类型图标底色（iconBg）暗色预合成：iconColor 与 surface 按 ratio/(1-ratio)
 * 混合出一个具体实色。不用 CSS `color-mix()`——X6 节点渲染是把颜色值直接赋给 SVG attrs
 * （fill/stroke），不经过 CSSOM 级联，`color-mix()` 这类 CSS 函数在这条路径上不会被解析
 * （同文件头"为什么是 TS 常量"一节的既定理由），必须在 JS 侧算出最终的 `rgb()` 字面量。
 * ratio 默认 16%（iconBg 的混合占比）：数值越大结果
 * 越接近 iconColor 本身，越小越接近 surface 底色。
 *
 * 选中态卡片底色 selectedFill 也复用本函数，按更小的比例混出"轻微着色"（见 buildPalette
 * 消费处）——与 iconBg 是同一套"主色/类型色与 surface 按比例混合"配方，只是比例不同。
 */
export function mixIconBg(iconColor: string, surface: string, ratio = 0.16): string {
  const [r1, g1, b1] = parseColor(iconColor);
  const [r2, g2, b2] = parseColor(surface);
  const blend = (a: number, b: number) => Math.round(a * ratio + b * (1 - ratio));
  return `rgb(${blend(r1, r2)} ${blend(g1, g2)} ${blend(b1, b2)})`;
}

/**
 * buildPalette —— 按 mode/readVar 产出一份完整 CanvasPalette 的纯函数（不接触 DOM，可在
 * design-tokens.test.ts 里离线钉死每条取值规则）。
 *
 * 🔴 硬规则：品牌主色 PRIMARY_COLOR 在亮暗两档都保持现值 '#1464E0'，**不**映射宿主
 * `--primary-color`（宿主该变量当前是同名蓝色调下的另一个具体值，映射过去会让画布品牌色观感
 * 漂移）。
 */
export function buildPalette(input: { mode: CanvasThemeMode; readVar: ReadCssVar }): CanvasPalette {
  const { mode, readVar } = input;
  if (mode === 'light') {
    // 亮色分支根本不读 readVar——直接返回 LIGHT_PALETTE 本体（同一引用），这是"亮色零漂移"
    // 硬指标最直接的实现：哪怕宿主亮色 token 未来变化，画布亮色也不会跟着漂移。
    return LIGHT_PALETTE;
  }

  const canvasBg = resolveDarkNeutral('canvasBg', readVar);
  const border = resolveDarkNeutral('border', readVar);
  const textPrimary = resolveDarkNeutral('textPrimary', readVar);
  const textSecondary = resolveDarkNeutral('textSecondary', readVar);
  const gridDot = resolveDarkNeutral('gridDot', readVar);
  const edge = resolveDarkNeutral('edge', readVar);
  const surface = resolveDarkNeutral('surface', readVar);

  // 九类节点图标色：iconColor 色相不变（硬规则），iconBg 暗色下用 mixIconBg 预合成。
  const nodeTypes = {} as Record<DesignNodeType, { iconBg: string; iconColor: string }>;
  for (const type of Object.keys(NODE_TYPE_TOKENS) as DesignNodeType[]) {
    const { iconColor } = NODE_TYPE_TOKENS[type];
    nodeTypes[type] = { iconColor, iconBg: mixIconBg(iconColor, surface) };
  }

  // 🔴 阴影不在上面七项中性灰阶的宿主变量映射范围内——按"能对上同语义宿主 token 的优先读、
  // 读不到就沿用亮色同一条配方换算"的原则推导；暗色观感需要调整时只改这里，不涉及数据结构。
  const shadowTriple = readVar('--shadow-color')?.trim();
  const shadow = shadowTriple ? `rgba(${shadowTriple.replace(/\s+/g, ', ')}, .14)` : 'rgba(0, 0, 0, .48)';

  return {
    primary: PRIMARY_COLOR,
    border,
    textPrimary,
    textSecondary,
    canvasBg,
    gridDot,
    edge,
    surface,
    semantic: { ...SEMANTIC },
    nodeTypes,
    shadow,
    // 选中态外圈光环——primary 亮暗恒定（硬规则），SELECTION_GLOW 随之在暗色下取同一个值，
    // 不是遗漏（见该常量注释与 CanvasPalette.selectionGlow 字段注释）。
    selectionGlow: SELECTION_GLOW,
    // 选中态卡片底色——PRIMARY_COLOR 与本函数已解析出的暗色 surface 按 6% 混出，暗色下呈现
    // "暗色 surface 偏一点点蓝"而不是亮色那种浅蓝（同一份 mixIconBg 配方按各自主题的 surface
    // 换算，不是分别维护两套数值）。
    selectedFill: mixIconBg(PRIMARY_COLOR, surface, SELECTED_FILL_TINT_RATIO),
    // 校验错误红/待配置橙：状态强调色，无对应宿主中性灰 token 可映射，色相不变原则暗色沿用
    // 亮色取值（同 SEMANTIC/PRIMARY_COLOR 的既定处理）。
    validationError: VALIDATION_ERROR_RED,
    pendingConfig: PENDING_CONFIG_ORANGE,
    markers: {
      // fx 珠已配置：品牌蓝唯一档，亮暗恒定（同 primary 字段硬规则）。
      conditionConfigured: { stroke: PRIMARY_COLOR, text: PRIMARY_COLOR },
      // fx 珠未配置：装饰性橙色警示，色相不变原则。
      conditionUnconfigured: {
        stroke: MARKER_TOKENS.conditionUnconfigured.stroke,
        text: MARKER_TOKENS.conditionUnconfigured.text
      },
      // 默珠：亮色 stroke（MARKER_TOKENS.else.stroke '#C9CDD4'）本就是"空态中性灰描边"这一族
      // 色值，text 亮色本就直接复用 NEUTRAL.textSecondary（见 MARKER_TOKENS.else 注释）——
      // 两项暗色因此都复用本函数已解析出的 border/textSecondary，是精确映射而非另起数值。
      else: { stroke: border, text: textSecondary },
      // 按钮流转珠：stroke 亮色（'#E1E4E9'）与 NEUTRAL.border（'#D8DCE2'）同属"卡片中性描边"
      // 家族但非精确同值，暗色按同一家族就近复用已解析出的 border（近似映射，非精确匹配）；
      // text（'#4E5561'）在既有三档中性文字色（textPrimary/textSecondary 之外）里找不到精确
      // 对应，按色相不变原则暂保留亮色取值——置信度低于上面几项。
      button: { stroke: border, text: MARKER_TOKENS.button.text }
    }
  };
}

/**
 * resolvePalette —— buildPalette 的 DOM 入口：从真实 documentElement 解析当前主题模式
 * （`html.dark` 类）与宿主 CSS 变量，调用 buildPalette 产出 palette。buildPalette 本身保持
 * 纯函数（mode/readVar 都是入参）是为了让离线单测钉死每条取值规则；resolvePalette 是
 * "接 DOM"的那一层，composable（../designer/canvas/use-canvas-palette.ts）与未来其它需要
 * 一次性取值的调用方都应该走这个函数，不要各自重新拼一遍"判 dark 类 + getComputedStyle"逻辑。
 *
 * root 参数默认 document.documentElement，留了参数位是为了可测试性（design-tokens.test.ts
 * 可以传一个手造的元素而不必依赖全局 document 的当前状态）。
 */
export function resolvePalette(root: HTMLElement = document.documentElement): CanvasPalette {
  const mode: CanvasThemeMode = root.classList.contains('dark') ? 'dark' : 'light';
  const computedStyle = getComputedStyle(root);
  const readVar: ReadCssVar = (name) => computedStyle.getPropertyValue(name);
  return buildPalette({ mode, readVar });
}
