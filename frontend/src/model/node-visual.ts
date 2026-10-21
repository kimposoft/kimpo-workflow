/**
 * model/node-visual.ts —— 节点类型 -> 视觉三件套（色板/形状家族/图标）的唯一权威来源
 * （色板与图标不得有第二份拷贝）。
 *
 * 色板本身的权威值现收敛到 ./design-tokens.ts（见其文件头注释"为什么是 TS 常量"）——本文件的 NODE_PALETTE 是 design-tokens.ts NODE_TYPE_TOKENS 派生出的
 * 消费视图（附带 fill/stroke 兼容别名，见下方 NODE_PALETTE 注释），本身不重复书写颜色字面量。
 *
 * 消费方三处：
 *   - graph/x6-adapter.ts：画布节点渲染（X6 markup/attrs 全靠这里的数据拼出来）；
 *   - graph/svg-adapter.ts：progress 只读画布（V1 最小实现）同款配色；
 *   - designer/stencil/StencilPanel.vue：形状面板条目的色块+图标预览；
 *   - designer/panels/PanelShell.vue：节点属性面板头部图标（读 NODE_PALETTE 的 fill/stroke
 *     兼容别名，见下方注释）。
 * 各处若各自维护一份配色会跑偏（面板色块与 X6 画布不同步），因此统一从本文件+design-tokens.ts
 * 取值。
 */
import type { DesignNodeType } from './index';
import { LIGHT_PALETTE, type CanvasPalette } from './design-tokens';

/** 节点形状家族：决定画布上用哪一套 markup 骨架（见 x6-adapter.ts buildNodeVisual）。
 *   - capsule：start/end，胶囊形（圆角=半高）；
 *   - human：审批/办理/抄送，圆角矩形；
 *   - automatic：子流程，圆角矩形；
 *   - structure：V1 分支结构块（branch_split/branch_join）专用，V2 无节点类型映射到此家族，
 *     字面量继续保留仅因为
 *     graph/x6-adapter.ts 仍有按 family==='structure' 分叉的既有代码路径（保留但不依赖已删
 *     类型，不做重构，见该文件相应注释），不代表 V2 又引入了这个家族。
 * 🔴 所有节点共用同一张白底卡（1.5px 中性灰描边），家族间没有描边差异，仅靠图标块着色区分类型——human/automatic 两个枚举值本身仍保留（区分尺寸计算等场景
 * 之外，当前只剩语义分类作用，不再驱动任何视觉分叉，见 x6-adapter.ts applyNodeVisual）。 */
export type NodeShapeFamily = 'capsule' | 'human' | 'automatic' | 'structure';

export const NODE_SHAPE_FAMILY: Record<DesignNodeType, NodeShapeFamily> = {
  start: 'capsule',
  end: 'capsule',
  approve: 'human',
  handle: 'human',
  cc: 'human',
  subflow: 'automatic'
};

/** NODE_PALETTE 单条目形状：iconBg/iconColor 是新色板权威字段（design-tokens.ts
 * NODE_TYPE_TOKENS 逐字段透传）；fill/stroke 是**兼容别名**（值恒等于 iconBg/iconColor），
 * 仅为 designer/panels/PanelShell.vue 这一个历史消费方保留。新消费方（x6-adapter.ts/svg-adapter.ts/StencilPanel.vue）
 * 一律直接读 iconBg/iconColor，不要新增 fill/stroke 的读取点——PanelShell.vue 不再读取后，这两个别名
 * 字段可以整体删除。 */
export interface NodePaletteEntry {
  iconBg: string;
  iconColor: string;
  /** @deprecated 兼容字段，恒等于 iconColor；仅供 PanelShell.vue 过渡期消费，见本接口头注释。 */
  fill: string;
  /** @deprecated 兼容字段，恒等于 iconColor；仅供 PanelShell.vue 过渡期消费，见本接口头注释。 */
  stroke: string;
}

/** 按 palette.nodeTypes 派生出带兼容别名的节点色板——派生而非手写第二份，保证 iconBg/
 * iconColor 与 fill/stroke 两组字段永远同步，不会出现改了一处忘改另一处的漂移。
 *
 * 🔴 入参是整份 CanvasPalette，默认值 LIGHT_PALETTE（LIGHT_PALETTE.nodeTypes 就是
 * NODE_TYPE_TOKENS 本身，同一引用），因此下方 NODE_PALETTE 恒为亮色。按当前主题传入对应
 * palette（如 derivePalette(darkPalette)）即可拿到暗色下的节点色板，不需要再单独维护一份暗色
 * 派生逻辑。 */
export function derivePalette(palette: CanvasPalette = LIGHT_PALETTE): Record<DesignNodeType, NodePaletteEntry> {
  const result = {} as Record<DesignNodeType, NodePaletteEntry>;
  for (const type of Object.keys(palette.nodeTypes) as DesignNodeType[]) {
    const { iconBg, iconColor } = palette.nodeTypes[type];
    result[type] = { iconBg, iconColor, fill: iconBg, stroke: iconColor };
  }
  return result;
}

/** 节点色板（明亮模式）——权威取值在 design-tokens.ts NODE_TYPE_TOKENS（经
 * LIGHT_PALETTE.nodeTypes 透传），本处只做派生+兼容别名补充，不重复书写颜色字面量。 */
export const NODE_PALETTE: Record<DesignNodeType, NodePaletteEntry> = derivePalette();

/** 每类节点的内联 SVG 图标（V1 极简线性图标，手绘几何路径，非引入专业图标库——不新增依赖
 * 是硬约束）。坐标系统一 0~16 局部坐标；fill=true 表示实心填充风格（fill=描边色，
 * stroke=none），fill=false 表示描边线条风格（stroke=描边色，fill=none）。structure 家族
 * （branch_split/branch_join）不画图标：🔴 菱形只有 22×22，放不下图标，文字标签也一并去掉（语义改由容器头部承载，见 x6-adapter.ts
 * buildNodeVisual/applyNodeVisual 对 structure 分支的处理），形状+色板已经足够区分。 */
export const NODE_ICONS: Partial<Record<DesignNodeType, { d: string; fill: boolean }>> = {
  start: { d: 'M0,0 L12,6 L0,12 Z', fill: true },
  end: { d: 'M0,0 H12 V12 H0 Z', fill: true },
  approve: { d: 'M1,7 L5,11 L13,2', fill: false },
  handle: { d: 'M1,13 L2,9 L10,1 L13,4 L5,12 Z M9,2 L12,5', fill: false },
  cc: { d: 'M0,2 H14 V11 H0 Z M0,2 L7,7 L14,2', fill: false },
  subflow: { d: 'M0,0 H14 V10 H0 Z M3,3 H11 V13 H3 Z', fill: false }
};
