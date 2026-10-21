// designer/nodes/registry.test.ts —— 节点类型注册表的基础形状 + 六类默认配置 + 摘要算法单测
// （start/handle/approve/cc/subflow/end 六类节点全覆盖）。
import { describe, expect, it } from 'vitest';
import type { ApproveConfig, CCConfig, EndConfig, HandleConfig, StartConfig, SubflowConfig, WorkflowNode } from '../../model';
import { getNodeTypeDefinition, listNodeTypeDefinitions, listStencilNodeTypeDefinitions } from './registry';

describe('registry：基础登记形状', () => {
  it('当前登记六类节点：start/handle/approve/cc/subflow/end', () => {
    const kinds = listNodeTypeDefinitions()
      .map((def) => def.kind)
      .sort();
    expect(kinds).toEqual(['approve', 'cc', 'end', 'handle', 'start', 'subflow']);
  });

  it('start 不可删、不可拖入面板、数量上限 1；其余五类可删、可拖入面板、数量不限', () => {
    const start = getNodeTypeDefinition('start')!;
    expect(start.canDelete).toBe(false);
    expect(start.canAddFromStencil).toBe(false);
    expect(start.maxCount).toBe(1);

    for (const kind of ['handle', 'approve', 'cc', 'subflow', 'end'] as const) {
      const def = getNodeTypeDefinition(kind)!;
      expect(def.canDelete).toBe(true);
      expect(def.canAddFromStencil).toBe(true);
      expect(def.maxCount).toBeUndefined();
    }
  });

  it('isTerminal：只有 end 是末级节点类型，对齐 model/document.ts isTerminalNode 的权威判据', () => {
    for (const kind of ['start', 'handle', 'approve', 'cc', 'subflow'] as const) {
      expect(getNodeTypeDefinition(kind)!.isTerminal).toBe(false);
    }
    expect(getNodeTypeDefinition('end')!.isTerminal).toBe(true);
  });

  it('listStencilNodeTypeDefinitions 只返回 canAddFromStencil===true 的类型（不含 start）', () => {
    const kinds = listStencilNodeTypeDefinitions()
      .map((def) => def.kind)
      .sort();
    expect(kinds).toEqual(['approve', 'cc', 'end', 'handle', 'subflow']);
  });

  it('六类节点全部登记，查不到 undefined 的情况不应发生', () => {
    for (const kind of ['start', 'handle', 'approve', 'cc', 'subflow', 'end'] as const) {
      expect(getNodeTypeDefinition(kind)).toBeDefined();
    }
  });

  it('createDefaultConfig 每次调用返回全新对象（调用方修改不会互相污染）', () => {
    const def = getNodeTypeDefinition('handle')!;
    const a = def.createDefaultConfig() as unknown as HandleConfig;
    const b = def.createDefaultConfig() as unknown as HandleConfig;
    expect(a).not.toBe(b);
    expect(a.assignees).not.toBe(b.assignees);
    a.assignees!.push({ kind: 'user', user_ids: ['u1'] });
    expect(b.assignees).toEqual([]);
  });
});

describe('registry：start/handle/end 默认配置', () => {
  it('start 默认配置', () => {
    const cfg = getNodeTypeDefinition('start')!.createDefaultConfig() as unknown as StartConfig;
    expect(cfg).toEqual({
      target_template_id: '',
      allow_manual_start: true,
      no_route_hint: '',
      start_permission: {}
    });
  });

  it('handle 默认配置', () => {
    const cfg = getNodeTypeDefinition('handle')!.createDefaultConfig() as unknown as HandleConfig;
    expect(cfg).toEqual({
      assignees: [],
      complete_mode: { kind: 'any' },
      no_route_hint: ''
    });
  });

  it('end 默认配置', () => {
    const cfg = getNodeTypeDefinition('end')!.createDefaultConfig() as unknown as EndConfig;
    expect(cfg).toEqual({ end_flag: '' });
  });
});

describe('registry：approve/cc/subflow 默认配置', () => {
  it('approve 默认配置：没有 i18n 时退回 zh-CN 默认按钮文案', () => {
    const cfg = getNodeTypeDefinition('approve')!.createDefaultConfig() as unknown as ApproveConfig;
    expect(cfg).toEqual({
      approvers: [],
      complete_mode: { kind: 'any' },
      field_permissions: [],
      buttons: [
        { id: 'btn-agree', name: '同意', color: 'primary', action: 'submit_approve', result_tag: '已通过', require_reason: false },
        { id: 'btn-reject', name: '拒绝', color: 'danger', action: 'withdraw_specified_step', result_tag: '已拒绝', require_reason: true }
      ],
      result_field_id: '',
      reason_field_id: '',
      clear_on_withdraw: [],
      no_route_hint: ''
    });
  });

  it('approve 默认配置：注入 i18n 时按其 .t() 生成按钮文案（不是恒定 zh-CN）', () => {
    const fakeI18n = { t: (key: string) => `[EN]${key}` };
    const cfg = getNodeTypeDefinition('approve')!.createDefaultConfig(fakeI18n) as unknown as ApproveConfig;
    expect(cfg.buttons[0].name).toBe('[EN]workflow.designer.node.approve.defaultButtonAgreeName');
    expect(cfg.buttons[1].result_tag).toBe('[EN]workflow.designer.node.approve.defaultButtonRejectResultTag');
  });

  it('approve 默认配置：每次调用返回全新的按钮数组（互不污染）', () => {
    const def = getNodeTypeDefinition('approve')!;
    const a = def.createDefaultConfig() as unknown as ApproveConfig;
    const b = def.createDefaultConfig() as unknown as ApproveConfig;
    expect(a.buttons).not.toBe(b.buttons);
    a.buttons[0].name = '改过的名字';
    expect(b.buttons[0].name).toBe('同意');
  });

  it('cc 默认配置：title_expr/content_expr 是合法空值 null（不是缺字段，也不是空对象）', () => {
    const cfg = getNodeTypeDefinition('cc')!.createDefaultConfig() as unknown as CCConfig;
    expect(cfg).toEqual({
      recipients: [],
      channels: ['system'],
      title_expr: null,
      content_expr: null,
      field_permissions: []
    });
    expect(Object.prototype.hasOwnProperty.call(cfg, 'title_expr')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cfg, 'content_expr')).toBe(true);
  });

  it('subflow 默认配置：默认不等待、处置为不管', () => {
    const cfg = getNodeTypeDefinition('subflow')!.createDefaultConfig() as unknown as SubflowConfig;
    expect(cfg).toEqual({
      target_workflow_id: '',
      field_mappings: [],
      wait: false,
      disposition: 'ignore'
    });
  });
});

describe('summarize：approve/cc/subflow', () => {
  it('approve 复用办理同款人员来源摘要算法（作用对象是 approvers）', () => {
    const def = getNodeTypeDefinition('approve')!;
    const node: WorkflowNode = { id: 'n1', kind: 'approve', config: { approvers: [], complete_mode: { kind: 'any' }, buttons: [], no_route_hint: '' } };
    expect(def.summarize(node)).toEqual({ key: 'workflow.designer.node.summary.assignee.empty' });
  });

  it('cc 复用办理同款人员来源摘要算法（作用对象是 recipients）', () => {
    const def = getNodeTypeDefinition('cc')!;
    const node: WorkflowNode = {
      id: 'n1',
      kind: 'cc',
      config: { recipients: [{ kind: 'user', user_ids: ['u1'] }], channels: ['system'], title_expr: null, content_expr: null }
    };
    expect(def.summarize(node)).toEqual({ key: 'workflow.designer.node.summary.assignee.count', params: { count: 1 } });
  });

  it('subflow：未指定目标流程 → unconfigured', () => {
    const def = getNodeTypeDefinition('subflow')!;
    const node: WorkflowNode = { id: 'n1', kind: 'subflow', config: { target_workflow_id: '', wait: false, disposition: 'ignore' } };
    expect(def.summarize(node)).toEqual({ key: 'workflow.designer.node.summary.subflow.unconfigured' });
  });

  it('subflow：已指定目标流程 → configured（不出现真实流程名）', () => {
    const def = getNodeTypeDefinition('subflow')!;
    const node: WorkflowNode = { id: 'n1', kind: 'subflow', config: { target_workflow_id: 'wf-1', wait: false, disposition: 'ignore' } };
    expect(def.summarize(node)).toEqual({ key: 'workflow.designer.node.summary.subflow.configured' });
  });
});

describe('summarize：start 发起节点', () => {
  const def = getNodeTypeDefinition('start')!;
  function node(config: StartConfig): WorkflowNode {
    return { id: 'n1', kind: 'start', config: config as unknown as Record<string, unknown> };
  }

  it('未选目标表单 → unconfigured', () => {
    const summary = def.summarize(node({ target_template_id: '', allow_manual_start: true, no_route_hint: '' }));
    expect(summary).toEqual({ key: 'workflow.designer.node.summary.start.unconfigured' });
  });

  it('已选目标表单但关闭人工发起 → manualOff', () => {
    const summary = def.summarize(node({ target_template_id: 'tpl-1', allow_manual_start: false, no_route_hint: '' }));
    expect(summary).toEqual({ key: 'workflow.designer.node.summary.start.manualOff' });
  });

  it('已选目标表单且允许人工发起 → configured', () => {
    const summary = def.summarize(node({ target_template_id: 'tpl-1', allow_manual_start: true, no_route_hint: '' }));
    expect(summary).toEqual({ key: 'workflow.designer.node.summary.start.configured' });
  });
});

describe('summarize：end 结束节点', () => {
  const def = getNodeTypeDefinition('end')!;
  function node(config: EndConfig): WorkflowNode {
    return { id: 'n1', kind: 'end', config: config as unknown as Record<string, unknown> };
  }

  it('未填结束标识 → unconfigured', () => {
    expect(def.summarize(node({ end_flag: '' }))).toEqual({ key: 'workflow.designer.node.summary.end.unconfigured' });
  });

  it('已填结束标识 → configured，携带原文文本参数', () => {
    expect(def.summarize(node({ end_flag: '已通过' }))).toEqual({
      key: 'workflow.designer.node.summary.end.configured',
      params: { flag: '已通过' }
    });
  });
});

describe('summarize：handle 办理节点（同一算法覆盖 assignees 摘要）', () => {
  const def = getNodeTypeDefinition('handle')!;
  function node(assignees: HandleConfig['assignees']): WorkflowNode {
    return { id: 'n1', kind: 'handle', config: { assignees, complete_mode: { kind: 'any' }, no_route_hint: '' } };
  }

  it('没有任何来源 → empty', () => {
    expect(def.summarize(node([]))).toEqual({ key: 'workflow.designer.node.summary.assignee.empty' });
  });

  it('有来源但没有解析器（拿不到名字）→ 数量兜底 count', () => {
    const summary = def.summarize(node([{ kind: 'user', user_ids: ['u1'] }, { kind: 'department', department_ids: ['d1'] }]));
    expect(summary).toEqual({ key: 'workflow.designer.node.summary.assignee.count', params: { count: 2 } });
  });

  it('main_field 来源即使有 ctx 也解不出名字，退化为数量兜底', () => {
    const ctx = {
      resolveUserName: () => '不应被调用',
      resolveRoleName: () => '不应被调用',
      resolveDepartmentName: () => '不应被调用'
    };
    const summary = def.summarize(node([{ kind: 'main_field', main_field_id: 'f1', match_by: 'display_name' }]), ctx);
    expect(summary).toEqual({ key: 'workflow.designer.node.summary.assignee.count', params: { count: 1 } });
  });

  // relation 不是来源，而是独立过滤器
  // （config.relation_filters），正常链路下 sources 经 ensureDocumentShape 整形后不会再带这种
  // 条目；本用例覆盖"万一遇到未整形数据"的兜底口径——摘要不把它算进来源数，也不占用两个"能解出
  // 名字"的名额。
  describe('relation（不是来源，仅覆盖未整形数据的兜底口径）', () => {
    it('来源清单只有 relation 条目（理论不应出现，未整形数据）：视同来源为空，走既有「尚未指定」空态文案', () => {
      const summary = def.summarize(node([{ kind: 'relation', relation: 'same_department' }]));
      expect(summary).toEqual({ key: 'workflow.designer.node.summary.assignee.empty' });
    });

    it('relation 与其它来源混配：relation 不计入来源数，也不占「最多两个代表名」的名额', () => {
      const ctx = { resolveUserName: (id: string) => `用户-${id}` };
      const summary = def.summarize(
        node([{ kind: 'relation', relation: 'same_department' }, { kind: 'user', user_ids: ['a'] }]),
        ctx
      );
      expect(summary).toEqual({
        key: 'workflow.designer.node.summary.assignee.named',
        params: { names: '用户-a', count: 1 }
      });
    });
  });

  it('能解出名字时按来源成话："名字1、名字2 等 N 项来源"（例：张三、采购部 等 3 项来源）', () => {
    const ctx = {
      resolveUserName: (id: string) => (id === 'u1' ? '张三' : undefined),
      resolveDepartmentName: (id: string) => (id === 'd1' ? '采购部' : undefined)
    };
    const summary = def.summarize(
      node([{ kind: 'user', user_ids: ['u1'] }, { kind: 'department', department_ids: ['d1'] }, { kind: 'role', role_ids: ['r1'] }]),
      ctx
    );
    expect(summary).toEqual({
      key: 'workflow.designer.node.summary.assignee.named',
      params: { names: '张三、采购部', count: 3 }
    });
  });

  it('最多取前两个能解出的名字，即使更多来源都能解析', () => {
    const ctx = {
      resolveUserName: (id: string) => `用户-${id}`
    };
    const summary = def.summarize(
      node([{ kind: 'user', user_ids: ['a'] }, { kind: 'user', user_ids: ['b'] }, { kind: 'user', user_ids: ['c'] }]),
      ctx
    );
    expect(summary).toEqual({
      key: 'workflow.designer.node.summary.assignee.named',
      params: { names: '用户-a、用户-b', count: 3 }
    });
  });

  // 来源「发起人」：与 main_field/relation 不同，它不依赖任何 id，只要
  // ctx 注入了 resolveInitiatorLabel 就总能产出代表名（同 user/role/department 走 ctx 解析器的
  // 思路，只是它不需要参数）；ctx 缺省时仍安全退化为数量兜底，不写死中文。
  describe('initiator（发起人）', () => {
    it('只配了发起人 + 有解析器 → 代表名就是解析器给的文案，如"办理人：发起人"这类既有句式里的名字位置', () => {
      const ctx = { resolveInitiatorLabel: () => '发起人' };
      const summary = def.summarize(node([{ kind: 'initiator' }]), ctx);
      expect(summary).toEqual({
        key: 'workflow.designer.node.summary.assignee.named',
        params: { names: '发起人', count: 1 }
      });
    });

    it('发起人 + 用户混配 → 两个代表名按来源顺序拼接', () => {
      const ctx = {
        resolveInitiatorLabel: () => '发起人',
        resolveUserName: (id: string) => (id === 'u1' ? '张三' : undefined)
      };
      const summary = def.summarize(node([{ kind: 'initiator' }, { kind: 'user', user_ids: ['u1'] }]), ctx);
      expect(summary).toEqual({
        key: 'workflow.designer.node.summary.assignee.named',
        params: { names: '发起人、张三', count: 2 }
      });
    });

    it('有发起人来源但 ctx 缺省 resolveInitiatorLabel（或 ctx 整体缺省）→ 退化为数量兜底，不写死中文', () => {
      expect(def.summarize(node([{ kind: 'initiator' }]))).toEqual({
        key: 'workflow.designer.node.summary.assignee.count',
        params: { count: 1 }
      });
      expect(def.summarize(node([{ kind: 'initiator' }]), {})).toEqual({
        key: 'workflow.designer.node.summary.assignee.count',
        params: { count: 1 }
      });
    });
  });
});
