/**
 * model/store.ts —— 设计器 entity store（nodes/edges/metadata）。
 *
 * 纯 TS，零 Vue/零 X6 依赖。store 只是"当前设计文档在内存里的可变表示"，
 * 不做撤销/重做；store 只提供确定性的增删改查原语，供
 * CommandStack 在 execute/undo 时调用。
 *
 * 节点/边操作对象是 WorkflowNode/WorkflowLink（V2 没有分支结构块/数据契约概念）。
 *
 * 节点位置（NodePosition）不是 WorkflowDocument 的字段（引擎不关心，见 ./index.ts DesignLayout
 * 注释），因此本 store 延续 V1 既定设计，把位置作为"表现层附属状态"单独存放，不参与业务节点
 * 对象本身——WorkflowNode 虽然自带 position_x/position_y 字段（对齐后端 model.Node，随文档一并
 * 持久化），但那是"落库时把当前画布坐标写进文档"那一步（序列化）的职责，不是本 store 的职责；
 * store 内部的 positions Map 是画布会话期间的实时展示态，语义与 V1 完全一致。
 */
import type { Point, WorkflowLink, WorkflowNode } from './document';

/** 节点在画布上的表现层坐标（非业务字段，见文件头注释）。 */
export interface NodePosition {
  x: number;
  y: number;
}

/** 当前选中态：节点与边分开记录，允许两者同时存在多选（V1 只用到单选，字段留出多选空间）。 */
export interface SelectionState {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * 生成设计器本地实体 id（节点/边）。前缀便于调试期肉眼区分类型，不参与任何业务语义比较
 * （后端只要求非空字符串）。
 */
export function createEntityId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

/** config 是按节点类型收窄的联合类型，内部可能含嵌套对象（如 assignees/buttons），需要深拷贝，
 * 避免调用方持有的对象被 store 内部变更污染。 */
function structuredCloneConfig<T>(config: T): T {
  if (typeof structuredClone === 'function') return structuredClone(config);
  return JSON.parse(JSON.stringify(config));
}

function cloneNode(node: WorkflowNode): WorkflowNode {
  return {
    ...node,
    config: node.config ? structuredCloneConfig(node.config) : undefined
  };
}

function cloneEdge(edge: WorkflowLink): WorkflowLink {
  return {
    ...edge,
    condition_doc: edge.condition_doc ? structuredCloneConfig(edge.condition_doc) : undefined,
    vertices: edge.vertices ? edge.vertices.map((v) => ({ ...v })) : undefined
  };
}

/**
 * DesignerStore —— nodes/edges 的归一化内存表示（Map 存储 + 插入序数组维持稳定遍历顺序）。
 *
 * 所有增删改方法都是"低层原语"：不产生历史记录、不校验业务规则（如"边必须连接存在的节点"），
 * 这些约束由调用方（commands.ts / designer/ 组件）在更高层保证。之所以不在 store 内部做校验，
 * 是因为 undo 过程中会短暂出现"先删节点、稍后再撤销回边"这类中间态，store 必须允许这些中间态
 * 存在，校验统一在用户可见的时机跑。
 */
export class DesignerStore {
  private nodes = new Map<string, WorkflowNode>();
  private edges = new Map<string, WorkflowLink>();
  private nodeOrder: string[] = [];
  private edgeOrder: string[] = [];
  private positions = new Map<string, NodePosition>();
  private selection: SelectionState = { nodeIds: [], edgeIds: [] };
  /** 流程定义名称（对齐 WorkflowDocument.name）；当前没有 UI 会修改它，只保证往返时原样
   * 保真。通知配置在节点级（见 model/document.ts NodeNotify），本 store 不持有 `notify`。 */
  private name = '';

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------

  getNode(id: string): WorkflowNode | undefined {
    const node = this.nodes.get(id);
    return node ? cloneNode(node) : undefined;
  }

  getEdge(id: string): WorkflowLink | undefined {
    const edge = this.edges.get(id);
    return edge ? cloneEdge(edge) : undefined;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  hasEdge(id: string): boolean {
    return this.edges.has(id);
  }

  /** 按插入顺序返回节点快照列表（顺序与业务无关，仅用于确定性遍历；持久化顺序由后续序列化卡
   * 定义）。 */
  listNodes(): WorkflowNode[] {
    return this.nodeOrder.map((id) => cloneNode(this.nodes.get(id)!));
  }

  listEdges(): WorkflowLink[] {
    return this.edgeOrder.map((id) => cloneEdge(this.edges.get(id)!));
  }

  getPosition(nodeId: string): NodePosition | undefined {
    const pos = this.positions.get(nodeId);
    return pos ? { ...pos } : undefined;
  }

  listPositions(): Record<string, NodePosition> {
    const out: Record<string, NodePosition> = {};
    for (const [id, pos] of this.positions) out[id] = { ...pos };
    return out;
  }

  /** 与该节点相连（作为 from 或 to）的边 id 列表，供 RemoveNode 命令级联收集。 */
  edgesTouchingNode(nodeId: string): string[] {
    return this.edgeOrder.filter((id) => {
      const edge = this.edges.get(id)!;
      return edge.from === nodeId || edge.to === nodeId;
    });
  }

  getSelection(): SelectionState {
    return { nodeIds: [...this.selection.nodeIds], edgeIds: [...this.selection.edgeIds] };
  }

  getName(): string {
    return this.name;
  }

  // ------------------------------------------------------------------
  // 变更原语（供 commands.ts 调用）
  // ------------------------------------------------------------------

  /** 插入节点；index 缺省则追加到末尾（用于 undo 时把节点插回原来的位置）。 */
  addNode(node: WorkflowNode, position?: NodePosition, index?: number): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`[designer/store] duplicate node id: ${node.id}`);
    }
    this.nodes.set(node.id, cloneNode(node));
    if (index === undefined || index >= this.nodeOrder.length) {
      this.nodeOrder.push(node.id);
    } else {
      this.nodeOrder.splice(index, 0, node.id);
    }
    if (position) this.positions.set(node.id, { ...position });
  }

  /** 移除节点并返回其快照 + 原索引 + 原位置，供 undo 时精确还原。 */
  removeNode(id: string): { node: WorkflowNode; index: number; position?: NodePosition } | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const index = this.nodeOrder.indexOf(id);
    const position = this.positions.get(id);
    this.nodes.delete(id);
    this.nodeOrder.splice(index, 1);
    this.positions.delete(id);
    this.selection.nodeIds = this.selection.nodeIds.filter((n) => n !== id);
    return { node: cloneNode(node), index, position: position ? { ...position } : undefined };
  }

  /** 整体替换节点的 name/config（UpdateNodeConfig 命令用）；返回替换前快照供 undo。 */
  replaceNode(id: string, next: Pick<WorkflowNode, 'name' | 'config'>): WorkflowNode {
    const prev = this.nodes.get(id);
    if (!prev) throw new Error(`[designer/store] node not found: ${id}`);
    const snapshot = cloneNode(prev);
    this.nodes.set(id, { ...prev, name: next.name, config: next.config ? structuredCloneConfig(next.config) : undefined });
    return snapshot;
  }

  /** 设置节点位置，返回原位置（可能为 undefined，即此前未设置过）供 undo。 */
  setPosition(nodeId: string, position: NodePosition): NodePosition | undefined {
    if (!this.nodes.has(nodeId)) throw new Error(`[designer/store] node not found: ${nodeId}`);
    const prev = this.positions.get(nodeId);
    this.positions.set(nodeId, { ...position });
    return prev ? { ...prev } : undefined;
  }

  addEdge(edge: WorkflowLink, index?: number): void {
    if (this.edges.has(edge.id)) {
      throw new Error(`[designer/store] duplicate edge id: ${edge.id}`);
    }
    this.edges.set(edge.id, cloneEdge(edge));
    if (index === undefined || index >= this.edgeOrder.length) {
      this.edgeOrder.push(edge.id);
    } else {
      this.edgeOrder.splice(index, 0, edge.id);
    }
  }

  removeEdge(id: string): { edge: WorkflowLink; index: number } | undefined {
    const edge = this.edges.get(id);
    if (!edge) return undefined;
    const index = this.edgeOrder.indexOf(id);
    this.edges.delete(id);
    this.edgeOrder.splice(index, 1);
    this.selection.edgeIds = this.selection.edgeIds.filter((e) => e !== id);
    return { edge: cloneEdge(edge), index };
  }

  /** 更新边的 condition_doc（普通引导线 V4 判断表达式；UpdateEdgeCondition 命令用）。
   * 返回替换前快照供 undo。 */
  replaceEdgeCondition(id: string, condition: WorkflowLink['condition_doc']): WorkflowLink {
    const prev = this.edges.get(id);
    if (!prev) throw new Error(`[designer/store] edge not found: ${id}`);
    const snapshot = cloneEdge(prev);
    this.edges.set(id, { ...prev, condition_doc: condition ? structuredCloneConfig(condition) : undefined });
    return snapshot;
  }

  /** 更新边的折点（layoutChange 事件用，纯展示态，不参与撤销历史——同 V1 既定既不产生命令的
   * 处理手法，调用方按需决定是否包一层命令）。 */
  replaceEdgeVertices(id: string, vertices: Point[] | undefined): void {
    const prev = this.edges.get(id);
    if (!prev) throw new Error(`[designer/store] edge not found: ${id}`);
    this.edges.set(id, { ...prev, vertices: vertices ? vertices.map((v) => ({ ...v })) : undefined });
  }

  setSelection(next: SelectionState): void {
    this.selection = { nodeIds: [...next.nodeIds], edgeIds: [...next.edgeIds] };
  }

  setName(next: string): string {
    const previous = this.name;
    this.name = next;
    return previous;
  }

  clearSelection(): void {
    this.selection = { nodeIds: [], edgeIds: [] };
  }
}
