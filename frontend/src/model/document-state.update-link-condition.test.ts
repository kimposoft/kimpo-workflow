// model/document-state.update-link-condition.test.ts —— WorkflowDocumentState.updateLinkCondition
// 单测：引导线条件的写回与清空。EdgePanel.vue 只是本方法的
// 薄包装（选中一条连线时把 V4ExpressionField 的 update:modelValue 原样转发给它），本文件覆盖的是
// 它依赖的唯一权威写入口，不是重复造一个只测 UI 包装壳的浅层用例。
import { describe, expect, it } from 'vitest';
import { createDefaultDocument } from './defaults';
import { WorkflowDocumentState } from './document-state';
import type { V4ExpressionDocumentEnvelope } from './document';

function makeState(): WorkflowDocumentState {
  return new WorkflowDocumentState(createDefaultDocument('测试流程'));
}

function sampleCondition(linkId: string): V4ExpressionDocumentEnvelope {
  return {
    schema_version: 'kimpo.report-expression/v4',
    mode: 'condition',
    expression: {
      expression_id: linkId,
      purpose: 'condition',
      source_text: '[amount]#{r1} > 0',
      refs: [{ ref_id: 'r1', kind: 'report_field', table_id: 't1', field_id: 'amount', last_label: '本报表.[采购申请单].[amount]' }]
    }
  };
}

describe('updateLinkCondition：引导线条件写回与清空', () => {
  it('写入一份条件文档：link.condition_doc 更新为该文档，且置脏', () => {
    const state = makeState();
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const link = state.addLink(startId, handle.id);
    expect(link.ok).toBe(true);
    const linkId = link.ok ? link.link.id : '';

    const doc = sampleCondition(linkId);
    state.updateLinkCondition(linkId, doc);

    const updated = state.doc.links.find((l) => l.id === linkId);
    expect(updated?.condition_doc).toEqual(doc);
    expect(state.isDirty()).toBe(true);
  });

  it('传 undefined 清空条件：condition_doc 变回 undefined（=无条件，恒可走）', () => {
    const state = makeState();
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const link = state.addLink(startId, handle.id);
    const linkId = link.ok ? link.link.id : '';
    state.updateLinkCondition(linkId, sampleCondition(linkId));

    state.updateLinkCondition(linkId, undefined);

    const updated = state.doc.links.find((l) => l.id === linkId);
    expect(updated?.condition_doc).toBeUndefined();
  });

  it('目标 linkId 不存在时不产生任何变更（不静默创建新连线，也不报错）', () => {
    const state = makeState();
    const before = state.doc;
    state.updateLinkCondition('no-such-link', sampleCondition('no-such-link'));
    expect(state.doc).toEqual(before);
    expect(state.isDirty()).toBe(false);
  });

  it('连续改动同一条线的条件在合并窗口内算一步撤销：设条件 A 后紧接着改成条件 B，一次 undo 应直接回到两次改动之前（无条件），不是先退回 A', () => {
    const state = makeState();
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const link = state.addLink(startId, handle.id);
    const linkId = link.ok ? link.link.id : '';

    const conditionA = sampleCondition(linkId);
    const conditionB = { ...sampleCondition(linkId), expression: { ...sampleCondition(linkId).expression, source_text: '[amount]#{r1} > 100' } };
    state.updateLinkCondition(linkId, conditionA);
    state.updateLinkCondition(linkId, conditionB);
    expect(state.doc.links.find((l) => l.id === linkId)?.condition_doc).toEqual(conditionB);

    state.undo();
    const afterUndo = state.doc.links.find((l) => l.id === linkId);
    expect(afterUndo?.condition_doc).toBeUndefined();
  });
});
