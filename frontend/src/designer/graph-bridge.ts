/**
 * designer/graph-bridge.ts —— WorkflowDocument ↔ 渲染器无关画布展示态（GraphNodeView/
 * GraphEdgeView/DesignLayout，见 ../graph/port.ts）之间的双向转换。
 *
 * 是画布桥接层里唯一持有 i18n 的模块：GraphNodeView.label 的"类型名 + 序号"兜底需要把 designer/nodes
 * 注册表登记的四语键（labelKey/NodeSummary.key）求值成当下语言的文案——model/ 与 designer/nodes/
 * 两层刻意不持有 i18n（不认识"当前语言"这个概念，见 designer/nodes/types.ts NodeSummary
 * 注释），本文件是它们与"业务话文案"之间唯一的转换点。GraphEdgeView.label 只取连线名称、不需要
 * 翻译（见下方 toGraphEdges 注释），持有 i18n 只是因为 toGraphNodes 需要。
 *
 * DesignLayout 的双向转换（layoutFromDocument / applyLayoutToDocument）与业务字段无关，是纯粹
 * 的"画布展示态 ⇄ 文档持久化字段"搬运——位置/折点本就是 WorkflowNode.position_x/position_y、
 * WorkflowLink.vertices 字段（对齐后端 model.Node/model.Link，见 document.ts 注释"画布坐标，
 * 引擎不关心，仅设计器读写、随文档整体保存"），这里只是把它们从"文档形状"搬到"DesignLayout
 * 形状"，反之亦然。
 */
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { ApproveConfig, DesignLayout, Point, WorkflowDocument } from '../model';
import type { GraphEdgeView, GraphNodeView } from '../graph';
import type { NodeSummary } from './nodes/registry';
import { nextOrdinalForKind, typeOrdinalName } from '../model/node-naming';
import type { WorkflowDocumentState } from '../model/document-state';

/** 连线名称珠中点显示的字符数上限（画布中点珠子只认名称）：超过
 * 这个长度截断为前 8 个字符 + '…'，完整名称走 marker.tooltip（悬停气泡），不在珠子本体上把
 * 至多 20 字的全名都挤出来。 */
const EDGE_NAME_MARKER_MAX_CHARS = 8;

/** 「不通过并结束流程」装饰边的 id 前缀：与文档连线 id、X6 拖拽预览线 'x6-temp-'
 * 都不冲突；完整 id = 前缀 + 审批节点 id + '-' + 按钮 id，同一按钮恒得同一 id，按钮配置改了 setEdges
 * 走"更新"而不是删了重建。 */
export const END_FLOW_DECORATIVE_EDGE_PREFIX = 'x6-deco-endflow-';

/** 按真实字符数截断（同 model/document-state.ts updateLinkName 的既定口径：Array.from(str)
 * .length，不按 UTF-16 code unit 长度，避免代理对被从中间切断），超出部分用 '…' 代替。 */
function truncateForMarker(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

export interface ToGraphNodesOptions {
  i18n: PluginI18n;
  /** 节点 id -> 该节点当前是否存在校验问题（由 model/validate-map.ts groupIssues().byNode 产出，
   * 这里只关心"有没有"，不关心具体问题列表——具体列表是属性面板的消费面）。 */
  issuesByNode?: Record<string, unknown>;
  /** 节点 id -> 摘要（designer/nodes 各类型 summarize() 的结果），undefined 表示该节点当前
   * 没有值得摘要的配置。summaries 由调用方按文档逐节点调用 registry 的 summarize() 算出——
   * graph-bridge 本身不遍历 registry，只负责把已经算好的 key+params 求值成文案。 */
  summaries?: Record<string, NodeSummary | undefined>;
}

/**
 * toGraphNodes —— 把文档节点清单转换为画布展示态。label 优先取 WorkflowNode.name（设计者自己
 * 改过的名字），缺省时退化为"类型名 + 序号"（如"办理 2"）：类型名经 labelKey 求值，序号按
 * 节点在 doc.nodes 里出现的顺序、同类型内从 1 开始计数——与新建节点顺序一致（addNode 是
 * push 到数组末尾），不是画布上的视觉行号。
 *
 * 序号算法与拼接规则调用 model/node-naming.ts 的 nextOrdinalForKind/typeOrdinalName——与
 * WorkflowDocumentState.addNode() 新建节点时落库的默认名共用同一份实现，避免两处分叉。这里对
 * 每个节点用 `doc.nodes.slice(0, index)` 取"它之前的节点"喂给 nextOrdinalForKind（第 i 个
 * 节点的序号 = 它之前同类型节点数 + 1）。
 */
export function toGraphNodes(doc: WorkflowDocument, options: ToGraphNodesOptions): GraphNodeView[] {
  return doc.nodes.map((node, index) => {
    const ordinal = nextOrdinalForKind(doc.nodes.slice(0, index), node.kind);
    const label = node.name?.trim() ? node.name : typeOrdinalName(options.i18n, node.kind, ordinal);

    const summary = options.summaries?.[node.id];

    return {
      id: node.id,
      type: node.kind,
      label,
      position: { x: node.position_x ?? 0, y: node.position_y ?? 0 },
      summary: summary ? options.i18n.t(summary.key, summary.params) : '',
      hasIssues: Boolean(options.issuesByNode?.[node.id])
    } satisfies GraphNodeView;
  });
}

export interface ToGraphEdgesOptions {
  i18n: PluginI18n;
  /** 引导线 id -> 该线当前是否存在校验问题，同 ToGraphNodesOptions.issuesByNode 的既定分工。 */
  issuesByLink?: Record<string, unknown>;
}

/**
 * toGraphEdges —— 把文档引导线清单转换为画布展示态。
 *
 * 🔴 画布上引导线中点的标识只认名称；有条件的线以线色区分，条件内容在选中引导线后的面板里看：
 *   - marker 只看 link.name：有名称（去空白后非空）就画名称珠，文字=名称，超过
 *     EDGE_NAME_MARKER_MAX_CHARS 个字符截断为"前 8 字+…"（完整名称走 tooltip，不在珠子本体
 *     显示全名，也不显示表达式原文）；没有名称就不画任何珠子，哪怕这条线配了条件；
 *   - hasCondition 字段独立表达"是否条件路线"，只驱动画布线色（见 graph/x6-adapter.ts
 *     applyEdgeVisual），与 marker/是否画珠完全解耦；
 *   - "条件配置不完整时显示待处理标识"目前不产出：当前文档模型里 condition_doc 只有"有"或
 *     "没有"两种状态（V4ExpressionField 不落库"半成品"表达式），hasCondition（等价于
 *     `Boolean(link.condition_doc)`）恒等于"条件已完整配置"，不存在这个中间态。graph/port.ts
 *     EdgeConditionMarker.kind==='condition' + configured===false 这套类型形状已预留，将来文档
 *     模型出现该中间态时只需在这里接上判据。
 *
 * label（纯文本字段，供 svg-adapter.ts 读取）：有名称＝名称本身，无名称＝undefined。
 */
export function toGraphEdges(doc: WorkflowDocument, options: ToGraphEdgesOptions): GraphEdgeView[] {
  const linkEdges = doc.links.map((link) => {
    const hasCondition = Boolean(link.condition_doc);
    const trimmedName = link.name?.trim();
    const hasName = Boolean(trimmedName);
    return {
      id: link.id,
      from: link.from,
      to: link.to,
      label: hasName ? trimmedName : undefined,
      marker: hasName
        ? {
            kind: 'name',
            shortLabel: truncateForMarker(trimmedName!, EDGE_NAME_MARKER_MAX_CHARS),
            tooltip: trimmedName!
          }
        : { kind: 'none', shortLabel: '', tooltip: '' },
      hasCondition,
      hasIssues: Boolean(options.issuesByLink?.[link.id])
    } satisfies GraphEdgeView;
  });
  return [...linkEdges, ...toEndFlowDecorativeEdges(doc)];
}

/**
 * toEndFlowDecorativeEdges —— 为审批节点每个「不通过并结束流程」（action=end_flow）按钮派生一条
 * 只渲染、不入库的装饰虚线：审批节点 → 按钮 end_node_id 指向的结束节点，线上标按钮名（仅设计态画布装饰）。
 *
 * 🔴 纯派生：每次由当前文档重算，绝不写回 doc.links（这些线不是连线，没有 link id，不参与保存、
 * 校验与选路）；按钮改名/改目标/删除后重新派生，画布 setEdges 据 id 增删更新。结束节点可以没有任何
 * 连线进入，这条虚线正是它在画布上唯一的"来路"示意。
 * 目标缺失（end_node_id 为空、指向已删节点、或指向的不是结束节点）时不画——配置问题由发布期校验
 * （N3_BUTTON_END_TARGET_*）负责提示，画布不凭空造线，也不因此抛错。
 */
function toEndFlowDecorativeEdges(doc: WorkflowDocument): GraphEdgeView[] {
  const nodeKindById = new Map(doc.nodes.map((node) => [node.id, node.kind]));
  const edges: GraphEdgeView[] = [];
  for (const node of doc.nodes) {
    if (node.kind !== 'approve') continue;
    const buttons = (node.config as Partial<ApproveConfig> | undefined)?.buttons;
    if (!Array.isArray(buttons)) continue;
    for (const button of buttons) {
      if (button?.action !== 'end_flow' || !button.end_node_id) continue;
      if (nodeKindById.get(button.end_node_id) !== 'end') continue;
      const name = button.name?.trim() ?? '';
      edges.push({
        id: `${END_FLOW_DECORATIVE_EDGE_PREFIX}${node.id}-${button.id}`,
        from: node.id,
        to: button.end_node_id,
        label: name || undefined,
        // 标签沿用连线名称珠的截断口径；装饰边不可交互，故不带 tooltip（完整名称在按钮配置面板里看）。
        marker: name
          ? { kind: 'endflow', shortLabel: truncateForMarker(name, EDGE_NAME_MARKER_MAX_CHARS), tooltip: '' }
          : { kind: 'none', shortLabel: '', tooltip: '' },
        decorative: true
      } satisfies GraphEdgeView);
    }
  }
  return edges;
}

/**
 * layoutFromDocument —— 从文档当前的节点坐标 / 引导线折点派生一份 DesignLayout（不含
 * viewport：缩放/平移是纯画布会话态，不随文档持久化，见 x6-adapter.ts getLayout() 的既定
 * 处理——那里的 viewport 字段来自画布适配器自身的会话状态，不是文档字段）。缺省
 * position_x/position_y 的节点（理论不应发生，防御性处理）不计入 nodePositions。
 */
export function layoutFromDocument(doc: WorkflowDocument): DesignLayout {
  const layout: DesignLayout = {};

  const nodePositions: Record<string, Point> = {};
  for (const node of doc.nodes) {
    if (Number.isFinite(node.position_x) && Number.isFinite(node.position_y)) {
      nodePositions[node.id] = { x: node.position_x as number, y: node.position_y as number };
    }
  }
  if (Object.keys(nodePositions).length) layout.nodePositions = nodePositions;

  const edgeVertices: Record<string, Point[]> = {};
  for (const link of doc.links) {
    if (link.vertices && link.vertices.length) {
      edgeVertices[link.id] = link.vertices.map((point) => ({ ...point }));
    }
  }
  if (Object.keys(edgeVertices).length) layout.edgeVertices = edgeVertices;

  return layout;
}

/**
 * applyLayoutToDocument —— layoutFromDocument 的逆操作：把画布当前的坐标/折点写回文档状态。
 * 节点坐标一次性交给 state.moveNodes（内部合成一步撤销），折点逐条交给 state.setLinkVertices
 * （每条一步撤销）——批量应用整份布局（如画布"自动布局"工具条按钮）因此会产生"1 + 折点条数"
 * 步撤销历史，不是单个原子操作；目前没有"多次调用合并成一步"的批处理入口（document-state.ts
 * 的合并窗口机制只覆盖 updateNodeConfig/renameNode/updateLinkCondition/setName 四类，见其头
 * 注释）。viewport 不在本函数处理范围（同 layoutFromDocument 头注释，
 * 那是画布会话态，不经文档状态机）。
 */
export function applyLayoutToDocument(state: WorkflowDocumentState, layout: DesignLayout): void {
  const moves = Object.entries(layout.nodePositions ?? {}).map(([id, position]) => ({ id, x: position.x, y: position.y }));
  if (moves.length) state.moveNodes(moves);

  for (const [linkId, vertices] of Object.entries(layout.edgeVertices ?? {})) {
    state.setLinkVertices(linkId, vertices);
  }
}
