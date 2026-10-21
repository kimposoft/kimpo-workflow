// model/document-state.test.ts —— WorkflowDocumentState 单测：
// 节点/引导线增删改、发起不可删/不可连入、结束不可连出、重复连线拒绝、撤销/重做（含合并窗口、
// 上限 50、脏态与基线比较）、以及"往返幂等"集成用例（ensureDocumentShape → state → 拖动/撤销/
// 重做 → toJSON 未知键与坐标折点仍正确）。
import { createPluginI18n, type PluginI18n } from '@kimposoft/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCN from '../../locales/zh-CN.json';
import type { NodeKind } from './document';
import { createDefaultDocument, ensureDocumentShape } from './defaults';
import { WorkflowDocumentState } from './document-state';
import { toGraphNodes } from '../designer/graph-bridge';

function makeState(): WorkflowDocumentState {
  return new WorkflowDocumentState(createDefaultDocument('测试流程'));
}

/** 真实 zh-CN i18n（同 designer/graph-bridge.test.ts makeI18n() 既定手法），供"addNode 默认名
 *  与画布展示态 toGraphNodes 一致"一组用例核对同一语言下的文案。 */
function makeI18n(): PluginI18n {
  return createPluginI18n({ messages: { 'zh-CN': zhCN as Record<string, string> }, defaultLocale: 'zh-CN' });
}

describe('addNode / removeNodes', () => {
  // addNode 不留空 name，写入"类型名+序号"默认名（与画布展示态
  // 兜底共用同一个纯函数，见 model/node-naming.ts）。
  it('新增一个办理节点，id/kind/坐标（取整）正确，name 写入默认值「办理 1」', () => {
    const state = makeState();
    const node = state.addNode('handle', { x: 100.4, y: 200.6 });
    expect(node).toBeDefined();
    expect(node!.kind).toBe('handle');
    expect(node!.name).toBe('办理 1');
    expect(node!.position_x).toBe(100);
    expect(node!.position_y).toBe(201);
    expect(state.doc.nodes.some((n) => n.id === node!.id)).toBe(true);
    expect(state.isDirty()).toBe(true);
  });

  // 节点库拖拽预览图要在节点还没建时就画出"落下后的名字"，默认名算法由只读的
  // nextDefaultNodeName 提供——这里锁两件事：预告的名字恒等于随后 addNode 真写入的名字
  // （含"名字已被占用则继续往后取"的跳号）；预告本身不改文档。
  it('nextDefaultNodeName 预告的名字 = 随后 addNode 真正写入的名字，且预告不改文档', () => {
    const state = makeState();
    const before = JSON.stringify(state.doc);
    expect(state.nextDefaultNodeName('handle')).toBe('办理 1');
    expect(JSON.stringify(state.doc)).toBe(before);
    expect(state.isDirty()).toBe(false);

    const first = state.addNode('handle', { x: 0, y: 0 })!;
    const second = state.addNode('handle', { x: 0, y: 100 })!;
    expect(second.name).toBe('办理 2');
    // 删掉靠前的「办理 1」：同类型只剩 1 个，起算序号回到 2，但「办理 2」已被占用 ⇒ 跳到「办理 3」。
    state.removeNodes([first.id]);
    const predicted = state.nextDefaultNodeName('handle');
    expect(predicted).toBe('办理 3');
    expect(state.addNode('handle', { x: 0, y: 200 })!.name).toBe(predicted);
  });

  it('addNode 第三个可选参数 i18n 原样转手给 createDefaultConfig：新增审批节点时按注入的 i18n 生成默认按钮文案', () => {
    const state = makeState();
    const fakeI18n = { t: (key: string) => `[fake]${key}` };
    const node = state.addNode('approve', { x: 0, y: 0 }, fakeI18n);
    expect(node).toBeDefined();
    const buttons = (node!.config as { buttons: Array<{ name: string }> }).buttons;
    expect(buttons[0].name).toBe('[fake]workflow.designer.node.approve.defaultButtonAgreeName');
  });

  it('addNode 不传 i18n 时不报错，approve 默认配置退回 zh-CN 兜底文案', () => {
    const state = makeState();
    const node = state.addNode('approve', { x: 0, y: 0 });
    const buttons = (node!.config as { buttons: Array<{ name: string }> }).buttons;
    expect(buttons[0].name).toBe('同意');
  });

  it('start 已存在时再次 addNode(\'start\', …) 因 maxCount=1 被拒绝，不产生任何变更', () => {
    const state = makeState();
    const before = state.doc;
    const result = state.addNode('start', { x: 0, y: 0 });
    expect(result).toBeUndefined();
    expect(state.doc).toEqual(before);
    expect(state.isDirty()).toBe(false);
    expect(state.canUndo()).toBe(false);
  });

  it('发起节点不可删除（canDelete===false），混在同一批里时其余可删节点仍生效', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;

    state.removeNodes([startId, handle.id]);

    const kinds = state.doc.nodes.map((n) => n.kind);
    expect(kinds).toContain('start');
    expect(kinds).not.toContain('handle');
  });

  it('删除节点级联删除相关连线，并清理选中态', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 200, y: 200 })!;
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    const link = state.addLink(startId, handle.id);
    expect(link.ok).toBe(true);
    const linkId = link.ok ? link.link.id : '';
    state.setSelection([handle.id], [linkId]);

    state.removeNodes([handle.id]);

    expect(state.doc.links.some((l) => l.id === linkId)).toBe(false);
    expect(state.getSelection()).toEqual({ nodeIds: [], linkIds: [] });
  });
});

describe('moveNodes：批量位置写入算一步', () => {
  it('批量移动多个节点后一次 undo 即可全部还原', () => {
    const state = makeState();
    // 默认文档不自带结束节点，本用例要测的是"批量移动多个节点算
    // 一步"，与第二个节点是不是默认带出来的无关，手动 addNode 造一个即可。
    const start = state.doc.nodes[0]!;
    const end = state.addNode('end', { x: 0, y: 0 })!;
    state.moveNodes([
      { id: start.id, x: 11.6, y: 22.4 },
      { id: end.id, x: 33.5, y: 44.5 }
    ]);
    expect(state.doc.nodes.find((n) => n.id === start.id)!.position_x).toBe(12);
    expect(state.doc.nodes.find((n) => n.id === end.id)!.position_y).toBe(45);

    state.undo();
    expect(state.doc.nodes.find((n) => n.id === start.id)!.position_x).toBe(start.position_x);
    expect(state.doc.nodes.find((n) => n.id === end.id)!.position_y).toBe(end.position_y);
  });
});

describe('addLink：连线校验', () => {
  it('端点不存在 → unknownEndpoint', () => {
    const state = makeState();
    expect(state.addLink('no-such-node', 'also-no')).toEqual({ ok: false, reason: 'unknownEndpoint' });
  });

  it('自连 → selfLoop', () => {
    const state = makeState();
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    expect(state.addLink(startId, startId)).toEqual({ ok: false, reason: 'selfLoop' });
  });

  it('连入发起节点 → intoStart', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    expect(state.addLink(handle.id, startId)).toEqual({ ok: false, reason: 'intoStart' });
  });

  it('从结束节点连出 → outOfEnd（isTerminal 判据，不是硬编码 kind===\'end\'）', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    // 默认文档不自带结束节点，本用例要测的是"连出结束节点"这个
    // 行为本身，与结束节点是不是默认带出来的无关，手动 addNode 造一个即可。
    const end = state.addNode('end', { x: 0, y: 0 })!;
    expect(state.addLink(end.id, handle.id)).toEqual({ ok: false, reason: 'outOfEnd' });
  });

  it('重复同向连线 → duplicate', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    expect(state.addLink(startId, handle.id).ok).toBe(true);
    expect(state.addLink(startId, handle.id)).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('合法连线成功，返回新引导线快照', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    const result = state.addLink(startId, handle.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.from).toBe(startId);
      expect(result.link.to).toBe(handle.id);
      expect(state.doc.links.some((l) => l.id === result.link.id)).toBe(true);
    }
  });
});

describe('撤销 / 重做：合并窗口、上限、脏态与基线比较', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('连续对同一节点 renameNode 在 500ms 内合并为一步撤销', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const stepsBefore = state.canUndo();
    expect(stepsBefore).toBe(true); // addNode 已经是一步

    state.renameNode(handle.id, '第一次改名');
    const pastAfterFirstRename = (state as unknown as { past: string[] }).past.length;
    vi.advanceTimersByTime(100);
    state.renameNode(handle.id, '第二次改名');
    vi.advanceTimersByTime(100);
    state.renameNode(handle.id, '第三次改名');
    const pastAfterMergedRenames = (state as unknown as { past: string[] }).past.length;

    // 三次改名只压了一次历史（与第一次改名后的历史条数相同）。
    expect(pastAfterMergedRenames).toBe(pastAfterFirstRename);
    expect(state.doc.nodes.find((n) => n.id === handle.id)!.name).toBe('第三次改名');

    state.undo();
    // 一次 undo 直接回到"改名前"（三次改名合并成的这一步整体撤销），不是回到"第二次改名"——
    // 这个"改名前"状态即 addNode 落库的默认名，不是 undefined。
    expect(state.doc.nodes.find((n) => n.id === handle.id)!.name).toBe('办理 1');
  });

  it('超过 500ms 窗口后的改名另起一步，undo 一次只回退最近一次改名', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;

    state.renameNode(handle.id, 'A');
    vi.advanceTimersByTime(600); // 超过合并窗口
    state.renameNode(handle.id, 'B');

    state.undo();
    expect(state.doc.nodes.find((n) => n.id === handle.id)!.name).toBe('A');
  });

  it('不同节点之间的改动不会互相合并（合并 key 按目标 id 区分）', () => {
    const state = makeState();
    const h1 = state.addNode('handle', { x: 0, y: 0 })!;
    const h2 = state.addNode('handle', { x: 10, y: 10 })!;

    state.renameNode(h1.id, 'H1');
    state.renameNode(h2.id, 'H2'); // 不同目标，不合并，各自一步

    state.undo();
    // h2 是第二个办理节点，回到"改名前"应是 addNode 落库的默认名「办理 2」，
    // 不是 undefined。
    expect(state.doc.nodes.find((n) => n.id === h2.id)!.name).toBe('办理 2');
    expect(state.doc.nodes.find((n) => n.id === h1.id)!.name).toBe('H1');
  });

  it('updateNodeConfig 支持 patch 对象与函数两种形式，并有合并窗口', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;

    state.updateNodeConfig(handle.id, { no_route_hint: '暂存' });
    vi.advanceTimersByTime(100);
    state.updateNodeConfig(handle.id, (config) => ({ ...config, no_route_hint: '暂存2' }));

    expect((state.doc.nodes.find((n) => n.id === handle.id)!.config as Record<string, unknown>).no_route_hint).toBe('暂存2');
    state.undo();
    // 两次配置改动合并为一步，一次 undo 回到 addNode 之后的初始 config。
    expect((state.doc.nodes.find((n) => n.id === handle.id)!.config as Record<string, unknown>).no_route_hint).toBe('');
  });

  it('setLinkVertices 不做合并（每次调用各算一步）', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    const link = state.addLink(startId, handle.id);
    if (!link.ok) throw new Error('unexpected reject');

    state.setLinkVertices(link.link.id, [{ x: 1, y: 1 }]);
    state.setLinkVertices(link.link.id, [{ x: 2, y: 2 }]);

    state.undo();
    expect(state.doc.links.find((l) => l.id === link.link.id)!.vertices).toEqual([{ x: 1, y: 1 }]);
    state.undo();
    expect(state.doc.links.find((l) => l.id === link.link.id)!.vertices).toBeUndefined();
  });

  it('上限 50：超过上限的最早历史被丢弃，无法无限次 undo 回到最初状态', () => {
    const state = makeState();
    // 用 moveNodes（mergeKey 恒为 undefined，每次都各算一步、不合并）对发起节点反复挪坐标，
    // 产生 60 次不可合并的提交——本用例只
    // 关心"60 次不可合并提交、栈上限 50"这条撤销栈行为，与具体挪的是哪个字段无关。
    const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
    for (let i = 0; i < 60; i += 1) {
      state.moveNodes([{ id: startId, x: i, y: i }]);
    }
    // 60 次不可合并的提交，历史栈只保留最近 50 条。
    expect((state as unknown as { past: string[] }).past.length).toBe(50);

    let undone = 0;
    while (state.canUndo() && undone < 100) {
      state.undo();
      undone += 1;
    }
    // 只保留最近 50 步，undo 次数不超过 50；耗尽后 canUndo() 变 false，多余的 undo() 调用是 no-op。
    expect(undone).toBe(50);
    expect(state.canUndo()).toBe(false);
    const stateBeforeNoop = state.doc;
    state.undo();
    expect(state.doc).toEqual(stateBeforeNoop);
  });

  it('撤销/重做后 dirty 按与保存基线的深比较重新判定：回到保存点时 dirty=false', () => {
    const state = makeState();
    state.markSaved();
    expect(state.isDirty()).toBe(false);

    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    expect(state.isDirty()).toBe(true);

    state.undo();
    // 撤销回到了保存点当时的状态，即使撤销栈本身不为空（还能 redo），也应视为不脏。
    expect(state.doc.nodes.some((n) => n.id === handle.id)).toBe(false);
    expect(state.isDirty()).toBe(false);

    state.redo();
    expect(state.doc.nodes.some((n) => n.id === handle.id)).toBe(true);
    expect(state.isDirty()).toBe(true);
  });

  it('canUndo/canRedo 在提交新变更后 redo 栈清空', () => {
    const state = makeState();
    const h1 = state.addNode('handle', { x: 0, y: 0 })!;
    state.undo();
    expect(state.canRedo()).toBe(true);

    state.addNode('handle', { x: 5, y: 5 });
    expect(state.canRedo()).toBe(false);
    expect(state.doc.nodes.some((n) => n.id === h1.id)).toBe(false);
  });
});

describe('setSelection：不计入脏态/撤销栈', () => {
  it('setSelection 不改变 dirty，也不新增可撤销的步骤（撤销栈条数不变）', () => {
    const state = makeState();
    const handle = state.addNode('handle', { x: 0, y: 0 })!;
    state.markSaved();
    const pastLengthBefore = (state as unknown as { past: string[] }).past.length;

    state.setSelection([handle.id], []);
    expect(state.isDirty()).toBe(false);
    expect((state as unknown as { past: string[] }).past.length).toBe(pastLengthBefore);
  });

  it('从零撤销历史开始时，setSelection 不会凭空产生可撤销步骤', () => {
    const state = makeState();
    state.setSelection(['whatever'], []);
    expect(state.canUndo()).toBe(false);
    expect(state.isDirty()).toBe(false);
  });
});

describe('onChange：变更事件', () => {
  it('每次会改变内容/脏态的操作都触发监听器；取消订阅后不再触发', () => {
    const state = makeState();
    let calls = 0;
    const off = state.onChange(() => {
      calls += 1;
    });

    state.addNode('handle', { x: 0, y: 0 });
    expect(calls).toBe(1);
    state.markSaved();
    expect(calls).toBe(2);

    off();
    state.addNode('handle', { x: 1, y: 1 });
    expect(calls).toBe(2);
  });
});

describe('往返幂等集成：ensureDocumentShape → state → 拖动/撤销/重做 → toJSON', () => {
  it('未知字段全程不丢，坐标/折点正确', () => {
    const raw = {
      schema: 'workflow/1',
      name: '报销流程',
      bar: 'top-level-unknown',
      nodes: [
        {
          id: 'start',
          kind: 'start',
          config: { target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '', foo: 'node-config-unknown' },
          position_x: 10,
          position_y: 20
        },
        { id: 'end-1', kind: 'end', config: { end_flag: 'ok' }, position_x: 400, position_y: 20 }
      ],
      links: [{ id: 'l1', from: 'start', to: 'end-1', vertices: [{ x: 1, y: 2 }] }],
      notify: { task_assigned: false, task_withdrawn: true, task_revoked: true, instance_ended: true }
    };

    const shaped = ensureDocumentShape(raw);
    const state = new WorkflowDocumentState(shaped);

    // 拖动发起节点。
    state.moveNodes([{ id: 'start', x: 99, y: 88 }]);
    // 改写引导线折点。
    state.setLinkVertices('l1', [{ x: 5, y: 6 }, { x: 7, y: 8 }]);

    state.undo(); // 撤销折点改动
    state.redo(); // 重做回来

    const json = state.toJSON();
    expect((json as unknown as Record<string, unknown>).bar).toBe('top-level-unknown');
    expect((json.nodes.find((n) => n.id === 'start')!.config as Record<string, unknown>).foo).toBe('node-config-unknown');
    expect(json.nodes.find((n) => n.id === 'start')!.position_x).toBe(99);
    expect(json.nodes.find((n) => n.id === 'start')!.position_y).toBe(88);
    expect(json.links.find((l) => l.id === 'l1')!.vertices).toEqual([{ x: 5, y: 6 }, { x: 7, y: 8 }]);
  });
});

// 发起/结束节点默认名的存量兼容——打开一份"发起/结束 name 恰好是空
// 串"的旧草稿时，不能一打开就变脏（不能让设计者还没做任何操作、只是打开看了一眼，就被提示
// "有未保存的改动"），也不能悄悄把这份草稿的业务数据改写掉。
describe('打开旧草稿（name 为空）：不自动改写文档，也不会一打开就变脏', () => {
  it('start+handle+end 的旧草稿，start/end 的 name 都是空串：ensureDocumentShape 之后原样保留，构造出的 state 恒不脏', () => {
    const raw = {
      schema: 'workflow/1',
      name: '报销流程',
      nodes: [
        { id: 'start', kind: 'start', name: '', config: { target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' } },
        { id: 'h1', kind: 'handle', name: '部门审批', config: {} },
        { id: 'end-1', kind: 'end', name: '', config: { end_flag: 'ok' } }
      ],
      links: []
    };

    const shaped = ensureDocumentShape(raw);
    // 存量兼容：已存在节点的 name 一律原样保留，即便是空串——不属于"全新草稿最小形状"，本函数
    // 不会代为补默认名（同 defaults.test.ts「存量兼容」一节的断言）。
    expect(shaped.nodes.find((n) => n.kind === 'start')!.name).toBe('');
    expect(shaped.nodes.find((n) => n.kind === 'end')!.name).toBe('');

    const state = new WorkflowDocumentState(shaped);
    // 刚构造出来的 state 必须是"干净"的：dirty 只由后续的写操作方法置位（commit()），
    // ensureDocumentShape 对初始快照的任何加工都发生在构造函数之前，不经过 commit()，因此
    // 不会让新打开的会话一开始就显示"有未保存的改动"。
    expect(state.isDirty()).toBe(false);
    expect(state.canUndo()).toBe(false);
    expect(state.doc.nodes.find((n) => n.kind === 'start')!.name).toBe('');
    expect(state.doc.nodes.find((n) => n.kind === 'end')!.name).toBe('');
  });
});

// addNode() 落库默认名与画布展示态 toGraphNodes() 的"名字为空时的
// 兜底"必须完全一致——两处调用同一个 model/node-naming.ts 纯函数，本节做端到端交叉验证（不是
// 重复 node-naming.test.ts 已经覆盖的纯函数单测，而是验证"接线接对了"这一层）。
describe('addNode 默认名与画布展示态 toGraphNodes 一致', () => {
  it('五类可重复新建的节点（办理/审批/抄送/子流程/结束）：写入的 name 都非空，且与"假设它没有 name、由 toGraphNodes 兜底算出的 label"完全相同', () => {
    const state = makeState();
    const i18n = makeI18n();
    const kinds: NodeKind[] = ['handle', 'approve', 'cc', 'subflow', 'end'];
    for (const kind of kinds) {
      const created = state.addNode(kind, { x: 0, y: 0 });
      expect(created, `addNode(${kind}) 应成功`).toBeDefined();
      expect(created!.name, `addNode(${kind}) 应写入非空默认名`).toBeTruthy();

      // 把这个节点的 name 抹掉，模拟"假设它当初没写 name"，用画布展示态的兜底算法重新求一次
      // label——必须与 addNode 实际写入的 name 完全相同，否则两处规则已经分叉。
      const docWithBlankName = {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => (n.id === created!.id ? { ...n, name: undefined } : n))
      };
      const fallbackLabel = toGraphNodes(docWithBlankName, { i18n }).find((v) => v.id === created!.id)!.label;
      expect(fallbackLabel, `${kind} 节点：addNode 写入的默认名应与画布展示兜底一致`).toBe(created!.name);
    }
  });

  it('start 已存在（maxCount=1）：addNode 恒被拒绝，不需要（也不会）写默认名', () => {
    const state = makeState();
    expect(state.addNode('start', { x: 0, y: 0 })).toBeUndefined();
  });

  it('连续新建两个办理节点：序号递增「办理 1」「办理 2」', () => {
    const state = makeState();
    const h1 = state.addNode('handle', { x: 0, y: 0 })!;
    const h2 = state.addNode('handle', { x: 10, y: 10 })!;
    expect(h1.name).toBe('办理 1');
    expect(h2.name).toBe('办理 2');
  });

  it('删除第一个办理节点后再新建一个：起算序号与现存节点重名时自动往后取，不产生两个同名步骤', () => {
    const state = makeState();
    const h1 = state.addNode('handle', { x: 0, y: 0 })!;
    const h2 = state.addNode('handle', { x: 10, y: 10 })!;
    expect(h1.name).toBe('办理 1');
    expect(h2.name).toBe('办理 2');

    state.removeNodes([h1.id]);
    const h3 = state.addNode('handle', { x: 20, y: 20 })!;
    // 删除 h1 后只剩 h2（名字已冻结为"办理 2"）；新节点起算序号 = 1（已有数）+1 = 2，与 h2 重名，
    // 故顺延为"办理 3"。同名步骤在填报层的进度页 / 任务列表里分不清，新建时必须避开。
    expect(h3.name).toBe('办理 3');
    const names = state.doc.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('addNode 不写默认名不会影响已有节点：新建节点不改写文档里其它节点的 name', () => {
    const state = makeState();
    const before = state.doc.nodes.map((n) => ({ id: n.id, name: n.name }));
    state.addNode('handle', { x: 0, y: 0 });
    const afterOldNodes = state.doc.nodes.filter((n) => before.some((b) => b.id === n.id));
    for (const n of afterOldNodes) {
      expect(n.name).toBe(before.find((b) => b.id === n.id)!.name);
    }
  });
});
