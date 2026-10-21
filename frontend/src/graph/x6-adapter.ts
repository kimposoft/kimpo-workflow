/**
 * X6 画布适配器。X6 只存在于 graph 边界；所有业务写操作都以 GraphPort 事件回到
 * DesignerRoot，再由 DesignerStore/CommandStack 落地。视口、选择框和边拐点属于会话级表现态。
 */
import { Graph, type Cell, type Edge, type Node } from '@antv/x6';
import { Keyboard } from '@antv/x6-plugin-keyboard';
import { MiniMap } from '@antv/x6-plugin-minimap';
import { Selection } from '@antv/x6-plugin-selection';
import { Snapline } from '@antv/x6-plugin-snapline';
import {
  type EdgeConditionMarker,
  type GraphEdgeView,
  type GraphNodeView,
  type GraphPort,
  type GraphPortEvents
} from './port';
import { DESIGN_LAYOUT_MAX_EDGE_VERTICES, type DesignLayout } from '../model';
import type { NodePosition } from '../model/store';
import { NODE_ICONS, NODE_SHAPE_FAMILY, type NodeShapeFamily } from '../model/node-visual';
import { LIGHT_PALETTE, type CanvasPalette } from '../model/design-tokens';

/** 普通业务节点（human/automatic 家族）尺寸：184×64，圆角 10。 */
const NODE_WIDTH = 184;
const NODE_HEIGHT = 64;
/** 胶囊节点（start/end，capsule 家族）尺寸——与普通业务节点不同档，168×56，rx=ry=半高=28。 */
const CAPSULE_WIDTH = 168;
const CAPSULE_HEIGHT = 56;
/** 分支点/汇合点（structure 家族）菱形尺寸 22：菱形不承载"分支点/汇合点"的文字语义，取与其它
 * 画布图形协调的小尺寸。refPoints 用相对坐标描述菱形形状（见 applyNodeVisual 里 `body` 的
 * refPoints 计算，X6 registry/attr/ref.ts 的 shapeWrapper 会按 refBBox 自动等比缩放这份坐标去
 * 匹配节点实际宽高），因此本常量是缩放菱形尺寸的唯一改动点，不需要连带改 refPoints 字面量。 */
const STRUCTURE_SIZE = 22;
/** 图标块：26×26 圆角 7 的彩色背景块，左边距 12、垂直居中——节点卡视觉为"白底 + 中性灰描边 +
 * 彩色图标块"（见 buildNodeVisual/applyNodeVisual 头注释）。 */
const ICON_BG_SIZE = 26;
const ICON_BG_RADIUS = 7;
const ICON_BG_LEFT = 12;
/** label/summary 两行文字的统一起排位置——图标块（左边距 12 + 宽 26）之后留出间距。 */
const LABEL_START = 40;
const CLIPBOARD_KEY = '__kimpo_workflow_designer_clipboard__';
/** 选中态四角方形手柄：8×8、圆角 2，纯装饰（pointer-events:none，不是可拖拽的缩放柄——画布内
 * 没有缩放节点的交互）。与节点家族/尺寸无关，四角坐标用 refX/refY 的相对定位公式统一计算，
 * 22×22 的 structure 家族与其余家族共用同一份实现（见 applySelectionHandles）。 */
const SELECT_HANDLE_SIZE = 8;
const SELECT_HANDLE_RADIUS = 2;

/** 小地图最小缩放比下限（见 refreshMinimapScale 头注释）：内容自然适配算出的缩放
 * 比低于这个值时被拉到这个值，保证最小的普通业务节点（184×64）在小地图里至少渲染出
 * 184*0.3≈55px × 64*0.3≈19px 的可辨认圆角矩形（而不是缩成一个点）；胶囊/结构菱形等更小的
 * 家族同理成比例放大。0.3 是按"形状仍可辨"倒推的经验值。 */
const MINIMAP_MIN_SCALE = 0.3;
/** 小地图最大缩放比上限——延续 mount() 里 `new MiniMap({ maxScale: 1 })` 构造参数原本想表达
 * 但未生效的意图（该构造参数实际只作用于拖拽缩放手柄，见 mount() 消费处注释），content 极小
 * （如单节点）时也不放大到超过真实尺寸的 100%，避免小地图里的节点比画布本体还显眼。 */
const MINIMAP_MAX_SCALE = 1;

/** 按节点类型返回创建/包围盒计算共用的画布尺寸——setNodes 的创建分支与下方
 * computeBlockContainerBBox 的成员包围盒计算只认这一份口径（同 buildNodeVisual/applyNodeVisual
 * "两处共用一份实现"的既定手法）。三态：structure（菱形）22×22；capsule（胶囊）168×56；其余
 * （human/automatic 家族的普通业务节点）184×64。 */
// 导出供设计层的纯几何计算复用：双击节点库新增节点时要算"放哪儿不重叠"（见
// designer/stencil-drop-placement.ts 头注释），需要各家族节点的真实卡片尺寸。设计层不越过 graph
// 边界直接 import X6 本身，只读这一份尺寸数字（同 designer/layout.ts 头注释"两图层独立取值"既定分工）。
export function nodeDimensions(type: GraphNodeView['type']): { width: number; height: number } {
  const family = NODE_SHAPE_FAMILY[type];
  if (family === 'structure') return { width: STRUCTURE_SIZE, height: STRUCTURE_SIZE };
  if (family === 'capsule') return { width: CAPSULE_WIDTH, height: CAPSULE_HEIGHT };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/**
 * 节点卡片（capsule/human/automatic 三个家族共用的那张"白底卡"）的几何与字号口径，导出供设计层
 * 在**画布之外**复刻同一张卡——目前唯一消费方是节点库拖拽预览图（designer/stencil/
 * drag-preview.ts：从节点库往画布拖节点时，跟着指针走的图样要与落下后的节点长得一样）。
 *
 * 图标块/文字起点四项直接引用本文件上方的私有常量；cardRadius/strokeWidth/字号/行位置这几项在
 * applyNodeVisual 里是内联字面量，这里照录一份——两边一旦漂移，预览图就会与真节点对不上，故由
 * x6-adapter.card-geometry.test.ts 用假 cell 跑一遍 applyNodeVisual 逐项对账锁死，改 applyNodeVisual
 * 的这几个数时该测试会红，提醒同步这里。structure（菱形）家族不是卡片，不在本口径内。
 */
export const NODE_CARD_GEOMETRY = {
  /** 普通业务节点卡圆角；胶囊家族圆角恒为半高，不读这一项。 */
  cardRadius: 10,
  /** 默认态（未选中、无校验问题）描边宽度。 */
  strokeWidth: 1.5,
  iconBgSize: ICON_BG_SIZE,
  iconBgRadius: ICON_BG_RADIUS,
  iconBgLeft: ICON_BG_LEFT,
  /** 图标 path 的局部坐标系边长（0~16），在图标块内居中。 */
  iconViewBox: 16,
  iconStrokeWidth: 1.6,
  labelStart: LABEL_START,
  /** 摘要文字右侧留白（applyNodeVisual 的 textWrap.width = -(LABEL_START + 12)）。 */
  summaryRightPadding: 12,
  labelFontSize: 13,
  labelFontWeight: 600,
  summaryFontSize: 11,
  /** 标题垂直位置（占节点高度的比例）：单行居中 / 有摘要时上移。 */
  labelRefYSingle: 0.5,
  labelRefYWithSummary: 0.38,
  summaryRefY: 0.68
} as const;

// —— 分支结构块容器几何常量 ——
// 本文件只维护几何相关的常量与消费处，不在本地维护颜色字面量（颜色全部来自 CanvasPalette）。
/** 展开态容器四周留白：成员节点最外沿到容器边框的距离。 */
const BLOCK_CONTAINER_PADDING = 32;
/** 顶部预留高度（头部文字/chip/工具区所占的整段空间，即便不再画实心头部条，这段空间仍需要
 * 留给容器头部的浮动文案，见 computeBlockContainerBBox 的消费处）。 */
const BLOCK_HEADER_HEIGHT = 40;
/** 头部避让非成员节点时额外计入的安全边距。端口圆半径为 5px（portGroups），取 8px 同时覆盖
 * 端口描边与亚像素缩放误差，保证高层头部控件不会与外部节点的 magnet 争抢同一个命中点。 */
const BLOCK_HEADER_OBSTACLE_CLEARANCE = 8;
/** 折叠态尺寸对齐普通业务节点卡——折叠后视觉上就是"退化成一个节点"。 */
const BLOCK_COLLAPSED_WIDTH = NODE_WIDTH;
const BLOCK_COLLAPSED_HEIGHT = NODE_HEIGHT;

/**
 * 节点视觉数据（色板/形状家族/图标）的唯一权威来源在 ../model/node-visual.ts（色板取值本身又
 * 收敛到 ../model/design-tokens.ts，见其文件头注释）——画布与形状面板
 * （../designer/stencil/StencilPanel.vue）共用同一份数据，避免"两套配色互相跑偏"。
 *
 * 🔴 暗色支持：颜色由调用方传入的 CanvasPalette 参数决定，`palette.nodeTypes[type]` 就是该类型在
 * 当前主题下的 {iconBg, iconColor}（CanvasPalette.nodeTypes 字段本身已经是 NODE_TYPE_TOKENS 的
 * 主题感知视图，见 design-tokens.ts 该字段注释）。本文件不维护模块级颜色常量，不产生第二份颜色数据。
 *
 * 🔴 节点视觉语言："白底 + 中性灰描边（NEUTRAL.border）+ 彩色图标块"——九类节点共用同一张白底卡，
 * 家族间没有描边差异，仅靠 26×26 图标块的 iconBg/iconColor 着色区分类型。NodeShapeFamily 的
 * 四个取值只决定"形状"（capsule 胶囊 / 其余矩形 / structure 菱形）。
 * 节点视觉分层（NodeShapeFamily，同样在 node-visual.ts）：
 *   - capsule：start/end，胶囊形（圆角=半高，168×56），区别于普通业务节点的直角矩形；
 *   - human：审批/办理/抄送三类人工节点，圆角矩形（184×64）；
 *   - automatic：自动化动作/等待/子流程三类自动节点，同尺寸矩形（184×64），与 human 视觉上
 *     没有描边差异；
 *   - structure：branch_split/branch_join，菱形，不画图标也不画文字标签（22×22 放不下文字，
 *     形状+色板已足够区分，见下方 buildNodeVisual/applyNodeVisual 的处理）。
 */
/**
 * buildNodeVisual —— 按形状家族拼出节点**创建时刻**的 X6 自定义 markup。不用 X6 内置
 * 'rect'/'polygon' 形状自带的默认 markup（那只有 body+label 两个元素），而是显式给出完整 markup
 * 数组——多出来的 iconBg/icon 元素、以及 label 的定位全部用 refX/refY/xAlign/yAlign 相对节点
 * 包围盒定位（X6 markup 特殊属性，见其官方文档"相对定位"一节），不依赖节点宽高的硬编码像素
 * 换算，形状/尺寸微调时无需同步改这里的每一个数字。
 *
 * 家族间没有 markup 结构差异：非 structure 家族统一是"body + iconBg + icon + label + summary"
 * 同一套骨架（有没有 iconBg/icon 只取决于该类型是否配了图标，与形状家族无关）。structure（菱形）
 * 家族只有 body 一个视觉元素（22×22 放不下文字标签，见文件头分层注释"不画图标也不画文字标签"），
 * 不产出图标也不产出摘要。
 *
 * 本函数只负责**结构性骨架**——这组 tagName/selector 只在创建时决定一次，此后不随 view 的
 * 更新而增删元素。真正随 view 变化的视觉属性（颜色/文字/摘要/描边宽度等）统一交给下方的
 * applyNodeVisual 在创建后与每次更新时填入，两者不重复计算同一份东西（避免"创建算一套、
 * 更新算另一套"导致更新分支漏属性，例如改了审批人之后摘要不刷新）。
 *
 * summary 元素恒存在于非 structure 家族的 markup 里（不按"创建那一刻有没有摘要"条件加入）：
 * 若节点创建时恰好没有摘要就不建这个元素，之后摘要从无变有时再怎么 setAttr 也出不来。有没有
 * 摘要交给 applyNodeVisual 用空文本处理（空文本的 text 元素不占视觉空间，不影响布局）。
 *
 * 🔴 选中态四角手柄同样遵循"markup 恒建、apply 控显隐"的既定手法（同 summary 元素的处理）——
 * 四个 selectHandleXX rect 元素在两个分支（structure/非 structure）里都恒存在，选中与否只影响
 * applyNodeVisual 里 display 的取值，不影响这里的结构性骨架，因此 structure 家族的 markup 也需要
 * 追加这四个元素（分支点/汇合点同样可被选中）。
 */
export function buildNodeVisual(family: NodeShapeFamily, nodeType: GraphNodeView['type']): { tagName: string; selector: string }[] {
  const selectHandles = [
    { tagName: 'rect', selector: 'selectHandleTL' },
    { tagName: 'rect', selector: 'selectHandleTR' },
    { tagName: 'rect', selector: 'selectHandleBL' },
    { tagName: 'rect', selector: 'selectHandleBR' }
  ];
  if (family === 'structure') {
    // 不产出 label 文字元素——22×22 的菱形放不下文字（见本函数头注释）。
    return [{ tagName: 'polygon', selector: 'body' }, ...selectHandles];
  }

  const hasIcon = Boolean(NODE_ICONS[nodeType]);
  return [
    { tagName: 'rect', selector: 'body' },
    ...(hasIcon ? [{ tagName: 'rect', selector: 'iconBg' }, { tagName: 'path', selector: 'icon' }] : []),
    { tagName: 'text', selector: 'label' },
    { tagName: 'text', selector: 'summary' },
    ...selectHandles
  ];
}

/**
 * NodeVisualCell / EdgeVisualCell —— applyNodeVisual / applyEdgeVisual 所需的最小 X6 节点/边
 * 接口。真实调用方传入 X6 的 Node/Edge 实例（结构上天然满足，多出来的方法不影响结构类型匹配）；
 * 单测传入手写的假对象/spy 即可，不必真的实例化 X6 Graph——X6 Graph 依赖真实 DOM 布局测算，
 * happy-dom 环境下代价大且脆，抽出这组最小接口是让画布视觉逻辑变得可测的关键一步。
 */
export interface NodeVisualCell {
  position(x: number, y: number): unknown;
  attr(path: string, value: unknown): unknown;
}
export interface EdgeVisualCell {
  attr(path: string, value: unknown): unknown;
  setSource(source: { cell: string; port: string }): unknown;
  setTarget(target: { cell: string; port: string }): unknown;
  setLabels(labels: unknown[]): unknown;
}

/**
 * applySelectionHandles —— 选中态四角 8×8 方形手柄的公共视觉计算。structure/非 structure 两个
 * 家族共用同一份实现（同 buildNodeVisual/applyNodeVisual 头注释"两处共用一份实现"的既定手法）：
 * 手柄坐标用 refX/refY 的相对定位公式算出（左上角=`-half`；右上角=`100% - half`；下方同理），
 * 与节点实际宽高无关，因此 22×22 的 structure 家族与 184×64/168×56 的其余家族可以共用同一份
 * 计算，不需要按 family 分叉。
 *
 * 纯视觉、不可交互：pointer-events:none（既不是拖拽缩放柄，也不应该挡住下方节点卡本身的点击/
 * 拖拽/连线手柄）。四个 selector 在 buildNodeVisual 里恒建，本函数只控制 display 显隐 + 静态
 * 描边配色，同 hideElement() 用于分支结构块容器的既定手法（元素恒存在，可见性交给 apply 决定）。
 *
 * palette 参数（暗色支持）：手柄白底 fill 取 palette.surface，描边取 palette.primary（品牌蓝，
 * 亮暗恒定）——末位参数、默认值 LIGHT_PALETTE。
 */
function applySelectionHandles(cell: NodeVisualCell, selected: boolean, palette: CanvasPalette = LIGHT_PALETTE): void {
  const half = SELECT_HANDLE_SIZE / 2;
  const paint = {
    width: SELECT_HANDLE_SIZE,
    height: SELECT_HANDLE_SIZE,
    rx: SELECT_HANDLE_RADIUS,
    ry: SELECT_HANDLE_RADIUS,
    fill: palette.surface,
    stroke: palette.primary,
    strokeWidth: 1.5,
    'pointer-events': 'none',
    style: { display: selected ? '' : 'none' }
  };
  cell.attr('selectHandleTL', { ...paint, refX: -half, refY: -half });
  cell.attr('selectHandleTR', { ...paint, refX: '100%', refX2: -half, refY: -half });
  cell.attr('selectHandleBL', { ...paint, refX: -half, refY: '100%', refY2: -half });
  cell.attr('selectHandleBR', { ...paint, refX: '100%', refX2: -half, refY: '100%', refY2: -half });
}

/**
 * applyNodeVisual —— 把一个 GraphNodeView 的全部视觉状态（position、label 文本与位置、
 * summary 文本、body 的 stroke/strokeWidth、iconBg、icon……）施加到一个已存在的 X6 节点上。
 * **创建分支（addNode 之后）与更新分支共用同一份实现**——这样更新分支不会漏掉某个视觉属性
 * （如 summary 文本、hasIssues 对应的 strokeWidth），避免"改了审批人之后节点卡摘要不刷新"这类
 * 缺陷。buildNodeVisual 只管创建时刻的 markup 骨架，视觉属性的计算只在本函数里出现一次，不存在
 * 第二处独立实现。iconBg 同理，全部计算收在这里，不在 buildNodeVisual 里算任何颜色/位置（同一份
 * "新增视觉计算必须放在 apply* 里"纪律）。
 *
 * 幂等：连续对同一个 cell apply 同一个 view 两次，结果与只 apply 一次一致；先 apply view A
 * 再 apply view B，结果等于只 apply 过 B（不残留 A 的状态）——"摘要从有变无"要求 summary
 * 文本被显式清空，就是靠这条幂等性保证的：本函数总是把每个会变化的字段显式带上当次的值，
 * 不依赖"这次不传就维持上次的值"。
 *
 * palette 参数（暗色支持）：末位参数，默认值 LIGHT_PALETTE。切主题时由 X6GraphAdapter.setPalette()
 * 对已渲染的每个节点重新调用本函数（同一份实现，见该方法注释），不新增第二套视觉计算路径。
 */
export function applyNodeVisual(cell: NodeVisualCell, view: GraphNodeView, palette: CanvasPalette = LIGHT_PALETTE): void {
  const family = NODE_SHAPE_FAMILY[view.type];
  // 该类型在当前主题下的图标块配色——palette.nodeTypes 本身已是 NODE_TYPE_TOKENS 的主题感知
  // 视图（见 CanvasPalette.nodeTypes 字段注释），此处直接取用，不需要再经过 node-visual.ts
  // 的 derivePalette（那是给 fill/stroke 兼容别名消费方 PanelShell.vue 用的，见其注释）。
  const nodeColors = palette.nodeTypes[view.type];
  const selected = Boolean(view.selected);
  // 🔴 选中态（选中态真实来源见 setNodes/setSelection/setPalette 头注释）：根容器（rootSelector，
  // parseJSONMarkup 里恒把 'root' 映射到节点的真实 DOM 容器，见 node_modules/@antv/x6 view/cell.js
  // parseJSONMarkup）打 data-selected 属性——X6 node.setData() 只写模型层数据不落 DOM，
  // attr('root/xxx', value) 才是唯一能把值写进节点根 <g> DOM 属性的路径（同创建时 addNode({ attrs:
  // { root: {...} } }) 已经在用的同一条路径），保留供 DOM/e2e 消费方使用。路径带 '/' 是深合并写入、
  // 不是整体覆盖，不会连带清掉创建时写入的 data-node-id/data-node-type。
  cell.attr('root/data-selected', selected ? 'true' : 'false');
  // 选中态外圈光环：不放在宿主页面 CSS 里（那样要读宿主全局变量，与画布自身的 CanvasPalette 主题
  // 系统脱节），而是与其余节点视觉同一条路径：SVG attrs 内联
  // style，直接消费 palette.primary/palette.selectionGlow（design-tokens.ts 里的唯一色板权威
  // 源）。叠两层 drop-shadow——内层 1px 模糊、palette.primary 全不透明，贴着描边勾出一圈清晰
  // 边界；外层 4px 模糊、palette.selectionGlow（primary 45% 透明度），产出向外扩散的柔光——
  // drop-shadow 语法本身不支持 box-shadow 那种"扩散但不模糊"的 spread 参数（同
  // buildMarkerLabelConfig 头注释同款近似取舍），两层叠加是在这个限制下逼近"清晰光环"观感
  // 的写法（单层淡光环几乎看不出选中）。未选中时清空 filter，不留残留（幂等性要求，见本函数头注释）。有检查问题
  // （hasIssues）的节点选中时光环照常叠加——描边色仍优先显示问题色（见下方 strokeColor），
  // 光环只是独立的"正在编辑它"信号，两者不冲突。
  cell.attr(
    'root/style/filter',
    selected ? `drop-shadow(0 0 1px ${palette.primary}) drop-shadow(0 0 4px ${palette.selectionGlow})` : 'none'
  );
  // 四角手柄与节点家族/尺寸无关，一次性统一处理（见 applySelectionHandles 头注释）。
  applySelectionHandles(cell, selected, palette);
  // 🔴 body 描边不按节点类型着色，统一走中性灰（palette.border），仅校验错误态（hasIssues）转红
  // ——"仅靠图标块着色区分类型"的视觉语言要求描边恒定，见文件头说明注释。选中态优先级低于
  // hasIssues、高于默认中性灰：描边换成品牌蓝 palette.primary。hasIssues 红取
  // palette.validationError——与 palette.semantic.danger 是两个不同色值，有意保持现状不统一
  // （见 design-tokens.ts CanvasPalette.validationError 字段注释）。
  // strokeWidth：选中态加粗到 2px（只换色不够醒目），hasIssues 是最粗的 2.5，两者不会同时命中
  // （hasIssues 优先）。
  const strokeColor = view.hasIssues ? palette.validationError : selected ? palette.primary : palette.border;
  const strokeWidth = view.hasIssues ? 2.5 : selected ? 2 : 1.5;

  cell.position(view.position.x, view.position.y);

  if (family === 'structure') {
    // structure（菱形）家族用"实心色块"视觉，不用白底——整块着色区分，配色走
    // design-tokens 的 iconBg/iconColor。选中态优先级同上（hasIssues > selected > 默认类型色）。
    // 不 attr('label', ...)——buildNodeVisual 不产出 label 元素，这里对称地不写它（X6 对未知
    // selector 的 attr 调用是静默 no-op，写了也没有意义）。
    const diamondStroke = view.hasIssues ? palette.validationError : selected ? palette.primary : nodeColors.iconColor;
    cell.attr('body', { refPoints: '0,10 10,0 20,10 10,20', fill: nodeColors.iconBg, stroke: diamondStroke, strokeWidth });
    return;
  }

  const icon = NODE_ICONS[view.type];
  const isCapsule = family === 'capsule';

  // 两行卡：有摘要时标题上移、摘要排在下面；没有摘要则保持单行居中（不留空行占位）。
  const summary = (view.summary ?? '').trim();
  const hasSummary = summary.length > 0;

  cell.attr('body', {
    refWidth: '100%',
    refHeight: '100%',
    // 胶囊（start/end）圆角=半高（CAPSULE_HEIGHT/2=28）；普通业务节点圆角 10。
    rx: isCapsule ? CAPSULE_HEIGHT / 2 : 10,
    ry: isCapsule ? CAPSULE_HEIGHT / 2 : 10,
    // 白底卡：body 默认恒为 palette.surface（暗色下即暗色卡片底），不按类型/家族着色或加虚线
    // ——类型区分完全交给下方的 iconBg/icon。选中时改用 palette.selectedFill（主色轻微着色，见其
    // 字段注释）——"节点底色轻微主色着色"是描边 + 光环之外的第三层选中态信号，与 hasIssues 无关
    // （问题节点被选中时同样着色，两者独立）。
    fill: selected ? palette.selectedFill : palette.surface,
    stroke: strokeColor,
    strokeWidth,
    strokeDasharray: 'none'
  });
  cell.attr('label', {
    text: view.label,
    fill: palette.textPrimary,
    fontSize: 13,
    fontWeight: 600,
    refX: LABEL_START,
    // 两行卡：标题上移到 38%，摘要落在 68%；单行时仍居中。这个切换只能在
    // 这里按 view.summary 动态判断，不能再靠 markup 有没有 summary 元素判断——markup 现在
    // 恒含该元素（见 buildNodeVisual），元素是否存在已经不能反映"当前有没有摘要"这件事。
    refY: hasSummary ? 0.38 : 0.5,
    yAlign: 'middle',
    textAnchor: 'start',
    textVerticalAnchor: 'middle'
  });
  // summary 元素在 markup 里恒存在，这里也恒调用——摘要从"有"变"无"时必须显式把文本清空，
  // 否则旧文案会残留在画布上。
  cell.attr('summary', {
    // 摘要可能很长（如多个处理人），超出卡片就截断——X6 的 textWrap 支持 ellipsis，
    // 不截断会溢出到卡片外面盖住相邻节点。
    text: summary,
    // "待配置"橙标：needsConfig 时摘要转橙（沿用画布上既有的"待处理"橙 palette.pendingConfig，
    // 与设计器顶栏"未保存"指示点用色一致，不新造一个语义色），配置齐全时保持原有的灰色说明文字
    // （palette.textSecondary）。文案本身（是具体的"未设置处理人"还是占位的"待配置"）由
    // DesignerRoot.vue 的 nodeViews 计算好装进 view.summary，这里只管配色。
    fill: view.needsConfig ? palette.pendingConfig : palette.textSecondary,
    fontSize: 11,
    refX: LABEL_START,
    refY: 0.68,
    yAlign: 'middle',
    textAnchor: 'start',
    textVerticalAnchor: 'middle',
    textWrap: { width: -(LABEL_START + 12), height: 14, ellipsis: true }
  });
  if (icon) {
    // 图标块：26×26 圆角 7 的彩色背景块，左边距 12、垂直居中。
    cell.attr('iconBg', {
      width: ICON_BG_SIZE,
      height: ICON_BG_SIZE,
      rx: ICON_BG_RADIUS,
      ry: ICON_BG_RADIUS,
      fill: nodeColors.iconBg,
      // 🔴 图标块必须显式声明"无描边"：X6 的 createShape('rect') 会给 markup 里**所有 `<rect>`
      // 标签**（按标签名选择器）挂一份默认 stroke/strokeWidth（@antv/x6 shape/util.js createShape
      // → Base.bodyAttr，深色 2px），body 与四角选中手柄各自显式覆盖了 stroke，图标块若只设 fill
      // 不设 stroke，就会带着一圈 X6 默认的深色粗边（且不随主题变）。按 markup selector（iconBg）
      // 写的属性优先级高于按标签名（rect）挂的默认值，显式写 none/0 即可确定性盖掉。
      stroke: 'none',
      strokeWidth: 0,
      refX: ICON_BG_LEFT,
      refY: 0.5,
      yAlign: 'middle'
    });
    // 图标 path 画在图标块内居中：图标局部坐标系是 0~16，图标块是 26×26，居中留白
    // (26-16)/2=5px。
    cell.attr('icon', {
      d: icon.d,
      refX: ICON_BG_LEFT + (ICON_BG_SIZE - 16) / 2,
      refY: 0.5,
      yAlign: 'middle',
      fill: icon.fill ? nodeColors.iconColor : 'none',
      stroke: icon.fill ? 'none' : nodeColors.iconColor,
      strokeWidth: icon.fill ? 0 : 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    });
  }
}

/** 按钮流转珠（marker.kind==='button'）几何常量——白底胶囊 h22、圆角=半高、左右内边距 9：
 * 高度固定 22，左右各留 9px 内边距；6×6 语义色圆点与文字之间再留 BUTTON_BEAD_DOT_GAP 间距。
 * 宽度不是固定值——按钮名长度不定（用户可编辑文本，同"同意"/"退回申请人"这类长短不一的
 * 场景），见 BUTTON_BEAD_CHAR_WIDTH 注释"近似估算"。 */
const BUTTON_BEAD_HEIGHT = 22;
const BUTTON_BEAD_PADDING_X = 9;
const BUTTON_BEAD_DOT_SIZE = 6;
const BUTTON_BEAD_DOT_GAP = 4;
/** 按钮名文字宽度的粗略估算（px/字符）：SVG 原生没有"内容自适应宽度的胶囊"这种布局能力
 * （不像 CSS padding+inline-block 可以让容器自动包住文字），本文件也没有引入真实文本度量管线
 * ——因此按"11.5px 字号下 CJK 字符近似正方形宽度"取一个偏宽松的估算值，保证胶囊宽度大概率能
 * 包住实际文字（按钮名以中文为主，英文字符更窄，估算偏宽不会截断，只是可能留白略多），是简化
 * 实现，非精确文本度量。 */
const BUTTON_BEAD_CHAR_WIDTH = 12;

/** 连线名称珠（画布中点珠子只认名称）几何常量：高 24、圆角=半高=12、字号 12、左右内边距 10。
 * 🔴 宽度不走"按字符数×固定 px 估算"（中英文混排/半角全角混排时估不准，外壳会包不住文字或留白
 * 过多），而是用 X6 markup 的 ref 相对定位——外壳跟随文字**真实渲染宽度**，见下方
 * buildMarkerLabelConfig name 分支注释"🔴 ref 配方"一节。因此这里不需要"每字符宽度"常量。 */
const NAME_BEAD_HEIGHT = 24;
const NAME_BEAD_PADDING_X = 10;

/** buildMarkerLabelConfig 的返回形状：position/attrs 是 X6 标签配置；markup 是各态各自的自定义
 * markup（见下方函数注释，均不沿用 X6 内置默认 rect+text markup）；tooltip 是透传字段（不挂在
 * body attrs 上作原生 title），供 mount() 里的 onEdgeLabelRendered 回调读取。 */
interface MarkerLabelConfig {
  position: number;
  markup: { tagName: string; selector: string }[];
  attrs: Record<string, unknown>;
  tooltip: string;
}

/**
 * buildMarkerLabelConfig —— 把一个 EdgeConditionMarker 转成 X6 setLabels() 要的单条标签配置。
 *
 * condition/else 两态用自定义 markup（circle r=11 + text，22×22 正圆命中区），不用 X6 内置默认
 * 标签 markup（rect+text 圆角矩形）。
 *
 * button 态同样是自定义 markup——白底胶囊
 * （rect，rx/ry=半高=11，宽度按文字长度估算，见 BUTTON_BEAD_CHAR_WIDTH 注释）+ 6×6 语义色圆点
 * （circle，色值来自 marker.buttonColor，即 designer/node-summary.ts resolveEdgeButtonLabel
 * 换算出的按钮语义色；未提供时退回 palette.markers.else.stroke 中性灰，同"默"珠既有色相，不是
 * 报错态——调用方可以只传 buttonLabel 不传 buttonColor）+ 文字（胶囊壳配色
 * palette.markers.button）。三个元素
 * 都用显式数值定位（body 的 x/y 是矩形左上角、dot 的 cx/cy 是圆心、label 的 x 是文字起点），
 * 不依赖 X6 markup 的 refX/refY 相对定位——那套相对定位是给"有固定 refBBox 的节点"用的（见
 * applyNodeVisual 注释），边标签没有这个 bbox 概念，X6 默认按 position（这里恒 0.5，边中点）
 * 把整个 markup 组的坐标原点摆在锚点上，因此 body/dot/label 的坐标都是"相对锚点的偏移量"（负数
 * 表示往左/往上），三者共同十字线对齐锚点即可视觉居中，同 condition/else 两态"circle 默认以
 * 自身 (0,0) 为圆心即天然居中锚点"是同一个坐标系。
 *
 * tooltip 字段：不走 X6 原生 title 特殊属性（弹出延迟由浏览器控制、不可编程，见 port.ts
 * EdgeConditionMarker.tooltip 注释）——
 * 原样把文案透传在返回对象上，Edge.Label 的 parseLabel() 对非字符串输入原样返回、不剥离额外
 * 字段（见 @antv/x6 model/edge.js parseLabel 源码），因此 mount() 里 onEdgeLabelRendered 回调
 * 收到的 `label` 参数上能读到这个 tooltip；该回调负责绑定 mouseenter/mouseleave 原生事件并
 * emit GraphPortEvents.edgeMarkerHover/edgeMarkerLeave，"300ms 后出现"的计时器与浮层渲染都在
 * 消费方 designer/canvas/DesignerCanvas.vue，不在本文件（适配器只上报"悬停这一事实"）。
 *
 * 点击选中边：circle/rect body 元素没有 pointer-events:none（仅内置默认给 text 设置
 * 了 pointerEvents:'none'，见 Edge.defaultLabel.attrs.text 的合并规则），点击会正常冒泡触发 X6
 * 的 edge:click / Selection 插件选中——"点击珠＝选中该边"不需要本文件写任何额外的点击
 * 处理代码，是 X6 默认行为的自然结果，各态形状均不影响这条结论。
 *
 * palette 参数（暗色支持）：末位参数，默认值 LIGHT_PALETTE——珠子壳白底读 palette.surface、
 * 阴影读 palette.shadow、各态描边/文字读 palette.markers.*（design-tokens.ts CanvasPalette.markers）。
 *
 * 🔴 'name' 态（连线名称珠）：白底胶囊（同 button 态"矩形+文字"
 * 两元素 markup，没有 button 态那颗语义色圆点），高 24/圆角 12/字号 12/左右内边距 10（见
 * NAME_BEAD_* 常量）。配色：design-tokens.ts CanvasPalette.markers 目前没有单独一档"主色浅
 * 描边+主色文字"的语义 token（'button' 用的是中性灰壳、'condition'/'else' 用的是各自的三态
 * 语义），复用形状最接近的 palette.markers.conditionConfigured（品牌蓝描边+品牌蓝文字，本就是
 * "白底+主色描边+主色文字"这套配方现成的取值）——不新增 token、不写死十六进制（本文件有静态
 * 断言钉死这条，见 x6-adapter.no-color-literal.static.test.ts）。
 *
 * 🔴 ref 配方（name 态外壳跟随文字宽度的关键）：
 * X6 的 `Edge.defaultLabel.attrs` 按**标签名当 CSS 选择器**给所有同标签元素挂默认值
 * （config.useCSSSelector 默认开启，见 registry/config.js 与 view/view.js View.find 的 CSS
 * 回退分支：找不到同名显式 selector 时退化成 `rootNode.querySelectorAll(selector)`）——
 * 默认的 `attrs.rect`（ref:'label'、rx/ry、refWidth:1、refHeight:1、refX:0、refY:0）会通过标签名
 * `rect` 命中我们 markup 里 `<rect selector="body">` 这同一个元素（与我们显式给的 'body' key 是
 * 同一个 DOM 节点，只是分属两个不同的顶层 attrs key）。setLabels 时
 * `ObjectExt.merge({}, defaultLabel.attrs, ourAttrs)` 先把两边顶层对象合并，若没有同名 'rect'
 * 顶层 key 去覆盖，`ref`/`refWidth`/`refHeight`/`refX`/`refY` 会原样残留；`ref` 一旦非空，X6 的
 * AttrManager.updateRelativeAttrs 就把这个节点按 refWidth/refHeight/refX/refY 相对 refNode
 * （label 文字包围盒）重新计算尺寸位置，'body' 下给的绝对像素 x/y/width/height 会被这套相对定位
 * 算掉。因此必须用同名 'rect' key 逐字段覆盖默认值，且要注意 `registry/attr/ref.js` 的两条语义：
 *   1) `refX2`/`refY2`/`refWidth2`/`refHeight2` 是 `refX`/`refY`/`refWidth`/`refHeight` 的**别名**
 *      （`exports.refX2 = exports.refX`），不是"在基准值上叠加的独立修正量"。`refX`/`refY` 属于
 *      positionWrapper：**每个**位置类属性各自算出一个 Point 并通过 `nodePosition.translate()`
 *      **累加**（不是后写覆盖前写），同时给 `refX` 与 `refX2` 会被加两次。`refWidth`/`refHeight`
 *      属于 setWrapper：同名属性多次出现按 Object.assign 语义后写覆盖前写，且对不在 [0,1] 区间
 *      的值算的是 `值 + refBBox[dimension]`（**不是**绝对值本身），例如 refHeight:24 会得到
 *      `24 + 文字高`。
 *   2) positionWrapper 对 `val == null` 直接 `return null`（不贡献任何位移）；setWrapper 对
 *      非法/空值走 `parseFloat` 得 `NaN`，`Number.isFinite(NaN)` 为假，不写该属性——这才是
 *      "确定性关掉 X6 默认值、又不产生任何副作用"的正规手段（ObjectExt.merge 是 lodash merge 语义：
 *      只跳过 `undefined` 源值，`null` 是合法值会正常覆盖目标，
 *      `merge({}, {refHeight:1}, {refHeight:null})` → `{refHeight:null}`）。
 * 准确配方（每个轴只保留一个位置属性、每个维度只保留一个尺寸属性，其余显式设 null 关掉）：
 *   - `rect`（同名覆盖 default）：`ref:'label'`、`refWidth: NAME_BEAD_PADDING_X*2`（=20，不在
 *     [0,1] ⇒ 宽度 = 文字宽 + 20，setWrapper 语义如上）、`refX: -NAME_BEAD_PADDING_X`（=-10，
 *     位置 = 文字包围盒左缘 + (-10)，只写一次不重复叠加）、`refHeight: null`/`refY: null`
 *     （关掉默认的"跟随文字高度/纵向相对定位"，高度与垂直位置改由下面 body 的普通属性给）、
 *     `rx`/`ry` 不变。
 *   - `body`：视觉属性之外补两个**普通**（非 ref）几何属性——`y: -NAME_BEAD_HEIGHT/2`（文字
 *     textVerticalAnchor:'middle' 时纵向中心即标签坐标原点 y=0，胶囊高度固定不需要相对定位，
 *     直接给绝对值更简单可靠）、`height: NAME_BEAD_HEIGHT`；**不**给 `x`/`width`（交给
 *     `rect` 的 `refX`/`refWidth` 算）。
 * 合并后落在 `<rect>` 元素上的 attrs：`refHeight`/`refY` 为 `null`（覆盖成功，不残留 default 的
 * 1/0）、无任何 `*2` 系列键、`y`/`height` 是我们给的绝对值、无 `x`/`width` 字面量（交给 ref 计算）。
 */
function buildMarkerLabelConfig(marker: EdgeConditionMarker, palette: CanvasPalette = LIGHT_PALETTE): MarkerLabelConfig {
  if (marker.kind === 'name' || marker.kind === 'endflow') {
    // 'name'：复用 conditionConfigured 语义色（见上方函数头注释"🔴"一节），白底 + 主色描边 + 主色
    // 文字。'endflow'（「不通过并结束流程」装饰虚线上的按钮名标签）：同一套胶囊几何（同一份 ref
    // 配方，不另起一份），只把描边/文字换成危险色 palette.semantic.danger，与该装饰线同色；不带
    // tooltip（marker.tooltip 为空串），onEdgeLabelRendered 不会为它挂悬停监听。
    const tokens =
      marker.kind === 'endflow'
        ? { stroke: palette.semantic.danger, text: palette.semantic.danger }
        : palette.markers.conditionConfigured;
    return {
      position: 0.5,
      tooltip: marker.tooltip,
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'text', selector: 'label' }
      ],
      attrs: {
        body: {
          // 普通（非 ref）几何属性：高度固定、垂直居中，不需要相对文字包围盒计算，直接给绝对值
          // （见函数头注释"🔴 ref 配方"一节）；不给 x/width，交给下面 rect 的 ref 属性算。
          y: -NAME_BEAD_HEIGHT / 2,
          height: NAME_BEAD_HEIGHT,
          fill: palette.surface,
          stroke: tokens.stroke,
          strokeWidth: 1,
          // 同 condition/else/button 三态一致的阴影手法。
          style: { filter: `drop-shadow(0 1px 4px ${palette.shadow})` }
        },
        // 与上面 body 是同一个 DOM 元素、但走的是 X6 默认按标签名 'rect' 命中的那条合并链路
        // （见函数头注释"🔴 ref 配方"）——这里专门覆盖 X6 Edge.defaultLabel.attrs.rect
        // 的全部 ref* 字段：每个轴只保留一个位置属性（refX）、一个尺寸属性（refWidth），不同时给
        // refX/refX2（会被累加两次）或 refHeight/refHeight2（setWrapper 对非 [0,1] 值算的是
        // "值+文字尺寸"，不是绝对值）；refHeight/refY 显式设 null 确定性关掉
        // 默认的"跟随文字高度/纵向相对定位"（改由上面 body 的普通 y/height 给）。
        rect: {
          ref: 'label',
          refWidth: NAME_BEAD_PADDING_X * 2,
          refX: -NAME_BEAD_PADDING_X,
          refHeight: null,
          refY: null,
          rx: NAME_BEAD_HEIGHT / 2,
          ry: NAME_BEAD_HEIGHT / 2
        },
        label: {
          text: marker.shortLabel,
          fill: tokens.text,
          fontSize: 12,
          fontWeight: 600,
          // 没有 button 态那颗圆点占位，文字直接在胶囊内水平垂直居中（锚点即胶囊中心，见函数头
          // 注释"三者共同十字线对齐锚点"一段）。
          textAnchor: 'middle',
          textVerticalAnchor: 'middle'
        }
      }
    };
  }

  // 🔴 踩坑提醒（见上方函数头注释"🔴 ref 配方"）：下面
  // 这个 'button' 分支的 body 同样只在 'body' key 下给了绝对 x/y/width/height，没有同名
  // 'rect' key 覆盖 X6 Edge.defaultLabel.attrs.rect 的 ref/refWidth:1/refHeight:1/refX:0/
  // refY:0——理论上同款会中招（外壳被相对文字包围盒的默认定位顶掉）。当前没有任何调用方产出
  // kind==='button'（见 designer/graph-bridge.ts toGraphEdges 与 port.ts
  // EdgeConditionMarker.kind 注释），无法在实际渲染中验证，因此暂不改动，只留注释指路。启用前请
  // 完整按 'name' 分支的 ref 配方（每轴一个位置属性、每维度一个尺寸属性、null 关默认值）处理，
  // 不要用"*2 键叠加绝对值修正量"的写法。
  if (marker.kind === 'button') {
    const tokens = palette.markers.button;
    const dotColor = marker.buttonColor ?? palette.markers.else.stroke;
    const textWidth = marker.shortLabel.length * BUTTON_BEAD_CHAR_WIDTH;
    const capsuleWidth = BUTTON_BEAD_PADDING_X * 2 + BUTTON_BEAD_DOT_SIZE + BUTTON_BEAD_DOT_GAP + textWidth;
    const halfWidth = capsuleWidth / 2;
    return {
      position: 0.5,
      tooltip: marker.tooltip,
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'circle', selector: 'dot' },
        { tagName: 'text', selector: 'label' }
      ],
      attrs: {
        body: {
          x: -halfWidth,
          y: -BUTTON_BEAD_HEIGHT / 2,
          width: capsuleWidth,
          height: BUTTON_BEAD_HEIGHT,
          rx: BUTTON_BEAD_HEIGHT / 2,
          ry: BUTTON_BEAD_HEIGHT / 2,
          fill: palette.surface,
          stroke: tokens.stroke,
          strokeWidth: 1,
          // 同 condition/else 珠一致的阴影手法（见下方分支 body.style），三态视觉统一。
          style: { filter: `drop-shadow(0 1px 4px ${palette.shadow})` }
        },
        dot: {
          cx: -halfWidth + BUTTON_BEAD_PADDING_X + BUTTON_BEAD_DOT_SIZE / 2,
          cy: 0,
          r: BUTTON_BEAD_DOT_SIZE / 2,
          fill: dotColor,
          stroke: 'none'
        },
        label: {
          text: marker.shortLabel,
          fill: tokens.text,
          fontSize: 11.5,
          fontWeight: 600,
          x: -halfWidth + BUTTON_BEAD_PADDING_X + BUTTON_BEAD_DOT_SIZE + BUTTON_BEAD_DOT_GAP,
          textAnchor: 'start',
          textVerticalAnchor: 'middle'
        }
      }
    };
  }

  // condition/else 两态：22×22 正圆，白底 + 描边 + 文字三色（design-tokens.ts
  // CanvasPalette.markers，主题感知版 MARKER_TOKENS）。
  const isCondition = marker.kind === 'condition';
  const tokens = isCondition
    ? marker.configured
      ? palette.markers.conditionConfigured
      : palette.markers.conditionUnconfigured
    : palette.markers.else;
  return {
    position: 0.5,
    tooltip: marker.tooltip,
    markup: [
      { tagName: 'circle', selector: 'body' },
      { tagName: 'text', selector: 'label' }
    ],
    attrs: {
      body: {
        r: 11,
        fill: palette.surface,
        stroke: tokens.stroke,
        strokeWidth: 1.5,
        // 阴影（"0 1px 4px"柔和投影）：drop-shadow 方式同节点选中态光晕（见 applyNodeVisual 头
        // 注释）——SVG 没有 box-shadow 那种"扩散但不模糊"的效果，drop-shadow 的模糊半径是可行范围
        // 内最接近的近似。阴影色取 palette.shadow。
        style: { filter: `drop-shadow(0 1px 4px ${palette.shadow})` }
      },
      label: {
        text: marker.shortLabel,
        fill: tokens.text,
        fontSize: isCondition ? 11 : 10,
        fontWeight: isCondition ? 700 : 600,
        // fx 珠：Georgia 衬线斜体；默珠：不设置 fontFamily/fontStyle——正体，继承画布默认字体、
        // 不额外指定。
        ...(isCondition ? { fontFamily: 'Georgia, serif', fontStyle: 'italic' } : {})
      }
    }
  };
}

/**
 * applyEdgeVisual —— 把一个 GraphEdgeView 的全部视觉状态（source/target 连接点、line 的
 * stroke/strokeWidth/strokeDasharray、labels）施加到一个已存在的 X6 边上。**创建分支
 * （addEdge 之后）与更新分支共用同一份实现**，理由同 applyNodeVisual：若更新分支单独实现，
 * 容易漏掉 position/颜色/描边等标签属性，或 isElseRoute 的虚线、hasIssues 的红线加粗在更新时
 * 不刷新。
 *
 * ports（source/target 挂的具体 port id）由调用方算好传入——它由 terminalPorts() 依据节点
 * 位置图推导，不是 GraphEdgeView 自身携带的字段，因此不适合放进本函数内部计算。
 *
 * 连线标识：line 在条件分支时走蓝线，hasIssues 的红色描边仍然优先于蓝色（校验错误比
 * "这是条件分支"这件事更需要被看见）。labels 只在 marker 存在且不是 'none' 态时渲染一条标记珠。
 * 🔴 "是否条件分支"读 GraphEdgeView.hasCondition 这个独立字段，不读 marker.kind——marker 只表达
 * "名称珠"（'name'/'none' 两态，见 port.ts EdgeConditionMarker 头注释），一条配了条件但没起名字
 * 的线 marker 是 'none'，但线仍要走蓝色。是否画珠（labels）和线是否走蓝色（stroke）是两件互不
 * 影响的事。
 *
 * palette 参数（暗色支持）：末位参数，默认值 LIGHT_PALETTE，原样透传给 buildMarkerLabelConfig。
 */
export function applyEdgeVisual(
  cell: EdgeVisualCell,
  view: GraphEdgeView,
  ports: { source: string; target: string },
  palette: CanvasPalette = LIGHT_PALETTE
): void {
  // 把业务边身份直接写到 X6 根 <g>，供浏览器自动化按真实模型身份定位。三个属性均来自
  // GraphEdgeView，不从几何、标签或 DOM 顺序反推；applyEdgeVisual 同时服务首次创建与每次
  // setEdges 更新，因此端点变化后 from/to 身份也会同步刷新，不残留旧值。
  cell.attr('root/data-edge-id', view.id);
  cell.attr('root/data-from-node-id', view.from);
  cell.attr('root/data-to-node-id', view.to);
  cell.setSource({ cell: view.from, port: ports.source });
  cell.setTarget({ cell: view.to, port: ports.target });
  if (view.decorative) {
    // 只读装饰边（审批按钮「不通过并结束流程」→ 结束节点的示意线）：危险色虚线 +
    // 同规格箭头 + 线上按钮名标签。root 上 pointer-events:none 让它对鼠标完全透明（点不中、拖
    // 不动、右键无菜单，标签胶囊也一并继承），配合 Graph.interacting / Selection.filter /
    // 各事件处理器里的 decorative 过滤形成多重保险；data-decorative 供浏览器自动化区分。
    // 视觉上不读 hasIssues/hasCondition/isElseRoute——装饰边不参与校验与选路。
    cell.attr('root/data-decorative', 'true');
    cell.attr('root/style/pointerEvents', 'none');
    cell.attr('line', {
      stroke: palette.semantic.danger,
      strokeWidth: 1.5,
      strokeDasharray: '6 4',
      targetMarker: { name: 'path', d: 'M10 0 L0 4 L10 8 Z', width: 9, height: 7 }
    });
    cell.setLabels(view.marker && view.marker.kind !== 'none' ? [buildMarkerLabelConfig(view.marker, palette)] : []);
    return;
  }
  const isConditionRoute = Boolean(view.hasCondition);
  cell.attr('line', {
    // 默认线色/线宽 palette.edge/1.8px；条件边品牌蓝 palette.primary；hasIssues 红
    // （palette.validationError）加粗；else 路线虚线。
    stroke: view.hasIssues ? palette.validationError : isConditionRoute ? palette.primary : palette.edge,
    strokeWidth: view.hasIssues ? 2.2 : 1.8,
    strokeDasharray: view.isElseRoute ? '6 4' : '',
    // 自定义箭头：等腰三角形 path，marker 视口 9×7（不用内置 'block' 预设）。
    // 🔴 尖端必须画在 d 的"低 x"一侧（M10 0 L0 4 L10 8，尖端在 x=0）。原因是
    // X6 registry/attr/marker.ts 的 targetMarker 定义对 marker-end 无条件叠加了一次
    // `transform:'rotate(180)'`（target 场景专属、source 没有），配合 X6 生成的
    // <marker orient="auto">让局部 +x 轴与线段前进方向对齐，若尖端画在"高 x"一侧（如
    // M0 0 L10 4 L0 8，尖端在 x=10），会被这记内置 180° 翻转成尖端指向 -x（逆着前进方向），
    // 表现为箭头反指。旁证：X6 内置 classic/block 预设（marker/classic.ts）尖端同样固定画在
    // x=0 这一侧，正是为了吃这记内置翻转。
    targetMarker: { name: 'path', d: 'M10 0 L0 4 L10 8 Z', width: 9, height: 7 }
  });
  cell.setLabels(view.marker && view.marker.kind !== 'none' ? [buildMarkerLabelConfig(view.marker, palette)] : []);
}

export interface BlockContainerBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * computeBlockContainerBBox —— 展开态下，容器需要包住的几何范围：全部成员节点当前位置的
 * 包围盒 + 四周留白（BLOCK_CONTAINER_PADDING）+ 顶部预留头部行高度（BLOCK_HEADER_HEIGHT）。
 * 抽成纯函数是让这段包围盒计算在单测里可验证的唯一方式（同 computeCenterTranslate 的既定
 * 手法），setBlocks() 内部只用它算出目标值再落到 cell 上。
 *
 * memberRects 为空（理论上不应发生——展开态的 GraphBlockView.memberNodeIds 至少含 split/join
 * 两个节点；调用方传参有误或成员尚未渲染时的防御性兜底）时退回一个以 fallbackAnchor 为中心的
 * 最小默认框，不产生 NaN/负宽高。
 */
export function computeBlockContainerBBox(
  memberRects: Array<{ x: number; y: number; width: number; height: number }>,
  fallbackAnchor: { x: number; y: number },
  obstacleRects: Array<{ x: number; y: number; width: number; height: number }> = []
): BlockContainerBBox {
  if (memberRects.length === 0) {
    return {
      x: fallbackAnchor.x - BLOCK_CONTAINER_PADDING,
      y: fallbackAnchor.y - BLOCK_HEADER_HEIGHT,
      width: BLOCK_COLLAPSED_WIDTH + BLOCK_CONTAINER_PADDING * 2,
      height: BLOCK_COLLAPSED_HEIGHT + BLOCK_HEADER_HEIGHT + BLOCK_CONTAINER_PADDING
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of memberRects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  const left = minX - BLOCK_CONTAINER_PADDING;
  const right = maxX + BLOCK_CONTAINER_PADDING;
  // 头部默认紧贴成员最上沿；若此 40px 带与任何非成员节点（向外扩 8px，含 ports）相交，
  // 将整条头部带移到该障碍上方。循环处理上移后新遇到的障碍，最多每个障碍推动一次，结果与
  // obstacleRects 输入顺序无关。成员节点不在 obstacleRects 中，仍由既有 10px 控件底部留白保护。
  let headerBottom = minY;
  for (let i = 0; i <= obstacleRects.length; i++) {
    const headerTop = headerBottom - BLOCK_HEADER_HEIGHT;
    const blockers = obstacleRects.filter((rect) => {
      const obstacleLeft = rect.x - BLOCK_HEADER_OBSTACLE_CLEARANCE;
      const obstacleRight = rect.x + rect.width + BLOCK_HEADER_OBSTACLE_CLEARANCE;
      const obstacleTop = rect.y - BLOCK_HEADER_OBSTACLE_CLEARANCE;
      const obstacleBottom = rect.y + rect.height + BLOCK_HEADER_OBSTACLE_CLEARANCE;
      return obstacleLeft < right && obstacleRight > left && obstacleTop < headerBottom && obstacleBottom > headerTop;
    });
    if (blockers.length === 0) break;
    const nextBottom = Math.min(...blockers.map((rect) => rect.y - BLOCK_HEADER_OBSTACLE_CLEARANCE));
    if (nextBottom >= headerBottom) break;
    headerBottom = nextBottom;
  }
  const top = headerBottom - BLOCK_HEADER_HEIGHT;
  return {
    x: left,
    y: top,
    width: maxX - minX + BLOCK_CONTAINER_PADDING * 2,
    height: maxY + BLOCK_CONTAINER_PADDING - top
  };
}

// ------------------------------------------------------------------
// 泳道插槽拖入几何判定——纯函数，同 computeBlockContainerBBox 的既定手法（可脱离真实 Graph
// 单测）。当前节点模型没有分支结构块概念，这组函数暂无真实消费方，保留仅为可编译。
// ------------------------------------------------------------------

/** 每条路线的一个空档带高度（空路线没有真实成员可测时的"预留带"，见 computeRouteBands 注释）。
 * 与 designer/layout.ts computeRouteLanes 的"泳道偏移量＝路线序号 × ROW_HEIGHT（120）"同一个
 * 思路、同一个数值——本文件不 import 该私有函数，独立声明一份同构
 * 常量，保证"自动布局"产出的路线间距与本文件独立实现的空路线预留带精确对齐，不会出现拖拽
 * 判定带与自动布局摆位对不上的错位。 */
const ROUTE_BAND_HEIGHT = 120;
/** 非空路线量出的实际 y 范围前后各加的半间距，避免贴边落点被判定失配（拖到路线内某节点的
 * 上边缘正上方几像素处也应算命中这条路线，而不是掉进"两条路线之间"的空隙）。 */
const ROUTE_BAND_GAP = 16;

/** computeRouteBands 单条路线的输入：由调用方（matchRouteAtPoint）从当前 nodeViews 量出，
 * 本类型不携带任何 X6/GraphNodeView 依赖，保持 computeRouteBands 是纯几何函数。 */
export interface RouteBandInput {
  branchId: string;
  /** 该路线现有成员节点的 y 范围（顶部/底部像素坐标，取节点 position.y 与 position.y+height
   * 的并集极值）；路线为空传 undefined。 */
  memberYRange: { minY: number; maxY: number } | undefined;
}

export interface RouteBand {
  branchId: string;
  yMin: number;
  yMax: number;
}

/**
 * computeRouteBands —— 泳道插槽拖入核心几何判定：给定一个结构块 split 节点当前 y 与
 * 各路线的成员 y 范围（routes，调用方须已按 BranchRoute.order 升序排好），算出每条路线在容器内
 * 的"泳道带"（y 区间）——拖拽落点落在哪个区间即归属哪条路线，失配（不落在任何区间）由调用方
 * matchRouteBandAtY 判定并拒绝。
 *
 * 算法：
 *   - 非空路线（memberYRange 有值）：按字面"该路线现有节点链的 y 范围"实现——区间 =
 *     [minY - ROUTE_BAND_GAP, maxY + ROUTE_BAND_GAP]。
 *   - 空路线：没有真实成员可测，退化为"预留带"——以 split 节点当前 y 为基准，按该路线在入参
 *     数组里的序号（laneIndex，调用方已排好序）乘以 ROUTE_BAND_HEIGHT 得到预留区间的中心，
 *     高度同样是 ROUTE_BAND_HEIGHT（见该常量注释"与 designer/layout.ts 同一思路"）。
 *
 * 返回顺序＝入参顺序，不重新排序——纯计算职责单一，排序是调用方的事。
 */
export function computeRouteBands(splitY: number, routes: RouteBandInput[]): RouteBand[] {
  return routes.map((route, laneIndex) => {
    if (route.memberYRange) {
      return {
        branchId: route.branchId,
        yMin: route.memberYRange.minY - ROUTE_BAND_GAP,
        yMax: route.memberYRange.maxY + ROUTE_BAND_GAP
      };
    }
    const center = splitY + laneIndex * ROUTE_BAND_HEIGHT;
    return { branchId: route.branchId, yMin: center - ROUTE_BAND_HEIGHT / 2, yMax: center + ROUTE_BAND_HEIGHT / 2 };
  });
}

/**
 * matchRouteBandAtY —— 给定一组泳道带与拖拽落点 y，返回命中的 branchId；落点不落在任何带内
 * （容器留白/头部区域）时返回 undefined（"失配则拒绝"，见 embedding.validate 消费处）。落点
 * 同时落入多条带（用户手动把节点挪到未对齐泳道网格的位置，导致带重叠）时按数组顺序取第一个
 * 命中——不做"更接近哪条带中心"的复杂优选（简化实现）。
 */
export function matchRouteBandAtY(bands: RouteBand[], y: number): string | undefined {
  for (const band of bands) {
    if (y >= band.yMin && y <= band.yMax) return band.branchId;
  }
  return undefined;
}

/**
 * resolveInsertAfterNodeId —— 泳道插槽拖入落点在路线内部的插入序判定。chain 是目标路线现有
 * 成员的 {nodeId, x} 列表（顺序不要求，本函数内部会先按 x 升序排序）——用 x 坐标近似"节点链序"
 * 而不做真正的边拓扑遍历（简化：真实链序需要沿边走一遍图，多一层遍历成本；对当前"路线内容
 * 基本是从左到右摆放"的实际画布场景——无论走自动布局还是手动拖拽，x 递增方向对齐"流程前进方向"
 * 这一贯穿全文件的既定视觉语义，见 designer/layout.ts 文件头注释——x 排序结果与真实拓扑序恒
 * 一致；只有用户把某个节点手动拖到"视觉乱序"位置时两者才可能不同，此时按 x 排序仍能给出一个
 * 确定性的、符合"这一刻画布上看起来的顺序"的结果，不算错误只是口径不同）。
 *
 * 返回 chain 中"x 小于等于落点 x"的最后一个节点 id；一个都没有（chain 为空，或落点比链上第一个
 * 节点还靠左）时返回 null，表示插入到路线最前端。
 */
export function resolveInsertAfterNodeId(chain: Array<{ nodeId: string; x: number }>, dropX: number): string | null {
  const sorted = [...chain].sort((a, b) => a.x - b.x || a.nodeId.localeCompare(b.nodeId));
  let after: string | null = null;
  for (const item of sorted) {
    if (item.x <= dropX) after = item.nodeId;
    else break;
  }
  return after;
}

/**
 * computeCenterTranslate —— 给定目标点（cell 中心，local/paper 坐标）、当前缩放与画布容器尺寸，
 * 算出让该点落在容器正中央所需的 translate(tx, ty)（供 centerOn(nodeId)，如点击校验问题定位到节点）。
 *
 * 抽成纯函数、不直接调用 X6 内置的 Graph.centerCell/positionPoint：happy-dom 环境下 X6 的
 * TransformManager 无法把计算结果写回可读的 DOM 变换矩阵——即便直接调用
 * `graph.translate(tx, ty)`，随后的 `graph.translate()`（读）与 DOM `transform` 属性都仍是初始
 * 单位矩阵（同 x6-adapter.visual.test.ts 头注释"X6 Graph 挂载依赖真实 DOM 布局测算，
 * happy-dom 环境下代价大且脆"）。抽出这个纯函数是让"定位到节点"这件事在单测里
 * 可验证的唯一方式（同 applyNodeVisual/applyEdgeVisual 的既定手法），centerOn() 内部只用它算出
 * 目标值、再调用一次 `graph.translate(tx, ty)`——与 X6 自身 positionPoint 的公式等价
 * （`translate = containerCenter - point * scale`，见 @antv/x6 transform.js positionPoint）。
 */
export function computeCenterTranslate(
  target: { x: number; y: number },
  scale: number,
  containerSize: { width: number; height: number }
): { tx: number; ty: number } {
  return {
    tx: containerSize.width / 2 - target.x * scale,
    ty: containerSize.height / 2 - target.y * scale
  };
}

type HandlerMap = { [K in keyof GraphPortEvents]: Set<GraphPortEvents[K]> };

export interface X6GraphMessages {
  renamePrompt: string;
  rename: string;
  copy: string;
  delete: string;
  editVertices: string;
  clearVertices: string;
  deleteEdge: string;
  paste: string;
  fit: string;
  zoom100: string;
}

function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return target.isContentEditable || target.matches('input, textarea, select');
}

/** palette 参数（暗色支持）：末位参数，默认值 LIGHT_PALETTE。stroke（品牌蓝）在 palette.primary
 * 亮暗恒定，不随主题变化；fill 读 palette.surface，X6GraphAdapter.setPalette() 切主题时
 * 会对已渲染节点的四个端口逐一重设这个 fill（见该方法注释）。 */
function portGroups(palette: CanvasPalette = LIGHT_PALETTE) {
  const circle = {
    r: 5,
    magnet: true,
    // 品牌蓝唯一档。
    stroke: palette.primary,
    strokeWidth: 1.5,
    fill: palette.surface,
    style: { visibility: 'hidden' as const }
  };
  return {
    groups: {
      top: { position: 'top', attrs: { circle } },
      right: { position: 'right', attrs: { circle } },
      bottom: { position: 'bottom', attrs: { circle } },
      left: { position: 'left', attrs: { circle } }
    },
    items: ['top', 'right', 'bottom', 'left'].map((group) => ({ id: `port-${group}`, group }))
  };
}

/** 当前文档没有 port 字段，先按节点相对方位确定四向定点胶水；layout 契约落地后再保真用户选桩。 */
function terminalPorts(edge: GraphEdgeView, nodes: Map<string, GraphNodeView>): { source: string; target: string } {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  if (!from || !to) return { source: 'port-right', target: 'port-left' };
  const dx = to.position.x - from.position.x;
  const dy = to.position.y - from.position.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { source: 'port-right', target: 'port-left' }
      : { source: 'port-left', target: 'port-right' };
  }
  return dy >= 0
    ? { source: 'port-bottom', target: 'port-top' }
    : { source: 'port-top', target: 'port-bottom' };
}

export class X6GraphAdapter implements GraphPort {
  private container: HTMLElement | null = null;
  private minimapContainer: HTMLElement | null = null;
  private graph: Graph | null = null;
  private nodeViews = new Map<string, GraphNodeView>();
  private edgeViews = new Map<string, GraphEdgeView>();
  /** 当前主题下的画布调色板——mount() 用它初始化
   * Graph 背景/网格/端口/预览线配色，setNodes/setEdges 创建 cell 时用它 apply 视觉，
   * setPalette() 切主题时更新它并对已渲染内容重绘（见该方法注释）。默认 LIGHT_PALETTE，保证
   * 调用方未传入主题调色板（或未挂载）时 adapter 自身行为确定。 */
  private palette: CanvasPalette = LIGHT_PALETTE;
  private readOnly = false;
  private syncingSelection = false;
  private clipboard: string[] = [];
  private moveStart = new Map<string, NodePosition>();
  private dragLeaderId: string | null = null;
  private applyingGroupMove = false;
  private syncingModel = false;
  private restoringLayout = false;
  private messages: X6GraphMessages;
  /** X6 会在 pointerup 自己的监听器里完成最后一次 snapline 修正，下一微任务再提交历史。 */
  private boundMovePointerUp = () => queueMicrotask(() => this.commitMoves());
  private contextMenu: HTMLDivElement | null = null;
  private selectionPlugin: Selection | null = null;
  private snaplinePlugin: Snapline | null = null;
  /** 小地图插件实例——mount() 时持有，供 refreshMinimapScale() 二次夹住其自动适配缩放比下限
   * （见该方法头注释）；未挂载小地图容器（DesignerCanvas.vue 未调 setMinimapContainer，如某些
   * 沙盒挂载场景）时始终为 null。 */
  private minimapPlugin: MiniMap | null = null;
  // —— 三开关：网格显隐（grid.visible，走既有 setGridVisible/isGridVisible，不新增状态）与
  // "吸附"/"参考线"两个独立能力。X6 语义下，拖拽落点吸附由 grid size 决定（size=1 等效关闭，是
  // 唯一正交的网格吸附旋钮，见 setSnapToGrid 注释）；参考线是 Snapline 插件整体启停。两者都需要
  // 一份"用户在工具条上的当前设定"（snapToGridEnabled/snaplineDesiredEnabled），与 Alt 精细对齐的
  // "临时压制"（fineAlignmentActive）分开记——Alt 只是按住期间临时把两者都压到"关"，松开后必须
  // 按用户各自的设定值还原，而不是无脑重新打开（否则用户按住 Alt 前已在工具条上手动关闭了参考线，
  // 松开 Alt 会违背用户意愿地把它重新打开），统一交给 refreshAlignmentAids() 收口，见其注释。
  private snapToGridEnabled = true;
  private snaplineDesiredEnabled = true;
  private fineAlignmentActive = false;
  /** 标尺（常驻）订阅方——viewport（scale/translate）变化的通知集合，见
   * getViewport/onViewportChange 注释。 */
  private viewportChangeHandlers = new Set<() => void>();
  private handlers: HandlerMap = {
    nodeSelect: new Set(),
    edgeSelect: new Set(),
    nodeMoveEnd: new Set(),
    connect: new Set(),
    selectionChange: new Set(),
    nodesMoveEnd: new Set(),
    deleteSelection: new Set(),
    undo: new Set(),
    redo: new Set(),
    save: new Set(),
    paste: new Set(),
    renameNode: new Set(),
    layoutChange: new Set(),
    edgeMarkerHover: new Set(),
    edgeMarkerLeave: new Set()
  };

  /** 节点重命名的输入回调：本类是纯 TS 类，不依赖宿主总线，由持有者（DesignerCanvas）
   * 经构造参数注入；返回用户输入的新名称，取消返回 null。未注入时重命名不可用（不回退原生 prompt）。 */
  private promptRename?: (current: string) => Promise<string | null>;

  constructor(messages: X6GraphMessages, options?: { promptRename?: (current: string) => Promise<string | null> }) {
    this.messages = { ...messages };
    this.promptRename = options?.promptRename;
  }

  setMessages(messages: Partial<X6GraphMessages>): void {
    this.messages = { ...this.messages, ...messages };
  }

  setMinimapContainer(container: HTMLElement): void {
    this.minimapContainer = container;
  }

  mount(container: HTMLElement): void {
    if (this.graph) throw new Error('[graph/x6-adapter] already mounted');
    this.container = container;
    const graph: Graph = new Graph({
      container,
      autoResize: true,
      // 画布底色 palette.canvasBg、16px 点阵、点色 palette.gridDot。读 this.palette（挂载时的
      // 当前主题）——mount() 只在 Graph 构造这一刻生效一次，之后主题切换由 setPalette() 调用
      // graph.drawBackground()/drawGrid() 重绘（X6 官方 API，同这里构造 Graph 时用的同一套配置项），
      // 不是本处响应式。
      // 🔴 size 按 this.snapToGridEnabled 取初值（默认 true→16；mount() 之前调过
      // setSnapToGrid(false) 时为 1，见类字段注释）。
      background: { color: this.palette.canvasBg },
      grid: { visible: true, size: this.snapToGridEnabled ? 16 : 1, type: 'dot', args: { color: this.palette.gridDot, thickness: 1 } },
      mousewheel: {
        enabled: true,
        modifiers: ['ctrl', 'meta'],
        zoomAtMousePosition: true,
        factor: 1.1,
        minScale: 0.2,
        maxScale: 4
      },
      panning: { enabled: false },
      // 装饰边（只渲染不入库）对任何交互关闭：不能拖动/改端点/加顶点。
      interacting: (cellView) => !this.readOnly && !this.isDecorativeEdge(cellView.cell.id),
      connecting: {
        snap: { radius: 60 },
        allowBlank: false,
        allowLoop: false,
        allowNode: true,
        allowEdge: false,
        allowMulti: false,
        highlight: true,
        connectionPoint: 'anchor',
        router: { name: 'manhattan', args: { padding: 18, step: 10 } },
        connector: { name: 'rounded', args: { radius: 8 } },
        validateConnection: ({ sourceCell, targetCell }) => {
          if (!sourceCell || !targetCell || sourceCell.id === targetCell.id) return false;
          const source = this.nodeViews.get(sourceCell.id);
          const target = this.nodeViews.get(targetCell.id);
          return source?.type !== 'end' && target?.type !== 'start';
        },
        createEdge: (): Edge =>
          graph.createEdge({
            zIndex: 0,
            attrs: {
              // 拖拽连线时的预览线——同 applyEdgeVisual 的品牌蓝/自定义箭头规格，两处保持
              // 一致。d 的尖端朝向见 applyEdgeVisual 里 targetMarker 那处注释（X6 targetMarker
              // 内置 rotate(180) 的方向约定）。
              // createEdge 是回调函数，每次拖拽连线都重新求值，因此 this.palette.primary 天然
              // 读到调用当时的主题（不需要 setPalette() 额外处理这一处）。
              line: {
                stroke: this.palette.primary,
                strokeWidth: 1.8,
                targetMarker: { name: 'path', d: 'M10 0 L0 4 L10 8 Z', width: 9, height: 7 }
              }
            }
          })
      },
      // 磁吸高亮描边色——品牌蓝 palette.primary 在亮暗两档恒定（buildPalette 的硬规则，见
      // design-tokens.ts 该字段注释），这里在 mount() 这一刻取值即可，不需要 setPalette() 重设。
      highlighting: {
        magnetAdsorbed: { name: 'stroke', args: { padding: 4, attrs: { stroke: this.palette.primary, strokeWidth: 2 } } }
      },
      // 标记珠悬停：X6 没有 label 级别的 mouseenter/mouseleave 事件
      // （graph/view.js 的事件委托只绑到 `.x6-cell` 这一级，整条边共用，无法区分"悬停到了标记
      // 珠"还是"悬停到了普通线段"），edge:mouseenter 这类事件因此不可用。
      // onEdgeLabelRendered 是 X6 提供的另一个钩子（Graph 构造选项，见 @antv/x6
      // graph/options.d.ts OnEdgeLabelRenderedArgs）：每次标记珠的 DOM 被（重新）渲染时回调一次
      // （edge.js customizeLabels()），拿到真实的珠子 DOM 元素（selectors.body，circle 或
      // name/button 态的 rect——name 态的 ref* 定位字段不改变 markup 里的 selector 'body'，
      // selectors.body 照常取到同一个元素）与其所属的
      // label 配置对象，天然是"珠子级别"的粒度——在这里绑定原生
      // mouseenter/mouseleave 监听器，是最贴近"label 级事件"的可行路径。返回值
      // 是销毁函数：edge.js 的 onLabelsChange() 每次都先调用它清理上一轮监听器、再重新渲染，
      // 与 applyEdgeVisual() 每次 setLabels() 都传全新数组（触发 shouldRerenderLabels() 恒
      // true，见 @antv/x6 model/edge.js）的调用节奏天然匹配，不会产生重复绑定或监听器泄漏。
      //
      // 只上报"悬停这一事实"（进入/离开 + 珠子当前几何位置 + tooltip 原文）：clientX/clientY 取
      // 珠子自身 body 元素 getBoundingClientRect() 的横向中点/顶部（不是鼠标指针坐标）——"跟随
      // 珠子定位（珠子上方居中）"要求气泡锚定珠子本身，用鼠标坐标会导致气泡随指针在珠子内部
      // 移动而抖动。真正"300ms 后出现"的计时器与浮层渲染都在消费方
      // designer/canvas/DesignerCanvas.vue，本文件不持有任何计时器。
      onEdgeLabelRendered: ({ edge, label, container, selectors }) => {
        const bodyEntry = selectors.body;
        const target = (Array.isArray(bodyEntry) ? bodyEntry[0] : bodyEntry) ?? container;
        const tooltip = (label as { tooltip?: string }).tooltip ?? '';
        if (!tooltip) return undefined; // 无文案（理论不会发生——buildMarkerLabelConfig 恒带 tooltip）不挂监听
        const handleEnter = () => {
          const rect = target.getBoundingClientRect();
          this.emit('edgeMarkerHover', edge.id, rect.left + rect.width / 2, rect.top, tooltip);
        };
        const handleLeave = () => this.emit('edgeMarkerLeave');
        target.addEventListener('mouseenter', handleEnter);
        target.addEventListener('mouseleave', handleLeave);
        return () => {
          target.removeEventListener('mouseenter', handleEnter);
          target.removeEventListener('mouseleave', handleLeave);
        };
      }
    });
    this.graph = graph;
    graph.use(new Keyboard({ enabled: true, global: false }));
    // Selection 配置说明（strict/rubberband/multiple 三项与分支结构块容器的关系）：
    //   - strict:false（部分相交即选中）：容器是一个大矩形，框选时很容易"部分覆盖"到它，若改成
    //     true 反而更难通过框选选中容器本身，不利于"点击容器边缘/头部选中整块"的临近操作习惯；
    //   - rubberband:true / multiple:true：容器与其内部成员是两个独立的可选中 cell（容器不消费
    //     选中框选逻辑本身，只是多了一个可被选中的大矩形），不影响多选语义；
    //   - movable:true 对应的手写群移在 node:moving 里已按"跳过 leader 的子孙节点"处理容器/成员
    //     的位移冲突，见该处理器注释。
    // 🔴 showNodeSelectionBox 为 false：节点选中态视觉由节点卡自身描边换色 + 光晕 + 四角手柄 +
    // 四端口承担（applyNodeVisual/applySelectionHandles），若再叠加插件默认的虚线选框，两套选中态
    // 视觉会互相打架（虚线框 + 描边叠在一起），因此关掉默认选框，只保留 showEdgeSelectionBox（边的
    // 选中态视觉仍用插件选框；宿主侧另有 `.x6-widget-selection-box{pointer-events:none}` 规则遮掉
    // 选框交互，见 DesignerCanvas.vue）。
    // 🔴 指针手势：框选为「按住 Ctrl / ⌘ 再拖动空白处」（更贴近普通用户习惯），
    // 直接拖动空白处交给 bindPanning() 做画布平移。modifiers 传数组即「任一按下即匹配」
    // （@antv/x6-common ModifierKey.isMatch 对数组走 or 分支）——未按修饰键时
    // Selection 插件的 onBlankMouseDown 不会起框选，与平移手势天然互斥，不需要再靠
    // disableRubberband()/enableRubberband() 临时开关。
    this.selectionPlugin = new Selection({
      enabled: true,
      multiple: true,
      rubberband: true,
      modifiers: ['ctrl', 'meta'],
      movable: true,
      strict: false,
      multipleSelectionModifiers: ['ctrl', 'meta', 'shift'],
      showNodeSelectionBox: false,
      showEdgeSelectionBox: true,
      // 装饰边永远不可选中：点击/框选/setSelection 都经此过滤。
      filter: (cell) => !this.isDecorativeEdge(cell.id)
    });
    graph.use(this.selectionPlugin);
    // 🔴 enabled 同上一处 grid.size 一样按 this.snaplineDesiredEnabled 取初值。
    this.snaplinePlugin = new Snapline({ enabled: this.snaplineDesiredEnabled, sharp: true, tolerance: 8 });
    graph.use(this.snaplinePlugin);
    if (this.minimapContainer) {
      // 🔴 minScale/maxScale 这两项构造参数只作用于"拖拽小地图缩放手柄改变主画布缩放"这一个
      // 交互（@antv/x6-plugin-minimap 源码 doAction() 的 'zooming' 分支唯一读取它们的地方），
      // 跟"小地图自动把全部内容适配进 176×88 视口"这件事完全无关——自动适配
      // 靠 sourceGraph 的 model:updated/resize 事件分别触发插件内部 onModelUpdated()/
      // updatePaper()，两者末尾都调用不带任何参数的 targetGraph.zoomToFit()，因此这两个数字
      // 对"内容很小时缩得看不清"没有约束力，保留只是给"拖拽缩放手柄"这个交互一组取值；真正的
      // 下限在 refreshMinimapScale()（见其头注释）。
      const minimap = new MiniMap({
        container: this.minimapContainer,
        // 小地图规格：宽 176 / 本体高 88（外层另有 28px 头部条）。
        width: 176,
        height: 88,
        padding: 8,
        minScale: 0.01,
        maxScale: 1
      });
      graph.use(minimap);
      this.minimapPlugin = minimap;
    }
    this.bindGraphEvents(graph);
    this.bindKeyboard(graph);
    this.bindPanning(graph);
    this.setNodes([...this.nodeViews.values()]);
    this.setEdges([...this.edgeViews.values()]);
  }

  private bindGraphEvents(graph: Graph): void {
    graph.on('node:mounted', ({ node, view }: { node: Node; view: { container: Element } }) => {
      const type = this.nodeViews.get(node.id)?.type;
      view.container.setAttribute('data-node-id', node.id);
      if (type) view.container.setAttribute('data-node-type', type);
    });
    graph.on('edge:mounted', ({ edge, view }: { edge: Edge; view: { container: Element } }) => {
      const edgeView = this.edgeViews.get(edge.id);
      view.container.setAttribute('data-edge-id', edge.id);
      if (edgeView) {
        view.container.setAttribute('data-from-node-id', edgeView.from);
        view.container.setAttribute('data-to-node-id', edgeView.to);
      }
    });
    // 🔴 四个圆形连接点（ports）只认"指针有没有悬停在该节点上"这一个判据，选中态不豁免：
    // 选中 ≠ 常显端口，只有真的悬停才显示、离开即隐藏（选中后端口常显会与四角方形选中手柄叠在
    // 一起显得杂乱）。
    graph.on('node:mouseenter', ({ node }) => {
      for (const port of node.getPorts()) node.setPortProp(port.id!, 'attrs/circle/style/visibility', 'visible');
    });
    graph.on('node:mouseleave', ({ node }) => {
      for (const port of node.getPorts()) node.setPortProp(port.id!, 'attrs/circle/style/visibility', 'hidden');
    });
    // 画布双击节点不弹名称编辑框：改名只保留右键菜单「重命名」这一个入口，
    // 这里刻意不绑 'node:dblclick'，避免日后被当成遗漏补回来。
    graph.on('node:contextmenu', ({ e, node }) => this.openContextMenu(e, node));
    graph.on('edge:contextmenu', ({ e, edge }) => {
      // 装饰边没有右键菜单（不可编辑顶点、不可删除）。
      if (this.isDecorativeEdge(edge.id)) return;
      this.openContextMenu(e, edge);
    });
    graph.on('blank:contextmenu', ({ e }) => this.openContextMenu(e, null));
    graph.on('blank:click', () => {
      this.closeContextMenu();
      this.emit('selectionChange', [], []);
    });
    graph.on('selection:changed', ({ selected }) => {
      if (this.syncingSelection) return;
      const nodeIds = selected.filter((cell) => cell.isNode()).map((cell) => cell.id);
      const edgeIds = selected.filter((cell) => cell.isEdge() && !this.isDecorativeEdge(cell.id)).map((cell) => cell.id);
      this.emit('selectionChange', nodeIds, edgeIds);
    });
    graph.on('node:mousedown', ({ node }) => {
      this.moveStart.clear();
      const selected = graph.getSelectedCells().filter((cell): cell is Node => cell.isNode());
      const moving = selected.some((item) => item.id === node.id) ? selected : [node];
      for (const item of moving) this.moveStart.set(item.id, item.getPosition());
      this.dragLeaderId = node.id;
    });
    graph.on('node:change:position', ({ node }) => {
      if (this.applyingGroupMove || this.syncingModel) return;
      if (this.readOnly || this.moveStart.has(node.id)) return;
      const previous = this.nodeViews.get(node.id)?.position;
      if (previous) this.moveStart.set(node.id, { ...previous });
    });
    graph.on('node:moving', ({ node }) => {
      if (this.applyingGroupMove || this.dragLeaderId !== node.id || this.moveStart.size < 2) return;
      const leaderOrigin = this.moveStart.get(node.id);
      if (!leaderOrigin) return;
      const leaderPosition = node.getPosition();
      const dx = leaderPosition.x - leaderOrigin.x;
      const dy = leaderPosition.y - leaderOrigin.y;
      this.applyingGroupMove = true;
      try {
        for (const [id, origin] of this.moveStart) {
          if (id === node.id) continue;
          const peer = graph.getCellById(id);
          if (!peer?.isNode()) continue;
          // 子孙节点跳过（防御性处理；当前节点模型没有分支结构块容器，无真实消费方）：leader 自身
          // 的子孙节点（若通过 X6 原生 embed() 成为其子节点）已经被 X6 原生 Node.translate() 的
          // eachChild 递归移动过一遍——leader 每移动一步，X6 底层先把这份位移级联给了它的全部
          // 子孙，本回调才收到这次 node:moving。若这里再对同一个子孙调用 peer.position()
          // 施加一次同样的 delta，就是同一节点在一次拖拽里被移动两次（双重位移）。isDescendantOf
          // 是 X6 Cell 的既有方法（沿 getParent() 链上溯），这里只需要一行判断即可跳过——native
          // 级联已经保证了它跟着 leader 走，不需要（也不能）再交给手写群移接管。
          if (peer.isDescendantOf(node)) continue;
          peer.position(origin.x + dx, origin.y + dy);
        }
      } finally {
        this.applyingGroupMove = false;
      }
    });
    window.addEventListener('pointerup', this.boundMovePointerUp, true);
    graph.on('edge:connected', ({ edge, isNew }) => {
      if (!isNew) return;
      const source = edge.getSourceCellId();
      const target = edge.getTargetCellId();
      edge.remove();
      if (source && target) this.emit('connect', source, target);
    });
    graph.on('edge:click', ({ edge }) => {
      if (this.readOnly || this.isDecorativeEdge(edge.id)) return;
      // 🔴 选中态只保留 target 端一个箭头指向下游，不加 source-arrowhead。
      // 原因：'source-arrowhead'/'target-arrowhead' 是 X6 内置的**交互拖拽手柄**工具（@antv/x6
      // registry/tool/arrowhead.js Arrowhead.define，深色三角，用于按住拖拽改变
      // 该端连接的节点），与 applyEdgeVisual 里 line.targetMarker 那个"静态箭头"是完全不同的两
      // 套机制——若两个都加，一点击/选中连线，source 端就多出这个拖拽手柄，视觉上像一个指向
      // 相反方向的箭头。只保留 target-arrowhead：拖拽改连接目标节点的能力仍在，只是不能通过
      // 拖手柄改连接来源节点（需删除重连），这是为消除反向箭头刻意收窄的交互面。
      edge.addTools([{ name: 'vertices' }, { name: 'target-arrowhead' }]);
    });
    graph.on('blank:click', () => graph.getEdges().forEach((edge) => edge.removeTools()));
    graph.on('edge:change:vertices', () => {
      if (!this.restoringLayout && !this.syncingModel) this.emit('layoutChange');
    });
    graph.on('scale', () => {
      // 纯视口变化（缩放）不算未保存改动：DesignerRoot.vue currentDocument() 每次保存都会
      // 重新 getLayout() 取一遍当前视口，视口本身会随下一次正常保存顺带落库，不需要仅因为用户
      // 点了"适应窗口"/滚轮缩放就单独把文档标记为未保存。因此这里不 emit('layoutChange')，只保留
      // 下面的视口通知。
      this.emitViewportChange();
      // 标尺：不受 restoringLayout 门槛限制，见 getViewport/onViewportChange
      // 头注释——程序化恢复视口（setLayout）时标尺也必须跟着刷新，否则会显示"上一次用户操作
      // 时的刻度"，与画布实际视口不一致。
    });
    graph.on('translate', () => {
      // 纯视口变化（平移）同样不算未保存改动，理由同上面 'scale' 分支注释。
      this.emitViewportChange();
    });
  }

  private tagRenderedCell(id: string, attributes: Record<string, string>): void {
    const apply = () => {
      const element = this.container?.querySelector<SVGGElement>(`[data-cell-id="${CSS.escape(id)}"]`);
      if (!element) return false;
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      return true;
    };
    if (!apply()) requestAnimationFrame(apply);
  }

  private bindKeyboard(graph: Graph): void {
    const guard = (event: KeyboardEvent) => !isEditableTarget(event);
    graph.bindKey(['ctrl+z', 'meta+z'], (event) => {
      if (!guard(event)) return;
      this.emit('undo');
      event.preventDefault();
    });
    graph.bindKey(['ctrl+shift+z', 'meta+shift+z', 'ctrl+y'], (event) => {
      if (!guard(event)) return;
      this.emit('redo');
      event.preventDefault();
    });
    graph.bindKey(['ctrl+s', 'meta+s'], (event) => {
      if (!guard(event)) return;
      this.emit('save');
      event.preventDefault();
    });
    graph.bindKey(['delete', 'backspace'], (event) => {
      if (!guard(event) || this.readOnly) return;
      this.emit('deleteSelection');
      event.preventDefault();
    });
    graph.bindKey(['ctrl+c', 'meta+c'], (event) => {
      if (!guard(event)) return;
      this.clipboard = graph.getSelectedCells().filter((cell) => cell.isNode()).map((cell) => cell.id);
      (globalThis as Record<string, unknown>)[CLIPBOARD_KEY] = [...this.clipboard];
      event.preventDefault();
    });
    graph.bindKey(['ctrl+v', 'meta+v'], (event) => {
      if (!guard(event) || this.readOnly) return;
      const ids = ((globalThis as Record<string, unknown>)[CLIPBOARD_KEY] as string[] | undefined) ?? this.clipboard;
      if (ids.length) this.emit('paste', ids);
      event.preventDefault();
    });
    graph.bindKey(['left', 'right', 'up', 'down'], (event) => {
      if (!guard(event) || this.readOnly) return;
      const delta = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
      const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0;
      const moves = graph
        .getSelectedCells()
        .filter((cell): cell is Node => cell.isNode())
        .map((node) => {
          const p = node.getPosition();
          return { nodeId: node.id, position: { x: p.x + dx, y: p.y + dy } };
        });
      if (moves.length) this.emit('nodesMoveEnd', moves);
      event.preventDefault();
    });
  }

  private bindPanning(graph: Graph): void {
    if (!this.container) return;
    /** Ctrl/⌘+左键在空白处按下（框选手势）期间为真，仅用于压制 macOS 的 Ctrl+左键 contextmenu。 */
    let modifierSelect = false;
    let manualPan: { clientX: number; clientY: number; tx: number; ty: number; moved: boolean } | null = null;
    // 画布平移只有一种手势入口（见 pointerDown 头注释），不提供"空格+拖动平移"。
    const down = (event: KeyboardEvent) => {
      // 🔴 Alt 精细对齐：同时压制吸附与参考线——fineAlignmentActive 是类字段，供
      // refreshAlignmentAids() 统一按"吸附/参考线各自的工具条设定 × 是否正在按住 Alt"两个维度算出
      // 这一刻真正应生效的 grid size / Snapline enabled，不在这里直接调用
      // snaplinePlugin.disable()（那样会绕开 refreshAlignmentAids 的统一判断，见该方法注释）。
      if (event.key === 'Alt' && !this.fineAlignmentActive && !isEditableTarget(event)) {
        this.fineAlignmentActive = true;
        this.refreshAlignmentAids();
        event.preventDefault();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Alt' && this.fineAlignmentActive) {
        this.fineAlignmentActive = false;
        // 松开 Alt：按用户各自在工具条上的设定值（snapToGridEnabled/snaplineDesiredEnabled）
        // 还原，而不是无脑重新打开——见类字段注释。
        this.refreshAlignmentAids();
      }
    };
    // 🔴 指针手势（更贴近普通用户习惯）：
    //   - 直接按住左键拖动空白处 / 中键拖动 = 平移画布；
    //   - 按住 Ctrl/⌘ 再拖动空白处 = 框选，由 Selection 插件的
    //     modifiers:['ctrl','meta'] 承接，见 mount() 里 Selection 构造处注释，本方法不参与框选本身。
    // 🔴 左键平移**不得**在 pointerdown 上 preventDefault：浏览器会因此不再派发兼容的
    // mousedown/mouseup，而 X6 整套空白处链路都挂在 mousedown 上——Keyboard 插件
    // （global:false）靠 blank:mouseup 给画布容器聚焦（见 @antv/x6-plugin-keyboard 源码），
    // X6 GraphView.onClick 靠 mousedown 之后的位移计数区分「单击」与「拖完松手」。
    // 放行 mousedown 后：单击空白照常触发 blank:click 清空选区并聚焦画布；拖动平移后松手因
    // 位移计数超过 clickThreshold 不触发 blank:click，平移不会顺带清掉当前选区。中键仍
    // preventDefault（压掉浏览器的中键自动滚动）。
    const pointerDown = (event: PointerEvent) => {
      const isMiddle = event.button === 1;
      const isLeft = event.button === 0;
      if (!isMiddle && !isLeft) return;
      const target = event.target as Element | null;
      if (target?.closest('.x6-node, .x6-edge')) return;
      if (isLeft && (event.ctrlKey || event.metaKey)) {
        // 框选手势起手：只记一个标记供下方 suppressSelectContextMenu 使用，其余交给 X6。
        modifierSelect = true;
        return;
      }
      const translation = graph.translate();
      manualPan = { clientX: event.clientX, clientY: event.clientY, tx: translation.tx, ty: translation.ty, moved: false };
      if (isMiddle) event.preventDefault();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!manualPan) return;
      if (!manualPan.moved) {
        // 真的发生位移才切「抓取中」光标——单击空白不闪光标。
        manualPan.moved = true;
        if (this.container) this.container.style.cursor = 'grabbing';
      }
      graph.translate(
        manualPan.tx + event.clientX - manualPan.clientX,
        manualPan.ty + event.clientY - manualPan.clientY
      );
      event.preventDefault();
    };
    const pointerUp = () => {
      modifierSelect = false;
      if (!manualPan) return;
      if (manualPan.moved && this.container) this.container.style.cursor = '';
      manualPan = null;
    };
    // 🔴 macOS 上 Ctrl+左键按下会被系统翻译成 contextmenu 事件（等价于
    // 右键），而 X6 的 node/edge/blank:contextmenu 正是靠委托监听同一个 container 上的原生
    // contextmenu 事件转发出来的（见 @antv/x6 graph/view.js GraphView 的
    // `contextmenu: 'onContextMenu'`，监听对象是 `this.options.container`，与
    // new Graph({ container }) 传入的、本文件持有的 this.container 是同一个 DOM 元素）。
    // Ctrl+左键拖动空白处是「框选」，不该弹出右键菜单；这里在
    // capture 阶段提前拦截：pointerdown（同样 capture:true）比 contextmenu 更早触发，
    // modifierSelect 在「起手」那一刻（按下的瞬间，不等真的发生位移）就已置真，因此只需判断
    // 它即可同时覆盖「框选手势期间」与「Ctrl+左键按下起手时」两种时机。stopPropagation() 让
    // 事件在到达 X6 自身的委托监听器（bubble 阶段）之前就被拦下，自定义右键菜单因此不会弹出；
    // modifierSelect 只在空白画布（不含节点/边，见 pointerDown 的 target.closest 早退）才会
    // 置真，Ctrl+点击节点/边仍走原有右键菜单，不受影响。松开左键（pointerUp 置回 false）后
    // 普通右键菜单照常可用。
    const suppressSelectContextMenu = (event: MouseEvent) => {
      if (!modifierSelect) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    this.container.addEventListener('pointerdown', pointerDown, true);
    this.container.addEventListener('contextmenu', suppressSelectContextMenu, true);
    window.addEventListener('pointermove', pointerMove, true);
    window.addEventListener('pointerup', pointerUp, true);
    graph.on('removed', () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      this.container?.removeEventListener('pointerdown', pointerDown, true);
      this.container?.removeEventListener('contextmenu', suppressSelectContextMenu, true);
      window.removeEventListener('pointermove', pointerMove, true);
      window.removeEventListener('pointerup', pointerUp, true);
    });
  }

  unmount(): void {
    this.closeContextMenu();
    window.removeEventListener('pointerup', this.boundMovePointerUp, true);
    this.graph?.dispose();
    this.graph = null;
    this.selectionPlugin = null;
    this.snaplinePlugin = null;
    this.minimapPlugin = null;
    this.container = null;
    for (const handlers of Object.values(this.handlers)) handlers.clear();
    this.viewportChangeHandlers.clear();
  }

  private commitMoves(): void {
    if (!this.graph || !this.moveStart.size) return;
    const moves = [...this.moveStart.keys()]
      .map((id) => {
        const node = this.graph!.getCellById(id);
        if (!node?.isNode()) return null;
        const position = node.getPosition();
        const origin = this.moveStart.get(id);
        if (origin && origin.x === position.x && origin.y === position.y) return null;
        return { nodeId: id, position };
      })
      .filter((value): value is { nodeId: string; position: NodePosition } => Boolean(value));
    this.moveStart.clear();
    this.dragLeaderId = null;
    if (moves.length === 1) this.emit('nodeMoveEnd', moves[0].nodeId, moves[0].position);
    else if (moves.length > 1) this.emit('nodesMoveEnd', moves);
  }

  /**
   * withCurrentSelection —— 节点视觉的选中态真实来源永远是 X6 Selection 插件
   * （this.graph.isSelected(cell)），不是 GraphNodeView.selected 字段本身：上游（designer/
   * DesignerRoot.vue 的 `nodes` computed，经 designer/graph-bridge.ts toGraphNodes() 产出）不给
   * 这个字段赋值——业务层的文档转展示态转换不知道"当前选中了谁"，选中态纯粹是画布会话内的本地
   * 状态。applyNodeVisual() 若直接读 view.selected 会恒为 false，选中态视觉永远不会被触发。
   *
   * 本方法统一收口：每次要把某个 view 喂给 applyNodeVisual() 之前，先拿 X6 自己的权威选中
   * 状态覆盖一份 view.selected（不改 nodeViews 缓存里的原始 view，只在传给 applyNodeVisual
   * 的这一份浅拷贝上覆盖）——applyNodeVisual() 本身签名与单测（直接构造 view.selected
   * 断言纯函数行为，见 x6-adapter.visual.test.ts）不变，本类内部的调用点（setNodes 的
   * 创建/更新分支、setPalette 的重绘循环、setSelection() 的选中态刷新循环）全部用
   * 这份"当下真实"的选中态，不信任 view.selected 本身。
   */
  private withCurrentSelection(view: GraphNodeView, cell: Node): GraphNodeView {
    return { ...view, selected: this.graph?.isSelected(cell) ?? false };
  }

  setNodes(nodes: GraphNodeView[]): void {
    this.nodeViews = new Map(nodes.map((node) => [node.id, node]));
    if (!this.graph) return;
    this.syncingModel = true;
    const wanted = new Set(nodes.map((node) => node.id));
    for (const cell of this.graph.getNodes()) {
      if (!wanted.has(cell.id)) cell.remove();
    }
    for (const view of nodes) {
      const existing = this.graph.getCellById(view.id);
      if (existing?.isNode()) {
        applyNodeVisual(existing, this.withCurrentSelection(view, existing), this.palette);
        continue;
      }
      const family = NODE_SHAPE_FAMILY[view.type];
      const structure = family === 'structure';
      const { width: size, height } = nodeDimensions(view.type);
      const created = this.graph.addNode({
        id: view.id,
        x: view.position.x,
        y: view.position.y,
        width: size,
        height,
        shape: structure ? 'polygon' : 'rect',
        // 只建结构性骨架（markup/ports/size/zIndex），不在这里算视觉属性——紧接着调用与
        // 更新分支同一份 applyNodeVisual 填视觉，两条路径不各算一套（见该函数注释）。
        markup: buildNodeVisual(family, view.type),
        zIndex: 2,
        attrs: { root: { 'data-node-id': view.id, 'data-node-type': view.type } },
        ports: portGroups(this.palette),
        data: { nodeType: view.type }
      });
      applyNodeVisual(created, this.withCurrentSelection(view, created), this.palette);
      this.tagRenderedCell(view.id, { 'data-node-id': view.id, 'data-node-type': view.type });
    }
    this.syncingModel = false;
    this.refreshMinimapScale();
  }

  setEdges(edges: GraphEdgeView[]): void {
    this.edgeViews = new Map(edges.map((edge) => [edge.id, edge]));
    if (!this.graph) return;
    const wanted = new Set(edges.map((edge) => edge.id));
    for (const cell of this.graph.getEdges()) {
      if (cell.id.startsWith('x6-temp-')) continue;
      if (!wanted.has(cell.id)) cell.remove();
    }
    for (const view of edges) {
      const ports = terminalPorts(view, this.nodeViews);
      const existing = this.graph.getCellById(view.id);
      if (existing?.isEdge()) {
        applyEdgeVisual(existing, view, ports, this.palette);
        continue;
      }
      // 只建结构性骨架（router/connector/zIndex），source/target/line 样式/labels 交给
      // 紧接着的 applyEdgeVisual 统一填——与更新分支共用同一份实现（见该函数注释）。
      const created = this.graph.addEdge({
        id: view.id,
        source: { cell: view.from, port: ports.source },
        target: { cell: view.to, port: ports.target },
        router: { name: 'manhattan', args: { padding: 18, step: 10 } },
        connector: { name: 'rounded', args: { radius: 8 } },
        zIndex: 0,
        attrs: {
          root: {
            'data-edge-id': view.id,
            'data-from-node-id': view.from,
            'data-to-node-id': view.to
          }
        }
      });
      applyEdgeVisual(created, view, ports, this.palette);
      this.tagRenderedCell(view.id, {
        'data-edge-id': view.id,
        'data-from-node-id': view.from,
        'data-to-node-id': view.to
      });
    }
    this.refreshMinimapScale();
  }

  /**
   * setPalette —— 主题切换时的画布就地重绘入口（暗色支持）。调用方（DesignerCanvas.vue，见其
   * 接入 useCanvasPalette() 的说明）在宿主主题变化时把新的 CanvasPalette 传进来——本方法**不重建画布、不丢选中态与
   * 视口**：只更新已挂载 Graph 的底色/网格，并对 setNodes/setEdges 已经在维护的
   * nodeViews/edgeViews 缓存里的每一条视图，重新调用一次 applyNodeVisual/
   * applyEdgeVisual——与"业务数据变化时更新节点/边"的既有路径完全同构（这两个
   * 函数本就是"创建/更新共用同一份实现"，见各自头注释），唯一区别是这次视觉数据没变、只是
   * palette 变了，不新增第二套视觉计算逻辑。
   *
   * 未挂载（this.graph 为 null）时只记下新 palette 供下次 mount() 使用，不做任何画布操作——
   * DesignerCanvas.vue 卸载重挂场景下不会因为提前收到主题变化通知而报错。
   */
  setPalette(palette: CanvasPalette): void {
    this.palette = palette;
    if (!this.graph) return;
    // 底色/网格：X6 官方 API（graph/background.ts drawBackground / graph/grid.ts 经 Graph.drawGrid
    // 转发），同 mount() 构造 Graph 时传入的 background/grid 配置项一一对应，只是从"构造一次性
    // 参数"改成"运行时重绘调用"。
    this.graph.drawBackground({ color: palette.canvasBg });
    this.graph.drawGrid({ type: 'dot', args: { color: palette.gridDot, thickness: 1 } });
    for (const node of this.graph.getNodes()) {
      const view = this.nodeViews.get(node.id);
      if (view) applyNodeVisual(node, this.withCurrentSelection(view, node), palette);
      // 四向端口圆点白底（同 portGroups() 创建时的配色，见该函数注释）：stroke（品牌蓝）亮暗
      // 恒定不需要重设，这里只覆盖 fill。setPortProp 写入的是该端口自身的 attrs 覆盖（优先级
      // 高于 groups 级别的默认 attrs，见 @antv/x6 model/port.ts getPortMetadata 的 merge 顺序），
      // 会触发 X6 NodeView 的 'ports' action 重新渲染端口（同 cell.attr() 触发 'attrs' action
      // 重渲染是同一套机制，见 @antv/x6 view/node.js actionMap）。
      for (const group of ['top', 'right', 'bottom', 'left']) {
        node.setPortProp(`port-${group}`, 'attrs/circle/fill', palette.surface);
      }
    }
    for (const edge of this.graph.getEdges()) {
      const view = this.edgeViews.get(edge.id);
      // 进行中的拖拽连线预览（'x6-temp-' 前缀边）不在 edgeViews 里，天然被跳过——预览线本身在
      // createEdge() 回调里已经读的是 this.palette.primary（见 mount() 该处注释），不需要这里
      // 补一次。
      if (!view) continue;
      applyEdgeVisual(edge, view, terminalPorts(view, this.nodeViews), palette);
    }
  }

  /**
   * refreshMinimapScale —— 小地图最小缩放比下限（小流程如 3 个节点时，小地图里节点不能缩成
   * 看不清的点）。
   *
   * X6 MiniMap 插件构造参数里的 minScale/maxScale（mount() 那份 0.01/1）只作用于"拖拽小地图
   * 右下角缩放手柄改变主画布缩放"这一个交互（@antv/x6-plugin-minimap 源码 doAction() 的
   * 'zooming' 分支唯一读取这两个字段的地方），跟"小地图自动把全部内容适配进 176×88 视口"这件
   * 事完全无关——自动适配靠 sourceGraph 的 model:updated/resize 事件分别触发插件内部
   * onModelUpdated()/updatePaper()，两者末尾都调用不带任何参数的 `targetGraph.zoomToFit()`，
   * 因此内容很小（如 3 节点紧凑排布）时自动算出的缩放比没有下限，内容
   * 越紧凑、缩得越小，最终缩成看不清的点。
   *
   * 本方法在每次内容变化后（setNodes/setEdges 末尾各调一次，覆盖全部会改变小地图
   * 内容 bbox 的入口）用同一个 targetGraph 重新 zoomToFit 一次并显式带上 minScale/maxScale——
   * 不是"绕开"插件自己的计算，而是在插件按自己的节奏（对 addNode/removeCell 等模型层变更同步
   * 反应，此时应已经算完一轮，见调用点位置）算完之后，用完全相同的 zoomToFit() 入口对同一份
   * 当前内容再夹一次下限：zoomToFit 内部的缩放比计算只取决于内容包围盒与视口尺寸的比值，与
   * "调用前的当前缩放比"无关（@antv/x6 graph/transform.js scaleContentToFitImpl 的 newSX/newSY
   * 公式两次约掉了 currentScale），因此重复调用是幂等、确定性的，不会因为调用两次而
   * 产生和只调一次不同的结果——唯一的差别就是这次带上了下限。
   *
   * 自然缩放比低于阈值（小流程）时被拉到 MINIMAP_MIN_SCALE，内容因此可能超出小地图视口——
   * "超阈值时允许内容超出+视口框仍准确"是预期行为，不是缺陷（视口框由插件自己另一套 geometry
   * 计算维护，不受这里影响）；自然缩放比本来就低于阈值（超大流程）时 Math.max 语义（通过
   * zoomToFit 的 minScale 选项实现同等效果）不会把它拉高，维持插件原计算，不会因为强行放大而
   * 让更多内容被裁到视口外。
   *
   * targetGraph 是 MiniMap 插件的私有字段（未出现在其公开 .d.ts），用结构类型 cast 拿到——同
   * 本文件其余"拿到内部真实实例做二次处理"的既定手法。未挂载小地图（minimapPlugin 为 null）
   * 时直接跳过。
   */
  private refreshMinimapScale(): void {
    const targetGraph = (this.minimapPlugin as unknown as { targetGraph?: Graph } | null)?.targetGraph;
    if (!targetGraph) return;
    targetGraph.zoomToFit({ minScale: MINIMAP_MIN_SCALE, maxScale: MINIMAP_MAX_SCALE });
  }

  setSelection(nodeIds: string[], edgeIds: string[]): void {
    if (!this.graph) return;
    this.syncingSelection = true;
    this.graph.cleanSelection();
    const cells = [...nodeIds, ...edgeIds].map((id) => this.graph!.getCellById(id)).filter((cell): cell is Cell => Boolean(cell));
    if (cells.length) this.graph.select(cells);
    this.syncingSelection = false;
    // 🔴 X6 Selection 插件的选中状态在这里才真正落地，但 setNodes()
    // 在同一次 sync()（DesignerCanvas.vue）里恒排在 setSelection() 之前调用——若不在这里补一次
    // 重绘，本次刚变化的选中态要等下一次任意触发 setNodes() 的变化（节点增删/属性变化）才会
    // 被 applyNodeVisual 看见，纯粹的"选中/取消选中"操作永远不会自己触发重绘。逐个已渲染节点
    // 按 graph.isSelected() 重新 apply 一次视觉，与 setPalette() 的重绘循环同一手法。
    this.refreshNodeSelectionVisuals();
  }

  /** 选中态视觉与 X6 Selection 插件当前状态对齐——setSelection() 与（未来任何直接调用
   * `this.graph.select()`/`cleanSelection()` 的路径）都应该在变更选中状态后调用本方法，
   * 保证画布上"看起来选中的"与"X6 真正记为选中的"恒一致。见 setSelection() 头注释。 */
  private refreshNodeSelectionVisuals(): void {
    if (!this.graph) return;
    for (const node of this.graph.getNodes()) {
      const view = this.nodeViews.get(node.id);
      if (view) applyNodeVisual(node, this.withCurrentSelection(view, node), this.palette);
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    if (readOnly) this.graph?.getEdges().forEach((edge) => edge.removeTools());
  }

  on<K extends keyof GraphPortEvents>(event: K, handler: GraphPortEvents[K]): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  private emit<K extends keyof GraphPortEvents>(event: K, ...args: Parameters<GraphPortEvents[K]>): void {
    for (const handler of this.handlers[event]) (handler as (...values: Parameters<GraphPortEvents[K]>) => void)(...args);
  }

  zoomIn(): void {
    this.graph?.zoom(0.1, { minScale: 0.2, maxScale: 4 });
  }
  zoomOut(): void {
    this.graph?.zoom(-0.1, { minScale: 0.2, maxScale: 4 });
  }
  zoomTo100(): void {
    this.graph?.zoomTo(1);
  }
  zoomToFit(): void {
    this.graph?.zoomToFit({ padding: 40, maxScale: 1 });
  }
  getZoomPercent(): number {
    return Math.round((this.graph?.zoom() ?? 1) * 100);
  }
  /** 状态栏缩放滑杆（20%–400%）：设为指定缩放比，钳制在与 mount() 时
   * mousewheel/zoomIn/zoomOut 同一个范围内（minScale:0.2/maxScale:4），避免滑杆拖到端点时把
   * 画布缩没或缩爆。 */
  zoomToPercent(percent: number): void {
    const clamped = Math.min(400, Math.max(20, percent));
    this.graph?.zoomTo(clamped / 100);
  }
  /** 校验面板"点击定位" + 快捷创建后自动带入视野：把画布平移到给定节点/边的中心。
   * id 可以是节点 id 也可以是边 id——getCellById 对两者一视同仁，getBBox() 拿到的都是模型
   * 坐标而非依赖真实渲染测算的包围盒，两种目标一份实现即可覆盖（不需要 centerOnNode/
   * centerOnEdge 两个方法）。找不到该 id 对应的 cell（已被删除等竞态）时静默跳过，不抛错。 */
  centerOn(id: string): void {
    if (!this.graph || !this.container) return;
    const cell = this.graph.getCellById(id);
    if (!cell) return;
    const center = cell.getBBox().getCenter();
    const rect = this.container.getBoundingClientRect();
    const { tx, ty } = computeCenterTranslate(center, this.graph.zoom(), { width: rect.width, height: rect.height });
    this.graph.translate(tx, ty);
  }

  /**
   * getNodeCenter —— 取某节点当前渲染包围盒的中心点（画布/模型坐标），与 centerOn() 内部同一份
   * 取值逻辑（cell.getBBox().getCenter()），抽成公开方法供"首次打开画布，把发起节点锚到容器
   * 左中"这类只需要几何信息、不需要立刻落视口的场景使用（见
   * designer/canvas/DesignerCanvas.vue applyInitialAnchor() 消费处；该场景要先拿中心点算出
   * 目标视口再决定要不要落地，不能直接复用 centerOn() 那种"取到就立刻 translate 到容器正
   * 中央"的语义）。找不到该 id 对应的 cell 时返回 null（防御性兜底，同 centerOn 的既定处理，
   * 调用方按"找不到，回退现有行为"处理）。
   */
  getNodeCenter(id: string): { x: number; y: number } | null {
    if (!this.graph) return null;
    const cell = this.graph.getCellById(id);
    if (!cell) return null;
    const center = cell.getBBox().getCenter();
    return { x: center.x, y: center.y };
  }

  /**
   * getNodeSize —— 取某节点当前渲染包围盒的宽高（"首次打开画布绕开
   * 浮动节点库面板"需要发起节点的真实卡片尺寸才能算"节点左缘"而不只是中心点，见
   * designer/canvas/DesignerCanvas.vue applyInitialAnchor() 消费处）。与 getNodeCenter 同一份
   * cell 查找，找不到时同样返回 null（防御性兜底，理论不应发生）。
   */
  getNodeSize(id: string): { width: number; height: number } | null {
    if (!this.graph) return null;
    const cell = this.graph.getCellById(id);
    if (!cell) return null;
    const bbox = cell.getBBox();
    return { width: bbox.width, height: bbox.height };
  }

  /**
   * getContainerSize —— 画布容器当前像素尺寸，供"首次打开定位到发起节点"
   * 等只需要容器几何、不需要具体视口操作的场景使用。未挂载时返回 null。
   */
  getContainerSize(): { width: number; height: number } | null {
    if (!this.container) return null;
    const rect = this.container.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  // —— 画布开关（工具条三开关：网格 / 吸附 / 参考线）——
  // 三者是正交的三枚 toggle，各自控制一件真实可观测行为：
  //   - 网格 = grid.visible（setGridVisible/isGridVisible）；
  //   - 吸附 = grid size 16↔1——X6 语义下拖拽落点吸附由 grid size 决定（连接手柄的吸附半径是
  //     另一个独立配置 connecting.snap，不受此影响），size=1 是唯一能在不引入额外插件/事件
  //     拦截的前提下"关掉网格吸附但不关网格显示"的正交旋钮（见 setSnapToGrid 注释）；
  //   - 参考线 = Snapline 插件整体启停（setSnaplineEnabled，只管参考线，不承担"吸附"的职责）。
  // 状态权威：网格显隐读 DOM（isGridVisible）；吸附/参考线因为要与 Alt 精细
  // 对齐的"临时压制"区分"用户设定 ×这一刻是否生效"两层语义（见 fineAlignmentActive 等类字段
  // 注释），读本类维护的 snapToGridEnabled/snaplineDesiredEnabled 这两个"设定"字段，而不是
  // 直接读插件/grid 的当前瞬时值——Alt 按住期间瞬时值会被临时压到"关"，但这不代表用户在工具条
  // 上把开关关掉了，UI 不应该在这个瞬间跳变成"关"态（用户根本没点按钮）。

  setGridVisible(visible: boolean): void {
    if (!this.graph) return;
    if (visible) this.graph.showGrid();
    else this.graph.hideGrid();
  }
  isGridVisible(): boolean {
    // X6 的 showGrid/hideGrid 实际操作的是**画布背景层的 backgroundImage**
    // （grid.js update()：不可见时走 clear() 把 backgroundImage 置空），
    // 没有 `.x6-graph-grid` 这样的独立图层，也没有公开的可见性读口。
    // 因此判据取"背景图是否为空"——这正是 hideGrid 唯一改动的那个属性，
    // 比自己另存一个布尔更不容易与真实状态脱节。
    //
    // 🔴 已知限制（见 @antv/x6 GridManager.update() 源码）：该方法内部还有一条
    // `gridSize <= 1 || !visible` 即整体 clear() 背景的判断，与本方法要读的"是否可见"共用同一个
    // 背景图属性。也就是说，若用户把"吸附"关掉（grid.size 降到 1），即便"网格"开关本身仍是
    // true，背景图也会被一并清空——本方法此时会如实读出"不可见"。这是 X6 内部把"网格尺寸"与
    // "网格可见性"耦合在同一处判断里的实现细节；默认状态（吸附开）下不受影响，彻底解决需要绕开
    // X6 GridManager 自绘一层背景。
    const bg = this.gridBackgroundElement();
    if (!bg) return false;
    const image = bg.style.backgroundImage;
    return image !== '' && image !== 'none';
  }

  /**
   * grid 背景所在的元素。DOM 实测：X6 把网格画在容器内的 `.x6-graph-grid` 上
   * （不是 `.x6-graph-background`，后者在本版本根本不存在）——这一点没有文档，
   * 是在浏览器里逐个扫 `[class*="x6"]` 的 backgroundImage 才确认的。
   */
  private gridBackgroundElement(): HTMLElement | null {
    return this.graph?.container?.querySelector<HTMLElement>('.x6-graph-grid') ?? null;
  }

  /**
   * setSnapToGrid —— "吸附"开关：graph.setGridSize(16↔1)。X6 拖拽
   * 落点吸附的唯一驱动源是 grid size（没有独立的"吸附半径"配置项给普通节点拖拽用——
   * connecting.snap.radius 那份配置是连线手柄专属，与节点拖拽落点无关，两者是两套不同机制），
   * size=1 时任意坐标都不需要吸附到网格线，等效于关闭；
   * size=16 与 mount() 构造期的网格步长一致（同一份网格，只是吸附与否）。
   */
  setSnapToGrid(enabled: boolean): void {
    this.snapToGridEnabled = enabled;
    this.refreshAlignmentAids();
  }
  isSnapToGridEnabled(): boolean {
    return this.snapToGridEnabled;
  }

  /** 参考线（Snapline 插件整体启停），只管参考线本身——不承担"吸附"的职责（吸附见
   * setSnapToGrid）。 */
  setSnaplineEnabled(enabled: boolean): void {
    this.snaplineDesiredEnabled = enabled;
    this.refreshAlignmentAids();
  }
  isSnaplineEnabled(): boolean {
    return this.snaplineDesiredEnabled;
  }

  /**
   * refreshAlignmentAids —— 吸附/参考线两条通道的唯一落地点：按"用户设定
   * （snapToGridEnabled/snaplineDesiredEnabled）× 是否正在按住 Alt 精细对齐
   * （fineAlignmentActive）"算出这一刻真正应生效的 grid size / Snapline enabled，写回
   * graph/snaplinePlugin。setSnapToGrid/setSnaplineEnabled/bindPanning 的 Alt down/up 四个
   * 调用点都只改自己负责的那个状态位，再调用本方法收口，不在各自调用点里直接摆弄
   * graph.setGridSize()/snaplinePlugin.enable()/disable()——避免"Alt 按住期间用户又点了一次
   * 工具条按钮"这类交叉场景下四处判断各自为政、算出不一致的结果（本方法是唯一权威）。
   */
  private refreshAlignmentAids(): void {
    const suppressed = this.fineAlignmentActive;
    this.graph?.setGridSize(suppressed || !this.snapToGridEnabled ? 1 : 16);
    if (suppressed || !this.snaplineDesiredEnabled) this.snaplinePlugin?.disable();
    else this.snaplinePlugin?.enable();
  }

  /**
   * alignSelection —— 对齐 6 图标按钮（横向 左/水平居中/右，
   * 纵向 顶/垂直居中/底）。只**计算**目标坐标并 emit 既有 nodesMoveEnd（同拖拽移动节点的既有
   * 回程通道），落库/撤销栈交给调用方（DesignerRoot.vue）走 MoveNodeCommand/CompositeCommand，
   * 天然可撤销——本方法不直接改动画布上的 cell 位置（那样会绕开撤销历史，同文件头"画布本身
   * 不直接改 store"的既定分工）。
   *
   * 选中数 < 2 时无意义（"对齐"这个概念至少需要两个对象），静默不 emit——调用方（工具条按钮）
   * 应已经用 :disabled 挡住这个场景，这里是第二道防线。
   *
   * 六档与轴的对应关系（**本方法最重要的纪律**：横向三档只碰 x，纵向三档只碰 y，不允许混）：
   *   横向（改 x，y 维持节点当前值不动）：
   *     - 'left'   ：对齐到选中集合最靠左的左边缘 min(x)；
   *     - 'center' ：对齐到选中集合包围盒的水平中心线 (min(x)+max(x+width))/2 —— 是 'middle'
   *       （垂直居中）的 x 轴镜像；
   *     - 'right'  ：对齐到选中集合最靠右的右边缘 max(x+width)；
   *   纵向（改 y，x 维持节点当前值不动）：
   *     - 'top'    ：对齐到选中集合最靠上的上边缘 min(y) —— 是 'left' 的 y 轴镜像；
   *     - 'middle' ：对齐到选中集合包围盒的垂直中心线，取上下两端极值中点 `(minTop+maxBottom)/2`，
   *       不是"逐节点高度加权平均"。加权平均会让结果随"当前具体选中了哪几个节点"抖动（换一批
   *       选中集合，即便包围盒不变，加权平均值也可能变），包围盒中心点只取决于最上/最下两个
   *       极值，符合"对齐结果只取决于选区几何范围"的直觉，也是 Figma 一类设计工具"居中对齐"的
   *       既定算法；
   *     - 'bottom' ：对齐到选中集合最靠下的下边缘 max(y+height) —— 是 'right' 的 y 轴镜像。
   *
   *   🔴 注意：六档按轴命名（横向 left/center/right，纵向 top/middle/bottom），'middle' 是
   *   "垂直居中"（改 y），不是"水平居中"。修改这里必须先核对上面这张表，不能按"中文文案
   *   听起来是什么方向"去改分组——文案与轴的绑定关系由调用方（工具条）负责，不是这里；
   *   文案与算法对调的错位不会报错，只会让节点在错误的轴上跳动。
   */
  alignSelection(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void {
    const items = this.selectedAlignableNodes();
    if (items.length < 2) return;
    let moves: Array<{ nodeId: string; position: NodePosition }>;
    if (mode === 'left' || mode === 'center' || mode === 'right') {
      // 横向三档：只算 x，y 原样透传。align 挡位与档名一一对应：left→min / right→max / center→center。
      const align = mode === 'left' ? 'min' : mode === 'right' ? 'max' : 'center';
      const xs = this.alignAxis(items.map((item) => ({ start: item.x, span: item.width })), align);
      moves = items.map((item, index) => ({ nodeId: item.id, position: { x: xs[index], y: item.y } }));
    } else {
      // 纵向三档：只算 y，x 原样透传。align 挡位与档名一一对应：top→min / bottom→max / middle→center。
      const align = mode === 'top' ? 'min' : mode === 'bottom' ? 'max' : 'center';
      const ys = this.alignAxis(items.map((item) => ({ start: item.y, span: item.height })), align);
      moves = items.map((item, index) => ({ nodeId: item.id, position: { x: item.x, y: ys[index] } }));
    }
    this.emit('nodesMoveEnd', moves);
  }

  /**
   * alignAxis —— alignSelection 六档共用的单轴目标坐标计算，把"横向只碰 x / 纵向只碰 y"的
   * 对称性落到一处实现，避免六个分支各写一份 min/max/center 算式（易在后续改动中失去对称）。
   * `start`/`span` 是调用方传入的"该轴起点 + 该轴跨度"（横向传 x/width，纵向传 y/height）：
   *   - 'min'    —— 对齐到所有起点里最小的一个（left/top），每个元素的目标值都相同；
   *   - 'max'    —— 对齐到所有终点（start+span）里最大的一个，再减去自身 span（right/bottom）；
   *   - 'center' —— 取（最小起点、最大终点）的中点，再减去自身 span 的一半（center/middle）。
   * 返回数组与入参 items 一一对应（同下标），不改变入参顺序。
   */
  private alignAxis(items: Array<{ start: number; span: number }>, align: 'min' | 'max' | 'center'): number[] {
    if (align === 'min') {
      const target = Math.min(...items.map((item) => item.start));
      return items.map(() => target);
    }
    if (align === 'max') {
      const target = Math.max(...items.map((item) => item.start + item.span));
      return items.map((item) => target - item.span);
    }
    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.start + item.span));
    const center = (minStart + maxEnd) / 2;
    return items.map((item) => center - item.span / 2);
  }

  /**
   * distributeSelection —— 等间距分布（⋮⋮ 按钮，带方向参数）。业界标准
   * "distribute spacing"算法：保持选中集合里首、尾两个节点的位置不动，把中间节点按"边到边
   * 等间距"（而不是"中心点等间距"）重新摆放——节点尺寸不一致时，中心点等间距会在视觉上产生
   * 不均匀的空隙（大节点之间的可见间隙比小节点之间的更窄），边到边等间距才是"看起来均匀"的
   * 定义。
   *
   * mode 与轴的对应（同 alignSelection 的"横向只碰 x/纵向只碰 y"纪律，不允许混）：
   *   - 'horizontal'：按 x 升序排序（同 x 按 id 排），首尾不动，用 width 算
   *     边到边等距，只改 x，y 维持每个节点当前值不动；
   *   - 'vertical'：横向算法的同构镜像——按 y 升序排序（同 y 按 id 排），首尾不动，用 height
   *     代替 width 算边到边等距，只改 y，x 维持每个节点当前值不动。
   * 无默认值，调用方必须显式传方向——留默认值会让漏改的调用点悄悄退化成横向而不报错，
   * 造成 alignSelection 头注释里提到的那种静默错位。
   *
   * 选中 < 2 个节点：同 alignSelection，静默不 emit。恰好 2 个节点时首尾即全部，没有"中间"
   * 节点可分布，calculation 恒等于把两者摆回原位（no-op，emit 出去的坐标与当前坐标相同，
   * DesignerRoot 的上层 MoveNodeCommand 生成逻辑会自行按"坐标未变化"跳过，不产生一次空撤销
   * 步骤——那部分判断在调用方，不在本方法职责内）。
   */
  distributeSelection(mode: 'horizontal' | 'vertical'): void {
    const items = this.selectedAlignableNodes();
    if (items.length < 2) return;
    let moves: Array<{ nodeId: string; position: NodePosition }>;
    if (mode === 'horizontal') {
      const sorted = [...items].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
      const leftMost = sorted[0];
      const rightMost = sorted[sorted.length - 1];
      const span = rightMost.x + rightMost.width - leftMost.x;
      const totalWidth = sorted.reduce((sum, item) => sum + item.width, 0);
      const gapCount = sorted.length - 1;
      const gap = gapCount > 0 ? (span - totalWidth) / gapCount : 0;
      let cursor = leftMost.x;
      moves = sorted.map((item) => {
        const position: NodePosition = { x: cursor, y: item.y };
        cursor += item.width + gap;
        return { nodeId: item.id, position };
      });
    } else {
      // 纵向：横向算法的同构镜像，把 x/width 换成 y/height，其余逻辑相同。
      const sorted = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
      const topMost = sorted[0];
      const bottomMost = sorted[sorted.length - 1];
      const span = bottomMost.y + bottomMost.height - topMost.y;
      const totalHeight = sorted.reduce((sum, item) => sum + item.height, 0);
      const gapCount = sorted.length - 1;
      const gap = gapCount > 0 ? (span - totalHeight) / gapCount : 0;
      let cursor = topMost.y;
      moves = sorted.map((item) => {
        const position: NodePosition = { x: item.x, y: cursor };
        cursor += item.height + gap;
        return { nodeId: item.id, position };
      });
    }
    this.emit('nodesMoveEnd', moves);
  }

  /** alignSelection/distributeSelection 共用的"当前选中的可对齐节点"取数——只取真实业务节点，
   * 带上计算对齐/分布所需的最小几何（当前位置 + 当前尺寸，取自 X6 模型层的 getPosition/getSize，
   * 不依赖真实 DOM 渲染测算）。 */
  private selectedAlignableNodes(): Array<{ id: string; x: number; y: number; width: number; height: number }> {
    if (!this.graph) return [];
    return this.graph
      .getSelectedCells()
      .filter((cell): cell is Node => cell.isNode())
      .map((node) => {
        const position = node.getPosition();
        const size = node.getSize();
        return { id: node.id, x: position.x, y: position.y, width: size.width, height: size.height };
      });
  }

  /**
   * getViewport / onViewportChange —— 标尺（常驻）的唯一数据源。标尺是"画布
   * 专属能力"（同 zoom/grid/snap 等既定分工，不进 graph/port.ts 的 GraphPort 最小契约，见
   * DesignerCanvas.vue 里这几个方法的注释），直接由持有具体 X6GraphAdapter 实例的
   * DesignerCanvas.vue 调用——本类不知道也不关心"标尺"这个概念本身，只提供"当前视口是什么"
   * 与"视口变了请叫我"两个通用能力。
   *
   * 复用 bindGraphEvents() 里已经在监听的 graph 'scale'/'translate' 两个事件——标尺不新增任何
   * X6 事件绑定，只是在同一个回调里多发一路通知。不受 `restoringLayout` 门槛限制：标尺必须
   * 如实反映画布当前视口，不管这次变化的原因是用户操作还是程序化恢复布局；纯视口变化（缩放/
   * 平移）也不触发 layoutChange，见 bindGraphEvents() 里这两个事件的绑定处注释。
   */
  getViewport(): { scaleX: number; tx: number; ty: number } {
    if (!this.graph) return { scaleX: 1, tx: 0, ty: 0 };
    const translation = this.graph.translate();
    return { scaleX: this.graph.zoom(), tx: translation.tx, ty: translation.ty };
  }
  onViewportChange(handler: () => void): () => void {
    this.viewportChangeHandlers.add(handler);
    return () => this.viewportChangeHandlers.delete(handler);
  }
  private emitViewportChange(): void {
    for (const handler of this.viewportChangeHandlers) handler();
  }
  getLayout(): DesignLayout {
    if (!this.graph) return {};
    const nodePositions = Object.fromEntries(
      this.graph.getNodes().map((node) => [node.id, { ...node.getPosition() }])
    );
    const edgeVertices = Object.fromEntries(
      this.graph
        .getEdges()
        // 装饰边不入库，其顶点/存在不进布局。
        .filter((edge) => this.edgeViews.has(edge.id) && !this.isDecorativeEdge(edge.id) && edge.getVertices().length > 0)
        .map((edge) => [
          edge.id,
          edge.getVertices().map((point) => ({ x: point.x, y: point.y }))
        ])
    );
    const translation = this.graph.translate();
    return {
      ...(Object.keys(nodePositions).length ? { nodePositions } : {}),
      ...(Object.keys(edgeVertices).length ? { edgeVertices } : {}),
      viewport: { scale: this.graph.zoom(), x: translation.tx, y: translation.ty }
    };
  }
  setLayout(layout: DesignLayout | undefined): void {
    if (!this.graph || !layout) return;
    this.restoringLayout = true;
    try {
      for (const [id, position] of Object.entries(layout.nodePositions ?? {})) {
        const node = this.graph.getCellById(id);
        if (node?.isNode() && Number.isFinite(position.x) && Number.isFinite(position.y)) {
          node.position(position.x, position.y);
        }
      }
      for (const edge of this.graph.getEdges()) {
        if (!this.edgeViews.has(edge.id) || this.isDecorativeEdge(edge.id)) continue;
        edge.setVertices(
          (layout.edgeVertices?.[edge.id] ?? [])
            .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
            .slice(0, DESIGN_LAYOUT_MAX_EDGE_VERTICES)
            .map((point) => ({ ...point }))
        );
      }
      if (
        layout.viewport &&
        Number.isFinite(layout.viewport.scale) &&
        layout.viewport.scale > 0 &&
        Number.isFinite(layout.viewport.x) &&
        Number.isFinite(layout.viewport.y)
      ) {
        this.graph.zoomTo(layout.viewport.scale);
        this.graph.translate(layout.viewport.x, layout.viewport.y);
      }
    } finally {
      this.restoringLayout = false;
    }
  }
  clientToLocal(clientX: number, clientY: number): NodePosition {
    if (!this.graph) return { x: 0, y: 0 };
    return this.graph.clientToLocal(clientX, clientY);
  }
  getNearestEdgeId(point: NodePosition): string | undefined {
    if (!this.graph) return undefined;
    let best: { id: string; distance: number } | undefined;
    for (const edge of this.graph.getEdges()) {
      // 装饰边不是真实连线，不能作为"贴边插入"的目标。
      if (!this.edgeViews.has(edge.id) || this.isDecorativeEdge(edge.id)) continue;
      const box = edge.getBBox();
      const dx = point.x - box.center.x;
      const dy = point.y - box.center.y;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { id: edge.id, distance };
    }
    return best && best.distance <= 120 ? best.id : undefined;
  }

  /** 该 id 是否是只渲染不入库的装饰边（GraphEdgeView.decorative）——各交互点的统一判据。 */
  private isDecorativeEdge(id: string): boolean {
    return Boolean(this.edgeViews.get(id)?.decorative);
  }

  private requestRename(nodeId: string): void {
    if (this.readOnly) return;
    const current = this.nodeViews.get(nodeId)?.label ?? '';
    // 不使用原生 window.prompt；未注入回调时不重命名，只记一条警告。
    const promptRename = this.promptRename;
    if (!promptRename) {
      console.warn('[kimpo-workflow] 节点重命名未提供输入回调，已忽略');
      return;
    }
    void promptRename(current)
      .then((value) => {
        // 取消 / 空白名称：保持原有行为，不触发重命名。
        if (value !== null && value.trim()) this.emit('renameNode', nodeId, value.trim());
      })
      .catch((err) => console.warn('[kimpo-workflow] 节点重命名输入失败', err));
  }

  private openContextMenu(
    event: { preventDefault(): void; clientX: number; clientY: number },
    cell: Cell | null
  ): void {
    event.preventDefault();
    this.closeContextMenu();
    if (!this.container) return;
    if (cell && this.graph && !this.graph.isSelected(cell)) {
      this.graph.cleanSelection();
      this.graph.select(cell);
    }
    const menu = document.createElement('div');
    menu.className = 'kimpo-workflow-context-menu';
    menu.dataset.testid = cell?.isNode() ? 'node-context-menu' : cell?.isEdge() ? 'edge-context-menu' : 'blank-context-menu';
    const add = (label: string, action: () => void, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', () => {
        action();
        this.closeContextMenu();
      });
      menu.appendChild(button);
    };
    if (cell?.isNode()) {
      add(this.messages.rename, () => this.requestRename(cell.id), this.readOnly);
      add(this.messages.copy, () => {
        this.clipboard = [cell.id];
        (globalThis as Record<string, unknown>)[CLIPBOARD_KEY] = [cell.id];
      });
      add(this.messages.delete, () => this.emit('deleteSelection'), this.readOnly);
    } else if (cell?.isEdge()) {
      add(
        this.messages.editVertices,
        () => {
          if (this.readOnly) return;
          // 同上方 'edge:click' 处置——右键菜单"编辑顶点"是这两个工具的另一个入口，同样只保留
          // target-arrowhead，保持"连线永远只在下游端画箭头"这条规则在两个入口上一致。
          (cell as Edge).addTools([{ name: 'vertices' }, { name: 'target-arrowhead' }]);
        },
        this.readOnly
      );
      add(
        this.messages.clearVertices,
        () => {
          if (this.readOnly) return;
          (cell as Edge).setVertices([]);
        },
        this.readOnly
      );
      add(this.messages.deleteEdge, () => this.emit('deleteSelection'), this.readOnly);
    } else {
      const ids = ((globalThis as Record<string, unknown>)[CLIPBOARD_KEY] as string[] | undefined) ?? [];
      add(this.messages.paste, () => this.emit('paste', ids), this.readOnly || !ids.length);
      add(this.messages.fit, () => this.zoomToFit());
      add(this.messages.zoom100, () => this.zoomTo100());
    }
    const bounds = this.container.getBoundingClientRect();
    menu.style.left = `${event.clientX - bounds.left}px`;
    menu.style.top = `${event.clientY - bounds.top}px`;
    this.container.appendChild(menu);
    this.contextMenu = menu;
  }

  private closeContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }
}
