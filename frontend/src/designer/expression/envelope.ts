/**
 * expression/envelope.ts —— 组装 V4ExpressionDocumentEnvelope 落库信封的纯函数。
 *
 * 从 @kimposoft/expression-editor textSourceToV4ExpressionDocument 的产出组装最终落库形态，是
 * V4ExpressionEditDialog.vue 确认回调与本文件单测共用的唯一实现——避免"组件里怎么拼"和"测试里
 * 怎么断言"两处各写一份、悄悄漂移。
 *
 * 硬约束：信封与 expression 内不得多出任何键——宿主解码 DisallowUnknownFields，
 * 多一个键发布必失败；故本函数只取入参 doc 已产出的字段，不额外拼别的内容（如 readable_text）
 * 进文档。expression_id/purpose 显式覆盖为调用方传入值（与 doc 里已带的同值，双重保险）。
 */
import type { V4ExpressionDocumentEnvelope } from '../../model';

/** textSourceToV4ExpressionDocument 的产出形状（@kimposoft/expression-editor V4ExpressionDocument），
 *  本文件不直接 import 该类型以避免与包版本耦合，按其头注释里点名的字段手写同构声明。 */
export interface RawV4ExpressionDocument {
  expression_id: string;
  purpose: string;
  source_text: string;
  refs: unknown[];
  normalized_digest?: string;
}

/** 组装信封：mode='condition' 落 purpose='condition'；mode='value' 落 purpose='output'（同
 *  V4ExpressionField.vue 头注释的口径），expressionId 由调用方按「引导线＝linkId／步骤摘要＝
 *  `<nodeId>:summary`」拼好传入。 */
export function buildExpressionEnvelope(
  doc: RawV4ExpressionDocument,
  mode: 'condition' | 'value',
  expressionId: string,
  purpose: 'condition' | 'output'
): V4ExpressionDocumentEnvelope {
  return {
    schema_version: 'kimpo.report-expression/v4',
    mode,
    expression: {
      expression_id: expressionId,
      purpose,
      source_text: doc.source_text,
      refs: doc.refs,
      normalized_digest: doc.normalized_digest
    }
  };
}
