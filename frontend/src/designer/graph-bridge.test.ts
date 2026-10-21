// designer/graph-bridge.test.ts —— WorkflowDocument ↔ 画布展示态转换单测。
// i18n 用真实的 zh-CN 语言包（经 @kimposoft/plugin-sdk createPluginI18n）而不是手写 stub——顺带验证
// 用到的 locale key 确实可解（key 拼错会在这里直接暴露成 t() 原样返回 key）。
import { createPluginI18n, type PluginI18n } from '@kimposoft/plugin-sdk';
import { describe, expect, it } from 'vitest';
import zhCN from '../../locales/zh-CN.json';
import { createDefaultDocument } from '../model/defaults';
import { WorkflowDocumentState } from '../model/document-state';
import type { WorkflowDocument, WorkflowNode } from '../model';
import {
  applyLayoutToDocument,
  END_FLOW_DECORATIVE_EDGE_PREFIX,
  layoutFromDocument,
  toGraphEdges,
  toGraphNodes
} from './graph-bridge';

function makeI18n(): PluginI18n {
  return createPluginI18n({ messages: { 'zh-CN': zhCN as Record<string, string> }, defaultLocale: 'zh-CN' });
}

describe('toGraphNodes：展示名兜底', () => {
  it('节点有 name 时直接用 name', () => {
    const doc = createDefaultDocument('t');
    doc.nodes[0].name = '自定义名字';
    const views = toGraphNodes(doc, { i18n: makeI18n() });
    expect(views.find((v) => v.id === doc.nodes[0].id)!.label).toBe('自定义名字');
  });

  it('节点没有 name 时退化为"类型名 + 序号"，同类型按出现顺序从 1 计数', () => {
    const doc = createDefaultDocument('t');
    doc.nodes.push({ id: 'h1', kind: 'handle', config: {} }, { id: 'h2', kind: 'handle', config: {} });
    const views = toGraphNodes(doc, { i18n: makeI18n() });
    expect(views.find((v) => v.id === 'h1')!.label).toBe('办理 1');
    expect(views.find((v) => v.id === 'h2')!.label).toBe('办理 2');
  });

  it('位置取 position_x/position_y，缺省时兜底 0', () => {
    const doc = createDefaultDocument('t');
    doc.nodes.push({ id: 'h1', kind: 'handle', config: {} });
    const views = toGraphNodes(doc, { i18n: makeI18n() });
    expect(views.find((v) => v.id === 'h1')!.position).toEqual({ x: 0, y: 0 });
  });

  it('hasIssues 由 issuesByNode 是否存在该 id 决定', () => {
    const doc = createDefaultDocument('t');
    // 默认文档不自带结束节点，本用例要测的是"同一份 issuesByNode
    // 只命中一个节点"这件事，手动补一个结束节点作第二个对照节点即可。
    doc.nodes.push({ id: 'end-1', kind: 'end', config: {} });
    const startId = doc.nodes.find((n) => n.kind === 'start')!.id;
    const views = toGraphNodes(doc, { i18n: makeI18n(), issuesByNode: { [startId]: [{}] } });
    expect(views.find((v) => v.id === startId)!.hasIssues).toBe(true);
    const endId = doc.nodes.find((n) => n.kind === 'end')!.id;
    expect(views.find((v) => v.id === endId)!.hasIssues).toBe(false);
  });

  it('summaries 命中时用 i18n 求值出真实文案（不是原样返回 key）', () => {
    const doc = createDefaultDocument('t');
    // 默认文档不自带结束节点，本用例要测的是结束节点的 summary
    // 求值逻辑，手动补一个即可，与它是不是默认带出来的无关。
    doc.nodes.push({ id: 'end-1', kind: 'end', config: {} });
    const endId = doc.nodes.find((n) => n.kind === 'end')!.id;
    const views = toGraphNodes(doc, {
      i18n: makeI18n(),
      summaries: { [endId]: { key: 'workflow.designer.node.summary.end.configured', params: { flag: '已通过' } } }
    });
    expect(views.find((v) => v.id === endId)!.summary).toBe('结束标识：已通过');
  });

  it('summaries 未命中该节点时 summary 为空串（不是 undefined，对齐 GraphNodeView 空串语义）', () => {
    const doc = createDefaultDocument('t');
    const views = toGraphNodes(doc, { i18n: makeI18n() });
    expect(views[0].summary).toBe('');
  });
});

// 设计器画布上引导线中点的标识只认名称：marker/label 只看
// link.name，与是否配了条件完全无关；是否条件路线改由独立的 hasCondition 字段表达（只驱动画布
// 线色，见 graph/x6-adapter.ts applyEdgeVisual，本文件不测线色——那是 x6-adapter 层的事）。
describe('toGraphEdges：中点标记只认名称', () => {
  it('无名称、无条件：label 为 undefined，marker.kind=none，hasCondition=false', () => {
    const doc: WorkflowDocument = { ...createDefaultDocument('t'), links: [{ id: 'l1', from: 'a', to: 'b' }] };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].label).toBeUndefined();
    expect(views[0].marker).toEqual({ kind: 'none', shortLabel: '', tooltip: '' });
    expect(views[0].hasCondition).toBe(false);
  });

  it('有名称、无条件：label=名称，marker.kind=name，hasCondition=false', () => {
    const doc: WorkflowDocument = { ...createDefaultDocument('t'), links: [{ id: 'l1', from: 'a', to: 'b', name: '审批通过' }] };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].label).toBe('审批通过');
    expect(views[0].marker).toEqual({ kind: 'name', shortLabel: '审批通过', tooltip: '审批通过' });
    expect(views[0].hasCondition).toBe(false);
  });

  it('有名称、有条件：仍然画名称珠（不受条件影响），hasCondition=true，且不泄漏 source_text 原文', () => {
    const doc: WorkflowDocument = {
      ...createDefaultDocument('t'),
      links: [
        {
          id: 'l1',
          from: 'a',
          to: 'b',
          name: '金额较大',
          condition_doc: {
            schema_version: 'kimpo.report-expression/v4',
            mode: 'condition',
            expression: { expression_id: 'e1', purpose: 'link-condition', source_text: '金额 > 10000', refs: [] }
          }
        }
      ]
    };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].label).toBe('金额较大');
    expect(views[0].label).not.toContain('> 10000');
    expect(views[0].marker).toEqual({ kind: 'name', shortLabel: '金额较大', tooltip: '金额较大' });
    expect(views[0].hasCondition).toBe(true);
  });

  it('无名称、有条件：不画珠（marker.kind=none），但 hasCondition=true（线色仍要走主色，只是中点不显示任何标记）', () => {
    const doc: WorkflowDocument = {
      ...createDefaultDocument('t'),
      links: [
        {
          id: 'l1',
          from: 'a',
          to: 'b',
          condition_doc: {
            schema_version: 'kimpo.report-expression/v4',
            mode: 'condition',
            expression: { expression_id: 'e1', purpose: 'link-condition', source_text: '金额 > 10000', refs: [] }
          }
        }
      ]
    };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].label).toBeUndefined();
    expect(views[0].marker).toEqual({ kind: 'none', shortLabel: '', tooltip: '' });
    expect(views[0].hasCondition).toBe(true);
  });

  it('名称首尾空白不计入珠子/标签（去空白后与"无名称"同一分支）', () => {
    const doc: WorkflowDocument = { ...createDefaultDocument('t'), links: [{ id: 'l1', from: 'a', to: 'b', name: '   ' }] };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].label).toBeUndefined();
    expect(views[0].marker?.kind).toBe('none');
  });

  it('名称超过 8 个字符：珠子短文案截断为前 8 字+"…"，tooltip 仍是完整名称（不截断）', () => {
    // 10 个字符（未超过 updateLinkName 的 20 字上限，只测画布中点珠子这一层 8 字截断规则）。
    const longName = '一二三四五六七八九十';
    expect(Array.from(longName).length).toBe(10);
    const doc: WorkflowDocument = { ...createDefaultDocument('t'), links: [{ id: 'l1', from: 'a', to: 'b', name: longName }] };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].marker).toEqual({ kind: 'name', shortLabel: '一二三四五六七八…', tooltip: longName });
    // label（供 svg-adapter.ts 读取的纯文本字段）不做 8 字截断，仍是完整名称。
    expect(views[0].label).toBe(longName);
  });

  it('名称恰好 8 个字符：不截断、不追加省略号', () => {
    const exactName = '一二三四五六七八';
    expect(Array.from(exactName).length).toBe(8);
    const doc: WorkflowDocument = { ...createDefaultDocument('t'), links: [{ id: 'l1', from: 'a', to: 'b', name: exactName }] };
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views[0].marker?.shortLabel).toBe(exactName);
  });

  it('hasIssues 由 issuesByLink 决定', () => {
    const doc: WorkflowDocument = { ...createDefaultDocument('t'), links: [{ id: 'l1', from: 'a', to: 'b' }] };
    const views = toGraphEdges(doc, { i18n: makeI18n(), issuesByLink: { l1: [{}] } });
    expect(views[0].hasIssues).toBe(true);
  });
});

// 审批按钮「不通过并结束流程」（action=end_flow）→ 结束节点的只渲染、不入库装饰虚线。
describe('toGraphEdges：end_flow 按钮装饰边', () => {
  /** 一个审批节点（带若干按钮）+ 一个结束节点 + 一条文档连线的最小文档。 */
  function makeApproveDoc(
    buttons: Array<Record<string, unknown>>,
    endKind: 'end' | 'handle' = 'end'
  ): WorkflowDocument {
    return {
      ...createDefaultDocument('t'),
      nodes: [
        { id: 'a1', kind: 'approve', config: { buttons } },
        { id: 'e1', kind: endKind, config: {} }
      ],
      links: [{ id: 'l1', from: 'a1', to: 'e1' }]
    };
  }
  const endFlowButton = { id: 'b1', name: '不通过并结束', color: 'danger', action: 'end_flow', result_tag: 'rejected', require_reason: true, end_node_id: 'e1' };

  it('每个目标存在且是结束节点的 end_flow 按钮追加一条装饰边：审批节点 → 结束节点，标签=按钮名', () => {
    const doc = makeApproveDoc([{ ...endFlowButton }, { id: 'b2', name: '同意', action: 'submit_approve' }]);
    const views = toGraphEdges(doc, { i18n: makeI18n() });
    expect(views).toHaveLength(2); // 1 条文档连线 + 1 条装饰边（submit_approve 按钮不产出）
    const deco = views.find((v) => v.decorative)!;
    expect(deco.id).toBe(`${END_FLOW_DECORATIVE_EDGE_PREFIX}a1-b1`);
    expect(deco.from).toBe('a1');
    expect(deco.to).toBe('e1');
    expect(deco.marker).toEqual({ kind: 'endflow', shortLabel: '不通过并结束', tooltip: '' });
    // 文档连线原样保留，且不带装饰标记。
    expect(views.find((v) => v.id === 'l1')!.decorative).toBeUndefined();
  });

  it('按钮名超过 8 个字符时截断为前 8 字 + 省略号', () => {
    const doc = makeApproveDoc([{ ...endFlowButton, name: '一二三四五六七八九十' }]);
    const deco = toGraphEdges(doc, { i18n: makeI18n() }).find((v) => v.decorative)!;
    expect(deco.marker?.shortLabel).toBe('一二三四五六七八…');
  });

  it('目标缺失不生成：end_node_id 为空 / 指向不存在的节点 / 指向的不是结束节点', () => {
    for (const patch of [{ end_node_id: undefined }, { end_node_id: '' }, { end_node_id: 'ghost' }]) {
      const doc = makeApproveDoc([{ ...endFlowButton, ...patch }]);
      expect(toGraphEdges(doc, { i18n: makeI18n() }).some((v) => v.decorative)).toBe(false);
    }
    const notEnd = makeApproveDoc([{ ...endFlowButton }], 'handle');
    expect(toGraphEdges(notEnd, { i18n: makeI18n() }).some((v) => v.decorative)).toBe(false);
  });

  it('非 end_flow 动作即使带着遗留 end_node_id 也不生成；按钮清单缺失/非数组时不抛错', () => {
    const doc = makeApproveDoc([{ ...endFlowButton, action: 'withdraw_initiator' }]);
    expect(toGraphEdges(doc, { i18n: makeI18n() }).some((v) => v.decorative)).toBe(false);
    const broken: WorkflowDocument = { ...doc, nodes: [{ id: 'a1', kind: 'approve', config: {} }, doc.nodes[1]] };
    expect(() => toGraphEdges(broken, { i18n: makeI18n() })).not.toThrow();
  });

  it('改按钮后重新派生即更新：改名 → 标签变；改目标 → to 变；改动作/删按钮 → 装饰边消失', () => {
    const doc = makeApproveDoc([{ ...endFlowButton }]);
    doc.nodes.push({ id: 'e2', kind: 'end', config: {} });
    const decoOf = (d: WorkflowDocument) => toGraphEdges(d, { i18n: makeI18n() }).find((v) => v.decorative);

    const buttons = (doc.nodes[0].config as { buttons: Array<Record<string, unknown>> }).buttons;
    buttons[0].name = '驳回终止';
    expect(decoOf(doc)!.marker?.shortLabel).toBe('驳回终止');
    buttons[0].end_node_id = 'e2';
    expect(decoOf(doc)!.to).toBe('e2');
    // id 只由审批节点 + 按钮 id 决定：改名/改目标后 id 不变，画布 setEdges 走更新而不是重建。
    expect(decoOf(doc)!.id).toBe(`${END_FLOW_DECORATIVE_EDGE_PREFIX}a1-b1`);
    buttons[0].action = 'submit_approve';
    expect(decoOf(doc)).toBeUndefined();
    buttons[0].action = 'end_flow';
    buttons.length = 0;
    expect(decoOf(doc)).toBeUndefined();
  });

  it('只读派生：不改 doc.links，也不改文档本身（装饰边绝不入库）', () => {
    const doc = makeApproveDoc([{ ...endFlowButton }]);
    const before = JSON.stringify(doc);
    toGraphEdges(doc, { i18n: makeI18n() });
    expect(JSON.stringify(doc)).toBe(before);
    expect(doc.links).toEqual([{ id: 'l1', from: 'a1', to: 'e1' }]);
  });

  it('layoutFromDocument 只认文档连线：不产出装饰边的折点', () => {
    const doc = makeApproveDoc([{ ...endFlowButton }]);
    expect(layoutFromDocument(doc).edgeVertices).toBeUndefined();
  });
});

describe('layoutFromDocument / applyLayoutToDocument：布局双向转换', () => {
  it('layoutFromDocument 从节点坐标/引导线折点派生 DesignLayout，不含 viewport', () => {
    const doc: WorkflowDocument = {
      ...createDefaultDocument('t'),
      nodes: [{ id: 'n1', kind: 'handle', config: {}, position_x: 10, position_y: 20 }],
      links: [{ id: 'l1', from: 'n1', to: 'n1', vertices: [{ x: 1, y: 2 }] }]
    };
    const layout = layoutFromDocument(doc);
    expect(layout).toEqual({
      nodePositions: { n1: { x: 10, y: 20 } },
      edgeVertices: { l1: [{ x: 1, y: 2 }] }
    });
    expect(layout.viewport).toBeUndefined();
  });

  it('没有坐标/折点时对应字段整体缺省（不是空对象）', () => {
    const doc: WorkflowDocument = {
      ...createDefaultDocument('t'),
      nodes: [{ id: 'n1', kind: 'handle', config: {} }],
      links: [{ id: 'l1', from: 'n1', to: 'n1' }]
    };
    const layout = layoutFromDocument(doc);
    expect(layout.nodePositions).toBeUndefined();
    expect(layout.edgeVertices).toBeUndefined();
  });

  it('applyLayoutToDocument 把布局写回 WorkflowDocumentState（节点坐标 + 引导线折点）', () => {
    const base = createDefaultDocument('t');
    const [start] = base.nodes;
    // 默认文档不自带结束节点，本用例要测的是"一条连着两个节点的
    // 引导线，折点/坐标写回是否生效"，手动补一个结束节点作连线的另一端即可。
    const end: WorkflowNode = { id: 'end-1', kind: 'end', config: {} };
    base.nodes.push(end);
    base.links = [{ id: 'l1', from: start.id, to: end.id }];
    const state = new WorkflowDocumentState(base);

    applyLayoutToDocument(state, {
      nodePositions: { [start.id]: { x: 321, y: 654 } },
      edgeVertices: { l1: [{ x: 9, y: 9 }] }
    });

    expect(state.doc.nodes.find((n) => n.id === start.id)!.position_x).toBe(321);
    expect(state.doc.nodes.find((n) => n.id === start.id)!.position_y).toBe(654);
    expect(state.doc.links.find((l) => l.id === 'l1')!.vertices).toEqual([{ x: 9, y: 9 }]);
    expect(state.isDirty()).toBe(true);
  });

  it('layoutFromDocument(state.doc) 与 applyLayoutToDocument 往返一致', () => {
    const base = createDefaultDocument('t');
    const state = new WorkflowDocumentState(base);
    const layout = layoutFromDocument(state.doc);
    // 对齐 state.doc 自身当前的坐标（回填自身不应改变任何值）。
    applyLayoutToDocument(state, layout);
    expect(layoutFromDocument(state.doc)).toEqual(layout);
  });
});
