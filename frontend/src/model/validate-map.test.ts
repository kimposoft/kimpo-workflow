// model/validate-map.test.ts —— 发布/校验诊断 → 业务话问题条目的映射单测。
// 覆盖：后端当前已实现的全部诊断 code（KNOWN_DIAGNOSTIC_CODES，来源见文件头引用的 Go 源码
// 位置）逐条有专属 key；L11 按 reason 拆成两个不同的 key；未登记 code 走通用兜底；分组
// （byNode/byLink/global）按诊断携带的 node_id/link_id 正确归类。
import { describe, expect, it } from 'vitest';
import {
  groupIssues,
  KNOWN_DIAGNOSTIC_CODES,
  mapDiagnostic,
  mapDiagnostics,
  type RawDiagnostic
} from './validate-map';

describe('KNOWN_DIAGNOSTIC_CODES：与后端当前实现的诊断 code 清单逐条对齐', () => {
  // 清单来源（已逐一 grep 确认，见各文件 NewDiagnostic(...) 调用点）：
  //   internal/compile/checks.go   —— 结构检查
  //   internal/compile/compile.go  —— K2 / N1_TARGET_TEMPLATE_MISMATCH / NODE_CONFIG_INVALID
  //   internal/node/start.go       —— N1_TARGET_TEMPLATE_REQUIRED / N1_START_CONDITION_HINT_REQUIRED
  //   internal/node/handle.go      —— A1_*/A_SOURCE_UNSUPPORTED/…（来源与办理方式两套通用件
  //                                    已抽到 internal/node/assignee_rules.go，办理与审批共用）
  //   internal/node/approve.go     —— N3_BUTTON_*（审批节点）
  //   internal/node/end.go         —— N5_END_FLAG_REQUIRED
  //   internal/node/cc.go          —— N4_CHANNEL_*/N4_TITLE_REQUIRED/N4_CONTENT_REQUIRED（抄送）
  //   internal/node/subflow.go     —— N6_TARGET_REQUIRED/N6_MAPPING_*/N6_TERMINAL_MUST_NOT_WAIT/
  //                                    N6_DISPOSITION_REQUIRED（子流程）
  //   internal/compile/fieldtype.go —— FIELD_TYPE_UNSUPPORTED（K4 字段类型闸）
  //   internal/compile/subflowmap.go —— K3_TARGET_NOT_PUBLISHED/N6_MAPPING_SOURCE_INVALID/
  //                                     N6_MAPPING_TARGET_INVALID/N6_MAPPING_TYPE_MISMATCH
  //                                     （子流程发布期后端闸）
  //
  // D_RATIO_UNSUPPORTED 是历史遗留 code：internal/node/assignee_rules.go 当前只产
  // D_RATIO_OUT_OF_RANGE，这一条后端已不产（见 validate-map.ts 该项注释与
  // validate-map.backend-parity.static.test.ts，判据方向"后端产码 ⊆ 前端登记表"，本清单比
  // 后端多这一条不算错）——本测试文件按既定断言口径保留它，不做删除处理。
  const EXPECTED_BACKEND_CODES = [
    'LINK_ID_INVALID',
    'LINK_ENDPOINT_UNKNOWN',
    'LINK_SELF_LOOP',
    // 连线名称超过 20 字（internal/compile/checks.go）。
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
    'D_RATIO_UNSUPPORTED',
    'D_RATIO_OUT_OF_RANGE',
    'N3_BUTTON_REQUIRED',
    'N3_BUTTON_NAME_REQUIRED',
    'N3_BUTTON_ACTION_UNSUPPORTED',
    'N3_BUTTON_RESULT_TAG_REQUIRED',
    // 「不通过并结束流程」按钮的结束节点缺失/失效。
    'N3_BUTTON_END_TARGET_REQUIRED',
    'N3_BUTTON_END_TARGET_INVALID',
    'NO_ROUTE_HINT_REQUIRED',
    'N5_END_FLAG_REQUIRED',
    'N1_TARGET_TEMPLATE_REQUIRED',
    // 发起节点「配了发起条件却没填提示」，internal/node/start.go 产码。
    'N1_START_CONDITION_HINT_REQUIRED',
    // 只配了『关系』过滤器、没配来源，internal/node/assignee_rules.go 产码。
    'A1_FILTER_WITHOUT_SOURCE',
    'N4_CHANNEL_REQUIRED',
    'N4_CHANNEL_UNSUPPORTED',
    'N4_TITLE_REQUIRED',
    'N4_CONTENT_REQUIRED',
    'N6_TARGET_REQUIRED',
    'N6_MAPPING_TARGET_REQUIRED',
    'N6_MAPPING_MULTI_TABLE',
    'N6_TERMINAL_MUST_NOT_WAIT',
    'N6_DISPOSITION_REQUIRED',
    'K3_TARGET_NOT_PUBLISHED',
    'N6_MAPPING_SOURCE_INVALID',
    'N6_MAPPING_TARGET_INVALID',
    'N6_MAPPING_TYPE_MISMATCH',
    'FIELD_TYPE_UNSUPPORTED'
  ];

  // FIELD_TYPE_UNSUPPORTED 与 L11 一样是特判 code（key 不按 <code 小写> 自动派生），下面两条
  // "按规则派生"的断言都要把它跟 L11 一起排除。K3_TARGET_NOT_PUBLISHED /
  // N6_MAPPING_SOURCE_INVALID / N6_MAPPING_TARGET_INVALID 虽然也按 reason 特判，但
  // reason 缺省（未知/未传）时回落的通用 key 与"code 全小写"自动派生结果字面相同，
  // 不需要加入本排除清单——见 validate-map.ts 对应 keyFor* 函数注释。
  const AUTO_DERIVED_EXCEPTIONS = ['L11', 'FIELD_TYPE_UNSUPPORTED'];

  it('KNOWN_DIAGNOSTIC_CODES 与后端清单完全一致（缺一条即红）', () => {
    expect([...KNOWN_DIAGNOSTIC_CODES].sort()).toEqual([...EXPECTED_BACKEND_CODES].sort());
  });

  it('每个已知 code（除特判 code 外）都映射到独立的 workflow.designer.issue.<code 小写> key', () => {
    for (const code of KNOWN_DIAGNOSTIC_CODES) {
      if (AUTO_DERIVED_EXCEPTIONS.includes(code)) continue;
      const issue = mapDiagnostic({ code });
      expect(issue.textKey).toBe(`workflow.designer.issue.${code.toLowerCase()}`);
    }
  });

  it('每个已知 code 各自映射到互不相同的 key（无两码共用一份文案）', () => {
    const keys = KNOWN_DIAGNOSTIC_CODES.filter((c) => !AUTO_DERIVED_EXCEPTIONS.includes(c)).map((code) => mapDiagnostic({ code }).textKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('LINK_NAME_TOO_LONG 映射到 workflow.designer.issue.link_name_too_long，挂在该连线上', () => {
    const issue = mapDiagnostic({ code: 'LINK_NAME_TOO_LONG', link_id: 'l1' });
    expect(issue.textKey).toBe('workflow.designer.issue.link_name_too_long');
    expect(issue.linkId).toBe('l1');
  });

  it('FIELD_TYPE_UNSUPPORTED 映射到既有命名 workflow.designer.issue.fieldTypeUnsupported（K4 字段类型闸）', () => {
    const issue = mapDiagnostic({ code: 'FIELD_TYPE_UNSUPPORTED', node_id: 'n1', arguments: { field_id: 'f-status' } });
    expect(issue.textKey).toBe('workflow.designer.issue.fieldTypeUnsupported');
    expect(issue.nodeId).toBe('n1');
  });
});

describe('L11：按 arguments.reason 拆成两个不同的业务话', () => {
  it('reason=no_end_node → l11_no_end_node（整条流程缺结束节点，不挂节点/线）', () => {
    const issue = mapDiagnostic({ code: 'L11', arguments: { reason: 'no_end_node' } });
    expect(issue.textKey).toBe('workflow.designer.issue.l11_no_end_node');
  });

  it('reason=end_without_inline → l11_end_without_inline（某个结束节点没有入线，挂该节点）', () => {
    const issue = mapDiagnostic({ code: 'L11', node_id: 'end-1', arguments: { reason: 'end_without_inline' } });
    expect(issue.textKey).toBe('workflow.designer.issue.l11_end_without_inline');
    expect(issue.nodeId).toBe('end-1');
  });

  it('两个 key 互不相同', () => {
    const a = mapDiagnostic({ code: 'L11', arguments: { reason: 'no_end_node' } }).textKey;
    const b = mapDiagnostic({ code: 'L11', arguments: { reason: 'end_without_inline' } }).textKey;
    expect(a).not.toBe(b);
  });
});

describe('K3_TARGET_NOT_PUBLISHED：按 arguments.reason 拆分（子流程发布期后端闸）', () => {
  it('reason=missing → 目标流程不存在/不属于本应用', () => {
    const issue = mapDiagnostic({ code: 'K3_TARGET_NOT_PUBLISHED', node_id: 'n1', arguments: { reason: 'missing' } });
    expect(issue.textKey).toBe('workflow.designer.issue.k3_target_not_published_missing');
  });

  it('reason=unpublished → 目标流程还没发布过', () => {
    const issue = mapDiagnostic({ code: 'K3_TARGET_NOT_PUBLISHED', arguments: { reason: 'unpublished' } });
    expect(issue.textKey).toBe('workflow.designer.issue.k3_target_not_published_unpublished');
  });

  it('reason=disabled → 目标流程已停用', () => {
    const issue = mapDiagnostic({ code: 'K3_TARGET_NOT_PUBLISHED', arguments: { reason: 'disabled' } });
    expect(issue.textKey).toBe('workflow.designer.issue.k3_target_not_published_disabled');
  });

  it('reason 未知/缺省 → 回落通用文案，不显示裸 code', () => {
    expect(mapDiagnostic({ code: 'K3_TARGET_NOT_PUBLISHED' }).textKey).toBe('workflow.designer.issue.k3_target_not_published');
    expect(mapDiagnostic({ code: 'K3_TARGET_NOT_PUBLISHED', arguments: { reason: 'some_future_reason' } }).textKey).toBe(
      'workflow.designer.issue.k3_target_not_published'
    );
  });
});

describe('N6_MAPPING_SOURCE_INVALID：按 arguments.reason 拆分', () => {
  it('reason=missing → 来源字段在本表单里找不到了', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_SOURCE_INVALID', arguments: { reason: 'missing' } }).textKey).toBe(
      'workflow.designer.issue.n6_mapping_source_invalid_missing'
    );
  });

  it('reason=not_main → 按主表字段配置，实际选了扩展表字段', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_SOURCE_INVALID', arguments: { reason: 'not_main' } }).textKey).toBe(
      'workflow.designer.issue.n6_mapping_source_invalid_not_main'
    );
  });

  it('reason=main_table_id_as_detail → 按扩展表字段配置，实际选了主表字段', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_SOURCE_INVALID', arguments: { reason: 'main_table_id_as_detail' } }).textKey).toBe(
      'workflow.designer.issue.n6_mapping_source_invalid_main_table_id_as_detail'
    );
  });

  it('reason=table_mismatch → 字段不属于所选扩展表', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_SOURCE_INVALID', arguments: { reason: 'table_mismatch' } }).textKey).toBe(
      'workflow.designer.issue.n6_mapping_source_invalid_table_mismatch'
    );
  });

  it('reason 未知/缺省 → 回落通用文案', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_SOURCE_INVALID' }).textKey).toBe('workflow.designer.issue.n6_mapping_source_invalid');
  });
});

describe('N6_MAPPING_TARGET_INVALID：按 arguments.reason 拆分', () => {
  it('reason=missing → 目标字段在目标表单里找不到了', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_TARGET_INVALID', arguments: { reason: 'missing' } }).textKey).toBe(
      'workflow.designer.issue.n6_mapping_target_invalid_missing'
    );
  });

  it('reason=not_main → 目标字段不是目标表单的主表字段', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_TARGET_INVALID', arguments: { reason: 'not_main' } }).textKey).toBe(
      'workflow.designer.issue.n6_mapping_target_invalid_not_main'
    );
  });

  it('reason 未知/缺省 → 回落通用文案', () => {
    expect(mapDiagnostic({ code: 'N6_MAPPING_TARGET_INVALID' }).textKey).toBe('workflow.designer.issue.n6_mapping_target_invalid');
  });
});

describe('N6_MAPPING_TYPE_MISMATCH：无 reason 细分，标准派生 key', () => {
  it('映射到 workflow.designer.issue.n6_mapping_type_mismatch', () => {
    const issue = mapDiagnostic({
      code: 'N6_MAPPING_TYPE_MISMATCH',
      node_id: 'n1',
      arguments: { source_field_id: 'f1', target_field_id: 'f2', source_type: 'number', target_type: 'text' }
    });
    expect(issue.textKey).toBe('workflow.designer.issue.n6_mapping_type_mismatch');
    expect(issue.nodeId).toBe('n1');
  });
});

describe('未登记的 code：兜底通用文案', () => {
  it('不认识的 code 走 workflow.designer.issue.unknown，不抛错', () => {
    const issue = mapDiagnostic({ code: 'SOME_FUTURE_CODE_NOT_YET_MAPPED', node_id: 'n1' });
    expect(issue.textKey).toBe('workflow.designer.issue.unknown');
    expect(issue.nodeId).toBe('n1');
  });
});

describe('mapDiagnostic：字段透传', () => {
  it('node_id/link_id 为空串时归一为 undefined', () => {
    const issue = mapDiagnostic({ code: 'K2', node_id: '', link_id: '' });
    expect(issue.nodeId).toBeUndefined();
    expect(issue.linkId).toBeUndefined();
  });

  it('arguments 原样透传为 params', () => {
    const issue = mapDiagnostic({ code: 'NODE_KIND_UNSUPPORTED', node_id: 'n1', arguments: { kind: 'subflow' } });
    expect(issue.params).toEqual({ kind: 'subflow' });
  });
});

describe('mapDiagnostics：批量映射保持顺序', () => {
  it('逐条映射，顺序与输入一致', () => {
    const raw: RawDiagnostic[] = [{ code: 'K2' }, { code: 'L10', node_id: 'n1' }];
    const mapped = mapDiagnostics(raw);
    expect(mapped.map((m) => m.textKey)).toEqual(['workflow.designer.issue.k2', 'workflow.designer.issue.l10']);
  });
});

describe('tab：诊断 code → 属性面板分区', () => {
  it('N1_TARGET_TEMPLATE_REQUIRED（发起节点绑定模板）→ basic', () => {
    const issue = mapDiagnostic({ code: 'N1_TARGET_TEMPLATE_REQUIRED', node_id: 'n1' });
    expect(issue.tab).toBe('basic');
  });

  it('A1_SOURCE_REQUIRED（办理/审批/抄送共用的处理人来源）→ basic', () => {
    expect(mapDiagnostic({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' }).tab).toBe('basic');
  });

  it('A1_FILTER_WITHOUT_SOURCE（只配了『关系』过滤器没配来源）→ basic', () => {
    expect(mapDiagnostic({ code: 'A1_FILTER_WITHOUT_SOURCE', node_id: 'n1' }).tab).toBe('basic');
  });

  it('N1_START_CONDITION_HINT_REQUIRED（发起节点「发起条件」缺提示）→ basic', () => {
    expect(mapDiagnostic({ code: 'N1_START_CONDITION_HINT_REQUIRED', node_id: 'n1' }).tab).toBe('basic');
  });

  it('N3_BUTTON_REQUIRED（审批按钮）→ approveRule', () => {
    expect(mapDiagnostic({ code: 'N3_BUTTON_REQUIRED', node_id: 'n1' }).tab).toBe('approveRule');
  });

  it('N3_BUTTON_END_TARGET_REQUIRED / _INVALID（不通过并结束流程的结束节点）→ approveRule，参数原样透传', () => {
    const req = mapDiagnostic({ code: 'N3_BUTTON_END_TARGET_REQUIRED', node_id: 'n1', arguments: { button: '不通过', button_id: 'b1' } });
    expect(req.tab).toBe('approveRule');
    expect(req.textKey).toBe('workflow.designer.issue.n3_button_end_target_required');
    expect(req.params).toEqual({ button: '不通过', button_id: 'b1' });
    const inv = mapDiagnostic({ code: 'N3_BUTTON_END_TARGET_INVALID', node_id: 'n1', arguments: { button: '不通过', button_id: 'b1', end_node_id: 'e9' } });
    expect(inv.tab).toBe('approveRule');
    expect(inv.textKey).toBe('workflow.designer.issue.n3_button_end_target_invalid');
    expect(inv.params).toEqual({ button: '不通过', button_id: 'b1', end_node_id: 'e9' });
  });

  it('NO_ROUTE_HINT_REQUIRED（无路可走时的提示）→ formAndHint', () => {
    expect(mapDiagnostic({ code: 'NO_ROUTE_HINT_REQUIRED', node_id: 'n1' }).tab).toBe('formAndHint');
  });

  it('N4_TITLE_REQUIRED（抄送节点通知标题）→ notify', () => {
    expect(mapDiagnostic({ code: 'N4_TITLE_REQUIRED', node_id: 'n1' }).tab).toBe('notify');
  });

  it('没有登记分区的 code（如结构类 K2、子流程 N6_TARGET_REQUIRED、双节点类型共用的 ' +
    'D_RATIO_OUT_OF_RANGE/FIELD_TYPE_UNSUPPORTED）tab 为 undefined，不瞎跳分区', () => {
    expect(mapDiagnostic({ code: 'K2' }).tab).toBeUndefined();
    expect(mapDiagnostic({ code: 'N6_TARGET_REQUIRED', node_id: 'n1' }).tab).toBeUndefined();
    expect(mapDiagnostic({ code: 'D_RATIO_OUT_OF_RANGE', node_id: 'n1' }).tab).toBeUndefined();
    expect(mapDiagnostic({ code: 'FIELD_TYPE_UNSUPPORTED', node_id: 'n1' }).tab).toBeUndefined();
  });

  it('未登记的未来 code 兜底走 unknown 文案，tab 同样 undefined', () => {
    expect(mapDiagnostic({ code: 'SOME_FUTURE_CODE_NOT_YET_MAPPED', node_id: 'n1' }).tab).toBeUndefined();
  });
});

describe('groupIssues：按 nodeId/linkId/全局分组', () => {
  it('按优先级分组：先 nodeId，否则 linkId，否则 global', () => {
    const raw: RawDiagnostic[] = [
      { code: 'NO_ROUTE_HINT_REQUIRED', node_id: 'n1' },
      { code: 'NO_ROUTE_HINT_REQUIRED', node_id: 'n1' },
      { code: 'LINK_SELF_LOOP', link_id: 'l1' },
      { code: 'L11', arguments: { reason: 'no_end_node' } }
    ];
    const grouped = groupIssues(raw);
    expect(grouped.byNode.n1).toHaveLength(2);
    expect(grouped.byLink.l1).toHaveLength(1);
    expect(grouped.global).toHaveLength(1);
    expect(grouped.global[0].textKey).toBe('workflow.designer.issue.l11_no_end_node');
  });

  it('空诊断列表返回三个空容器', () => {
    const grouped = groupIssues([]);
    expect(grouped).toEqual({ byNode: {}, byLink: {}, global: [] });
  });
});
