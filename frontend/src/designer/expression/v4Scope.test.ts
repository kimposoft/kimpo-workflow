// expression/v4Scope.test.ts —— mainTemplateIdOf / toHostScope 单测（步骤摘要与
// 引导线条件只能引用主表字段）。useMainTableScope 本身依赖注入的
// DesignerHost（异步网络调用），不在本文件覆盖范围——它的行为收敛为两个纯函数后，真正需要单测
// 锁住的分支逻辑已经在这两个函数里，见文件头注释「本文件只做两件与主表相关的事」。
import { describe, expect, it } from 'vitest';
import { mainTemplateIdOf, toHostScope, type MainTableScope } from './v4Scope';
import { createDefaultDocument } from '../../model/defaults';
import type { StartConfig } from '../../model';

describe('mainTemplateIdOf', () => {
  it('发起节点已配置目标模板时，返回该模板 id', () => {
    const doc = createDefaultDocument('测试流程');
    const start = doc.nodes.find((n) => n.kind === 'start')!;
    (start.config as unknown as StartConfig).target_template_id = 'tmpl-001';
    expect(mainTemplateIdOf(doc)).toBe('tmpl-001');
  });

  it('发起节点尚未配置目标模板时，返回空串（不是 undefined，调用方按空串判断"尚无主表可引用"）', () => {
    const doc = createDefaultDocument('测试流程');
    expect(mainTemplateIdOf(doc)).toBe('');
  });

  it('doc 为 undefined 时返回空串，不抛错', () => {
    expect(mainTemplateIdOf(undefined)).toBe('');
  });
});

describe('toHostScope', () => {
  it('把主表信息翻成 V4HostScope：sources 恒空，report_sources 只有主表一条，table_role 恒 main', () => {
    const scope: MainTableScope = {
      table: { data_table_id: 'dt-1', table_name: '采购申请单', table_role: 'main' },
      fields: [],
      formTables: []
    };
    const hostScope = toHostScope(scope);
    expect(hostScope.sources).toEqual([]);
    expect(hostScope.report_sources).toHaveLength(1);
    expect(hostScope.report_sources[0]).toMatchObject({
      table_id: 'dt-1',
      table_role: 'main',
      alias: '采购申请单'
    });
    expect(hostScope.report_sources[0].instance_id).toMatch(/^rpt-dt-1-/);
  });

  it('instance_id 是按 data_table_id 确定性派生的（同一张表两次调用得到同一个 instance_id）', () => {
    const scope: MainTableScope = {
      table: { data_table_id: 'dt-9', table_name: '销售订单', table_role: 'main' },
      fields: [],
      formTables: []
    };
    const a = toHostScope(scope).report_sources[0].instance_id;
    const b = toHostScope(scope).report_sources[0].instance_id;
    expect(a).toBe(b);
  });
});
