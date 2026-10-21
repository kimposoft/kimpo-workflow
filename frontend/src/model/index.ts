/**
 * model/ —— 纯 TS 定义。
 *
 * 分层约束：前后端共享的是生成的 schema/types/error codes，不共享手写的镜像业务规则；
 * X6 类型不得出现在本目录（那是 graph/ 的边界）。本目录只放"设计文档/校验结果"这类纯数据
 * 形状与不依赖 Vue/X6 的转换函数。
 *
 * 本文件是 V2 模型的 barrel——业务文档类型逐字对齐后端 Go 类型，唯一权威源是 ./document.ts（其注释里
 * 点名对应的 internal/model/*.go 文件），本文件只做 re-export，不新增业务类型定义。
 */
export * from './document';

/** DesignNodeType 是 graph/designer 目录既有代码里对"节点类型"的历史称呼（GraphNodeView.type、
 * NODE_SHAPE_FAMILY/NODE_TYPE_TOKENS 等 Record 的键类型）——V2 下就是 NodeKind 本身，单独导出
 * 这个别名是为了不必逐处把 graph/designer 目录里的 `DesignNodeType` 标识符改名，新代码应直接使用 NodeKind。 */
export type { NodeKind as DesignNodeType } from './document';

// —— 画布展示态布局（DesignLayout） ——
//
// 这三个类型/常量与业务文档正交（引擎不关心，仅设计器画布读写、随文档整体保存的纯展示态），
// V1 时期就已经是"业务模型之外的附属状态"，V2 沿用同样的定位——graph/x6-adapter.ts 的
// getLayout()/setLayout() 仍然依赖这份形状，因此保留最小必要的布局类型。

/** 纯画布展示状态里的一个坐标点。 */
export interface DesignLayoutPoint {
  x: number;
  y: number;
}

/** X6 画布视口（缩放/平移）快照。 */
export interface DesignLayoutViewport {
  /** X6 画布缩放比例，1 表示 100%。 */
  scale: number;
  /** X6 画布平移量（像素）。 */
  x: number;
  y: number;
}

/** 可选的纯展示布局快照；历史文档省略时由设计器自动布局（见 designer/layout.ts）。 */
export interface DesignLayout {
  nodePositions?: Record<string, DesignLayoutPoint>;
  edgeVertices?: Record<string, DesignLayoutPoint[]>;
  viewport?: DesignLayoutViewport;
}

/** 单条边允许持久化的手工折点上限，防止异常文档放大 X6 渲染/序列化成本。 */
export const DESIGN_LAYOUT_MAX_EDGE_VERTICES = 256;
