// model/defaults.test.ts —— createDefaultDocument / ensureDocumentShape 单测。新建流程只带发起
// 节点（不带结束节点）；通知在节点级，文档顶层没有 notify 字段。重点覆盖"往返幂等"（未知字段
// 不丢，唯一例外是顶层 notify 键被丢弃）、"只在新建草稿最小形状时补发起节点默认名（不补结束
// 节点）"、"存量草稿的节点 name 不被代为改写"三条硬约束。
import { describe, expect, it } from 'vitest';
import { createDefaultDocument, ensureDocumentShape } from './defaults';

describe('createDefaultDocument', () => {
  it('只有一个发起节点，不预连线（不自带结束节点、不带流程级 notify 字段）', () => {
    const doc = createDefaultDocument('新流程');
    expect(doc.schema).toBe('workflow/1');
    expect(doc.name).toBe('新流程');
    expect(doc.links).toEqual([]);
    // 通知已下放到节点级（见 document.ts NodeNotify），新建文档不再带顶层 notify 键。
    expect((doc as unknown as Record<string, unknown>).notify).toBeUndefined();

    expect(doc.nodes).toHaveLength(1);
    const start = doc.nodes[0]!;
    expect(start.kind).toBe('start');
    expect(start.position_x).toBe(120);
    expect(start.position_y).toBe(200);
  });

  it('两次调用返回相互独立的对象（不共享节点/config 引用）', () => {
    const a = createDefaultDocument('x');
    const b = createDefaultDocument('x');
    expect(a.nodes[0]).not.toBe(b.nodes[0]);
    expect(a.nodes[0].config).not.toBe(b.nodes[0].config);
  });

  // 填报层进度页/任务列表/管理页直接读发起节点的 name，因此新造的发起节点必须自带默认名；
  // 结束节点不由本函数构造，无需验证其默认名。
  it('发起节点自带默认名：没有注入 i18n 时退回 zh-CN 文案「发起」', () => {
    const doc = createDefaultDocument('新流程');
    expect(doc.nodes[0]!.name).toBe('发起');
  });

  it('注入 i18n 时按其 .t() 生成默认名（不是恒定 zh-CN）', () => {
    const fakeI18n = { t: (key: string) => `[EN]${key}` };
    const doc = createDefaultDocument('新流程', fakeI18n);
    expect(doc.nodes[0]!.name).toBe('[EN]workflow.designer.node.start');
  });
});

describe('ensureDocumentShape：新草稿最小形状（后端只落一个 start 节点）', () => {
  it('只有 { schema, nodes: [start] } 时补齐 links，不补结束节点、不补 notify（已下放到节点级），start 带默认名', () => {
    const raw = {
      schema: 'workflow/1',
      nodes: [{ id: 'start', kind: 'start', config: { target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' } }]
    };
    const doc = ensureDocumentShape(raw);
    expect(doc.links).toEqual([]);
    expect((doc as unknown as Record<string, unknown>).notify).toBeUndefined();
    // 最小形状不连带补默认结束节点，节点数组只有原有的 start 一条。
    expect(doc.nodes.map((n) => n.kind)).toEqual(['start']);
    // 原有 start 节点内容原样保留（config 没有被重置成默认值）。
    const start = doc.nodes[0]!;
    expect(start.config).toEqual({ target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' });
    // 这是"全新草稿"（网关刚造出来，从没被使用者编辑过），后端造的
    // start 节点自己没带 name，应该补上默认名。
    expect(start.name).toBe('发起');
  });

  it('完全空对象（{}）也能补出一个可用的最小文档，只有发起节点、带默认名', () => {
    const doc = ensureDocumentShape({});
    expect(doc.nodes.some((n) => n.kind === 'start')).toBe(true);
    // 不补结束节点。
    expect(doc.nodes.some((n) => n.kind === 'end')).toBe(false);
    expect(doc.name).toBe('');
    expect(doc.nodes.find((n) => n.kind === 'start')!.name).toBe('发起');
  });

  it('注入 i18n 时全新草稿的发起节点默认名按其 .t() 生成（不是恒定 zh-CN）', () => {
    const fakeI18n = { t: (key: string) => `[EN]${key}` };
    const doc = ensureDocumentShape(
      { nodes: [{ id: 'start', kind: 'start', config: {} }] },
      fakeI18n
    );
    expect(doc.nodes.find((n) => n.kind === 'start')!.name).toBe('[EN]workflow.designer.node.start');
  });
});

describe('ensureDocumentShape：已经有多个节点时，不代为补结束节点、也不代为补 name（存量兼容）', () => {
  it('有 start + 若干非 end 节点、缺 end 时不强行插入（留给发布期 L11 检查拦）', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        { id: 'h1', kind: 'handle', config: {} }
      ]
    };
    const doc = ensureDocumentShape(raw);
    expect(doc.nodes.map((n) => n.kind)).toEqual(['start', 'handle']);
  });

  // "存量兼容"的核心断言——只要文档不是"全新草稿最小形状"，即便已有节点的 name 恰好是空串，
  // 本函数也绝不代为改写（这里不是改写已有数据的位置）。
  it('已有完整文档（start+handle+end）时，即便 start/end 的 name 是空串也原样保留，不被补默认名', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', name: '', config: {} },
        { id: 'h1', kind: 'handle', config: {} },
        { id: 'e1', kind: 'end', name: '', config: {} }
      ]
    };
    const doc = ensureDocumentShape(raw);
    expect(doc.nodes.find((n) => n.kind === 'start')!.name).toBe('');
    expect(doc.nodes.find((n) => n.kind === 'end')!.name).toBe('');
  });

  it('已有完整文档且 start/end 本来就没有 name 字段（更老的存量草稿）：同样不被补默认名', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        { id: 'h1', kind: 'handle', config: {} },
        { id: 'e1', kind: 'end', config: {} }
      ]
    };
    const doc = ensureDocumentShape(raw);
    expect(doc.nodes.find((n) => n.kind === 'start')!.name).toBeUndefined();
    expect(doc.nodes.find((n) => n.kind === 'end')!.name).toBeUndefined();
  });
});

describe('ensureDocumentShape：往返幂等，未知字段不丢', () => {
  it('文档顶层未知键、节点 config 内未知键、link 内 vertices 均原样保留', () => {
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
        {
          id: 'end-1',
          kind: 'end',
          config: { end_flag: 'ok' },
          position_x: 400,
          position_y: 20
        }
      ],
      links: [{ id: 'l1', from: 'start', to: 'end-1', vertices: [{ x: 1, y: 2 }] }]
    };

    const doc = ensureDocumentShape(raw);
    // @ts-expect-error 顶层未知键透传测试，doc 类型不声明 bar 字段
    expect(doc.bar).toBe('top-level-unknown');
    expect((doc.nodes[0].config as Record<string, unknown>).foo).toBe('node-config-unknown');
    expect(doc.links[0].vertices).toEqual([{ x: 1, y: 2 }]);

    // 再跑一遍应逐字段不变（幂等）。
    const again = ensureDocumentShape(doc);
    expect(again).toEqual(doc);
  });
});

// 顶层 notify（流程级四开关，旧文档可能还带着）是"未知字段原样保留"
// 这条硬约束**唯一的例外**——后端已停止读取（见 document.ts WorkflowDocument 头注释），本函数
// 改为丢弃它，不透传进返回的文档；但打开这样的旧文档不能报错/崩溃，行为应与不带 notify 的文档
// 完全一致。与上面"往返幂等"描述块分开单独一节，突出这是唯一的例外情形，不是漏测。
describe('ensureDocumentShape：旧文档顶层带 notify 键——丢弃而非透传', () => {
  it('打开带 notify 键的旧文档：正常解析，其余字段不受影响，返回的文档不再有 notify 键', () => {
    const raw = {
      schema: 'workflow/1',
      name: '报销流程',
      nodes: [
        { id: 'start', kind: 'start', config: { target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' } },
        { id: 'end-1', kind: 'end', config: { end_flag: 'ok' } }
      ],
      links: [],
      notify: { task_assigned: false, task_withdrawn: true, task_revoked: true, instance_ended: true, extra: 'notify-unknown' }
    };

    const doc = ensureDocumentShape(raw);
    expect(doc.name).toBe('报销流程');
    expect(doc.nodes.map((n) => n.kind)).toEqual(['start', 'end']);
    expect(Object.prototype.hasOwnProperty.call(doc, 'notify')).toBe(false);
  });

  it('保存（即再跑一遍 ensureDocumentShape，同 WorkflowDocumentState 构造时的处理）后仍然没有 notify 键', () => {
    const raw = {
      nodes: [{ id: 'start', kind: 'start', config: {} }],
      notify: { task_assigned: false, task_withdrawn: true, task_revoked: true, instance_ended: true }
    };
    const doc = ensureDocumentShape(raw);
    const again = ensureDocumentShape(doc);
    expect(Object.prototype.hasOwnProperty.call(again, 'notify')).toBe(false);
  });
});

// 办理/审批/抄送三类节点的『与上步处理人的关系』旧来源
// 打开时自动改记为节点 config 的 relation_filters 字段。三类节点各覆盖一条（来源字段名不同：
// assignees/approvers/recipients），另覆盖幂等、其余键不丢、非这三类节点不受影响。
describe('ensureDocumentShape：办理/审批/抄送三类节点『与上步处理人的关系』旧来源归一化为 relation_filters', () => {
  it('办理节点：assignees 里的 relation 条目摘出，写入 relation_filters，来源清单删掉该条', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        {
          id: 'h1',
          kind: 'handle',
          config: {
            assignees: [{ kind: 'user', user_ids: ['u1'] }, { kind: 'relation', relation: 'same_department' }],
            complete_mode: { kind: 'any' },
            no_route_hint: ''
          }
        }
      ]
    };
    const doc = ensureDocumentShape(raw);
    const handleNode = doc.nodes.find((n) => n.id === 'h1')!;
    const config = handleNode.config as Record<string, unknown>;
    expect(config.assignees).toEqual([{ kind: 'user', user_ids: ['u1'] }]);
    expect(config.relation_filters).toEqual(['same_department']);
  });

  it('审批节点：approvers 里的 relation 条目摘出，写入 relation_filters', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        {
          id: 'a1',
          kind: 'approve',
          config: {
            approvers: [{ kind: 'relation', relation: 'department_manager' }],
            complete_mode: { kind: 'any' },
            buttons: [],
            no_route_hint: ''
          }
        }
      ]
    };
    const doc = ensureDocumentShape(raw);
    const approveNode = doc.nodes.find((n) => n.id === 'a1')!;
    const config = approveNode.config as Record<string, unknown>;
    expect(config.approvers).toEqual([]);
    expect(config.relation_filters).toEqual(['department_manager']);
  });

  it('抄送节点：recipients 里的 relation 条目摘出，写入 relation_filters', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        {
          id: 'c1',
          kind: 'cc',
          config: {
            recipients: [{ kind: 'department', department_ids: ['d1'] }, { kind: 'relation', relation: 'child_department' }],
            channels: ['system'],
            title_expr: null,
            content_expr: null
          }
        }
      ]
    };
    const doc = ensureDocumentShape(raw);
    const ccNode = doc.nodes.find((n) => n.id === 'c1')!;
    const config = ccNode.config as Record<string, unknown>;
    expect(config.recipients).toEqual([{ kind: 'department', department_ids: ['d1'] }]);
    expect(config.relation_filters).toEqual(['child_department']);
  });

  it('幂等：对归一化后的文档再跑一遍 ensureDocumentShape，逐字段不变', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        {
          id: 'h1',
          kind: 'handle',
          config: {
            assignees: [{ kind: 'relation', relation: 'same_department' }, { kind: 'relation', relation: 'child_department' }],
            complete_mode: { kind: 'any' },
            no_route_hint: ''
          }
        }
      ]
    };
    const once = ensureDocumentShape(raw);
    const twice = ensureDocumentShape(once);
    expect(twice).toEqual(once);
  });

  it('config 内其余未知键不丢（归一化只动来源字段与 relation_filters 两个键）', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        {
          id: 'h1',
          kind: 'handle',
          config: {
            assignees: [{ kind: 'relation', relation: 'same_department' }],
            complete_mode: { kind: 'any' },
            no_route_hint: '',
            foo: 'node-config-unknown'
          }
        }
      ]
    };
    const doc = ensureDocumentShape(raw);
    const config = doc.nodes.find((n) => n.id === 'h1')!.config as Record<string, unknown>;
    expect(config.foo).toBe('node-config-unknown');
    expect(config.relation_filters).toEqual(['same_department']);
  });

  it('没有 relation 来源、也没有既有 filters 时：不产生任何改写（不往 config 里多写一个空 relation_filters）', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: {} },
        { id: 'h1', kind: 'handle', config: { assignees: [{ kind: 'user', user_ids: ['u1'] }], complete_mode: { kind: 'any' }, no_route_hint: '' } }
      ]
    };
    const doc = ensureDocumentShape(raw);
    const config = doc.nodes.find((n) => n.id === 'h1')!.config as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(config, 'relation_filters')).toBe(false);
  });

  it('非办理/审批/抄送节点（如发起、结束）不受影响，config 原样透传', () => {
    const raw = {
      nodes: [
        { id: 'start', kind: 'start', config: { target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' } },
        { id: 'e1', kind: 'end', config: { end_flag: 'ok' } }
      ]
    };
    const doc = ensureDocumentShape(raw);
    expect(doc.nodes.find((n) => n.id === 'start')!.config).toEqual({ target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' });
    expect(doc.nodes.find((n) => n.id === 'e1')!.config).toEqual({ end_flag: 'ok' });
  });
});
