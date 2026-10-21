/**
 * model/document.ts —— 流程引擎 V2 文档模型的 TS 镜像。
 *
 * 权威定义是后端 Go 类型 internal/model/{document.go,node.go,link.go,ids.go}——字段名（含
 * JSON tag 的 snake_case）逐字对齐，本文件不重新发明命名风格。本文件是唯一权威 TS 镜像，
 * 前端画布/面板层只应从这里（经 ./index.ts 转出）拿类型，不得再各自手写第二份。
 *
 * 与 Go 侧的一处系统性差异：Go 的 Node.Config / Link.ConditionDoc 等字段是 json.RawMessage
 * （延迟解析），本文件按 Go 注释里点名的具体结构体（StartConfig/HandleConfig/…）落成 TS
 * interface，供设计器直接读写；调用方需要自行按 node.kind 收窄 config 的类型（TS 没有
 * oneof 强绑定）。
 */

/** Document.Schema 唯一承认的取值，对齐后端 model.SchemaVersion。 */
export const WORKFLOW_DOCUMENT_SCHEMA = 'workflow/1' as const;

/** 六类节点类型（N1～N6），对齐后端 model.NodeKind 常量集合。 */
export type NodeKind = 'start' | 'handle' | 'approve' | 'cc' | 'subflow' | 'end';

/** 画布/面板层判断"是否末级节点"的唯一权威（指向末级节点的出线是支线）。当前 V2
 * 只有 end 是末级——与 Go 侧语义对齐（Document.Nodes 恰一个 start，Links 不要求闭合到某个
 * 特定终点，只有 end 类型节点没有出边意义上的"继续主线"）。 */
export function isTerminalNode(kind: NodeKind): boolean {
  return kind === 'end';
}

/** 主线节点类型集合（start/handle/approve/end）：cc/subflow 是辅助节点，不占主线位置——供
 * 画布自动布局/穷举场景按需引用，不是后端强制校验的概念，仅前端展示层的分类手法。 */
export const MAIN_LINE_KINDS: readonly NodeKind[] = ['start', 'handle', 'approve', 'end'];

/** 流程定义草稿/版本的完整内容：节点图 + 引导线，对齐后端 model.Document。
 *
 * 通知配置在节点级（见下方 NodeNotify），没有流程定义级的顶层 `notify`。后端 Document.Notify
 * 字段仅为解码兼容旧文档保留、不再读取（见 internal/model/document.go 头注释）；前端不持有这个
 * 字段——model/defaults.ts ensureDocumentShape 打开旧文档时会丢弃顶层 `notify` 键。 */
export interface WorkflowDocument {
  /** 恒为 WORKFLOW_DOCUMENT_SCHEMA。 */
  schema: typeof WORKFLOW_DOCUMENT_SCHEMA;
  /** 流程定义名称。 */
  name: string;
  /** 节点清单，恰一个 kind==='start'（后端 Decode 校验，本层不重复实现）。 */
  nodes: WorkflowNode[];
  /** 引导线清单。 */
  links: WorkflowLink[];
}

/** 画布上的一个节点：通用信封 + 按 kind 区分的专属配置，对齐后端 model.Node。 */
export interface WorkflowNode {
  /** 节点在本文档内唯一。 */
  id: string;
  /** 节点类型，取值见 NodeKind。 */
  kind: NodeKind;
  /** 节点在画布上的展示名（设计者可改，默认按类型生成）。 */
  name?: string;
  /** 节点专属配置，按 kind 收窄为 StartConfig/HandleConfig/ApproveConfig/CCConfig/
   * SubflowConfig/EndConfig 之一。 */
  config?: Record<string, unknown>;
  /** 画布坐标，引擎不关心，仅设计器读写、随文档整体保存。 */
  position_x?: number;
  position_y?: number;
}

/** 画布坐标点，供 WorkflowLink.vertices 使用，对齐后端 model.Point。 */
export interface Point {
  x: number;
  y: number;
}

/**
 * V4ExpressionDocumentEnvelope —— 宿主 V4 表达式文档的落库壳（判真假用 mode='condition'，
 * 取值用 mode='value'）。凡是"opaque 原样存取的表达式快照"字段（引导线条件、各节点的自动完成
 * 条件/步骤摘要/通知标题正文等）统一用本类型。
 */
export interface V4ExpressionDocumentEnvelope {
  schema_version: 'kimpo.report-expression/v4';
  mode: 'condition' | 'value';
  expression: {
    expression_id: string;
    purpose: string;
    source_text: string;
    refs: unknown[];
    normalized_digest?: string;
  };
}

/** 一条引导线：连接两个节点，可选一条 V4 判断表达式作为流转条件；不填即无条件、恒可走。
 * 对齐后端 model.Link。 */
export interface WorkflowLink {
  /** 引导线在本文档内唯一。 */
  id: string;
  /** 起止节点 id。 */
  from: string;
  to: string;
  /** 条件表达式的设计期文档（发布时冻结为发布物，求值在填报层由宿主 ExpressionService 做，
   * 本层不解析、不求值）。 */
  condition_doc?: V4ExpressionDocumentEnvelope;
  /** 连线名称：设计者自己填的一段文本，至多 20 字，可空。只用于
   * 画布上标识这条线（中点珠子只认它，留空不画），不参与选路。对齐后端 model.Link.Name。 */
  name?: string;
  /** 画布上的折线控制点，引擎不关心，仅设计器读写、随文档整体保存。 */
  vertices?: Point[];
}

// —— 字段权限（『B』） ——

/** 字段权限档位。B-可编辑型用全部四档；B-只看型只用 继承/只读/隐藏 三档。 */
export type FieldGrade = 'inherit' | 'edit' | 'readonly' | 'hidden';

/** 字段权限清单的一条：目标数据表 + 字段 + 档位。 */
export interface FieldPermission {
  table_id: string;
  field_id: string;
  grade: FieldGrade;
}

// —— 人员来源（『A』） ——

/** 『A 人员来源』六种取值之一（initiator：运行时取实例发起人，条目形状
 *  恒为 `{ kind: 'initiator' }`，无任何参数；只用于办理/审批/抄送三类节点，发起节点『谁能发起』
 *  走的是另一套 StartGrant/OrgTriLine，不复用本类型，见 model/document.ts StartGrant 注释）。
 *
 *  `relation`（『与上步处理人的关系』）不是设计器产生的来源——它是节点 config 上独立的
 *  relation_filters 字段（见下方 HandleConfig/ApproveConfig/CCConfig.relation_filters 注释），
 *  语义是"在已选出的人里再筛一道"。`'relation'` 这个取值**保留在类型里**只是为了兼容旧文档解码
 *  （旧草稿/旧发布物里可能还带着 kind==='relation' 的来源条目），**设计器不产生**这种条目——
 *  model/defaults.ts ensureDocumentShape 在文档打开时会把它自动改记为 relation_filters（A12），
 *  此后设计器内部（含下方 AssigneeSource.relation 字段）只应把它当"读兼容残留"看待，
 *  不应再有任何写入口。 */
export type AssigneeSourceKind = 'user' | 'role' | 'department' | 'main_field' | 'relation' | 'initiator';

/** 『与上步处理人的关系』五档取值。 */
export type AssigneeRelation =
  | 'same_department'
  | 'parent_department'
  | 'child_department'
  | 'department_manager'
  | 'parent_department_manager';

/** 『主表字段』来源匹配依据二选一（A3）。 */
export type AssigneeMatchBy = 'display_name' | 'login_name';

/** 宿主用户 id 列表；wire 形态恒为十进制字符串数组（防 19 位宿主用户 id 在浏览器侧丢精度，
 * 对齐后端 model.IDList——后端解码同时接受数字与字符串，但编码恒输出字符串数组）。 */
export type IDList = string[];

/** 人员来源清单的一条；同一节点可配多条并按 A2 取并集。 */
export interface AssigneeSource {
  kind: AssigneeSourceKind;
  /** kind==='user' 时生效。 */
  user_ids?: IDList;
  /** kind==='role' 时生效。 */
  role_ids?: string[];
  /** kind==='department' 时生效。 */
  department_ids?: string[];
  /** kind==='main_field' 时生效（A3：按用户名或登录名匹配）。 */
  main_field_id?: string;
  match_by?: AssigneeMatchBy;
  /** kind==='relation' 时生效（五档见 AssigneeRelation）。设计器不产生这种来源条目
   *  （见上方 AssigneeSourceKind 注释），本字段仅为读兼容旧文档保留——旧草稿一经
   *  model/defaults.ts ensureDocumentShape 打开即被改记为节点 config 的 relation_filters，
   *  设计器内部不应再有代码往来源清单里写一条 kind==='relation' 的条目。 */
  relation?: AssigneeRelation;
  // kind==='initiator' 时不需要任何参数（运行时取实例发起人），条目形状恒为 { kind: 'initiator' }，
  // 因此本接口不为它声明额外字段。
}

/** 发起权限（N1「用户、角色、部门、主表字段」四种来源，取并集），四组全空=留空，除超级
 * 管理员外无人可发起（N1.1）。对齐后端 model.StartGrant。 */
export interface StartGrant {
  user_ids?: IDList;
  role_ids?: string[];
  department_ids?: string[];
  /** 主表字段来源（N1.8）：目标模板主表的一个字段，取值口径同『A』的主表字段来源——字段
   *  内容按英文逗号拆成多个值，每个值按 match_by 匹配一个人。运行口径：菜单树、任务中心发起
   *  界面这类还没有单据的入口，配了这一档的流程照常列出；提交时按单据上该字段的值真判，不在
   *  其中的人发不起来（判定结果还要与应用访问权取交集）。 */
  main_field_id?: string;
  /** 匹配依据二选一，缺省按用户名（display_name）。 */
  match_by?: AssigneeMatchBy;
}

// —— 办理方式（『D』） ——

/** 『D 办理方式』三档取值，过关判定相同、节点上的叫法不同：
 *  办理节点 any=任意一人/all=全部完成/percentage=按比例；审批节点 any=或签/all=会签/
 *  percentage=按比例。all 档语义等同按比例 100%，但不带 percentage_bp（见 CompleteMode 注释）。 */
export type CompleteModeKind = 'any' | 'all' | 'percentage';

/** 『D』的完整配置：档位 + 按比例时的百分比（默认 10000＝100%，万分比）。kind==='all' 时不带
 *  percentage_bp——语义已固定为 100%，无需也不应该存这个字段（对齐后端 D5）。 */
export interface CompleteMode {
  kind: CompleteModeKind;
  /** 万分比（basis points，10000=100%）；kind==='percentage' 时生效。 */
  percentage_bp?: number;
}

// —— 回退（『E』） ——

/** 『E 回退』三种目标取值之一，节点上按 E1 逐个勾选允许哪些。 */
export type WithdrawMethod = 'previous_step' | 'initiator' | 'specified_step';

/** 『E2 回退时清空』清单的一条：目标数据表 + 字段。 */
export interface ClearOnWithdrawField {
  table_id: string;
  field_id: string;
}

// —— 通知渠道（『N4』） ——

/** 『N4 通知渠道』三选多之一。 */
export type NotifyChannel = 'system' | 'sms' | 'email';

// —— 节点级通知配置（『T』） ——

/** 节点级通知配置的五个事件开关键，对齐后端 internal/model/node.go NotifyKeyAssigned 等五个
 * 字符串常量（同时也是 JSON 里对应字段的键名，键名是前后端约定，不要改）。哪个开关对哪类节点
 * 有意义，按节点类型分别只读取其中几个（其余键对该类节点没有意义，校验/编译/运行期一律忽略、
 * 不报错，见 NodeNotify 注释）：
 *   - 办理 HandleConfig / 审批 ApproveConfig：on_assigned（收到任务）、on_returned（被退回到
 *     这一步）；
 *   - 发起 StartConfig：on_returned（被退回到发起人）、on_withdrawn（提交被撤销）、
 *     on_terminated（实例被管理员终止）；
 *   - 结束 EndConfig：on_ended（流程结束）；
 *   - 抄送 CCConfig、子流程 SubflowConfig：没有 notify 字段（抄送本就是"发出即完成"，通知参数
 *     就是它自己的正文/渠道配置；子流程不产生任何面向人的通知事件）。 */
export type NotifyEventKey = 'on_assigned' | 'on_returned' | 'on_withdrawn' | 'on_terminated' | 'on_ended';

/**
 * NodeNotify —— 节点级通知配置：若干事件开关 + 渠道多选，对齐后端 internal/model/node.go
 * NodeNotify。
 *
 * 开关用可选 boolean（不是必填）：**键缺席 = 默认开**——这是与后端 `*bool` 同一个理由：JSON 里
 * 没有这个键，与"显式配了 false"必须能分开，前者按开处理。`channels` 缺席或空数组同样有默认
 * 语义：仅系统通知（`['system']`），取值同 NotifyChannel。
 *
 * 本层不为按节点类型收窄的四个可选键做进一步的子类型拆分（不搞 StartNotify/HandleNotify 四份
 * 平行类型）——五个键的语义与命名在五类场景下都不冲突，拆分只会徒增类型体系复杂度而不提升类型
 * 安全（调用方本就要按各节点的属性表自行决定只传哪几个 switches，见
 * designer/panels/shared/NotifyCard.vue）。 */
export interface NodeNotify {
  /** 收到任务（办理 / 审批）。 */
  on_assigned?: boolean;
  /** 被退回到这一步（办理 / 审批）/ 被退回到发起人（发起）。 */
  on_returned?: boolean;
  /** 提交被撤销（发起）。 */
  on_withdrawn?: boolean;
  /** 实例被管理员终止（发起）。 */
  on_terminated?: boolean;
  /** 流程结束（结束）。 */
  on_ended?: boolean;
  /** 通知渠道多选，缺席或空数组时按仅 system 处理。 */
  channels?: NotifyChannel[];
}

// —— 审批按钮（『N3』） ——

/** 『N3 审批按钮』点击动作五档取值（end_flow 为「不通过并结束流程」）。 */
export type ButtonAction =
  | 'submit_approve'
  | 'withdraw_previous_step'
  | 'withdraw_initiator'
  | 'withdraw_specified_step'
  | 'end_flow';

/** 审批节点『审批按钮』清单的一条。 */
export interface ApprovalButton {
  id: string;
  name: string;
  color: string;
  action: ButtonAction;
  result_tag: string;
  require_reason: boolean;
  /** 「不通过并结束流程」的目标结束节点 id（N3.7 / N3.11）；仅 action 为 end_flow 时有意义。 */
  end_node_id?: string;
}

// —— 子流程传递字段（『N6』） ——

/** 子流程节点『传递字段』清单的一条：来源字段（当前流程目标模板的主表或扩展表字段）→
 * 目标字段（目标流程目标模板主表字段）。 */
export interface SubflowFieldMapping {
  source_table_id: string;
  source_field_id: string;
  target_field_id: string;
}

/** 『父流程结束后子流程的处置』两档取值（N6，仅"不等待"时可配）。 */
export type SubflowDisposition = 'ignore' | 'force_end';

// —— N1 发起：设计层配置 · 填报层触发 ——

/** 发起节点（N1）的专属配置，对齐后端 model.StartConfig。 */
export interface StartConfig {
  /** 目标模板（本应用内），经宿主通用模板选择弹窗设置。必填。 */
  target_template_id: string;
  /** 发起权限，四种来源（用户/角色/部门/主表字段）取并集；留空即除超级管理员外无人可发起
   *  （N1.1）。 */
  start_permission?: StartGrant;
  /** 允许人工发起，默认开（N1.3：关闭时只能由动作/子流程等发起）。 */
  allow_manual_start: boolean;
  /** 同『B-可编辑型』。 */
  field_permissions?: FieldPermission[];
  /** 无路可走时的提示（用于 L4/N1.4）。必填。 */
  no_route_hint: string;
  /** 步骤摘要（同『H』），V4 计算表达式发布物引用，可空。 */
  summary_expr?: V4ExpressionDocumentEnvelope;
  /** 发起条件（N1.7）：一条 V4 判断表达式，真正发起前求值一次
   *  （人工发起与动作发起一视同仁；**子流程发起不受它限制**），结果为假则不
   *  发起，向发起人展示
   *  start_condition_hint（不暴露表达式原文）。不填即不限——它只是闸门，**不参与**「用哪条
   *  流程」的选择（模板绑定的已发布流程仍由用户显式选一个）。 */
  start_condition?: V4ExpressionDocumentEnvelope;
  /** 不满足发起条件时的提示：告诉发起人为什么发不起来。配了 start_condition 时业务上必填
   *  （后端发布期 N1_START_CONDITION_HINT_REQUIRED 会拦），本层类型不强制、允许过渡态为空。 */
  start_condition_hint?: string;
  /** 节点级通知配置（『T』）：只认 on_returned（被退回到发起人）、
   * on_withdrawn（提交被撤销）、on_terminated（实例被管理员终止）三个键，可空——不配时按
   * 「全部开 + 系统通知」处理（同 NodeNotify 注释）。 */
  notify?: NodeNotify;
}

// —— N2 办理：设计层配置 · 填报层执行 ——

/** 办理节点（N2）的专属配置，对齐后端 model.HandleConfig。 */
export interface HandleConfig {
  /** 办理人，同『A』；见 A1（至少配一种来源）。 */
  assignees?: AssigneeSource[];
  /** 过滤器：与上步处理人的关系（A3/A10～A13）：
   *  五档可多选，默认不限；先按 assignees 算出候选，再只留下与上步处理人满足所选关系之一的人
   *  （不是来源，不参与 A2 的并集计算）。只配了本字段、assignees 一种来源都没配时，发布期拒绝
   *  （A1，诊断码 A1_FILTER_WITHOUT_SOURCE）。键名 relation_filters 是前后端约定，不要改；
   *  与后端 internal/model/node.go HandleConfig.RelationFilters 对齐。 */
  relation_filters?: AssigneeRelation[];
  /** 办理方式，同『D』。必填。 */
  complete_mode: CompleteMode;
  /** 同『B-可编辑型』。 */
  field_permissions?: FieldPermission[];
  /** 可用的回退方式（提交、暂存固定可用，不在此列）。 */
  allowed_withdraw_methods?: WithdrawMethod[];
  /** 回退时清空的字段清单（同『E2』）。 */
  clear_on_withdraw?: ClearOnWithdrawField[];
  /** 无路可走时的提示。必填。 */
  no_route_hint: string;
  /** 自动办理条件（同『F』），V4 判断表达式发布物引用，可空。 */
  auto_complete_condition?: V4ExpressionDocumentEnvelope;
  /** 步骤摘要（同『H』），可空。 */
  summary_expr?: V4ExpressionDocumentEnvelope;
  /** 节点级通知配置（『T』）：只认 on_assigned（收到任务）、on_returned
   * （被退回到这一步）两个键，可空——不配时按「全部开 + 系统通知」处理。 */
  notify?: NodeNotify;
}

// —— N3 审批：设计层配置 · 填报层执行 ——

/** 审批节点（N3）的专属配置，对齐后端 model.ApproveConfig。 */
export interface ApproveConfig {
  /** 审批人，同『A』；见 A1。 */
  approvers?: AssigneeSource[];
  /** 过滤器：与上步处理人的关系，语义与 A1/A3/A10～A13 同 HandleConfig.relation_filters 注释。 */
  relation_filters?: AssigneeRelation[];
  /** 办理方式，同『D』。必填。 */
  complete_mode: CompleteMode;
  /** 同『B-只看型』。 */
  field_permissions?: FieldPermission[];
  /** 审批按钮，至少一个（默认两个：同意=提交通过、拒绝=回退到指定步骤，由设计器初始化）。 */
  buttons: ApprovalButton[];
  /** 结果绑定字段（本表主表），可空；发布期只允许文本字段（K4）。 */
  result_field_id?: string;
  /** 理由绑定字段（本表主表），可空；发布期只允许文本字段（K4）。 */
  reason_field_id?: string;
  /** 回退时清空的字段清单（同『E2』）。 */
  clear_on_withdraw?: ClearOnWithdrawField[];
  /** 无路可走时的提示。必填。 */
  no_route_hint: string;
  /** 自动办理条件（同『F』），可空。 */
  auto_complete_condition?: V4ExpressionDocumentEnvelope;
  /** 步骤摘要（同『H』），可空。 */
  summary_expr?: V4ExpressionDocumentEnvelope;
  /** 节点级通知配置（『T』）：只认 on_assigned（收到任务）、on_returned
   * （被退回到这一步）两个键，与办理节点同一套语义，可空——不配时按「全部开 + 系统通知」处理。 */
  notify?: NodeNotify;
}

// —— N4 抄送：设计层配置 · 填报层通知 ——

/** 抄送节点（N4）的专属配置，对齐后端 model.CCConfig。 */
export interface CCConfig {
  /** 收件人，同『A』；见 A1。 */
  recipients?: AssigneeSource[];
  /** 过滤器：与上步处理人的关系，语义与 A1/A3/A10～A13 同 HandleConfig.relation_filters 注释。 */
  relation_filters?: AssigneeRelation[];
  /** 通知渠道，多选，至少一种；系统通知默认选中。 */
  channels: NotifyChannel[];
  /**
   * 通知标题（V4 取值表达式发布物引用）。业务上必填（发布期 N4_TITLE_REQUIRED 会拦），
   * 但类型允许 `null`——对齐后端 model.CCConfig.TitleExpr 是 `json.RawMessage` 且 json tag
   * 没有 `omitempty`（键必须出现在 JSON 里，取值可以是字面量 null）：字段"未配置"这件事在
   * wire 协议上唯一合法的表达就是 `null`，不能像 summary_expr 那类可选表达式槽一样直接省略键
   * （见 internal/node/cc.go isBlankExpr 对"空"的判定口径，与本层 nodes/cc/index.ts 默认配置
   * 的取值一致）。
   */
  title_expr: V4ExpressionDocumentEnvelope | null;
  /** 通知正文（V4 取值表达式发布物引用）。必填语义与 null 允许原因同 title_expr。 */
  content_expr: V4ExpressionDocumentEnvelope | null;
  /** 同『B-只看型』，在收件人查看单据时生效。 */
  field_permissions?: FieldPermission[];
}

// —— N5 结束：设计层配置 · 填报层收尾 ——

/** 结束节点（N5）的专属配置，对齐后端 model.EndConfig。 */
export interface EndConfig {
  /** 结束标识，一段文本（如「已通过」）。必填。 */
  end_flag: string;
  /** 标识写入字段（本表主表），可空；发布期只允许文本字段（K4）。 */
  write_field_id?: string;
  /** 节点级通知配置（『T』）：只认 on_ended（流程结束）一个键，可空——
   * 不配时按「全部开 + 系统通知」处理。 */
  notify?: NodeNotify;
}

// —— N6 子流程：设计层配置 · 填报层发起 ——

/** 子流程节点（N6）的专属配置，对齐后端 model.SubflowConfig。 */
export interface SubflowConfig {
  /** 目标流程（一条已发布的流程）。必填。 */
  target_workflow_id: string;
  /** 传递字段清单（同一张扩展表，或全部来自主表；见 N6.2）。 */
  field_mappings?: SubflowFieldMapping[];
  /** 是否等待：true=等待子流程全部结束再向后走；false=发起后立即向后走。必填。 */
  wait: boolean;
  /** 父流程结束后子流程的处置，仅 wait===false 时必填。 */
  disposition?: SubflowDisposition;
}
