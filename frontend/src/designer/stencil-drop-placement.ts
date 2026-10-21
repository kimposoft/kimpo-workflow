/**
 * designer/stencil-drop-placement.ts —— 双击节点库条目"快捷创建"的落点计算（纯函数）；另含拖拽松手落点的"指针对准节点中心"换算 computeStencilDropPosition。
 *
 * 背景：画布首次打开会做初始平移（发起节点锚在容器左中，不是原点对齐），写死的文档坐标可能
 * 落在可视区之外，让双击新增的节点"看不见"。因此落点按已有节点相对计算：
 *
 *   - 有选中节点：放在选中节点右侧同一行；
 *   - 没有选中节点：放在画布上最靠右的节点右侧同一行（流程自左向右画，只有发起节点时即发起节点
 *     右侧）；
 *   - 水平间距取 designer/layout.ts 的 COLUMN_WIDTH（自动布局的列步长，不另造魔法数）；
 *   - 目标位置与已有节点重叠（包围盒相交）时，按 designer/layout.ts 的 ROW_STEP（行步长）向下
 *     顺延直到不重叠。
 *
 * 只做"算出一个不挡视线、不压别的节点的坐标"这一件事，不碰 X6、不知道"节点自动成为选中节点"
 * "视口要不要平移把新节点带入可视区"这两件事——那两件事分别是 DesignerRoot.vue（选中态）与
 * designer/canvas/viewport.ts 的 computeMinimalPanToReveal + DesignerCanvas.vue revealRect()
 * （视口平移）的职责，见各自消费处注释。
 */
import { COLUMN_WIDTH, ROW_STEP } from './layout';

/** 已有节点的位置 + 尺寸（文档/模型坐标系，position_x/position_y 为左上角，与
 * WorkflowNode.position_x/position_y、graph/x6-adapter.ts nodeDimensions() 同一套单位）。 */
export interface PlacedNodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StencilDblClickPlacementInput {
  /** 当前文档全部节点的位置与尺寸——调用方（DesignerRoot.vue）按 doc.nodes 逐个用
   * graph/x6-adapter.ts 的 nodeDimensions(node.kind) 求出宽高后拼成这个数组，本文件不越过
   * designer/ 边界直接 import graph/ 的运行时逻辑（同 layout.ts 头注释"两图层独立取值"），只
   * 接收调用方已经拿到的数字。 */
  existingNodes: PlacedNodeRect[];
  /** 新建节点自身尺寸（同样由调用方经 nodeDimensions(key) 取得）。 */
  newNodeSize: { width: number; height: number };
  /** 当前选中的节点 id；存在且能在 existingNodes 里找到才生效，否则退化为"最靠右的节点"。 */
  selectedNodeId: string | undefined;
}

/** 写死兜底坐标——理论不应发生（发起节点恒存在，existingNodes 不会真的是空数组），
 * 只作极端防御分支。 */
const FALLBACK_POSITION = { x: 340, y: 380 };

/** 防御性循环次数上限：正常情况下顺延不超过 existingNodes.length 次必然找到空位（每次顺延躲开
 * 的是"当前挡路的那一个"，节点数有限），额外留一点余量防止将来极端输入（如 newNodeSize 或
 * ROW_STEP 被改成 0）导致死循环。 */
const OVERLAP_RESOLVE_GUARD_EXTRA = 8;

export function computeStencilDblClickPosition(input: StencilDblClickPlacementInput): { x: number; y: number } {
  const { existingNodes, newNodeSize, selectedNodeId } = input;
  if (existingNodes.length === 0) return { ...FALLBACK_POSITION };

  const anchor = resolveAnchorNode(existingNodes, selectedNodeId);
  const anchorCenterY = anchor.y + anchor.height / 2;
  const x = anchor.x + COLUMN_WIDTH;
  let y = anchorCenterY - newNodeSize.height / 2;

  const guardLimit = existingNodes.length + OVERLAP_RESOLVE_GUARD_EXTRA;
  let guard = 0;
  while (existingNodes.some((node) => rectsOverlap({ x, y, width: newNodeSize.width, height: newNodeSize.height }, node))) {
    y += ROW_STEP;
    guard += 1;
    if (guard > guardLimit) break; // 防御性兜底，见上方 OVERLAP_RESOLVE_GUARD_EXTRA 注释
  }

  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * computeStencilDropPosition —— 从节点库**拖拽**条目到画布松手时的落点（与上面双击快捷创建
 * 是两条入口）：把"指针所在的画布坐标"换算成节点 position（左上角）。
 *
 * 根因：此前 DesignerCanvas.vue onDrop 把指针坐标原样当作 position 交给 addNode，而 position
 * 在模型里是节点**左上角**（见 PlacedNodeRect 注释）——松手后节点左上角贴在指针处，整张卡片
 * 出现在指针右下方，与用户"我把它放在这儿"的直觉不符。修法：让节点**中心**对准指针，即左上角
 * = 指针坐标 − 节点宽高的一半。节点尺寸同样由调用方经 graph/x6-adapter.ts nodeDimensions(key)
 * 取得后传入（本文件不越过 designer/ 边界 import graph/ 运行时逻辑，同上）。取整交给
 * model/document-state.ts addNode（那里统一 Math.round），这里不重复取整。
 */
export function computeStencilDropPosition(
  pointer: { x: number; y: number },
  newNodeSize: { width: number; height: number }
): { x: number; y: number } {
  return { x: pointer.x - newNodeSize.width / 2, y: pointer.y - newNodeSize.height / 2 };
}

/** 选中节点存在且仍在当前节点集合里则用它；否则取"最靠右"的节点——按右缘（x+width）比较，
 * 并列时按 id 字典序兜底（同 designer/layout.ts 既定的确定性打平手做法，保证同一份输入任意次
 * 调用结果一致）。 */
function resolveAnchorNode(nodes: PlacedNodeRect[], selectedNodeId: string | undefined): PlacedNodeRect {
  if (selectedNodeId) {
    const selected = nodes.find((node) => node.id === selectedNodeId);
    if (selected) return selected;
  }
  return nodes.reduce((rightmost, node) => {
    const rightmostEdge = rightmost.x + rightmost.width;
    const nodeEdge = node.x + node.width;
    if (nodeEdge > rightmostEdge) return node;
    if (nodeEdge === rightmostEdge && node.id.localeCompare(rightmost.id) < 0) return node;
    return rightmost;
  });
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 轴对齐包围盒相交判据（半开区间：恰好边对边贴合不算相交）。 */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
