// designer/layout.test.ts —— 自动布局单测（画布工具栏"自动布局"）。
// 覆盖：确定性、左→右方向性（start 列 0）、空文档/单节点边界，以及"子树质心对齐"的
// 三条核心判据——链式同 y、分叉对称居中（边缘间距 48px）、分叉汇合与起点同 y。
//
// 节点/边工厂函数使用 WorkflowNode/WorkflowLink 形状（kind 字段、config 字段名对齐 model/document.ts）；
// 分流是普通引导线的判断表达式，没有"分支结构块按泳道居中"的概念，因此没有对应用例。
import { describe, expect, it } from 'vitest';
import type { ApproveConfig, EndConfig, StartConfig, WorkflowLink, WorkflowNode } from '../model';
import { DesignerStore } from '../model/store';
import { computeAutoLayout } from './layout';

function makeStartNode(id: string): WorkflowNode {
  return { id, kind: 'start', config: { target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' } satisfies StartConfig };
}
function makeApproveNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'approve',
    config: {
      approvers: [{ kind: 'user', user_ids: ['1'] }],
      complete_mode: { kind: 'any' },
      buttons: [],
      no_route_hint: ''
    } satisfies ApproveConfig
  };
}
function makeEndNode(id: string): WorkflowNode {
  return { id, kind: 'end', config: { end_flag: 'success' } satisfies EndConfig };
}
function makeEdge(id: string, from: string, to: string): WorkflowLink {
  return { id, from, to };
}

describe('computeAutoLayout：空文档/单节点边界', () => {
  it('空文档（无节点）返回空对象', () => {
    expect(computeAutoLayout(new DesignerStore())).toEqual({});
  });

  it('单节点（仅 start）：落在布局原点 (80, 120)', () => {
    const store = new DesignerStore();
    store.addNode(makeStartNode('n-start'));
    expect(computeAutoLayout(store)).toEqual({ 'n-start': { x: 80, y: 120 } });
  });
});

describe('computeAutoLayout：左→右方向性（start 恒在列 0）', () => {
  it('三节点直线：start 列 0，approve 列 1，end 列 2（同一行，x 严格递增）', () => {
    const store = new DesignerStore();
    store.addNode(makeStartNode('n-start'));
    store.addNode(makeApproveNode('n-approve'));
    store.addNode(makeEndNode('n-end'));
    store.addEdge(makeEdge('e-1', 'n-start', 'n-approve'));
    store.addEdge(makeEdge('e-2', 'n-approve', 'n-end'));

    const positions = computeAutoLayout(store);
    expect(positions['n-start'].x).toBe(80);
    expect(positions['n-approve'].x).toBeGreaterThan(positions['n-start'].x);
    expect(positions['n-end'].x).toBeGreaterThan(positions['n-approve'].x);
    // 简单直线链没有分支，理应停在同一行（不无端产生纵向偏移）。
    expect(positions['n-start'].y).toBe(positions['n-approve'].y);
    expect(positions['n-approve'].y).toBe(positions['n-end'].y);
  });

  it('🔴 回归：节点插入顺序与拓扑顺序相反（按插入序横排会把 start 排到最右侧）时，start 仍然落在最左列', () => {
    const store = new DesignerStore();
    // 故意先插入 end/approve，最后才插入 start——若按 doc.nodes 数组顺序（对应此处 store 插入序）
    // 逐个横向平铺，会让 start 排到最右侧；算法按拓扑分层，不受节点集合给定顺序影响。
    store.addNode(makeEndNode('n-end'));
    store.addNode(makeApproveNode('n-approve'));
    store.addNode(makeStartNode('n-start'));
    store.addEdge(makeEdge('e-1', 'n-start', 'n-approve'));
    store.addEdge(makeEdge('e-2', 'n-approve', 'n-end'));

    const positions = computeAutoLayout(store);
    expect(positions['n-start'].x).toBe(Math.min(positions['n-start'].x, positions['n-approve'].x, positions['n-end'].x));
    expect(positions['n-end'].x).toBe(Math.max(positions['n-start'].x, positions['n-approve'].x, positions['n-end'].x));
  });
});

describe('computeAutoLayout：确定性（同输入两跑同输出）', () => {
  it('多分叉拓扑连跑两次，逐字节结果相同', () => {
    const build = (): DesignerStore => {
      const store = new DesignerStore();
      store.addNode(makeStartNode('n-start'));
      store.addNode(makeApproveNode('n-route-a'));
      store.addNode(makeApproveNode('n-route-b'));
      store.addNode(makeApproveNode('n-route-c'));
      store.addNode(makeEndNode('n-end'));
      store.addEdge(makeEdge('e-start-a', 'n-start', 'n-route-a'));
      store.addEdge(makeEdge('e-start-b', 'n-start', 'n-route-b'));
      store.addEdge(makeEdge('e-start-c', 'n-start', 'n-route-c'));
      store.addEdge(makeEdge('e-a-end', 'n-route-a', 'n-end'));
      store.addEdge(makeEdge('e-b-end', 'n-route-b', 'n-end'));
      store.addEdge(makeEdge('e-c-end', 'n-route-c', 'n-end'));
      return store;
    };

    const first = computeAutoLayout(build());
    const second = computeAutoLayout(build());
    expect(second).toEqual(first);
  });
});

// —— 子树质心对齐（核心判据）——————————————————————————————————————
describe('computeAutoLayout：子树质心对齐（核心判据）', () => {
  it('链式 A→B→C：三节点同 y，等间距列（无分支时退化为一条水平直线）', () => {
    const store = new DesignerStore();
    store.addNode(makeStartNode('n-a'));
    store.addNode(makeApproveNode('n-b'));
    store.addNode(makeEndNode('n-c'));
    store.addEdge(makeEdge('e-1', 'n-a', 'n-b'));
    store.addEdge(makeEdge('e-2', 'n-b', 'n-c'));

    const positions = computeAutoLayout(store);
    expect(positions['n-a'].y).toBe(positions['n-b'].y);
    expect(positions['n-b'].y).toBe(positions['n-c'].y);
    // 列宽固定 260，等间距。
    expect(positions['n-b'].x - positions['n-a'].x).toBe(260);
    expect(positions['n-c'].x - positions['n-b'].x).toBe(260);
  });

  it('分叉 A→(B,C)：B、C 同列紧凑相邻（边缘间距 48px），A 的 y 为两者质心（对称）', () => {
    const store = new DesignerStore();
    store.addNode(makeStartNode('n-a'));
    store.addNode(makeApproveNode('n-b'));
    store.addNode(makeApproveNode('n-c'));
    store.addEdge(makeEdge('e-1', 'n-a', 'n-b'));
    store.addEdge(makeEdge('e-2', 'n-a', 'n-c'));

    const positions = computeAutoLayout(store);
    // 同列。
    expect(positions['n-b'].x).toBe(positions['n-c'].x);
    // 中心间距 = 节点卡高度 64 + 边缘间距 48 = 112（见 layout.ts ROW_STEP 注释）。
    expect(Math.abs(positions['n-c'].y - positions['n-b'].y)).toBe(112);
    // A 的 y 恰好是 B、C 的质心——对称居中，不是"贴着其中一个、另一个甩到下方"
    // （固定行高栅格 + 单向顺延在这个拓扑下会产出 B 与 A 同高、C 在 A 下方的非对称结果）。
    expect(positions['n-a'].y).toBe((positions['n-b'].y + positions['n-c'].y) / 2);
  });

  it('分叉汇合 A→(B,C)→D：D 与 A 同 y（都落在质心线上）', () => {
    const store = new DesignerStore();
    store.addNode(makeStartNode('n-a'));
    store.addNode(makeApproveNode('n-b'));
    store.addNode(makeApproveNode('n-c'));
    store.addNode(makeEndNode('n-d'));
    store.addEdge(makeEdge('e-1', 'n-a', 'n-b'));
    store.addEdge(makeEdge('e-2', 'n-a', 'n-c'));
    store.addEdge(makeEdge('e-3', 'n-b', 'n-d'));
    store.addEdge(makeEdge('e-4', 'n-c', 'n-d'));

    const positions = computeAutoLayout(store);
    expect(positions['n-d'].y).toBe(positions['n-a'].y);
    // 顺带确认 B、C 仍然对称展开在这条质心线两侧。
    expect(positions['n-a'].y).toBe((positions['n-b'].y + positions['n-c'].y) / 2);
  });
});
