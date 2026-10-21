/**
 * graph/port.ts —— GraphPort：渲染器无关的画布适配接口（graph adapter 与 store 双向同步；
 * X6 只能出现在 frontend/src/graph 及极薄的图形组件边界）。
 *
 * designer/ 只依赖本文件声明的接口，不直接依赖具体实现（svg-adapter.ts 是最小实现，
 * x6-adapter.ts 是 X6 实现，二者实现同一接口，designer/ 不感知具体渲染器）。
 *
 * 数据流向（双向同步）：
 *   store(commands 执行结果) --setNodes/setEdges/setSelection--> GraphPort（画布展示）
 *   GraphPort（用户在画布上的操作）--事件回调 GraphPortEvents--> designer/ 组件构造对应 Command
 *     --CommandStack.execute--> store 变更 --> 再次调用 setNodes/setEdges 回灌画布
 * 画布本身不直接改 store，只上报"用户意图"（选中/拖拽结束/连接），由消费方决定是否/如何
 * 转成命令——这样撤销/重做历史里不会混入画布内部的纯展示状态变化。
 */
import type { DesignNodeType } from '../model';
import type { NodePosition } from '../model/store';

/** 画布上一个节点的展示态（从 store 节点 + position 派生，不是业务 DesignNode 本身）。
 * type 用 DesignNodeType（含 handle/branch_split/branch_join，见 model/index.ts
 * DesignNode.type 注释），画布渲染层（svg-adapter.ts）按此类型穷举图形/配色。 */
export interface GraphNodeView {
  id: string;
  type: DesignNodeType;
  /** 展示用标签：优先 DesignNode.name，缺省时由消费方回填类型名的本地化文案。 */
  label: string;
  position: NodePosition;
  /**
   * 配置摘要（两行节点卡的第二行）：如"办理人：发起人""部门经理（角色）· 或签"。
   * 目的是**不点开面板也能读懂整条流程**。
   * 空串表示该节点没有值得摘要的配置，此时退化为单行居中，不留一条空行占位。
   */
  summary?: string;
  /** 该节点是否存在校验问题（来自 model/validate-map.ts），驱动画布上的警示态样式。 */
  hasIssues?: boolean;
  /**
   * 该节点是否"必填项没配全"（摘要显示「待配置」橙标）：与 hasIssues
   * 是两个不同的判据——hasIssues 来自服务端 ValidateDefinition 结果，只有点了保存/发布/校验
   * 才会有值；needsConfig 是纯本地、随编辑即时可算的"配置完整性"自检（服务端
   * 校验前的本地自检提示），见 designer/node-summary.ts nodeNeedsConfig 的判据说明。驱动
   * 摘要文本的橙色着色（配置全时为 false，不影响正常灰色摘要展示）。
   */
  needsConfig?: boolean;
  /**
   * 该节点当前是否处于选中态：驱动画布节点卡描边换色/光晕/四角手柄/四端口常显，见 graph/x6-adapter.ts
   * applyNodeVisual——调用方（DesignerRoot.vue）按当前选中态算好再传入，不在 apply* 内部
   * 反查选中集合。
   */
  selected?: boolean;
}

/**
 * 连线标记珠的完整描述：条件分支＝fx 珠，默认（兜底）路线＝「默」珠，按钮流转＝按钮名短标签，
 * 普通无条件直连＝不显示任何标记（不在线上铺整句文案）。
 *
 * 🔴 画布中点珠子的产出规则："设计器画布上引导线中点的标识只认名称"——唯一调用方
 * designer/graph-bridge.ts toGraphEdges 按"连线是否有名称"产出 'name'/'none' 两态，不按
 * "是否有条件"产出 'condition' 态（是否条件路线由 GraphEdgeView 的独立字段 hasCondition
 * 驱动线色，与 marker 完全解耦，见该字段注释）。'condition'/'else'/'button' 三态的类型定义与
 * graph/x6-adapter.ts buildMarkerLabelConfig 对应渲染分支仍然保留（可能的产出路径），只是
 * 当前 toGraphEdges 不产出它们。
 *
 * 本接口只声明**画布要渲染的数据形状**，不掺入 model/host-ui 依赖——具体"给一条 BranchRoute
 * 怎么算出这份数据"的业务逻辑放在 designer/node-summary.ts 的 edgeConditionMarker()（同
 * GraphNodeView.summary 是纯字符串、真正的文案计算在 designer/ 层的既定分工，graph/ 目录只放
 * 渲染器无关的展示态形状，见文件头说明）。
 */
export interface EdgeConditionMarker {
  /** 珠子类型：'condition' 需要 fx 编辑器的分支条件路线（含未配置态，见 configured 字段，
   * 当前 toGraphEdges 不产出，见上方"🔴"一节）；'else' 默认（兜底）路线（当前同样无产出）；
   * 'button' 审批按钮流转短标签（当前设计文档模型还没有"边关联到具体按钮"的字段，无真实
   * 调用方，见 edgeConditionMarker 头注释"遗留问题"）；'name' 连线名称珠（连线设了名称就画珠，
   * 文字=名称，与该线是否配了条件无关）；'endflow' 审批按钮「不通过并结束流程」的只读装饰
   * 虚线上的按钮名标签（危险色白底胶囊，仅装饰边使用，无 tooltip、不可交互）；'none' 无任何标记
   * （不渲染珠子——没有名称的连线落这一态，哪怕它配了条件）。 */
  kind: 'condition' | 'else' | 'button' | 'name' | 'endflow' | 'none';
  /** 珠子上显示的短文案：条件＝'fx'；默认＝'默'；按钮流转＝按钮名；连线名称＝名称本身（超过
   * 8 个字符时截断为前 8 个字符+'…'，完整名称走下方 tooltip，见 toGraphEdges 截断逻辑）；
   * 无标记＝空串。 */
  shortLabel: string;
  /** 仅 kind==='condition' 时有意义：该路线是否已经配置好条件，驱动珠子配色区分
   * "已配置（蓝）/ 待配置（橙）"——橙色语义与节点摘要"待配置"统一。 */
  configured?: boolean;
  /**
   * 仅 kind==='button' 时有意义：按钮语义色圆点的色值（六位十六进制），由
   * designer/node-summary.ts resolveEdgeButtonLabel 按 ButtonConfig.color（或 resultKey 猜测，
   * 见其注释）换算得出。未传入（如仅传
   * `{buttonLabel}` 调用方式）时 graph/x6-adapter.ts 按中性灰兜底，不是错误态。
   */
  buttonColor?: string;
  /**
   * 悬停后气泡展示的说明文字（悬停珠 300ms 出条件全文气泡）。
   * 🔴 不用 X6 原生 title 特殊属性（其弹出延迟由浏览器控制、不可编程）——渲染层
   * （graph/x6-adapter.ts）通过 GraphPortEvents.edgeMarkerHover/
   * edgeMarkerLeave 把本文字连同悬停坐标一起上报给消费方，由消费方（designer/canvas/
   * DesignerCanvas.vue）自绘气泡浮层并持有可编程的 300ms 计时器。
   */
  tooltip: string;
}

/** 画布上一条边的展示态。 */
export interface GraphEdgeView {
  id: string;
  from: string;
  to: string;
  /** 引导线展示的短文案（有名称时＝名称本身，无名称时＝undefined，不是"有条件"之类的
   * 提示文案，见 EdgeConditionMarker 头注释"🔴"一节），给 svg-adapter.ts（最小实现，只会画
   * 纯文本，不支持珠子视觉）读取；X6GraphAdapter 读下面的 marker 字段渲染完整标记珠。 */
  label?: string;
  /** X6 画布消费的完整标记珠描述，见 EdgeConditionMarker 注释。svg-adapter.ts 不
   * 读取本字段（最小实现不支持珠子视觉）。 */
  marker?: EdgeConditionMarker;
  /**
   * 该线是否配了条件表达式：只驱动线色（条件分支＝主色，见
   * graph/x6-adapter.ts applyEdgeVisual），与是否画标记珠（marker）完全解耦——marker 现在只
   * 看"有没有名称"，两件事互不影响，一条配了条件但没起名字的线：线是蓝的、中点不画任何珠子。
   */
  hasCondition?: boolean;
  hasIssues?: boolean;
  /** 该边是否是某条分支路线的兜底（else）起始引导线（表达式为 else 时，画布自动显示
   * '其他情况'），驱动画布上的兜底态视觉区分（虚线）。 */
  isElseRoute?: boolean;
  /**
   * 只渲染、不入库的装饰边标记：审批节点 end_flow 按钮到目标结束节点的示意虚线。
   * 它不是 WorkflowDocument.links 里的连线——不能选中/拖动/删除/改连接、不进 getLayout、不参与
   * 贴边插入就近判定与校验选路，画布适配器据此走独立的视觉分支并在各交互点过滤（见
   * graph/x6-adapter.ts）。由 designer/graph-bridge.ts toGraphEdges 从审批按钮配置派生，按钮配置
   * 变化时随之增删，绝不写回 document.links。
   */
  decorative?: boolean;
}

/** GraphPort 对外上报的用户交互事件（消费方据此构造 Command，见文件头数据流说明）。 */
export interface GraphPortEvents {
  /** 用户点击某节点；点击空白画布时以 null 触发一次，表示"清除节点选中"。 */
  nodeSelect: (nodeId: string | null) => void;
  /** 用户点击某条边；点击空白画布时以 null 触发一次。 */
  edgeSelect: (edgeId: string | null) => void;
  /**
   * 节点拖拽结束（mouseup）才触发——拖拽过程中的实时位置变化只是适配器内部的展示态，
   * 不经过本回调，也不产生 Command。
   */
  nodeMoveEnd: (nodeId: string, position: NodePosition) => void;
  /** 用户从 fromNodeId 的连接手柄拖拽到 toNodeId 并释放，表达"新增一条边"的意图。 */
  connect: (fromNodeId: string, toNodeId: string) => void;
  /** X6 框选/多选的完整快照；仍由 DesignerStore 持有最终选中态。 */
  selectionChange: (nodeIds: string[], edgeIds: string[]) => void;
  /** 群移在 mouseup 时一次回抛，消费方用 CompositeCommand 形成单步撤销。 */
  nodesMoveEnd: (moves: Array<{ nodeId: string; position: NodePosition }>) => void;
  /** 画布快捷键/菜单只表达意图，业务变更仍在 DesignerRoot 生成命令。 */
  deleteSelection: () => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  paste: (nodeIds: string[]) => void;
  renameNode: (nodeId: string, name: string) => void;
  /** 边拐点或视口变化；纯展示状态由 DesignerRoot 单独标记为未保存。 */
  layoutChange: () => void;
  // —— 条件标记珠的悬停上报（见 EdgeConditionMarker.tooltip 注释"不用原生 title"）。适配器只负责"检测到珠子被悬停/离开"这一事实并上报坐标+文案，
  // 300ms 出现延迟与气泡渲染全部交给消费方（designer/canvas/DesignerCanvas.vue），因此这里的
  // 事件是"进入/离开"的即时通知，不是"该出现气泡了"的延迟通知。
  /** 鼠标进入某条边的标记珠：clientX/clientY 是珠子自身几何位置（视口坐标，珠子横向中点、
   * 顶部边缘——"跟随珠子定位"要求气泡锚定珠子而非鼠标指针，见 x6-adapter.ts 里 mount() 内
   * onEdgeLabelRendered 的算法注释），text 即 EdgeConditionMarker.tooltip 原文。 */
  edgeMarkerHover: (edgeId: string, clientX: number, clientY: number, text: string) => void;
  /** 鼠标离开标记珠。 */
  edgeMarkerLeave: () => void;
}

/** GraphPort —— 渲染器无关的画布适配接口。所有实现必须是幂等的：重复调用同一份数据不应产生可观察副作用。 */
export interface GraphPort {
  /** 把画布挂载到给定容器；只能调用一次，重复挂载前必须先 unmount。 */
  mount(container: HTMLElement): void;
  /** 卸载画布，释放所有 DOM/事件监听，之后该实例不得再被使用。 */
  unmount(): void;
  /** 全量替换当前展示的节点集合（增量 diff 由具体实现内部处理，调用方不负责 diff）。 */
  setNodes(nodes: GraphNodeView[]): void;
  setEdges(edges: GraphEdgeView[]): void;
  /** 更新画布高亮的选中态（与 store 的 SelectionState 语义对齐，但这里只影响展示）。 */
  setSelection(nodeIds: string[], edgeIds: string[]): void;
  /** 只读模式：隐藏编辑手柄（拖拽/连接柄），仍然允许选中。 */
  setReadOnly(readOnly: boolean): void;
  /** 订阅事件，返回取消订阅函数。 */
  on<K extends keyof GraphPortEvents>(event: K, handler: GraphPortEvents[K]): () => void;
}
