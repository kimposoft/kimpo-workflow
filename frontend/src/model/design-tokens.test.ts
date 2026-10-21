/**
 * model/design-tokens.test.ts —— 画布色板（含暗色支持）单测。
 *
 * 覆盖四块：
 *   1. buildPalette({mode:'light'}) 与 LIGHT_PALETTE 深相等；
 *   2. 亮色下每个语义色与固定字面量逐一相等——把期望色值抄成这里的常量，是防止未来有人不小心改动 NEUTRAL/PRIMARY_COLOR/
 *      NODE_TYPE_TOKENS 等既有导出而导致画布亮色观感漂移的钉子（"亮色零漂移"硬指标）；
 *   3. readVar 全部返回空时，暗色取值等于回落实色表；
 *   4. mixIconBg 混合函数给定输入产出预期实色。
 * 另外补一组 resolvePalette 的最小 DOM 集成 smoke test，验证"判 dark 类 + 读 CSS 变量"这条
 * 拼接路径本身是通的（happy-dom 环境，不依赖真实宿主样式表）。
 */
import { describe, expect, it } from 'vitest';
import {
  LIGHT_PALETTE,
  MARKER_TOKENS,
  NEUTRAL,
  NODE_SHADOW,
  NODE_TYPE_TOKENS,
  PENDING_CONFIG_ORANGE,
  PRIMARY_COLOR,
  SEMANTIC,
  SURFACE_WHITE,
  VALIDATION_ERROR_RED,
  buildPalette,
  mixIconBg,
  resolvePalette,
  type CanvasPalette
} from './design-tokens';

/** 一个"全空"的 readVar：模拟宿主全部同名 CSS 变量都读不到（未挂载对应样式表/变量未定义），
 * 用于钉死暗色回落表。 */
const emptyReadVar = () => '';

describe('buildPalette：亮色分支', () => {
  it('buildPalette({mode:"light"}) 与 LIGHT_PALETTE 深相等（亮色分支根本不读 readVar）', () => {
    const palette = buildPalette({ mode: 'light', readVar: () => 'should-never-be-read' });
    expect(palette).toStrictEqual(LIGHT_PALETTE);
    // 亮色分支应直接返回 LIGHT_PALETTE 本体（同一引用），不是深相等的另一个对象——这也是零
    // 漂移最直接的保证方式（不存在"两份对象碰巧当前相等，未来某处漏改导致跑偏"的空间）。
    expect(palette).toBe(LIGHT_PALETTE);
  });

  it('亮色每个语义色与改造前字面量逐一相等（防漂移钉子）', () => {
    // 品牌蓝（唯一档）。
    expect(PRIMARY_COLOR).toBe('#1464E0');
    expect(LIGHT_PALETTE.primary).toBe('#1464E0');
    // 中性灰阶六项（改造前 NEUTRAL 的既有字面量）。
    expect(NEUTRAL.border).toBe('#D8DCE2');
    expect(NEUTRAL.textPrimary).toBe('#1F2329');
    expect(NEUTRAL.textSecondary).toBe('#8F959E');
    expect(NEUTRAL.canvasBg).toBe('#FAFBFC');
    expect(NEUTRAL.gridDot).toBe('#DDE0E5');
    expect(NEUTRAL.edge).toBe('#7A828E');
    expect(LIGHT_PALETTE.border).toBe('#D8DCE2');
    expect(LIGHT_PALETTE.textPrimary).toBe('#1F2329');
    expect(LIGHT_PALETTE.textSecondary).toBe('#8F959E');
    expect(LIGHT_PALETTE.canvasBg).toBe('#FAFBFC');
    expect(LIGHT_PALETTE.gridDot).toBe('#DDE0E5');
    expect(LIGHT_PALETTE.edge).toBe('#7A828E');
    // 卡片/面白底。
    expect(SURFACE_WHITE).toBe('#ffffff');
    expect(LIGHT_PALETTE.surface).toBe('#ffffff');
    // 语义色。
    expect(SEMANTIC).toStrictEqual({ success: '#16A34A', warning: '#F59E0B', danger: '#E5484D' });
    expect(LIGHT_PALETTE.semantic).toStrictEqual(SEMANTIC);
    // 六类节点图标块配色（宿主设计规范色板，逐字取值）。
    expect(NODE_TYPE_TOKENS).toStrictEqual({
      start: { iconBg: '#E8F7F0', iconColor: '#22A06B' },
      approve: { iconBg: '#EAF2FF', iconColor: '#1464E0' },
      handle: { iconBg: '#F4EEFF', iconColor: '#7C4DFF' },
      cc: { iconBg: '#E6F7F4', iconColor: '#0E9384' },
      subflow: { iconBg: '#EAF7EC', iconColor: '#16A34A' },
      end: { iconBg: '#F0F2F5', iconColor: '#5A6472' }
    });
    expect(LIGHT_PALETTE.nodeTypes).toStrictEqual(NODE_TYPE_TOKENS);
    // 标记珠阴影（x6-adapter.ts buildMarkerLabelConfig 两处 style.filter 字面量）。
    expect(NODE_SHADOW).toBe('rgba(15, 23, 42, .14)');
    expect(LIGHT_PALETTE.shadow).toBe('rgba(15, 23, 42, .14)');
    // 校验错误红/待配置橙（逐字取值）。
    expect(VALIDATION_ERROR_RED).toBe('#ff4d4f');
    expect(LIGHT_PALETTE.validationError).toBe('#ff4d4f');
    // 与 SEMANTIC.danger 是两个不同的值——现状如此、此处不统一（见
    // design-tokens.ts CanvasPalette.validationError 字段注释）。
    expect(LIGHT_PALETTE.validationError).not.toBe(LIGHT_PALETTE.semantic.danger);
    expect(PENDING_CONFIG_ORANGE).toBe('#fa8c16');
    expect(LIGHT_PALETTE.pendingConfig).toBe('#fa8c16');
    // 标记珠三态配色（MARKER_TOKENS 原样透传）。
    expect(LIGHT_PALETTE.markers).toStrictEqual(MARKER_TOKENS);
    expect(LIGHT_PALETTE.markers).toBe(MARKER_TOKENS); // 同一引用，不是深相等的拷贝
  });
});

describe('buildPalette：暗色分支——readVar 全部返回空时的回落实色', () => {
  const dark = buildPalette({ mode: 'dark', readVar: emptyReadVar });

  it('七项中性灰阶回落到给定的实色', () => {
    expect(dark.canvasBg).toBe('rgb(18 18 18)');
    expect(dark.border).toBe('rgb(76 76 76)');
    expect(dark.textPrimary).toBe('rgb(224 224 224)');
    expect(dark.textSecondary).toBe('rgb(176 176 176)');
    expect(dark.gridDot).toBe('rgb(56 56 56)');
    expect(dark.edge).toBe('rgb(130 130 130)');
    expect(dark.surface).toBe('rgb(28 28 28)');
  });

  it('品牌主色暗色下保持不变（硬规则：不映射宿主 --primary-color）', () => {
    expect(dark.primary).toBe('#1464E0');
  });

  it('语义色暗色下保持不变（不分主题）', () => {
    expect(dark.semantic).toStrictEqual(SEMANTIC);
  });

  it('节点图标色：iconColor 色相不变，iconBg 是 iconColor 与暗色 surface 的 16% 预合成实色', () => {
    expect(dark.nodeTypes.start.iconColor).toBe('#22A06B');
    expect(dark.nodeTypes.start.iconBg).toBe('rgb(29 49 41)');
    expect(dark.nodeTypes.approve.iconColor).toBe('#1464E0');
    expect(dark.nodeTypes.approve.iconBg).toBe('rgb(27 40 59)');
  });

  it('阴影：读不到宿主 token 时的自定回落值', () => {
    expect(dark.shadow).toBe('rgba(0, 0, 0, .48)');
    // 校验错误红/待配置橙/标记珠三态：色相不变原则，暗色沿用亮色取值（primary/semantic 硬规则
    // 的自然推广）。
    expect(dark.validationError).toBe('#ff4d4f');
    expect(dark.pendingConfig).toBe('#fa8c16');
    expect(dark.markers).toStrictEqual({
      conditionConfigured: { stroke: '#1464E0', text: '#1464E0' },
      conditionUnconfigured: { stroke: '#FFD591', text: '#D46B08' },
      // else：stroke/text 均精确映射到已解析出的暗色 border/textSecondary（亮色 stroke 与
      // 空路线插槽 border 字面量相同、text 亮色本就复用 NEUTRAL.textSecondary，见 buildPalette
      // 该处注释）。
      else: { stroke: 'rgb(76 76 76)', text: 'rgb(176 176 176)' },
      // button：stroke 按"卡片中性描边"家族就近映射到暗色 border（近似映射）；text 无精确对应，
      // 色相不变原则保留亮色取值（置信度低于其余几项，见任务汇报"遗留问题"）。
      button: { stroke: 'rgb(76 76 76)', text: '#4E5561' }
    });
  });
});

describe('buildPalette：暗色分支——readVar 命中宿主 token', () => {
  it('7 项中性灰阶按宿主 RGB 三元组包成 rgb(...)，不使用回落实色', () => {
    const hostValues: Record<string, string> = {
      '--layout-bg-color': '10 12 14',
      '--border-color': '60 62 64',
      '--base-text-color': '230 230 230',
      '--text-secondary-color': '160 160 160',
      '--border-lighter-color': '40 40 40',
      '--text-hint-color': '120 120 120',
      '--container-bg-color': '30 30 30'
    };
    const dark = buildPalette({ mode: 'dark', readVar: (name) => hostValues[name] });
    expect(dark.canvasBg).toBe('rgb(10 12 14)');
    expect(dark.border).toBe('rgb(60 62 64)');
    expect(dark.textPrimary).toBe('rgb(230 230 230)');
    expect(dark.textSecondary).toBe('rgb(160 160 160)');
    expect(dark.gridDot).toBe('rgb(40 40 40)');
    expect(dark.edge).toBe('rgb(120 120 120)');
    expect(dark.surface).toBe('rgb(30 30 30)');
  });

  it('--shadow-color 命中时按同一 .14 透明度换算，不落回自定默认值', () => {
    const dark = buildPalette({ mode: 'dark', readVar: (name) => (name === '--shadow-color' ? '5 6 7' : '') });
    expect(dark.shadow).toBe('rgba(5, 6, 7, .14)');
  });
});

describe('mixIconBg：iconBg 暗色预合成函数', () => {
  it('给定 iconColor（#hex）与 surface（rgb 三元组）产出预期实色（16%/84% 混合，四舍五入）', () => {
    // start 类型 iconColor #22A06B = rgb(34,160,107)，与暗色 surface rgb(28 28 28) 混合：
    // r: round(34*.16+28*.84)=29, g: round(160*.16+28*.84)=49, b: round(107*.16+28*.84)=41。
    expect(mixIconBg('#22A06B', 'rgb(28 28 28)')).toBe('rgb(29 49 41)');
  });

  it('surface 为纯黑时混合结果就是 iconColor 按 16% 缩放（回归极端输入）', () => {
    // #FFFFFF 与黑色 surface 混合：round(255*.16)=41（每个通道相同）。
    expect(mixIconBg('#FFFFFF', 'rgb(0 0 0)')).toBe('rgb(41 41 41)');
  });

  it('也接受逗号分隔的 rgb(r, g, b) 形式（宿主变量包装后的另一种可能写法）', () => {
    expect(mixIconBg('#22A06B', 'rgb(28, 28, 28)')).toBe('rgb(29 49 41)');
  });
});

describe('resolvePalette：DOM 集成 smoke test（happy-dom）', () => {
  it('documentElement 不带 dark 类时解析为亮色，返回 LIGHT_PALETTE 本体', () => {
    document.documentElement.classList.remove('dark');
    expect(resolvePalette()).toBe(LIGHT_PALETTE);
  });

  it('documentElement 带 dark 类时解析为暗色（happy-dom 下没有宿主样式表，全部回落到默认实色）', () => {
    document.documentElement.classList.add('dark');
    try {
      const palette: CanvasPalette = resolvePalette();
      expect(palette).not.toBe(LIGHT_PALETTE);
      expect(palette.canvasBg).toBe('rgb(18 18 18)');
      expect(palette.primary).toBe('#1464E0');
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('可传入自定义 root 元素（不依赖全局 document 当前状态）', () => {
    const el = document.createElement('div');
    el.classList.add('dark');
    expect(resolvePalette(el).canvasBg).toBe('rgb(18 18 18)');
  });
});
