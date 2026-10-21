/**
 * designer/stencil/drag-preview.ts —— 从节点库往画布拖节点时，跟着指针走的那张"拖拽预览图"
 * （HTML5 DnD 的 drag image）的构建器。
 *
 * 预览图不是节点库条目本身的样子（图标 + 类型名的一行按钮），而是
 * **该节点落到画布上之后的样子**（白底圆角卡 / 胶囊 + 彩色图标块 + 标题 + 摘要），且指针位于
 * 图样正中——与 stencil-drop-placement.ts computeStencilDropPosition"松手后节点中心对准指针"是
 * 同一个对齐口径，因此拖动过程中看到的图样与松手后真正出现的节点在位置、大小上都重合。
 *
 * 为什么是 HTML 而不是复用 X6 的 SVG 节点：拖拽预览图必须在 dragstart 派发的同步过程里交给
 * setDragImage，此时画布上还没有这个节点，也不应该为了拍一张快照去临时往 X6 图里塞一个节点
 * （会进撤销栈 / 触发选中 / 触发自动保存等一串副作用）。所以在画布之外用 DOM 复刻同一张卡，
 * 几何与字号一律读 graph/x6-adapter.ts 导出的 nodeDimensions / NODE_CARD_GEOMETRY，配色读同一份
 * CanvasPalette——不在本文件里另写一套尺寸或颜色（NODE_CARD_GEOMETRY 与 applyNodeVisual 的一致性
 * 由 x6-adapter.card-geometry.test.ts 锁定）。
 *
 * 为什么所有尺寸手工乘 scale 而不用 CSS transform：浏览器抓 drag image 时对"自身带 transform
 * 的元素"处理不一致（常见表现是按未变换的布局盒裁切，放大时被截掉一圈）；逐项乘系数得到的是
 * 真实布局尺寸，各浏览器抓图结果一致。
 *
 * 本文件只负责"造出这张图的 DOM"，不碰 dataTransfer、不负责挂载与回收——那是
 * StencilPanel.vue onDragStart 的职责（同既有分工：拖拽本身归面板，建节点归消费方）。
 */
import type { NodeKind } from '../../model';
import type { CanvasPalette } from '../../model/design-tokens';
import { NODE_ICONS, NODE_SHAPE_FAMILY } from '../../model/node-visual';
import { NODE_CARD_GEOMETRY, nodeDimensions } from '../../graph/x6-adapter';

export interface NodeDragPreviewInput {
  kind: NodeKind;
  /** 标题：应为"落下后画布上显示的名字"（如"办理 2"），由调用方算好传入。 */
  label: string;
  /** 摘要：落下后节点第二行的说明文字（如"未设置办理人"）；空串/缺省则按单行卡画。 */
  summary?: string;
  /** 画布当前缩放系数（1 = 100%）。预览图按它等比放缩，才能与落下后的节点一样大。 */
  scale?: number;
  palette: CanvasPalette;
}

export interface NodeDragPreview {
  element: HTMLElement;
  /** 已乘过 scale 的真实像素尺寸，调用方据此把指针锚在正中（width/2, height/2）。 */
  width: number;
  height: number;
}

/** 缩放系数的防御性夹取：画布缩放范围之外的值（或 NaN/0/负数）一律夹回，避免造出一张 0 尺寸
 * 或巨大无比的预览图。上下限比画布工具条允许的缩放范围略宽，只作兜底不作业务限制。 */
const MIN_PREVIEW_SCALE = 0.2;
const MAX_PREVIEW_SCALE = 4;

export function normalizePreviewScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, scale));
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 单行文字盒的行高系数：文字盒高度 = 字号 × 该系数，再按"行中心落在 refY × 节点高度"定位，
 * 对应 applyNodeVisual 里 textVerticalAnchor:'middle' 的语义。 */
const LINE_HEIGHT_RATIO = 1.3;

export function buildNodeDragPreview(input: NodeDragPreviewInput, doc: Document = document): NodeDragPreview {
  const g = NODE_CARD_GEOMETRY;
  const s = normalizePreviewScale(input.scale);
  const px = (value: number) => `${value * s}px`;
  const size = nodeDimensions(input.kind);
  const width = size.width * s;
  const height = size.height * s;
  const isCapsule = NODE_SHAPE_FAMILY[input.kind] === 'capsule';
  const colors = input.palette.nodeTypes[input.kind];
  const summary = (input.summary ?? '').trim();
  const hasSummary = summary.length > 0;

  // 卡片本体：默认态（未选中、无校验问题）的白底 + 中性灰描边，同 applyNodeVisual body。
  const card = doc.createElement('div');
  card.dataset.testid = 'stencil-drag-preview';
  card.dataset.nodeType = input.kind;
  card.style.cssText = [
    'position:relative',
    'box-sizing:border-box',
    'margin:0',
    'pointer-events:none',
    'overflow:hidden',
    `width:${width}px`,
    `height:${height}px`,
    `border:${px(g.strokeWidth)} solid ${input.palette.border}`,
    `border-radius:${isCapsule ? height / 2 : g.cardRadius * s}px`,
    `background:${input.palette.surface}`
  ].join(';');

  // 以下子元素的 left/top 都以"卡片外沿"为原点计算（与 X6 的 refX/refY 同一参照），而 absolute
  // 定位的参照是 padding box（边框内侧），故统一减掉一个边框宽度。
  const border = g.strokeWidth * s;

  const icon = NODE_ICONS[input.kind];
  if (icon) {
    const iconBg = doc.createElement('span');
    // 图标块无描边——与画布节点一致（applyNodeVisual 给 iconBg 显式写了 stroke:'none'，见该处注释）。
    iconBg.style.cssText = [
      'position:absolute',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      `left:${g.iconBgLeft * s - border}px`,
      `top:${(height - g.iconBgSize * s) / 2 - border}px`,
      `width:${px(g.iconBgSize)}`,
      `height:${px(g.iconBgSize)}`,
      `border-radius:${px(g.iconBgRadius)}`,
      `background:${colors.iconBg}`
    ].join(';');
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${g.iconViewBox} ${g.iconViewBox}`);
    svg.setAttribute('width', String(g.iconViewBox * s));
    svg.setAttribute('height', String(g.iconViewBox * s));
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', icon.d);
    path.setAttribute('fill', icon.fill ? colors.iconColor : 'none');
    path.setAttribute('stroke', icon.fill ? 'none' : colors.iconColor);
    // viewBox 会把描边随图标一起放缩，这里写未缩放的原值即可。
    path.setAttribute('stroke-width', icon.fill ? '0' : String(g.iconStrokeWidth));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    iconBg.appendChild(svg);
    card.appendChild(iconBg);
  }

  const makeLine = (text: string, fontSize: number, refY: number, extra: string[]): HTMLElement => {
    const line = doc.createElement('span');
    const lineHeight = fontSize * LINE_HEIGHT_RATIO * s;
    line.textContent = text;
    line.style.cssText = [
      'position:absolute',
      'display:block',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      `left:${g.labelStart * s - border}px`,
      `right:${g.summaryRightPadding * s - border}px`,
      `top:${height * refY - lineHeight / 2 - border}px`,
      `height:${lineHeight}px`,
      `line-height:${lineHeight}px`,
      `font-size:${px(fontSize)}`,
      ...extra
    ].join(';');
    return line;
  };

  const label = makeLine(input.label, g.labelFontSize, hasSummary ? g.labelRefYWithSummary : g.labelRefYSingle, [
    `font-weight:${g.labelFontWeight}`,
    `color:${input.palette.textPrimary}`
  ]);
  label.dataset.role = 'label';
  card.appendChild(label);

  if (hasSummary) {
    const summaryLine = makeLine(summary, g.summaryFontSize, g.summaryRefY, [`color:${input.palette.textSecondary}`]);
    summaryLine.dataset.role = 'summary';
    card.appendChild(summaryLine);
  }

  return { element: card, width, height };
}
