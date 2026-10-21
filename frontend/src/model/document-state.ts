/**
 * model/document-state.ts —— 设计器文档状态：一份 WorkflowDocument 的完整
 * 可变表示，自带撤销/重做、脏态、选中态与变更事件，供画布壳直接驱动。
 *
 * 与 ./store.ts（DesignerStore）的关系/取舍：store.ts 是 V1 遗留的"归一化 Map + 位置单独存放"
 * 低层原语（见其头注释"不产生历史记录、不做业务规则校验"），撤销/重做原打算由另一层
 * CommandStack 基于它的低层原语实现（Command 模式）。本文件改用**文档快照栈**（撤销/重做直接
 * 对整份 WorkflowDocument JSON 做深拷贝快照，而不是维护一组可逆 Command 对象）——理由：
 *   1) V2 的 WorkflowNode 本身就带 position_x/position_y（对齐后端 model.Node，见 document.ts
 *      注释），不再需要 store.ts 那种"位置与节点分开存放"的折衷，文档本身已经是完整状态；
 *   2) 往返幂等是硬约束（未知字段不丢）——快照方式对"文档里有一堆我不认识的字段"天然安全
 *      （深拷贝不关心字段语义），Command 模式则要求每个 Command 都精确知道如何应用到未知字段
 *      上，容易漏、也难维护；
 *   3) 上限 50 步的快照栈内存开销可控（典型流程文档几十个节点，JSON 体积远小于表格编辑器那类
 *      场景），不需要 Command 模式换来的增量存储收益。
 * 因此本文件不依赖 DesignerStore，独立持有 _doc（WorkflowDocument 全量快照）作为唯一数据源。
 *
 * 纯 TS，零 Vue/零 X6 依赖（同 store.ts 头注释的分层约束）。
 */
import type {
  NodeKind,
  Point,
  V4ExpressionDocumentEnvelope,
  WorkflowDocument,
  WorkflowLink,
  WorkflowNode
} from './document';
import { getNodeTypeDefinition, type DefaultConfigI18n } from '../designer/nodes/registry';
import { nextOrdinalForKind, typeOrdinalName } from './node-naming';
import { createEntityId } from './store';

/** 撤销/重做栈上限（每侧各自最多保留这么多步快照）。 */
const MAX_HISTORY = 50;
/** 连续同一目标的配置改动合并为一步的时间窗口（毫秒）。 */
const MERGE_WINDOW_MS = 500;

/** 当前选中态：节点与引导线分开记录。 */
export interface DocumentSelection {
  nodeIds: string[];
  linkIds: string[];
}

/** addLink 校验不通过时的原因键，供调用方拼装提示文案（如
 * `workflow.designer.link.reject.<reason>`）——本层不持有 i18n，不在这里拼中文。 */
export type AddLinkRejectReason = 'unknownEndpoint' | 'selfLoop' | 'duplicate' | 'intoStart' | 'outOfEnd';

export type AddLinkResult = { ok: true; link: WorkflowLink } | { ok: false; reason: AddLinkRejectReason };

function cloneDoc(doc: WorkflowDocument): WorkflowDocument {
  return JSON.parse(JSON.stringify(doc)) as WorkflowDocument;
}

/**
 * WorkflowDocumentState —— 设计器文档状态的唯一权威。所有会改变文档内容的方法
 * 都会：① 置 dirty=true；② 触发 onChange 监听；③（除 setSelection 外）计入撤销栈。
 */
export class WorkflowDocumentState {
  private _doc: WorkflowDocument;
  private selection: DocumentSelection = { nodeIds: [], linkIds: [] };
  private dirty = false;
  private savedSnapshot: string;
  private past: string[] = [];
  private future: string[] = [];
  private lastMergeKey: string | undefined;
  private lastMergeAt = 0;
  private listeners = new Set<() => void>();

  constructor(initial: WorkflowDocument) {
    this._doc = cloneDoc(initial);
    this.savedSnapshot = JSON.stringify(this._doc);
  }

  // ------------------------------------------------------------------
  // 读
  // ------------------------------------------------------------------

  /** 当前文档的深拷贝快照（调用方持有的对象改了不会污染内部状态，同 store.ts 既定风格）。 */
  get doc(): WorkflowDocument {
    return cloneDoc(this._doc);
  }

  getSelection(): DocumentSelection {
    return { nodeIds: [...this.selection.nodeIds], linkIds: [...this.selection.linkIds] };
  }

  isDirty(): boolean {
    return this.dirty;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 输出 Go 同形文档（含未知键），供保存/toJSON 序列化用。与 `doc` getter 等价，独立命名
   * 是为了在调用点读起来更贴近"我要序列化保存"的意图。 */
  toJSON(): WorkflowDocument {
    return cloneDoc(this._doc);
  }

  // ------------------------------------------------------------------
  // 写：节点
  // ------------------------------------------------------------------

  /**
   * 此刻再新增一个 kind 类型的节点，它会得到的默认名（"类型名 + 序号"，如"办理 2"）。只读，不改
   * 文档。从 addNode 里抽出来单列，是因为节点库拖拽预览图（designer/stencil/drag-preview.ts）要在
   * 节点**还没建**的时候就画出"它落下后的名字"——两处共用这一份实现，预览图上的名字才恒等于松手
   * 后真正写进文档的名字。
   *
   * 序号从「同类型已有数 + 1」起算（与画布展示兜底同一规则）；默认名一旦落库就冻结，删掉靠前的
   * 节点再新建时起算值可能与现存节点的名字相同——两个同名步骤在进度页 / 任务列表里分不清，故
   * 名字已被占用就继续往后取，直到不重名。
   */
  nextDefaultNodeName(kind: NodeKind, i18n?: DefaultConfigI18n): string {
    const taken = new Set(this._doc.nodes.map((n) => n.name));
    let ordinal = nextOrdinalForKind(this._doc.nodes, kind);
    while (taken.has(typeOrdinalName(i18n, kind, ordinal))) ordinal++;
    return typeOrdinalName(i18n, kind, ordinal);
  }

  /**
   * 新增一个节点：id 用 createEntityId(kind) 生成；按注册表 maxCount 校验，超限（如已存在发起
   * 节点时再次新增 start）返回 undefined 且不产生任何变更（不计入撤销栈、不触发 onChange）。
   *
   * `i18n` 可选：转手传给 createDefaultConfig（approve 默认两个
   * 按钮的名称需要按设计者当前语言生成，N3），调用方（designer/DesignerRoot.vue
   * onStencilDrop/onStencilDblClick）恰好持有 props.i18n，原样转手最省事、也不引入新的耦合面。
   *
   * name **不留空**，写入"类型名 + 序号"默认名（如"办理 1"
   * "抄送 2"）——序号算法与拼接规则经 model/node-naming.ts 的 nextOrdinalForKind/
   * typeOrdinalName，与画布展示态 toGraphNodes()（designer/graph-bridge.ts）的"名字为空时的
   * 展示兜底"共用同一份实现，因此"新建后画布显示的名字"恒等于"写进文档的名字"——否则设计者不手动
   * 改名就发布时，这一站在填报层（进度页/任务列表/管理页）会是空名（画布展示层的兜底继续保留，
   * 服务已存在的老文档）。i18n 参数同时转手给
   * typeOrdinalName——本层因此"认识当前语言"这件事，仍然只是转手 i18n.t()，不在本文件里
   * 拼一份新的语言判断逻辑，延续本文件头注释"纯 TS"的既定分工（i18n 只是个鸭子类型接口，
   * 不依赖 Vue/宿主）。
   */
  addNode(kind: NodeKind, position: { x: number; y: number }, i18n?: DefaultConfigI18n): WorkflowNode | undefined {
    const def = getNodeTypeDefinition(kind);
    if (def?.maxCount !== undefined) {
      const existing = this._doc.nodes.filter((n) => n.kind === kind).length;
      if (existing >= def.maxCount) return undefined;
    }
    const node: WorkflowNode = {
      id: createEntityId(kind),
      kind,
      name: this.nextDefaultNodeName(kind, i18n),
      config: def?.createDefaultConfig(i18n) ?? {},
      position_x: Math.round(position.x),
      position_y: Math.round(position.y)
    };
    this.commit(undefined, () => {
      this._doc.nodes.push(node);
    });
    // 深拷贝返回（同 `doc` getter 的既定风格）：node.config 是嵌套对象，浅拷贝会与内部状态
    // 共享同一个引用，调用方改 config 字段会污染 _doc。
    return JSON.parse(JSON.stringify(node)) as WorkflowNode;
  }

  /**
   * 删除一批节点：按注册表 canDelete 过滤（发起节点等 canDelete===false 的类型恒不可删，
   * 静默跳过而不是报错——同一批删除里混了可删/不可删节点时，可删的部分仍应生效）；级联删除
   * 与这些节点相连的全部引导线；选中态里被删掉的 id 自动清理。整批操作算一次撤销步骤。
   */
  removeNodes(ids: string[]): void {
    const requested = new Set(ids);
    const removableIds = new Set(
      this._doc.nodes.filter((n) => requested.has(n.id) && (getNodeTypeDefinition(n.kind)?.canDelete ?? true)).map((n) => n.id)
    );
    if (removableIds.size === 0) return;
    this.commit(undefined, () => {
      this._doc.nodes = this._doc.nodes.filter((n) => !removableIds.has(n.id));
      this._doc.links = this._doc.links.filter((l) => !removableIds.has(l.from) && !removableIds.has(l.to));
      this.sanitizeSelection();
    });
  }

  /** 批量写节点位置（坐标取整）；拖拽结束（单节点或群移）都走这一个方法，整批算一次撤销步骤
   * ——单节点拖拽结束时调用方传一个只含一项的数组即可，不需要单独的方法。 */
  moveNodes(moves: Array<{ id: string; x: number; y: number }>): void {
    const known = new Set(this._doc.nodes.map((n) => n.id));
    const applicable = moves.filter((m) => known.has(m.id));
    if (applicable.length === 0) return;
    this.commit(undefined, () => {
      for (const move of applicable) {
        const node = this._doc.nodes.find((n) => n.id === move.id);
        if (node) {
          node.position_x = Math.round(move.x);
          node.position_y = Math.round(move.y);
        }
      }
    });
  }

  /** 重命名节点；连续对同一节点重命名在 500ms 内合并为一步（如用户在输入框逐字符修改）。 */
  renameNode(id: string, name: string): void {
    if (!this._doc.nodes.some((n) => n.id === id)) return;
    this.commit(`renameNode:${id}`, () => {
      const node = this._doc.nodes.find((n) => n.id === id);
      if (node) node.name = name;
    });
  }

  /**
   * 更新节点 config：patch 为对象时与现有 config 浅合并；为函数时把现有 config（可能为
   * undefined）交给调用方自行算出下一份，用于"删除某个 key""替换整个数组"这类浅合并表达不了
   * 的变更。连续对同一节点的配置改动在 500ms 内合并为一步（属性面板逐字段/逐字符编辑的既定
   * 场景）。
   */
  updateNodeConfig(
    id: string,
    patch: Record<string, unknown> | ((config: Record<string, unknown> | undefined) => Record<string, unknown> | undefined)
  ): void {
    if (!this._doc.nodes.some((n) => n.id === id)) return;
    this.commit(`updateNodeConfig:${id}`, () => {
      const node = this._doc.nodes.find((n) => n.id === id);
      if (!node) return;
      node.config = typeof patch === 'function' ? patch(node.config) : { ...node.config, ...patch };
    });
  }

  // ------------------------------------------------------------------
  // 写：引导线
  // ------------------------------------------------------------------

  /**
   * 新增一条引导线：端点必须都存在、禁止自连、禁止与已有某条线同向重复、禁止连入发起节点
   * （发起是入口，不接受任何入边）、禁止从末级节点连出（isTerminal===true 的类型，如结束节点，
   * 语义上已经是"流转终点"，不应该再有出线）。校验不通过返回失败原因键，不产生任何变更。
   */
  addLink(from: string, to: string): AddLinkResult {
    const fromNode = this._doc.nodes.find((n) => n.id === from);
    const toNode = this._doc.nodes.find((n) => n.id === to);
    if (!fromNode || !toNode) return { ok: false, reason: 'unknownEndpoint' };
    if (from === to) return { ok: false, reason: 'selfLoop' };
    if (toNode.kind === 'start') return { ok: false, reason: 'intoStart' };
    if (getNodeTypeDefinition(fromNode.kind)?.isTerminal) return { ok: false, reason: 'outOfEnd' };
    if (this._doc.links.some((l) => l.from === from && l.to === to)) return { ok: false, reason: 'duplicate' };

    const link: WorkflowLink = { id: createEntityId('l'), from, to };
    this.commit(undefined, () => {
      this._doc.links.push(link);
    });
    return { ok: true, link: { ...link } };
  }

  /** 删除一批引导线；选中态里被删掉的 id 自动清理。 */
  removeLinks(ids: string[]): void {
    const idSet = new Set(ids);
    if (!this._doc.links.some((l) => idSet.has(l.id))) return;
    this.commit(undefined, () => {
      this._doc.links = this._doc.links.filter((l) => !idSet.has(l.id));
      this.sanitizeSelection();
    });
  }

  /** 写引导线折点（画布拖拽拐点结束后调用一次，同 moveNodes 一样"结束才算一步"，不做合并
   * 窗口——拖拽结束事件本就只在 mouseup 触发一次）。undefined 表示清空折点，恢复直线。 */
  setLinkVertices(id: string, points: Point[] | undefined): void {
    if (!this._doc.links.some((l) => l.id === id)) return;
    this.commit(undefined, () => {
      const link = this._doc.links.find((l) => l.id === id);
      if (link) link.vertices = points ? points.map((p) => ({ ...p })) : undefined;
    });
  }

  /** 更新引导线的判断表达式文档；连续改动同一条线在 500ms 内合并为一步（表达式编辑器内逐步
   * 调整同一条件时的既定场景）。 */
  updateLinkCondition(id: string, condition: V4ExpressionDocumentEnvelope | undefined): void {
    if (!this._doc.links.some((l) => l.id === id)) return;
    this.commit(`updateLinkCondition:${id}`, () => {
      const link = this._doc.links.find((l) => l.id === id);
      if (link) link.condition_doc = condition;
    });
  }

  /**
   * 更新引导线名称：设计者自己填的一段文本，至多 20 字，可空，
   * 只用于画布上标识这条线（中点珠子只认它，留空不画珠），不参与选路，同一节点出线允许重名
   * （本层不做重名校验）。规则：
   *   - 先去首尾空白；
   *   - 去空白后是空串 → 视为"未设置"，写成 undefined（同 updateLinkCondition 处理
   *     condition_doc 的既定口径——序列化后键本身消失，不是留一个 name:"" 空串占位）；
   *   - 超过 20 个字符 → 截断到 20。按 `Array.from(str).length` 计数/切片，不按原生
   *     `string.length`（UTF-16 code unit 长度）——避免占两个 UTF-16 单元的字符（如部分
   *     emoji/生僻字代理对）被从中间切断成半个非法字符。
   * 连续对同一条线改名在 500ms 内合并为一步（同 renameNode/updateLinkCondition 既定的"逐字符
   * 编辑合并为一步"策略，供面板"草稿 + 失焦/回车提交"场景哪怕连续触发也只计一步撤销）。
   */
  updateLinkName(linkId: string, name: string | undefined): void {
    if (!this._doc.links.some((l) => l.id === linkId)) return;
    this.commit(`updateLinkName:${linkId}`, () => {
      const link = this._doc.links.find((l) => l.id === linkId);
      if (!link) return;
      const trimmed = (name ?? '').trim();
      if (!trimmed) {
        link.name = undefined;
        return;
      }
      const chars = Array.from(trimmed);
      link.name = chars.length > 20 ? chars.slice(0, 20).join('') : trimmed;
    });
  }

  // ------------------------------------------------------------------
  // 写：流程属性 / 选中态
  // ------------------------------------------------------------------

  /** 设置流程名称；连续改动在 500ms 内合并为一步（输入框逐字符编辑）。 */
  setName(name: string): void {
    this.commit('setName', () => {
      this._doc.name = name;
    });
  }

  /** 选中态是纯展示状态（同 graph/port.ts 头注释"画布本身不直接改 store"的既定哲学延伸）：
   * 不计入撤销栈、不置 dirty、也不触发 onChange（onChange 的契约是"供壳层同步宿主 dirty
   * scope"，选中态变化不影响 dirty，没有必要触发）。 */
  setSelection(nodeIds: string[], linkIds: string[]): void {
    this.selection = { nodeIds: [...nodeIds], linkIds: [...linkIds] };
  }

  // ------------------------------------------------------------------
  // 撤销 / 重做
  // ------------------------------------------------------------------

  undo(): void {
    if (this.past.length === 0) return;
    const prevJson = this.past.pop()!;
    this.pushFuture(JSON.stringify(this._doc));
    this._doc = JSON.parse(prevJson) as WorkflowDocument;
    this.sanitizeSelection();
    this.lastMergeKey = undefined;
    this.recomputeDirty();
    this.emitChange();
  }

  redo(): void {
    if (this.future.length === 0) return;
    const nextJson = this.future.pop()!;
    this.pushPast(JSON.stringify(this._doc));
    this._doc = JSON.parse(nextJson) as WorkflowDocument;
    this.sanitizeSelection();
    this.lastMergeKey = undefined;
    this.recomputeDirty();
    this.emitChange();
  }

  // ------------------------------------------------------------------
  // 脏态 / 事件
  // ------------------------------------------------------------------

  /** 标记当前状态为"已保存"：记录新基线（默认取当前文档；传入 doc 时——例如保存接口回传了
   * 服务端补齐过 id 的规范化文档——改以该文档为准）并置 dirty=false。不清空撤销栈：保存点之前
   * 的历史仍然可以撤销回去，这是常见设计器的既定体验，不因为"已保存"就把历史砍断。 */
  markSaved(doc?: WorkflowDocument): void {
    if (doc) this._doc = cloneDoc(doc);
    this.savedSnapshot = JSON.stringify(this._doc);
    this.dirty = false;
    this.emitChange();
  }

  /** 订阅任意会改变"内容或脏态"的变化；返回取消订阅函数。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /**
   * commit —— 统一的"变更提交"入口：mergeKey 非空且与上一次提交的 mergeKey 相同、且距上一次
   * 提交未超过 MERGE_WINDOW_MS 时，不再压入新的撤销快照（合并进同一步）；否则先把"变更前"的
   * 文档压入撤销栈（超过 MAX_HISTORY 时丢弃最旧的一条）。任何一次 commit 都会清空重做栈（新
   * 分支使旧的重做历史失效，标准撤销/重做语义）、置 dirty=true、触发 onChange。
   */
  private commit(mergeKey: string | undefined, mutate: () => void): void {
    const now = Date.now();
    const mergeable = mergeKey !== undefined && mergeKey === this.lastMergeKey && now - this.lastMergeAt <= MERGE_WINDOW_MS;
    if (!mergeable) {
      this.pushPast(JSON.stringify(this._doc));
    }
    mutate();
    this.future = [];
    this.dirty = true;
    this.lastMergeKey = mergeKey;
    this.lastMergeAt = now;
    this.emitChange();
  }

  private pushPast(json: string): void {
    this.past.push(json);
    if (this.past.length > MAX_HISTORY) this.past.shift();
  }

  private pushFuture(json: string): void {
    this.future.push(json);
    if (this.future.length > MAX_HISTORY) this.future.shift();
  }

  /** 撤销/重做整体替换 _doc 后，选中态里可能残留"这一态下已不存在"的 id（如撤销回了删除
   * 该节点之前，选中态却还记着删除后清理掉的旧选中——或者反过来，重做又把它删掉了），统一按
   * 当前 _doc 的真实 id 集合过滤一次。 */
  private sanitizeSelection(): void {
    const nodeIds = new Set(this._doc.nodes.map((n) => n.id));
    const linkIds = new Set(this._doc.links.map((l) => l.id));
    this.selection = {
      nodeIds: this.selection.nodeIds.filter((id) => nodeIds.has(id)),
      linkIds: this.selection.linkIds.filter((id) => linkIds.has(id))
    };
  }

  /** 撤销/重做后按"深比较 JSON 字符串"重新判定 dirty——与保存基线逐字节相同即视为不脏，即使
   * 撤销栈本身非空（这是"回到了曾经保存过的那个状态"，不是"从未变更过"，两者在 UI 上都应显示
   * 为"已保存"）。 */
  private recomputeDirty(): void {
    this.dirty = JSON.stringify(this._doc) !== this.savedSnapshot;
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
