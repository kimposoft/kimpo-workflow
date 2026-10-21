/**
 * model/validate-map.ts —— 把网关 validate / 发布 409 返回的诊断列表，映射成设计器面板能直接
 * 消费的"业务话"结构。
 *
 * 诊断 code 的权威源是插件后端（不是本文件发明）：
 *   - internal/compile/checks.go（结构检查：LINK_* / NODE_KIND_UNSUPPORTED / L10 / L11 /
 *     END_HAS_OUTLINE）
 *   - internal/compile/compile.go（K2 目标模板未发布 / N1_TARGET_TEMPLATE_MISMATCH /
 *     NODE_CONFIG_INVALID）
 *   - internal/node/{start,handle,end,approve,cc,subflow}.go（各节点类型的 Validate：N1 系列 /
 *     A1 系列 / A_SOURCE_UNSUPPORTED / NO_ROUTE_HINT_REQUIRED / N5_END_FLAG_REQUIRED /
 *     N3_BUTTON_*（审批按钮）/ N4_CHANNEL_*、N4_TITLE_REQUIRED、N4_CONTENT_REQUIRED（抄送）/
 *     N6_TARGET_REQUIRED、N6_MAPPING_*、N6_TERMINAL_MUST_NOT_WAIT、N6_DISPOSITION_REQUIRED
 *     （子流程））
 *   - internal/node/assignee_rules.go（办理/审批/抄送共用的『A/D』通用校验：D_RATIO_OUT_OF_RANGE
 *     等；`D_RATIO_UNSUPPORTED` 是历史遗留 code——后端已改为只产 D_RATIO_OUT_OF_RANGE，本文件
 *     暂不删它，见下方 KNOWN_DIAGNOSTIC_CODES 该项注释）
 *   - internal/compile/fieldtype.go（K4 字段类型闸：FIELD_TYPE_UNSUPPORTED，结果 / 理由
 *     绑定字段与结束标识写入字段必须是主表文本字段）
 *   - internal/compile/checks.go（LINK_NAME_TOO_LONG：连线名称超过 20 个字符时产出，定位到
 *     该连线）
 *   - internal/compile/subflowmap.go（子流程发布期后端闸：K3_TARGET_NOT_PUBLISHED
 *     目标流程须存在/同应用/已发布/未停用；N6_MAPPING_SOURCE_INVALID、N6_MAPPING_TARGET_INVALID
 *     传递字段的来源/目标字段配置须有效；N6_MAPPING_TYPE_MISMATCH 传递字段来源与目标类型须
 *     相同或目标为文本。前三者 arguments.reason 细分具体原因，按 L11 先例逐个特判，见下方
 *     keyForK3TargetNotPublished / keyForN6MappingSourceInvalid / keyForN6MappingTargetInvalid）
 * 本文件对每个 code 登记一个四语键 + 业务话模板（文案里不出现 code/字段名/JSON 结构），未登记
 * 的 code（新增节点类型时的诊断，或本文件暂时没跟上的新增 code）统一走
 * `workflow.designer.issue.unknown` 兜底，不是"报错崩溃"。前端登记表与后端实际产码的对拍见
 * ./validate-map.backend-parity.static.test.ts（判据方向是"后端产码 ⊆ 本清单"，允许本清单比
 * 后端多几个历史幽灵码）。
 *
 * `{node}` 占位：本层只从 node_id/link_id 拿到 id，不持有文档、无法解析节点的展示名——文案
 * 模板里的 {node} 由调用方（持有文档 + i18n 的面板层）在最终 t(textKey, params) 时自行补上
 * `node: 节点展示名`，本层的 params 只透传诊断自带的 arguments。
 */

/** 网关 / 发布拒绝返回的原始诊断条目，字段形状对齐后端 internal/model/diagnostic.go
 * Diagnostic（json tag 保持 snake_case，与 wire 格式逐字一致）。 */
export interface RawDiagnostic {
  code: string;
  message_key?: string;
  message?: string;
  node_id?: string;
  link_id?: string;
  arguments?: Record<string, string>;
}

/** 映射后的业务话问题条目。 */
export interface MappedIssue {
  nodeId?: string;
  linkId?: string;
  /** 四语键，格式 workflow.designer.issue.<name>。 */
  textKey: string;
  /** 文案插值参数（透传自 RawDiagnostic.arguments，可能为空对象）。 */
  params?: Record<string, string>;
  /** 该问题在属性面板里对应的分区 key（与 i18n 键 workflow.designer.panel.tabs.<tab> 同名，
   *  如 'basic'/'approveRule'/'notify' 等），供属性面板改按分区（tab）组织后"点检查项定位到具体
   *  分区"使用。可选字段——只有能从 code 唯一确定分区的诊断才登记，见下方 CODE_TAB；未登记时
   *  undefined，消费方应表现为"只选中节点，不切分区"。 */
  tab?: string;
}

export interface GroupedIssues {
  byNode: Record<string, MappedIssue[]>;
  byLink: Record<string, MappedIssue[]>;
  /** 既不挂节点也不挂引导线的问题（如"流程缺少结束节点"这类文档级问题）。 */
  global: MappedIssue[];
}

/** 后端当前已实现校验的全部 code（结构检查、六类节点各自的 Validate、K4 字段类型闸、子流程
 * 发布期后端闸，外加少量后端已不再产出的历史码）。用于 locale-parity 一类"覆盖度"单测按此
 * 清单逐条断言不漏译，见 validate-map.test.ts；与后端实际产码的对拍见
 * ./validate-map.backend-parity.static.test.ts。 */
export const KNOWN_DIAGNOSTIC_CODES = [
  'LINK_ID_INVALID',
  'LINK_ENDPOINT_UNKNOWN',
  'LINK_SELF_LOOP',
  // 连线名称超过 20 个字符（internal/compile/checks.go）。key 走标准自动派生
  // （'LINK_NAME_TOO_LONG'.toLowerCase()），不需要特判。
  'LINK_NAME_TOO_LONG',
  'NODE_KIND_UNSUPPORTED',
  'L10',
  'L11',
  'END_HAS_OUTLINE',
  'K2',
  'N1_TARGET_TEMPLATE_MISMATCH',
  'NODE_CONFIG_INVALID',
  'A1_SOURCE_REQUIRED',
  'A1_SOURCE_EMPTY',
  'A_SOURCE_UNSUPPORTED',
  // D_RATIO_UNSUPPORTED：历史遗留 code，internal/node/assignee_rules.go 当前只产
  // D_RATIO_OUT_OF_RANGE，不再产这一条。保留而不删：既有四语翻译已经进了 locale-parity.test.ts
  // 的断言清单，删掉这一项要连带改那份测试与四份 locale 文件，
  // 收益（少一个不会再触发的 key）小于改动面；对拍测试只检查"后端产码 ⊆ 本清单"这个方向，
  // 本清单比后端多几个历史幽灵码不算错，见 validate-map.backend-parity.static.test.ts。
  'D_RATIO_UNSUPPORTED',
  'D_RATIO_OUT_OF_RANGE',
  'N3_BUTTON_REQUIRED',
  'N3_BUTTON_NAME_REQUIRED',
  'N3_BUTTON_ACTION_UNSUPPORTED',
  'N3_BUTTON_RESULT_TAG_REQUIRED',
  // 「不通过并结束流程」：end_flow 按钮没选结束节点 / 选的节点已不
  // 存在或不再是结束节点；带 arguments：button（按钮名）、button_id、end_node_id（仅 INVALID）。
  // key 走标准自动派生（code 全小写），不需要特判。
  'N3_BUTTON_END_TARGET_REQUIRED',
  'N3_BUTTON_END_TARGET_INVALID',
  // NO_ROUTE_HINT_REQUIRED：「无路可走时的提示」是选填项，
  // internal/node/{start,handle,approve}.go 的 Validate 已不再产这一条。与上面的
  // D_RATIO_UNSUPPORTED 同样处理——保留登记而不删：对拍测试只查「后端产码 ⊆ 本清单」这一个
  // 方向，清单里多一个不会再触发的历史码不算错；删它要连带动四份 locale 与 locale-parity
  // 的断言清单，收益不抵改动面。
  'NO_ROUTE_HINT_REQUIRED',
  'N5_END_FLAG_REQUIRED',
  'N1_TARGET_TEMPLATE_REQUIRED',
  // 发起节点配了「发起条件」却没填「不满足时的提示」（internal/node/start.go Validate 产码）。
  'N1_START_CONDITION_HINT_REQUIRED',
  // 只配了『与上步处理人的关系』过滤器、没配任何来源（用户/角色/部门/主表字段/发起人）——
  // internal/node/assignee_rules.go 产码（另见 internal/model/node.go
  // HandleConfig.RelationFilters 注释）。办理/审批/抄送三类节点共用，
  // 落基本分区（basic：从哪里选人 + 再缩小范围两张卡同分区），见下方 CODE_TAB。
  'A1_FILTER_WITHOUT_SOURCE',
  // —— 抄送节点（N4，internal/node/cc.go） ——
  'N4_CHANNEL_REQUIRED',
  'N4_CHANNEL_UNSUPPORTED',
  'N4_TITLE_REQUIRED',
  'N4_CONTENT_REQUIRED',
  // —— 子流程节点（N6，internal/node/subflow.go） ——
  'N6_TARGET_REQUIRED',
  'N6_MAPPING_TARGET_REQUIRED',
  'N6_MAPPING_MULTI_TABLE',
  'N6_TERMINAL_MUST_NOT_WAIT',
  'N6_DISPOSITION_REQUIRED',
  // —— 子流程发布期后端闸（internal/compile/subflowmap.go） ——
  // K3_TARGET_NOT_PUBLISHED / N6_MAPPING_SOURCE_INVALID / N6_MAPPING_TARGET_INVALID 三者
  // arguments.reason 细分具体原因，key 不是自动小写派生，见下方 keyForCode 特判分支；
  // N6_MAPPING_TYPE_MISMATCH 无 reason 细分，走标准的 <code 小写> 自动派生。
  'K3_TARGET_NOT_PUBLISHED',
  'N6_MAPPING_SOURCE_INVALID',
  'N6_MAPPING_TARGET_INVALID',
  'N6_MAPPING_TYPE_MISMATCH',
  // FIELD_TYPE_UNSUPPORTED（K4，internal/compile/fieldtype.go）：结果 / 理由绑定字段、
  // 结束标识写入字段类型不合规（非主表文本字段）。key 与其余 code 的自动小写派生规则不同——
  // 沿用既有命名 workflow.designer.issue.fieldTypeUnsupported，见下方 keyForCode 特判。
  'FIELD_TYPE_UNSUPPORTED'
] as const;

export type KnownDiagnosticCode = (typeof KNOWN_DIAGNOSTIC_CODES)[number];

const KNOWN_CODE_SET: ReadonlySet<string> = new Set(KNOWN_DIAGNOSTIC_CODES);

/** 未登记 code 的兜底 key（文案形如："流程配置有问题，请检查「{node}」"）。 */
const UNKNOWN_ISSUE_KEY = 'workflow.designer.issue.unknown';

/**
 * L11 一个 code 对应两种业务场景（checks.go 用 arguments.reason 区分："no_end_node" 整个流程
 * 没有结束节点 / "end_without_inline" 某个结束节点没有入线），业务话完全不同，不能共用一个
 * 通用 key（简单 {name} 插值不支持按参数分支选择文案，见 kimpo-plugin-sdk i18n.ts
 * interpolate() 实现），因此这一个 code 需要单独按 reason 拆成两个 key。
 */
function keyForL11(reason: string | undefined): string {
  return reason === 'no_end_node' ? 'workflow.designer.issue.l11_no_end_node' : 'workflow.designer.issue.l11_end_without_inline';
}

/**
 * K3_TARGET_NOT_PUBLISHED / N6_MAPPING_SOURCE_INVALID / N6_MAPPING_TARGET_INVALID 三个 code
 * （子流程发布期后端闸，internal/compile/subflowmap.go）都用 arguments.reason 区分
 * 具体原因，业务话各不相同，与 L11 同款按 reason 拆 key（见上方 keyForL11）。reason 取值不在
 * 已知枚举内时（后端新增了本文件没跟上的 reason、或调用方传参异常）统一回落到该 code 的通用
 * 文案键——三个回落 key 都与"code 全小写"自动派生结果一致（如
 * 'K3_TARGET_NOT_PUBLISHED'.toLowerCase() === 'k3_target_not_published'），不显示裸 code。
 */
function keyForK3TargetNotPublished(reason: string | undefined): string {
  switch (reason) {
    case 'missing':
      return 'workflow.designer.issue.k3_target_not_published_missing';
    case 'unpublished':
      return 'workflow.designer.issue.k3_target_not_published_unpublished';
    case 'disabled':
      return 'workflow.designer.issue.k3_target_not_published_disabled';
    default:
      return 'workflow.designer.issue.k3_target_not_published';
  }
}

function keyForN6MappingSourceInvalid(reason: string | undefined): string {
  switch (reason) {
    case 'missing':
      return 'workflow.designer.issue.n6_mapping_source_invalid_missing';
    case 'not_main':
      return 'workflow.designer.issue.n6_mapping_source_invalid_not_main';
    case 'main_table_id_as_detail':
      return 'workflow.designer.issue.n6_mapping_source_invalid_main_table_id_as_detail';
    case 'table_mismatch':
      return 'workflow.designer.issue.n6_mapping_source_invalid_table_mismatch';
    default:
      return 'workflow.designer.issue.n6_mapping_source_invalid';
  }
}

function keyForN6MappingTargetInvalid(reason: string | undefined): string {
  switch (reason) {
    case 'missing':
      return 'workflow.designer.issue.n6_mapping_target_invalid_missing';
    case 'not_main':
      return 'workflow.designer.issue.n6_mapping_target_invalid_not_main';
    default:
      return 'workflow.designer.issue.n6_mapping_target_invalid';
  }
}

/** 单个 code 的四语键：默认按 `workflow.designer.issue.<code 全小写>` 生成（code 本身已经是
 * SCREAMING_SNAKE_CASE 或 L10/L11 这类短码，小写后天然是合法的 i18n key 片段）；L11 走上面的
 * 特判；不在 KNOWN_DIAGNOSTIC_CODES 清单内的 code 一律兜底。 */
function keyForCode(diag: RawDiagnostic): string {
  if (diag.code === 'L11') return keyForL11(diag.arguments?.reason);
  // FIELD_TYPE_UNSUPPORTED 沿用既有命名 fieldTypeUnsupported（不是自动小写派生的
  // field_type_unsupported）——既有约定的 key，与其余 code 不同规则，跟 L11 一样单独特判。
  if (diag.code === 'FIELD_TYPE_UNSUPPORTED') return 'workflow.designer.issue.fieldTypeUnsupported';
  // 子流程发布期后端闸：三个 code 按 arguments.reason 细分文案，见上方三个
  // keyFor* 辅助函数。
  if (diag.code === 'K3_TARGET_NOT_PUBLISHED') return keyForK3TargetNotPublished(diag.arguments?.reason);
  if (diag.code === 'N6_MAPPING_SOURCE_INVALID') return keyForN6MappingSourceInvalid(diag.arguments?.reason);
  if (diag.code === 'N6_MAPPING_TARGET_INVALID') return keyForN6MappingTargetInvalid(diag.arguments?.reason);
  if (!KNOWN_CODE_SET.has(diag.code)) return UNKNOWN_ISSUE_KEY;
  return `workflow.designer.issue.${diag.code.toLowerCase()}`;
}

/**
 * 诊断 code → 属性面板分区 key 的映射（属性面板按分区/tab 组织，"点检查项定位到节点"要进一步
 * "定位到分区"）。分区 key 与 i18n 键
 * workflow.designer.panel.tabs.<key> 同名。
 *
 * 只登记"仅凭 code 就能唯一确定分区"的诊断。未登记的 code，tab 留 undefined，消费方据此只选中
 * 节点、不切分区。未登记不是一句话能带过的"拿不准"——下面按性质分三类，前两类是**终态**（不是
 * 待办、以后也不会补），第三类才是"有意不做"的取舍：
 *
 *   1) 结构/拓扑类问题，本就不对应任何面板字段（终态）——LINK_ID_INVALID/LINK_ENDPOINT_UNKNOWN/
 *      LINK_SELF_LOOP（连线本身有问题）、L10/L11/END_HAS_OUTLINE（缺出线/入线/结束节点）、
 *      NODE_KIND_UNSUPPORTED（节点类型不支持发布）、K2（目标模板未发布）、NODE_CONFIG_INVALID
 *      （配置数据损坏的通用兜底）。这些问题说的是"连线怎么连、拓扑对不对"，不是"某个面板字段配
 *      错了"，定位到节点或连线本身就是完整的处理路径，没有分区可跳、也不需要有。
 *
 *   2) 该类节点的属性面板按设计本就不分区（终态）——子流程节点全部诊断（N6_TARGET_REQUIRED、
 *      N6_MAPPING_TARGET_REQUIRED、N6_MAPPING_MULTI_TABLE、N6_TERMINAL_MUST_NOT_WAIT、
 *      N6_DISPOSITION_REQUIRED、K3_TARGET_NOT_PUBLISHED、N6_MAPPING_SOURCE_INVALID、
 *      N6_MAPPING_TARGET_INVALID、N6_MAPPING_TYPE_MISMATCH）与结束节点专属字段
 *      （N5_END_FLAG_REQUIRED）。属性面板的分区体系只覆盖发起/办理/审批/抄送四类
 *      节点（对应 basic/initiator/handleRule/approveRule/formAndHint/notify/form 这套分区
 *      key）；子流程、结束节点内容少，面板是平铺一屏看完、没有 tab 概念，因此这些 code 没有
 *      分区可落是设计如此，不是本文件漏登记。
 *
 *   3) 同一 code 会在不同节点类型上产生、且各节点类型对应的分区不同，本层从 RawDiagnostic 只
 *      拿到 node_id/link_id、拿不到节点类型，无法可靠区分该落到哪个分区（"有意不做"，
 *      非终态但当前不改）——
 *        - D_RATIO_UNSUPPORTED / D_RATIO_OUT_OF_RANGE：办理节点→办理规则「办理方式」，审批
 *          节点→审批规则「审批方式」，两者共用 internal/node/assignee_rules.go
 *          validateCompleteMode 同一诊断 code。（D_RATIO_UNSUPPORTED 在生产代码里已经没有
 *          产生点了，internal/node/assignee_rules.go 当前只产 D_RATIO_OUT_OF_RANGE，
 *          D_RATIO_UNSUPPORTED 仅见于 internal/compile/compile_test.go 里的负向断言。）
 *        - FIELD_TYPE_UNSUPPORTED：审批节点「结果与理由」绑定字段 vs 结束节点「结束标识」
 *          绑定字段，两者共用 internal/compile/fieldtype.go 同一诊断 code。
 *      取舍理由：定位到节点已经是主要价值，未登记时设计者在该节点最多三个分区里自己
 *      扫一眼成本很低；不值得为区分这三个 code 去改后端诊断协议（让后端诊断多带节点类型字段）
 *      或给这份映射表引入"按节点类型分流"的复杂度。
 */
const CODE_TAB: Partial<Record<string, string>> = {
  // 发起节点绑定模板——基本分区（basic：绑定模板）。
  N1_TARGET_TEMPLATE_MISMATCH: 'basic',
  N1_TARGET_TEMPLATE_REQUIRED: 'basic',
  // 发起节点「配了发起条件却没填提示」——按发起面板的 basic 分区登记；只有发起节点会产这个
  // code，没有 D_RATIO_OUT_OF_RANGE 那种"同 code 多节点类型分区不同"的歧义。
  N1_START_CONDITION_HINT_REQUIRED: 'basic',
  // 办理人/审批人/抄送收件人来源——三类节点共用同一批 code，且都落在基本分区
  // （basic：处理人来源），不受节点类型影响，不属于上面第 2 类歧义。
  A1_SOURCE_REQUIRED: 'basic',
  A1_SOURCE_EMPTY: 'basic',
  A_SOURCE_UNSUPPORTED: 'basic',
  // 只配了『与上步处理人的关系』过滤器、没配来源——
  // 同上三个来源相关诊断一样，三类节点共用、都落基本分区，不属于"同 code 多节点类型分区不同"
  // 的歧义。
  A1_FILTER_WITHOUT_SOURCE: 'basic',
  // 审批按钮 + 结果与理由——只有审批节点会产生，落审批规则分区（approveRule）。
  N3_BUTTON_REQUIRED: 'approveRule',
  N3_BUTTON_NAME_REQUIRED: 'approveRule',
  N3_BUTTON_ACTION_UNSUPPORTED: 'approveRule',
  N3_BUTTON_RESULT_TAG_REQUIRED: 'approveRule',
  // 「不通过并结束流程」按钮的「结束到」缺失/失效，同其它 N3 码落审批规则分区。
  N3_BUTTON_END_TARGET_REQUIRED: 'approveRule',
  N3_BUTTON_END_TARGET_INVALID: 'approveRule',
  // 无路可走时的提示——表单与提示分区（formAndHint）。后端已不再产这一条（该项为选填），
  // 分区映射一并保留，理由同 KNOWN_DIAGNOSTIC_CODES 里该项注释。
  NO_ROUTE_HINT_REQUIRED: 'formAndHint',
  // 抄送节点通知渠道/标题/正文——只有抄送节点会产生，落通知分区（notify）。
  N4_CHANNEL_REQUIRED: 'notify',
  N4_CHANNEL_UNSUPPORTED: 'notify',
  N4_TITLE_REQUIRED: 'notify',
  N4_CONTENT_REQUIRED: 'notify'
};

/** 把单条原始诊断映射为业务话问题条目。 */
export function mapDiagnostic(diag: RawDiagnostic): MappedIssue {
  return {
    nodeId: diag.node_id || undefined,
    linkId: diag.link_id || undefined,
    textKey: keyForCode(diag),
    params: diag.arguments,
    tab: CODE_TAB[diag.code]
  };
}

export function mapDiagnostics(diags: RawDiagnostic[]): MappedIssue[] {
  return diags.map(mapDiagnostic);
}

/** 按 nodeId/linkId 分组，供面板"节点卡片上显示告警角标 / 属性面板顶部列问题清单"两处消费。
 * 既有 nodeId 又有 linkId 的诊断当前后端不会产生（每条诊断只关联节点或引导线之一，见
 * checks.go/handle.go/start.go/end.go 全部调用点），因此按"先看 nodeId、否则看 linkId、否则
 * 归 global"的优先级分组，不会出现同一条诊断被计入两组的情况。 */
export function groupIssues(diags: RawDiagnostic[]): GroupedIssues {
  const byNode: Record<string, MappedIssue[]> = {};
  const byLink: Record<string, MappedIssue[]> = {};
  const global: MappedIssue[] = [];
  for (const diag of diags) {
    const issue = mapDiagnostic(diag);
    if (issue.nodeId) {
      (byNode[issue.nodeId] ??= []).push(issue);
    } else if (issue.linkId) {
      (byLink[issue.linkId] ??= []).push(issue);
    } else {
      global.push(issue);
    }
  }
  return { byNode, byLink, global };
}
