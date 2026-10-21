/**
 * designer/layout.ts —— 自动布局（画布工具栏"自动布局"按钮的唯一算法权威源，同时为
 * ../designer/defaults.ts 的兜底初始布局提供左→右排布，见该文件 autoLayoutPositions 注释）。
 *
 * 两段式："列"用分层拓扑，"行"用"子树质心对齐"（简化版 tidy tree / Sugiyama 质心对齐思想，
 * 不引入第三方库，纯函数可单测），保证并行分支的子节点围绕父节点对称，而不是一个贴着父节点、
 * 另一个被甩到很远：
 *
 *   1) 分层（列）：从 start 节点沿边做"最长路径分层"（longest path layering），用 Kahn
 *      拓扑排序实现，见 computeColumns 注释——start 恒在列 0，其余节点列号严格大于其任意前驱。
 *
 *   2) 排序（行）：不用固定行高栅格 + 单向"顺延到下一个空行"消解冲突（那样冲突总是让后处理的
 *      节点不断往下让路，从不回头对称），而是两遍质心对齐：
 *        - 第一遍自底向上（列从右到左）：每个节点的期望 y = 其全部直接后继节点期望 y 的算术
 *          平均——单后继时父子期望 y 完全相同（链式路径被拉成一条水平直线）；
 *        - 第二遍逐列用 pool adjacent violators（PAVA，等价于保序 isotonic regression）消解
 *          同列重叠：多个节点期望 y 相同/相近时，解出的最终 y 以它们期望 y 的均值为中心对称
 *          展开，而不是从某一个开始机械地一路往下顺延。
 *
 * 纯函数：只读 DesignerStore 当前快照（listNodes/listEdges），不做任何写操作、不产生撤销
 * 历史——调用方按需把结果包成 MoveNodeCommand[] + CompositeCommand 落库，天然可撤销（复用
 * 既有拖拽移动节点的同一条命令通道，不新开一套）。
 * 确定性：同一份输入图（节点/边拓扑不变）任意次调用结果逐字节相同，且不依赖节点集合给定
 * 顺序——同列/同期望 y 打平手时统一按节点 id 字典序兜底（若依赖"节点在输入数组中的下标"，
 * "仅调整节点声明顺序、拓扑完全不变"的等价输入会跑出不同布局）。
 *
 * 分流靠普通引导线的判断表达式，不是独立的结构化节点，因此没有"分支结构块按泳道居中"这类
 * 额外步骤。
 */
import type { WorkflowNode } from '../model';
import { DesignerStore, type NodePosition } from '../model/store';

/** 列宽——"自动布局"的列步长。与画布节点卡自身像素尺寸（graph/x6-adapter.ts NODE_WIDTH/
 * NODE_HEIGHT 等，184×64）分属不同图层（那是卡片本身多大，这里是网格步长多大），layout.ts
 * 刻意不 import x6-adapter.ts（避免设计层与画布渲染层耦合），只需网格步长大于卡片尺寸即可不
 * 重叠，两处按需各自独立取值，下方 ROW_STEP 同一原则。 */
// 双击节点库新增节点时（见 stencil-drop-placement.ts）复用这两个间距常量，不另造魔法数，因此导出。
export const COLUMN_WIDTH = 260;
/** 布局原点 (80, 120)：决定整张图画在画布哪个角落。 */
const ORIGIN_X = 80;
const ORIGIN_Y = 120;

/** 行间距相关常量——不把节点摁在整数行网格上，而是围绕节点真实卡片高度计算的最小"中心到中心"间距：NODE_CARD_HEIGHT 与
 * graph/x6-adapter.ts 的 NODE_HEIGHT 同值（本地复制一份，不 import，同 COLUMN_WIDTH 注释的
 * "两图层独立取值"既定设计），MIN_EDGE_GAP 是产品要求的相邻节点卡"边缘到边缘"最小可视间距
 * （48px）——两者相加即为质心对齐 / 冲突消解算法统一使用的最小间距单位。 */
const NODE_CARD_HEIGHT = 64;
const MIN_EDGE_GAP = 48;
export const ROW_STEP = NODE_CARD_HEIGHT + MIN_EDGE_GAP; // 112px，导出理由同上方 COLUMN_WIDTH

/** computeColumns 只需要边的 from/to 两个字段，用最小结构体接口而不是完整 DesignEdge，方便
 * 调用方（未来若有除 DesignerStore 外的图数据源）传入等价的简化形状。 */
interface GraphEdgeLike {
  from: string;
  to: string;
}

/**
 * computeAutoLayout —— 对外唯一入口：给定当前设计文档的完整状态（DesignerStore 快照），算出
 * 每个节点的目标位置。空文档（无节点）返回空对象。函数签名是调用方（defaults.ts/DesignerRoot.vue）
 * 的既定契约。
 */
export function computeAutoLayout(store: DesignerStore): Record<string, NodePosition> {
  const nodes = store.listNodes();
  if (nodes.length === 0) return {};
  const edges = store.listEdges();
  const nodeIds = nodes.map((node) => node.id);

  const columns = computeColumns(nodeIds, edges, findStartNodeId(nodes));
  const verticalOffsets = computeCentroidOffsets(nodeIds, edges, columns);

  const positions: Record<string, NodePosition> = {};
  for (const id of nodeIds) {
    positions[id] = {
      x: ORIGIN_X + (columns.get(id) ?? 0) * COLUMN_WIDTH,
      y: ORIGIN_Y + (verticalOffsets.get(id) ?? 0)
    };
  }
  return positions;
}

/** 唯一的开始节点（DesignDocument 语义上恒唯一，见 designer/defaults.ts createBlankFlow 注释
 * "开始节点是流程发起的唯一入口，画布上恒定存在且唯一"）；理论上不应缺失，缺失时列分层退化为
 * "谁的入度先归零谁先垫底"，不强行指定列 0 起点（见 computeColumns 注释）。 */
function findStartNodeId(nodes: WorkflowNode[]): string | undefined {
  return nodes.find((node) => node.kind === 'start')?.id;
}

// ------------------------------------------------------------------
// 第一段：分层（列）——longest path layering，Kahn 拓扑排序实现
// ------------------------------------------------------------------

function computeColumns(nodeIds: string[], edges: GraphEdgeLike[], startId: string | undefined): Map<string, number> {
  const nodeIdSet = new Set(nodeIds);
  const outAdjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const edge of edges) {
    // 防御：边引用了不存在于当前节点集合的端点（理论不应发生，store 的增删原语不做跨表一致性
    // 校验，见 model/store.ts 头注释"这些约束由调用方在更高层保证"，此处不假设调用方已校验过）。
    if (!nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to)) continue;
    outAdjacency.set(edge.from, [...(outAdjacency.get(edge.from) ?? []), edge.to]);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const columns = new Map<string, number>();
  const remainingInDegree = new Map(inDegree);
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueue = (id: string): void => {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };

  // start 强制列 0（即便它意外存在入边——理论不该发生，防御性处理，仍然让它作为分层起点）。
  if (startId && nodeIdSet.has(startId)) {
    columns.set(startId, 0);
    enqueue(startId);
  }
  // 其余入度为 0 的节点（无 start，或图不连通/存在多个入口的防御场景）按调用方给定的节点顺序
  // （store 插入序，确定性）依次入队，列号从 0 开始——与 startId 一致时 enqueue 自动去重。
  for (const id of nodeIds) {
    if ((inDegree.get(id) ?? 0) === 0) {
      if (!columns.has(id)) columns.set(id, 0);
      enqueue(id);
    }
  }

  // Kahn 拓扑排序：一个节点入队时刻，它的全部入边都已经处理完毕（入度归零），此时它的列号已经
  // 是全部前驱列号的最大值+1——这正是"最长路径分层"的标准实现方式，不需要额外的最长路径搜索。
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentColumn = columns.get(current) ?? 0;
    for (const next of outAdjacency.get(current) ?? []) {
      const candidate = currentColumn + 1;
      if ((columns.get(next) ?? -1) < candidate) columns.set(next, candidate);
      const left = (remainingInDegree.get(next) ?? 0) - 1;
      remainingInDegree.set(next, left);
      if (left <= 0) enqueue(next);
    }
  }

  // 防御性兜底：环路（异常拓扑，设计器编辑中间态或损坏文档）导致部分节点的入度从未归零、
  // 从未入队——按调用方给定顺序追加在已布局的最大列之后，保证每个节点都拿到确定的列号，
  // 不因异常拓扑遗漏节点（"至少给出一个确定性结果"）。
  let maxColumn = 0;
  for (const value of columns.values()) maxColumn = Math.max(maxColumn, value);
  for (const id of nodeIds) {
    if (!columns.has(id)) columns.set(id, ++maxColumn);
  }
  return columns;
}

// ------------------------------------------------------------------
// 第二段：子树质心对齐——自底向上取质心 + 自顶向下扫描消解重叠
// ------------------------------------------------------------------

/**
 * computeCentroidOffsets —— 算出每个节点相对 ORIGIN_Y 的纵向像素偏移（正负皆可，由调用方统一
 * 加上 ORIGIN_Y）。两步：
 *
 *   1) 自底向上取"自然期望 y"（见下方 naturalY 循环）：列从右到左处理，某节点的期望 y = 其
 *      全部直接后继节点期望 y 的算术平均；没有后继的节点（真正的图终端，如 end，或图不连通的
 *      死胡同）没有数据来源，统一取 0 作为占位种子——具体落在哪个纵向位置由第 2 步的同列冲突
 *      消解决定，这里的 0 不代表最终坐标。处理顺序严格按"某节点的全部后继必然在更靠右的列，
 *      因此必然已经算完"的方向性进行（与 computeColumns 的最长路径分层同源保证），不会读到
 *      尚未算出的后继期望 y。
 *
 *   2) 逐列扫描消解重叠（resolveOverlapsPreservingOrder，PAVA）：同一列内的节点按"期望 y 升序，
 *      并列按节点 id 字典序兜底"排序后，求一组保持这个顺序、任意相邻两个至少相距 ROW_STEP、且
 *      与期望 y 的欧氏距离平方和最小的最终 y——这个算法的关键性质是"多个节点期望 y 相同/相近
 *      时，解出的最终位置以它们期望 y 的均值为中心对称展开"（单向"顺延到下一个空行"的级联消解
 *      会导致"一个子节点贴着父节点、另一个被甩到很远"）——最终结果整体四舍五入到整数像素，避免半整数偏移渗到渲染层产生亚像素
 *      模糊。
 */
function computeCentroidOffsets(nodeIds: string[], edges: GraphEdgeLike[], columns: Map<string, number>): Map<string, number> {
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  }

  // —— 第 1 步：自底向上取自然期望 y（列从右到左）——
  const naturalY = new Map<string, number>();
  for (const column of groupByColumn(nodeIds, columns, 'desc')) {
    for (const id of column) {
      const succYs = (successors.get(id) ?? [])
        .map((succId) => naturalY.get(succId))
        .filter((value): value is number => value !== undefined);
      naturalY.set(id, succYs.length ? succYs.reduce((sum, value) => sum + value, 0) / succYs.length : 0);
    }
  }

  // —— 第 2 步：逐列 PAVA 消解重叠，保持顺序、相邻最小间距 ROW_STEP、对称外扩 ——
  const finalY = new Map<string, number>();
  for (const column of groupByColumn(nodeIds, columns, 'asc')) {
    const sorted = [...column].sort((a, b) => naturalY.get(a)! - naturalY.get(b)! || a.localeCompare(b));
    const settled = resolveOverlapsPreservingOrder(sorted.map((id) => naturalY.get(id)!));
    sorted.forEach((id, index) => finalY.set(id, Math.round(settled[index])));
  }
  return finalY;
}

/** 按列号分组，direction 只决定返回的列顺序（'desc' 供第 1 步自底向上使用，'asc' 供第 2 步
 * 使用——第 2 步逐列独立消解，列间顺序其实不影响结果，用 'asc' 只是保持代码阅读顺序自然）；
 * 列内部节点顺序沿用 nodeIds 给定顺序，两处调用方各自会再按需排序，这里不做额外排序。 */
function groupByColumn(nodeIds: string[], columns: Map<string, number>, direction: 'asc' | 'desc'): string[][] {
  const byColumn = new Map<number, string[]>();
  for (const id of nodeIds) {
    const column = columns.get(id) ?? 0;
    byColumn.set(column, [...(byColumn.get(column) ?? []), id]);
  }
  const sortedKeys = [...byColumn.keys()].sort((a, b) => (direction === 'asc' ? a - b : b - a));
  return sortedKeys.map((key) => byColumn.get(key)!);
}

/**
 * resolveOverlapsPreservingOrder —— pool adjacent violators（PAVA）的最小实现：给定一组已按
 * 期望值升序排好的数值，求一组同样单调不减、且相邻两个至少相距 ROW_STEP 的最终值，使其与期望
 * 值的欧氏距离平方和最小。标准做法是把"最小间距"约束通过减去累计间距（expected[i] - i*ROW_STEP）
 * 转换成普通的"单调不减"约束（无间距要求的经典 isotonic regression），求解后再加回累计间距。
 * 期望值相同/相近导致违反单调性的一段会被合并成一个"块"，取块内加权平均值——这正是"期望位置
 * 相同时对称展开"的来源：块平均值就是这些节点期望位置的中心，展开时左右对称分布在这个中心
 * 两侧，而不是从最上面那个开始机械地一个个往下顺延。
 */
function resolveOverlapsPreservingOrder(expected: number[]): number[] {
  const adjusted = expected.map((value, index) => value - index * ROW_STEP);
  // 单调栈：栈里每个元素是一个已合并的"块"（块内加权平均值 + 块内元素个数），标准 PAVA 实现——
  // 新值比栈顶块的平均值小（违反非递减）就弹出合并，直到不再违反或栈空为止。
  const blocks: Array<{ mean: number; count: number }> = [];
  for (const value of adjusted) {
    let mean = value;
    let count = 1;
    while (blocks.length > 0 && blocks[blocks.length - 1].mean > mean) {
      const prev = blocks.pop()!;
      mean = (prev.mean * prev.count + mean * count) / (prev.count + count);
      count += prev.count;
    }
    blocks.push({ mean, count });
  }
  const flattened: number[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.count; i += 1) flattened.push(block.mean);
  }
  return flattened.map((value, index) => value + index * ROW_STEP);
}
