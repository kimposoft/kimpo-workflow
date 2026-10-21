/**
 * graph/svg-adapter.ts —— SvgGraphAdapter：GraphPort 的最小实现。
 *
 * 不依赖 X6：本文件只用原生 SVG DOM API（createElementNS）画三类
 * 节点矩形 + 直线连线 + 拖拽/连接手柄 + 点击选中，不依赖 @antv/x6，也不依赖 Vue——GraphPort
 * 消费方通过普通 DOM ref 把容器交给 mount()，画布内部生命周期与 Vue 响应式系统完全解耦，
 * 与 X6GraphAdapter 可互换，designer/ 组件不感知具体实现。
 *
 * 渲染策略：setNodes/setEdges/setSelection 触发一次全量重绘（clear + 重建 DOM）。适用场景节点数
 * 量很小，全量重绘足够快且实现简单可靠；大图的虚拟化/增量 diff 不在本实现范围内。
 *
 * 拖拽预览：pointermove 期间只更新 `liveDragPosition`（不触发 setNodes、不产生 Command），
 * mouseup 才清空并通过 nodeMoveEnd 事件上报最终位置。
 *
 * 视口（缩放/平移/适应视图）：renderNode/renderEdge 里的节点/边坐标
 * 自始至终是未缩放的"画布坐标"，缩放/平移只通过给根 <svg> 设置 viewBox 属性实现（见
 * setViewport()），不改变任何节点/边的绘制坐标，也就不需要为此重绘。真正需要小心的是
 * handlePointerMove 里节点拖拽的屏幕像素位移 -> 画布坐标位移换算，缩放后两者不再是 1:1，
 * 必须除以当前 scale（见该方法注释）；hitTestNode 用 document.elementFromPoint 是纯屏幕空间
 * 操作，不受 viewBox 影响，无需改动。视口纯计算逻辑（clamp/光标锚点/fit bounds/坐标换算）
 * 收在 designer/canvas/viewport.ts，本文件只负责状态持有 + DOM 落地 + 拖拽换算这三件事。
 */
import type { GraphEdgeView, GraphNodeView, GraphPort, GraphPortEvents } from './port';
import type { NodePosition } from '../model/store';
// 配色直接消费 model/design-tokens.ts 的唯一色板权威源，不自行维护独立配色表——与 X6 画布
// （graph/x6-adapter.ts）共用同一份节点类型色，防止两块画布视觉跑偏。
import { NODE_TYPE_TOKENS, PRIMARY_COLOR } from '../model/design-tokens';
// viewport（缩放/平移）类型。只 import 类型，不 import 运行时代码/
// 常量——graph/ 是"唯一 X6 适配边界"，不应反向依赖 designer/ 的运行时逻辑；类型共享不产生真实
// 模块运行时依赖，本文件本就有先例（上面的 NodePosition 来自 model/store.ts），见
// designer/canvas/viewport.ts 文件头注释。
import type { Bounds, ViewportState } from '../designer/canvas/viewport';

const NODE_WIDTH = 160;
const NODE_HEIGHT = 64;
/** 分支点/汇合点是编译面结构节点（非自由拖拽的业务节点），画布上用更小的方形菱块与普通业务
 * 节点区分（产品层看到的是一个完整分支结构块，split/join 本身只是结构锚点，不是需要展示大段
 * 文案的业务节点）。 */
const BRANCH_NODE_SIZE = 56;
const CONNECTOR_RADIUS = 6;
/** 判定"点击"与"拖拽"的最小位移阈值（px），小于此值的 pointerdown+pointerup 视为点击选中。 */
const DRAG_THRESHOLD_PX = 4;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 按 NODE_TYPE_TOKENS 的某一字段（iconBg/iconColor）派生出 Record<节点类型, 颜色值>——
 * NODE_TYPE_FILL/NODE_TYPE_STROKE 均由此派生，不手写第二份颜色字面量。 */
function pickTokenField(field: 'iconBg' | 'iconColor'): Record<GraphNodeView['type'], string> {
  const result = {} as Record<GraphNodeView['type'], string>;
  for (const type of Object.keys(NODE_TYPE_TOKENS) as GraphNodeView['type'][]) {
    result[type] = NODE_TYPE_TOKENS[type][field];
  }
  return result;
}
/** 各节点类型的画布配色——直接消费 design-tokens.ts NODE_TYPE_TOKENS（唯一色板权威源，见本
 * 文件头 import 注释），fill=iconBg、stroke=iconColor。
 *
 * 暗色：这两张表固定读 NODE_TYPE_TOKENS（=LIGHT_PALETTE.nodeTypes，恒为亮色），未接暗色——
 * 本文件（SvgGraphAdapter）当前没有任何运行期消费方，见下方
 * ensureGlobalStyle 头注释"本文件无运行期消费方"一节，暗色适配留给"若未来这个类重新有了
 * 消费方"时再处理，不是漏改。 */
const NODE_TYPE_FILL: Record<GraphNodeView['type'], string> = pickTokenField('iconBg');
const NODE_TYPE_STROKE: Record<GraphNodeView['type'], string> = pickTokenField('iconColor');
/** 需要用"菱形结构锚点"渲染的节点类型（其余走普通矩形，见 renderNode）。
 *
 * 'branch_split'/'branch_join' 节点类型已退役，GraphNodeView['type']（=NodeKind）不再承认这两个
 * 字面量——本集合类型放宽为 Set<string>（而不是 Set<GraphNodeView['type']>）以便继续持有这两个
 * 已退役字面量用于比较，实际运行时恒不命中（没有任何节点会产出这两个 type），见 renderNode/
 * nodeSize 消费处。 */
const DIAMOND_NODE_TYPES = new Set<string>(['branch_split', 'branch_join']);

const STYLE_MARKER = 'data-kimpo-workflow-graph-style';

/**
 * 全局只注入一次的最小样式表（选中态描边、只读态手柄隐藏）。
 *
 * 暗色支持：这份 <style> 文本里的颜色写成 `rgb(var(--宿主配色token, 回落三元组))`——它是真正的
 * CSS <style> 标签内容，走标准 CSSOM 级联，宿主在 html.dark 上翻转变量值时这里天然跟着变，
 * 不需要额外接 JS。回落三元组即亮色下的默认色值。
 *
 * 🔴 本文件无运行期消费方：graph/svg-adapter.ts 的 SvgGraphAdapter 当前没有被任何真实挂载路径
 * 实例化——真正挂到 DesignerCanvas.vue 的是 graph/x6-adapter.ts 的 X6GraphAdapter（见该组件
 * `new X6GraphAdapter(...)`），SvgGraphAdapter 只在 svg-adapter.test.ts / designer/canvas/
 * svg-adapter-viewport.test.ts 两处单测里被直接 new 出来。因此 renderNode() 里直接 setAttribute
 * 到 rect/diamond 的 NODE_TYPE_FILL/NODE_TYPE_STROKE、以及 ensureArrowMarker() 里的箭头填充色
 * 仍是亮色——它们是 SVG 呈现属性直接赋值（同 x6-adapter.ts 的处境："SVG 渲染面不吃 CSS 变量，
 * 须算成实色字符串传入"），要接暗色需要 JS 侧按当前 palette 算出具体 rgb() 字符串（同 x6 侧
 * 改法）；由于本类无运行期消费方，只同步了上面这份 <style> 文本，SVG 属性直绘部分留给"若未来
 * 这个类重新有了消费方"时再按 x6 侧同款手法处理。
 */
function ensureGlobalStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.head.querySelector(`style[${STYLE_MARKER}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = `
    .kimpo-wf-graph { background: rgb(var(--layout-bg-color, 250 250 250)); touch-action: none; }
    .kimpo-wf-graph__node { cursor: grab; }
    .kimpo-wf-graph__node.is-selected rect { stroke-width: 3; }
    .kimpo-wf-graph__node.has-issues rect { stroke: rgb(var(--error-color, 245 34 45)); stroke-dasharray: 4 2; }
    .kimpo-wf-graph__node-label { font-size: 13px; fill: rgb(var(--base-text-color, 31 31 31)); pointer-events: none; user-select: none; }
    .kimpo-wf-graph__connector { fill: rgb(var(--container-bg-color, 255 255 255)); stroke: rgb(var(--text-hint-color, 140 140 140)); cursor: crosshair; }
    .kimpo-wf-graph.is-readonly .kimpo-wf-graph__connector { display: none; }
    .kimpo-wf-graph.is-readonly .kimpo-wf-graph__node { cursor: default; }
    .kimpo-wf-graph__edge { stroke: rgb(var(--text-hint-color, 140 140 140)); stroke-width: 1.5; fill: none; cursor: pointer; }
    .kimpo-wf-graph__edge.is-else { stroke-dasharray: 5 3; }
    .kimpo-wf-graph__edge.is-selected { stroke: ${PRIMARY_COLOR}; stroke-width: 2.5; }
    .kimpo-wf-graph__edge.has-issues { stroke: rgb(var(--error-color, 245 34 45)); }
    .kimpo-wf-graph__edge-hit { stroke: transparent; stroke-width: 12; fill: none; cursor: pointer; }
    .kimpo-wf-graph__edge-label { font-size: 11px; fill: rgb(var(--text-secondary-color, 89 89 89)); user-select: none; }
  `;
  document.head.appendChild(style);
}

/** 按节点类型返回画布尺寸（普通业务节点 160×64；分支点/汇合点结构锚点 56×56，见
 * BRANCH_NODE_SIZE 注释）。renderNode/renderEdge 共用同一份口径，保证连线锚点与节点边框
 * 精确重合。 */
function nodeSize(type: GraphNodeView['type']): { width: number; height: number } {
  if (DIAMOND_NODE_TYPES.has(type)) return { width: BRANCH_NODE_SIZE, height: BRANCH_NODE_SIZE };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/** 计算从矩形中心沿 (dx,dy) 方向到矩形边界的交点（用于把连线两端锚定在节点框边缘而不是中心）。 */
function pointOnRectBorder(cx: number, cy: number, halfW: number, halfH: number, dx: number, dy: number): NodePosition {
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

interface DragState {
  nodeId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originPosition: NodePosition;
  moved: boolean;
}

interface ConnectState {
  fromNodeId: string;
  pointerId: number;
}

export class SvgGraphAdapter implements GraphPort {
  private container: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private edgesLayer: SVGGElement | null = null;
  private nodesLayer: SVGGElement | null = null;

  private nodeViews = new Map<string, GraphNodeView>();
  private edgeViews = new Map<string, GraphEdgeView>();
  private selectedNodeIds = new Set<string>();
  private selectedEdgeIds = new Set<string>();
  private readOnly = false;

  /** 拖拽中节点的实时位置覆盖（不写回 nodeViews，mouseup 后清空，见文件头注释）。 */
  private liveDragPosition: NodePosition | null = null;
  private dragState: DragState | null = null;
  private connectState: ConnectState | null = null;

  /** 当前视口状态（缩放/平移，画布本地视图态，不影响 nodeViews/edgeViews 本身的坐标系——
   * 详见 designer/canvas/viewport.ts 文件头"视口变换是本地视图态"）。默认恒等映射
   * （scale=1, x=y=0），此时不设置 viewBox 属性，直接沿用 SVG "width/height=100%、无 viewBox"
   * 时浏览器的默认 1:1 像素映射。 */
  private viewport: ViewportState = { scale: 1, x: 0, y: 0 };

  private handlers: { [K in keyof GraphPortEvents]: Set<GraphPortEvents[K]> } = {
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
    // 最小实现不支持标记珠悬停（见 GraphEdgeView.marker
    // 注释"svg-adapter.ts 不读取本字段"），这两个事件永远不会被触发，仅为满足穷举
    // handlers 结构而声明。
    edgeMarkerHover: new Set(),
    edgeMarkerLeave: new Set()
  };

  private boundPointerMove = (event: PointerEvent) => this.handlePointerMove(event);
  private boundPointerUp = (event: PointerEvent) => this.handlePointerUp(event);

  mount(container: HTMLElement): void {
    if (this.container) throw new Error('[graph/svg-adapter] already mounted; call unmount() first');
    ensureGlobalStyle();
    this.container = container;
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('class', 'kimpo-wf-graph');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'workflow designer canvas');

    this.edgesLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    this.nodesLayer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    svg.appendChild(this.edgesLayer);
    svg.appendChild(this.nodesLayer);

    // 点击空白画布 => 清除选中（node/edge 均置 null）。
    svg.addEventListener('pointerdown', (event) => {
      if (event.target === svg) {
        this.emit('nodeSelect', null);
        this.emit('edgeSelect', null);
      }
    });

    container.appendChild(svg);
    this.svg = svg;
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp);
    this.render();
  }

  unmount(): void {
    window.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('pointerup', this.boundPointerUp);
    if (this.svg && this.container) {
      this.container.removeChild(this.svg);
    }
    this.svg = null;
    this.edgesLayer = null;
    this.nodesLayer = null;
    this.container = null;
    for (const set of Object.values(this.handlers)) set.clear();
  }

  setNodes(nodes: GraphNodeView[]): void {
    this.nodeViews = new Map(nodes.map((n) => [n.id, n]));
    this.render();
  }

  setEdges(edges: GraphEdgeView[]): void {
    this.edgeViews = new Map(edges.map((e) => [e.id, e]));
    this.render();
  }

  setSelection(nodeIds: string[], edgeIds: string[]): void {
    this.selectedNodeIds = new Set(nodeIds);
    this.selectedEdgeIds = new Set(edgeIds);
    this.render();
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.render();
  }

  // —— viewport（缩放/平移/适应视图）——不在 GraphPort 接口里，调用方需持有具体的
  // SvgGraphAdapter 类型（而非 GraphPort 接口）来调用这几个方法。X6GraphAdapter 用 X6 自己的
  // 原生 zoom/pan API，两者的 viewport 接线各自独立。

  /** 读取当前视口状态：DesignerCanvas.vue 用于缩放按钮/滚轮缩放的锚点计算、拖拽平移计算的
   * 入参（见 designer/canvas/viewport.ts zoomAtPoint/panBy）。 */
  getViewport(): ViewportState {
    return this.viewport;
  }

  /**
   * 应用新的视口状态：落地到 <svg> 的 viewBox 属性。节点/边的坐标系（renderNode/renderEdge
   * 里用的 position）自始至终是未缩放的画布坐标，缩放/平移只体现在 viewBox 这一层——因此本方法
   * 不触发 render()，也不需要重算任何节点/边的坐标。
   *
   * 契约：调用方（DesignerCanvas.vue）负责按 designer/canvas/viewport.ts 的
   * MIN_SCALE/MAX_SCALE 夹紧 scale，本方法不做二次校验。
   */
  setViewport(state: ViewportState): void {
    this.viewport = state;
    if (!this.svg || !this.container) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    // 容器尚未完成布局（如测试环境/隐藏 tab）：viewport 状态已记录，viewBox 留到下次有效尺寸时
    // 再落地，避免写入 "0 0 NaN NaN" 这种无效属性值。
    if (width <= 0 || height <= 0) return;
    this.svg.setAttribute('viewBox', `${state.x} ${state.y} ${width / state.scale} ${height / state.scale}`);
  }

  /** 计算当前所有节点的包围盒（画布坐标系），供 fit-to-view 使用；无节点时返回 null。按节点
   * 类型尺寸（nodeSize，与 renderNode 同一口径）精确计算，不是粗略估算。 */
  getContentBounds(): Bounds | null {
    if (this.nodeViews.size === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of this.nodeViews.values()) {
      const { width, height } = nodeSize(node.type);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }
    return { minX, minY, maxX, maxY };
  }

  on<K extends keyof GraphPortEvents>(event: K, handler: GraphPortEvents[K]): () => void {
    this.handlers[event].add(handler);
    return () => {
      this.handlers[event].delete(handler);
    };
  }

  private emit<K extends keyof GraphPortEvents>(event: K, ...args: Parameters<GraphPortEvents[K]>): void {
    for (const handler of this.handlers[event]) {
      (handler as (...a: Parameters<GraphPortEvents[K]>) => void)(...args);
    }
  }

  /** 供测试/内部使用：读取某节点当前渲染位置（含拖拽中的实时覆盖）。 */
  private effectivePosition(node: GraphNodeView): NodePosition {
    if (this.dragState && this.dragState.nodeId === node.id && this.liveDragPosition) {
      return this.liveDragPosition;
    }
    return node.position;
  }

  private render(): void {
    if (!this.svg || !this.nodesLayer || !this.edgesLayer) return;
    this.svg.classList.toggle('is-readonly', this.readOnly);

    // 全量重绘：先清空两层再重建（适用场景节点数很小，见文件头注释）。
    this.edgesLayer.replaceChildren();
    this.nodesLayer.replaceChildren();

    for (const edge of this.edgeViews.values()) {
      const from = this.nodeViews.get(edge.from);
      const to = this.nodeViews.get(edge.to);
      if (!from || !to) continue; // 悬空引用：画布不渲染，交给 quickClientValidate 提示
      this.renderEdge(edge, from, to, this.effectivePosition(from), this.effectivePosition(to));
    }
    for (const node of this.nodeViews.values()) {
      this.renderNode(node, this.effectivePosition(node));
    }
  }

  private renderEdge(edge: GraphEdgeView, fromNode: GraphNodeView, toNode: GraphNodeView, fromPos: NodePosition, toPos: NodePosition): void {
    if (!this.edgesLayer) return;
    const fromSize = nodeSize(fromNode.type);
    const toSize = nodeSize(toNode.type);
    const fromCenter = { x: fromPos.x + fromSize.width / 2, y: fromPos.y + fromSize.height / 2 };
    const toCenter = { x: toPos.x + toSize.width / 2, y: toPos.y + toSize.height / 2 };
    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;
    const p1 = pointOnRectBorder(fromCenter.x, fromCenter.y, fromSize.width / 2, fromSize.height / 2, dx, dy);
    const p2 = pointOnRectBorder(toCenter.x, toCenter.y, toSize.width / 2, toSize.height / 2, -dx, -dy);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-edge-id', edge.id);
    group.setAttribute('data-from-node-id', edge.from);
    group.setAttribute('data-to-node-id', edge.to);

    // 透明加粗的命中区域，让细线也容易点中。
    const hit = document.createElementNS(SVG_NS, 'line');
    hit.setAttribute('class', 'kimpo-wf-graph__edge-hit');
    hit.setAttribute('x1', String(p1.x));
    hit.setAttribute('y1', String(p1.y));
    hit.setAttribute('x2', String(p2.x));
    hit.setAttribute('y2', String(p2.y));
    hit.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.emit('edgeSelect', edge.id);
    });
    group.appendChild(hit);

    const line = document.createElementNS(SVG_NS, 'line');
    const classes = ['kimpo-wf-graph__edge'];
    if (edge.isElseRoute) classes.push('is-else');
    if (this.selectedEdgeIds.has(edge.id)) classes.push('is-selected');
    if (edge.hasIssues) classes.push('has-issues');
    line.setAttribute('class', classes.join(' '));
    line.setAttribute('x1', String(p1.x));
    line.setAttribute('y1', String(p1.y));
    line.setAttribute('x2', String(p2.x));
    line.setAttribute('y2', String(p2.y));
    line.setAttribute('marker-end', 'url(#kimpo-wf-arrow)');
    group.appendChild(line);

    if (edge.label) {
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'kimpo-wf-graph__edge-label');
      label.setAttribute('x', String((p1.x + p2.x) / 2));
      label.setAttribute('y', String((p1.y + p2.y) / 2 - 4));
      label.textContent = edge.label;
      group.appendChild(label);
    }

    this.ensureArrowMarker();
    this.edgesLayer.appendChild(group);
  }

  private ensureArrowMarker(): void {
    if (!this.svg || this.svg.querySelector('#kimpo-wf-arrow')) return;
    const defs = document.createElementNS(SVG_NS, 'defs');
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', 'kimpo-wf-arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    // SVG 呈现属性直接赋值，不走 ensureGlobalStyle 的 CSSOM 路径；本类无运行期消费方，暂未
    // 接暗色（见 ensureGlobalStyle 头注释"本文件无运行期消费方"）。
    path.setAttribute('fill', '#8c8c8c');
    marker.appendChild(path);
    defs.appendChild(marker);
    this.svg.insertBefore(defs, this.svg.firstChild);
  }

  private renderNode(node: GraphNodeView, position: NodePosition): void {
    if (!this.nodesLayer) return;
    const { width, height } = nodeSize(node.type);
    const isDiamond = DIAMOND_NODE_TYPES.has(node.type);
    const group = document.createElementNS(SVG_NS, 'g');
    const classes = ['kimpo-wf-graph__node'];
    if (this.selectedNodeIds.has(node.id)) classes.push('is-selected');
    if (node.hasIssues) classes.push('has-issues');
    group.setAttribute('class', classes.join(' '));
    group.setAttribute('data-node-id', node.id);
    group.setAttribute('data-node-type', node.type);
    group.setAttribute('transform', `translate(${position.x}, ${position.y})`);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', node.label);

    if (isDiamond) {
      // 分支点/汇合点：菱形结构锚点（BRANCH_NODE_SIZE 正方形沿对角线旋转 45°），与普通业务
      // 节点的矩形在视觉上明确区分（这两个节点不是"业务节点"，是结构锚点）。
      const half = width / 2;
      const diamond = document.createElementNS(SVG_NS, 'polygon');
      diamond.setAttribute(
        'points',
        `${half},0 ${width},${half} ${half},${height} 0,${half}`
      );
      diamond.setAttribute('fill', NODE_TYPE_FILL[node.type]);
      diamond.setAttribute('stroke', NODE_TYPE_STROKE[node.type]);
      diamond.setAttribute('stroke-width', '1.5');
      group.appendChild(diamond);
    } else {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('width', String(width));
      rect.setAttribute('height', String(height));
      rect.setAttribute('rx', '8');
      rect.setAttribute('fill', NODE_TYPE_FILL[node.type]);
      rect.setAttribute('stroke', NODE_TYPE_STROKE[node.type]);
      rect.setAttribute('stroke-width', '1.5');
      group.appendChild(rect);
    }

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'kimpo-wf-graph__node-label');
    label.setAttribute('x', String(width / 2));
    label.setAttribute('y', String(height / 2));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    if (isDiamond) label.style.fontSize = '11px'; // 菱形块更小，缩小字号避免文字溢出
    label.textContent = node.label;
    group.appendChild(label);

    group.addEventListener('pointerdown', (event) => this.handleNodePointerDown(event, node.id, position));
    // 键盘可达最小面：聚焦节点后回车/空格等价于点击选中。
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.emit('nodeSelect', node.id);
      }
    });

    // 分支点/汇合点不提供自由连接手柄（画布约束：split/join 不可单独删/不可跨块连线——
    // 它们的出入边只能通过结构块路线操作产生，不允许用户在画布上随手拖一条连线到/从它们）。
    if (!this.readOnly && !isDiamond) {
      const connector = document.createElementNS(SVG_NS, 'circle');
      connector.setAttribute('class', 'kimpo-wf-graph__connector');
      connector.setAttribute('cx', String(width + CONNECTOR_RADIUS));
      connector.setAttribute('cy', String(height / 2));
      connector.setAttribute('r', String(CONNECTOR_RADIUS));
      connector.setAttribute('aria-label', 'connect from this node');
      connector.addEventListener('pointerdown', (event) => this.handleConnectorPointerDown(event, node.id));
      group.appendChild(connector);
    }

    this.nodesLayer.appendChild(group);
  }

  private handleNodePointerDown(event: PointerEvent, nodeId: string, position: NodePosition): void {
    event.stopPropagation();
    if (this.readOnly) {
      this.emit('nodeSelect', nodeId);
      return;
    }
    this.dragState = {
      nodeId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originPosition: position,
      moved: false
    };
    this.liveDragPosition = position;
  }

  private handleConnectorPointerDown(event: PointerEvent, nodeId: string): void {
    event.stopPropagation();
    if (this.readOnly) return;
    this.connectState = { fromNodeId: nodeId, pointerId: event.pointerId };
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.dragState && event.pointerId === this.dragState.pointerId) {
      const dx = event.clientX - this.dragState.startClientX;
      const dy = event.clientY - this.dragState.startClientY;
      // "是否算拖拽"的位移阈值判定用屏幕像素（物理鼠标位移），与当前缩放无关。
      if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
        this.dragState.moved = true;
      }
      // 屏幕像素位移换算成画布坐标位移：缩放后 1 屏幕像素不再等于 1 画布单位，必须除以当前
      // viewport.scale 才能让节点在视觉上"跟手"（同款换算见 designer/canvas/viewport.ts
      // screenDeltaToCanvasDelta，这里内联而非 import 运行时函数，理由见本文件头 import 注释）。
      const scale = this.viewport.scale;
      this.liveDragPosition = {
        x: this.dragState.originPosition.x + dx / scale,
        y: this.dragState.originPosition.y + dy / scale
      };
      this.render();
    }
    // 连接手柄拖拽过程中的临时预览线省略（不影响功能正确性，只是少一份视觉反馈）；
    // 真实连接判定发生在 pointerup 时按落点坐标命中目标节点。
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.dragState && event.pointerId === this.dragState.pointerId) {
      const { nodeId, moved } = this.dragState;
      const finalPosition = this.liveDragPosition ?? this.dragState.originPosition;
      this.dragState = null;
      this.liveDragPosition = null;
      if (moved) {
        this.emit('nodeMoveEnd', nodeId, finalPosition);
      } else {
        this.emit('nodeSelect', nodeId);
      }
      this.render();
    }
    if (this.connectState && event.pointerId === this.connectState.pointerId) {
      const target = this.hitTestNode(event.clientX, event.clientY);
      const fromNodeId = this.connectState.fromNodeId;
      this.connectState = null;
      if (target && target !== fromNodeId) {
        this.emit('connect', fromNodeId, target);
      }
    }
  }

  /** 按屏幕坐标命中测试节点（连接手柄拖拽释放时用来判定落在哪个目标节点上）。 */
  private hitTestNode(clientX: number, clientY: number): string | null {
    if (!this.svg) return null;
    const el = document.elementFromPoint(clientX, clientY);
    const groupEl = el?.closest('[data-node-id]');
    return groupEl?.getAttribute('data-node-id') ?? null;
  }
}
