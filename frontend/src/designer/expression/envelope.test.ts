// expression/envelope.test.ts —— buildExpressionEnvelope 单测：
// 断言产出的信封形状与流程定义里落库的 condition_doc / summary_expr 逐字段同形、无多余键
// （硬约束：宿主解码 DisallowUnknownFields，多一个键发布必失败）。
import { describe, expect, it } from 'vitest';
import { buildExpressionEnvelope, type RawV4ExpressionDocument } from './envelope';

describe('buildExpressionEnvelope：信封形状', () => {
  it('condition 档：与落库 condition_doc 逐字段同形，无多余键', () => {
    const raw: RawV4ExpressionDocument = {
      expression_id: 'l1',
      purpose: 'condition',
      source_text: '[amount]#{r1} > 0',
      refs: [{ ref_id: 'r1', kind: 'report_field', table_id: '${TABLE:main}', field_id: '${FIELD:amount}', last_label: '本报表.[采购申请单].[amount]' }],
      normalized_digest: undefined
    };
    const envelope = buildExpressionEnvelope(raw, 'condition', 'l1', 'condition');

    expect(envelope).toEqual({
      schema_version: 'kimpo.report-expression/v4',
      mode: 'condition',
      expression: {
        expression_id: 'l1',
        purpose: 'condition',
        source_text: '[amount]#{r1} > 0',
        refs: raw.refs,
        normalized_digest: undefined
      }
    });
    expect(Object.keys(envelope).sort()).toEqual(['expression', 'mode', 'schema_version']);
    expect(Object.keys(envelope.expression).sort()).toEqual(['expression_id', 'normalized_digest', 'purpose', 'refs', 'source_text']);
  });

  it('value 档：purpose 落 output，与落库 summary_expr 逐字段同形', () => {
    const raw: RawV4ExpressionDocument = {
      expression_id: 'n1:summary',
      purpose: 'output',
      source_text: '[po_no]#{r1}',
      refs: [{ ref_id: 'r1', kind: 'report_field', table_id: '${TABLE:main}', field_id: '${FIELD:po_no}', last_label: '本报表.[采购申请单].[po_no]' }],
      normalized_digest: 'abc123'
    };
    const envelope = buildExpressionEnvelope(raw, 'value', 'n1:summary', 'output');

    expect(envelope).toEqual({
      schema_version: 'kimpo.report-expression/v4',
      mode: 'value',
      expression: {
        expression_id: 'n1:summary',
        purpose: 'output',
        source_text: '[po_no]#{r1}',
        refs: raw.refs,
        normalized_digest: 'abc123'
      }
    });
  });

  it('expression_id/purpose 恒以调用方显式传入值为准（即便 doc 里带的值不同，也按调用方口径覆盖）', () => {
    const raw: RawV4ExpressionDocument = {
      expression_id: 'stale-id',
      purpose: 'filter',
      source_text: 'x',
      refs: []
    };
    const envelope = buildExpressionEnvelope(raw, 'condition', 'n2:auto_complete', 'condition');
    expect(envelope.expression.expression_id).toBe('n2:auto_complete');
    expect(envelope.expression.purpose).toBe('condition');
  });
});
