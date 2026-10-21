/**
 * model/defaults.ts —— 空白文档构造 + 历史草稿"补形状"。
 *
 * 两个函数分别对应两种起点：
 *   - createDefaultDocument：全新流程，设计器工具条"新建流程"按钮用；
 *   - ensureDocumentShape：设计会话打开一份已存在的草稿时用——网关新建草稿只落一个 start
 *     节点（见后端 engine/app/definitions.go 新建定义逻辑），历史草稿也可能缺 links 等字段
 *     （老版本落库时字段集合更窄），本函数把这些"形状不完整"的输入规范成设计器内部可以安全
 *     读写的完整 WorkflowDocument，同时**不丢任何未知字段**——往返幂等是硬约束（见其注释；
 *     唯一例外是旧文档顶层可能带着的 notify 键）。
 *
 * 两者都不依赖 Vue/X6，纯 TS，与 ../model/document.ts 同一分工。
 *
 * 发起节点默认名：填报层的流程进度页/任务列表/管理页直接读文档 name 字段渲染"当前站"，没有
 * 设计器画布 toGraphNodes 那样的"类型名+序号"兜底显示，因此新造的发起节点必须带名字。构造函数
 * 接收可选 i18n，按当前设计器语言写入默认名（没有注入 i18n 时经 resolveDefaultText 退回 zh-CN
 * 文案，同 designer/nodes/default-i18n-fallback.ts 的做法）——只在"确实是新造出来的节点"时写，
 * 绝不回头改写已经存在于文档里的节点（哪怕它的 name 恰好是空串）。
 *
 * 新建流程/全新草稿只有一个发起节点，不自带结束节点，结束节点交给设计者从节点库拖入。发布期
 * "至少一个结束节点"的检查（L11）不受影响，没有结束节点的流程仍然发布拒绝。
 *
 * 通知开关在节点级（见 document.ts NodeNotify），不再有流程级 notify：createDefaultDocument
 * 不产出 notify 字段；ensureDocumentShape 对旧文档顶层可能带着的 notify 键**丢弃**（后端已不再
 * 读取，见 document.ts WorkflowDocument 头注释）。
 *
 * 办理/审批/抄送三类节点的『与上步处理人的关系』旧来源在 ensureDocumentShape 里统一改记为节点
 * config 上独立的 relation_filters 字段，见下方 normalizeNodeRelationConfig。
 */
import {
  WORKFLOW_DOCUMENT_SCHEMA,
  type AssigneeRelation,
  type AssigneeSource,
  type WorkflowDocument,
  type WorkflowNode
} from './document';
import { getNodeTypeDefinition, type DefaultConfigI18n } from '../designer/nodes/registry';
import { resolveDefaultText } from '../designer/nodes/default-i18n-fallback';
import { normalizeRelationConfig } from '../designer/panels/shared/relationFilters';
import { createEntityId } from './store';

/** 发起节点默认名对应的四语键，与画布展示态 toGraphNodes 的类型名兜底共用同一组键
 * （designer/graph-bridge.ts labelKey），不重复定义一套新文案。结束节点不由本文件构造，其默认名
 * 兜底由 node-naming.ts defaultNameForNodeAt() 通过注册表 labelKey 统一取值。 */
const START_NODE_LABEL_KEY = 'workflow.designer.node.start';

/** 新建流程画布发起节点的初始文档坐标——与 designer/stencil/index.ts 新增节点的默认落点
 * （340,380+）分属不同层：这里是"文档骨架"的固定初始位置，那里是"追加节点"的相对偏移，
 * 互不影响。画布首次打开时会把这个坐标换算成的渲染中心点锚到容器"水平约 30%、垂直居中"处
 * （见 designer/canvas/viewport.ts computeInitialAnchorTranslate），
 * 但这只是画布视口的展示态调整，不改这个常量本身的含义——发起节点的文档坐标依然是这里。 */
const START_NODE_POSITION = { x: 120, y: 200 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 造一个默认发起节点：id 固定为 'start'（同一文档内 start 恒唯一，用固定 id 便于调试/测试
 * 断言，不需要随机——对齐后端新建草稿时同样用固定 id 的既定做法，见 engine/app/definitions.go）。
 * name 按当前语言写「发起」——发起节点全图恒唯一（注册表 start.maxCount=1），不需要像办理/
 * 结束那样带序号区分，直接用类型名本身即可。 */
function createDefaultStartNode(i18n?: DefaultConfigI18n): WorkflowNode {
  return {
    id: 'start',
    kind: 'start',
    name: resolveDefaultText(i18n, START_NODE_LABEL_KEY),
    config: getNodeTypeDefinition('start')?.createDefaultConfig() ?? {},
    position_x: START_NODE_POSITION.x,
    position_y: START_NODE_POSITION.y
  };
}

/**
 * createDefaultDocument —— 全新流程的初始文档：只有一个发起节点，不预连线。name（流程名）由
 * 调用方传入（设计器新建对话框已收集好名称，本函数不代为生成默认流程名）；发起节点自己的
 * name 则由本函数按 i18n 生成默认值（见文件头注释）——i18n 可选，未传入时退回 zh-CN 文案。
 *
 * 不造结束节点，结束节点交给设计者从节点库拖入。不产出流程级 notify 字段，新建文档的通知配置
 * 全部走各节点 config 自己的 `notify?`（不配即按「全部开 + 系统通知」处理，见各节点面板
 * shared/NotifyCard.vue）。
 */
export function createDefaultDocument(name: string, i18n?: DefaultConfigI18n): WorkflowDocument {
  return {
    schema: WORKFLOW_DOCUMENT_SCHEMA,
    name,
    nodes: [createDefaultStartNode(i18n)],
    links: []
  };
}

/**
 * ensureNodeShape —— 单个节点的"补形状"：只保证 id/kind 是字符串（设计器后续所有节点操作都
 * 假设这两个字段存在），**其余字段（含 config 内部的任意未知键、position_x/position_y、
 * name）原样透传**——本函数不是节点级校验器，深层校验交给发布期网关/model/validate-map.ts
 * 消费的诊断结果，这里只负责"不让设计器因为字段缺失而在读取时报 undefined 相关的运行时错误"。
 */
function ensureNodeShape(raw: unknown, fallbackId: () => string): WorkflowNode {
  const src = isPlainObject(raw) ? raw : {};
  return {
    ...src,
    id: typeof src.id === 'string' && src.id ? src.id : fallbackId(),
    kind: (typeof src.kind === 'string' ? src.kind : 'handle') as WorkflowNode['kind']
  } as WorkflowNode;
}

/** 办理/审批/抄送三类节点各自的『A 人员来源』字段名（用于下方 normalizeNodeRelationConfig 按
 *  节点类型收窄读写哪一个键）；发起/结束/子流程三类节点没有『A』（发起节点走独立的
 *  StartGrant，见 document.ts StartGrant 注释；结束/子流程本就没有人员来源概念），不在此列。 */
const RELATION_SOURCE_FIELD: Partial<Record<WorkflowNode['kind'], string>> = {
  handle: 'assignees',
  approve: 'approvers',
  cc: 'recipients'
};

/**
 * normalizeNodeRelationConfig —— 单个节点的『与上步处理人的关系』归一化：旧文档里按来源配置的
 * 关系（kind==='relation' 的来源条目）在此处统一改记为节点 config 上独立的 relation_filters
 * 字段，来源清单里对应条目一并摘除——真正的
 * 抽取/去重/保序逻辑在 designer/panels/shared/relationFilters.ts 的纯函数
 * normalizeRelationConfig（幂等硬约束也由它保证），本函数只负责按节点类型收窄该读写 config
 * 的哪个来源字段、以及"没有任何要处理的内容时原样返回、不产生无意义改写"这一层判断。
 *
 * 只处理 handle/approve/cc 三类节点（各自的来源字段名见上方 RELATION_SOURCE_FIELD），其余节点
 * 类型的 config 不受影响、原样透传——发起节点『谁能发起』没有这一档（发起的那一刻还没有
 * 上一步），不在本函数改动范围内。
 */
function normalizeNodeRelationConfig(node: WorkflowNode): WorkflowNode {
  const sourceField = RELATION_SOURCE_FIELD[node.kind];
  if (!sourceField || !isPlainObject(node.config)) return node;
  const cfg = node.config;
  const rawSources = Array.isArray(cfg[sourceField]) ? (cfg[sourceField] as AssigneeSource[]) : [];
  const rawFilters = Array.isArray(cfg.relation_filters) ? (cfg.relation_filters as AssigneeRelation[]) : [];
  // 既没有 relation 来源条目、也没有既有过滤器时原样返回——不往每一份文档的每一个节点 config
  // 里都多写一个空的 relation_filters: []，保持"没碰过的字段不产生改写"。
  if (rawFilters.length === 0 && !rawSources.some((s) => s?.kind === 'relation')) return node;
  const { sources, filters } = normalizeRelationConfig(rawSources, rawFilters);
  const nextConfig: Record<string, unknown> = { ...cfg, [sourceField]: sources };
  if (filters.length > 0) {
    nextConfig.relation_filters = filters;
  } else {
    delete nextConfig.relation_filters;
  }
  return { ...node, config: nextConfig };
}

/**
 * ensureDocumentShape —— 把一份可能"形状不完整"的原始文档（后端新草稿、老版本草稿、或任何
 * 来源不明的 JSON）规范成设计器可以安全读写的完整 WorkflowDocument。
 *
 * 硬约束（往返幂等，见 defaults.test.ts 对应用例）：
 *   - 任何本函数不认识的键（文档顶层、单个节点、config 内部、link 内部）一律原样保留，不丢弃、
 *     不重排；
 *   - 已经完整的文档传入后应逐字段不变（除非确实缺了发起节点这一种需要补全的情形）；
 *   - 只有"整份文档一个节点都没有"时才补一个默认发起节点——文档已经有其它节点但没有发起节点
 *     （理论不应发生的异常草稿）按"补一个发起节点"兜底，不做更复杂的猜测式修复；结束节点
 *     从不由本函数代为补全，没有结束节点的草稿留给发布期 L11 检查拦（见该检查的业务提示文案
 *     workflow.designer.issue.l11_no_end_node）。
 *
 * 发起节点默认名的补全时机——只在"新草稿最小形状"（isBareNewDraft，整份文档除了一个发起节点
 * 外空无一物）时补发起节点自己的空 name，这只可能是"designer 从没
 * 被这份草稿的使用者编辑过"的全新态，此时补默认名是安全的——不是"改写已有数据"，是
 * "把从没被赋过值的默认态一次性补齐"。反之，只要文档不是这个最小形状（哪怕只多一个节点），
 * 就说明使用者已经真正编辑过这份草稿，本函数对已存在节点的 name 一律原样保留、绝不代为填充
 * （即便该节点 name 恰好是空串）——这正是 ensureNodeShape 本身"不动 name 字段"的既定策略，
 * 见其函数头注释。这样处理不会导致"一打开草稿就变脏"：dirty 只由 WorkflowDocumentState 的
 * 写操作方法置位（见 document-state.ts），本函数只参与构造传给其构造函数的初始快照，不经过
 * 任何 commit()。
 *
 * 旧文档顶层可能带着的 `notify`（流程级四开关，后端已停止读取，见 document.ts WorkflowDocument
 * 头注释）本函数**丢弃**，不再透传进返回的文档——这是本函数
 * "未知字段一律原样保留"这条硬约束唯一的例外（其余顶层未知键、节点 config 内部未知键、link
 * 内部未知键仍然逐一原样保留，不受影响）。丢弃通过"先从 src 里解构掉这个键、再展开其余字段"
 * 实现，不能像别的字段那样简单地不写显式覆盖——`...src` 铺底会把来源对象里的 notify 键原样
 * 带出来，必须显式排除。打开一份带着旧 notify 键的历史文档应该正常可用、保存后不再带这个键，
 * 见 defaults.test.ts 对应用例。
 *
 * 办理/审批/抄送三类节点的『与上步处理人的关系』旧来源在此处统一改记为节点 config 上独立的
 * relation_filters 字段（真正的抽取逻辑见上方
 * normalizeNodeRelationConfig / designer/panels/shared/relationFilters.ts
 * normalizeRelationConfig），这样旧草稿一打开就是新形状，AssigneeSourceList.vue 与三个属性面板
 * 都不需要再认识 relation 来源。与上面 name/notify 两段同一个理由：本函数的返回值只是构造
 * WorkflowDocumentState 初始快照的输入（DesignerRoot.vue `new WorkflowDocumentState(doc)`），
 * 不经过该类任何一个会置 dirty=true 的写方法（见 document-state.ts 构造函数与
 * markSaved()：两处调用点——加载草稿、保存后用服务端回传的 draft 重新对齐基线——都是在"确立
 * 新基线"的时刻调用本函数，之后 isDirty() 恒为 false），因此这处归一化不会让文档一打开就变成
 * "有未保存的改动"。
 */
export function ensureDocumentShape(raw: unknown, i18n?: DefaultConfigI18n): WorkflowDocument {
  const src = isPlainObject(raw) ? raw : {};
  // 丢弃顶层 notify（见函数头注释），其余未知键仍经 restSrc 原样透传。
  const { notify: _discardedNotify, ...restSrc } = src;

  const rawNodes = Array.isArray(restSrc.nodes) ? restSrc.nodes : [];
  let seq = 0;
  let nodes = rawNodes.map((n) => ensureNodeShape(n, () => createEntityId(`n${seq++}`)));
  if (!nodes.some((n) => n.kind === 'start')) {
    nodes = [createDefaultStartNode(i18n), ...nodes];
  }
  // 只有"新建草稿的最小形状"（仅一个发起节点）才补发起节点自己的默认名，见函数头注释；
  // 不连带补默认结束节点。
  const isBareNewDraft = nodes.length === 1 && nodes[0].kind === 'start';
  if (isBareNewDraft && !nodes[0].name) {
    nodes = [{ ...nodes[0], name: resolveDefaultText(i18n, START_NODE_LABEL_KEY) }];
  }
  // 『与上步处理人的关系』旧来源 → relation_filters 归一化（见函数头注释）：只影响
  // handle/approve/cc 三类节点，其余节点类型原样透传。
  nodes = nodes.map(normalizeNodeRelationConfig);

  const links = Array.isArray(restSrc.links) ? restSrc.links : [];

  return {
    ...restSrc,
    // schema 只承认唯一取值（见 document.ts 头注释），不透传来源里的任意取值——与其余字段
    // "原样透传未知键"的策略不同：这一个字段本身就没有"未知但合法"的取值空间。
    schema: WORKFLOW_DOCUMENT_SCHEMA,
    name: typeof restSrc.name === 'string' ? restSrc.name : '',
    nodes,
    links
  } as WorkflowDocument;
}
