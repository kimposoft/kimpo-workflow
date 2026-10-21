// src/locale-parity.test.ts —— 四语文件键集合一致性单测。
// manifest.json 声明的四个 locale（zh-CN/zh-TW/en-US/ja-JP）必须逐一提供完全相同的 key 集合
// ——两级查找链的"当前 locale 缺 key → 落到默认 locale"这一级（见 SDK
// `@kimposoft/plugin-sdk` 的 createPluginI18n 说明"插件自带语言包[默认 locale]"）能兜底运行时不
// 崩，但静默出现"某语言少一句翻译"的问题只有这类结构性单测能在合并前拦住。
import { describe, expect, it } from 'vitest';
import enUS from '../locales/en-US.json';
import jaJP from '../locales/ja-JP.json';
import zhCN from '../locales/zh-CN.json';
import zhTW from '../locales/zh-TW.json';

const LOCALES: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP
};

describe('四语文件键集合一致', () => {
  const localeNames = Object.keys(LOCALES);
  const keySets = Object.fromEntries(localeNames.map((name) => [name, Object.keys(LOCALES[name]).sort()]));

  it('四个文件的 key 集合完全相同', () => {
    const [first, ...rest] = localeNames;
    for (const name of rest) {
      expect(keySets[name]).toEqual(keySets[first]);
    }
  });

  it('每个文件里每个 key 都是非空字符串（没有漏翻成空串）', () => {
    for (const name of localeNames) {
      for (const [key, value] of Object.entries(LOCALES[name])) {
        expect(typeof value, `${name}.${key} 应为字符串`).toBe('string');
        expect(value.trim().length, `${name}.${key} 不应为空串`).toBeGreaterThan(0);
      }
    }
  });

  it('关键扁平 key 全部存在（含拉平后的 plugin.name，不是嵌套 {plugin:{name}}）', () => {
    const expectedKeys = [
      'plugin.name',
      'workflow.designer.node.start',
      'workflow.designer.node.handle',
      'workflow.designer.node.end',
      'workflow.designer.node.summary.start.unconfigured',
      'workflow.designer.node.summary.start.manualOff',
      'workflow.designer.node.summary.start.configured',
      'workflow.designer.node.summary.assignee.empty',
      'workflow.designer.node.summary.assignee.count',
      'workflow.designer.node.summary.assignee.named',
      'workflow.designer.node.summary.end.unconfigured',
      'workflow.designer.node.summary.end.configured',
      // 连线名称分区/占位/帮助语与对应发布期诊断 key（画布中点珠子只认连线名称）。
      'workflow.designer.panel.section.linkName',
      'workflow.designer.panel.linkNamePlaceholder',
      'workflow.designer.panel.linkNameHint',
      'workflow.designer.issue.link_id_invalid',
      'workflow.designer.issue.link_endpoint_unknown',
      'workflow.designer.issue.link_name_too_long',
      'workflow.designer.issue.link_self_loop',
      'workflow.designer.issue.node_kind_unsupported',
      'workflow.designer.issue.l10',
      'workflow.designer.issue.l11_no_end_node',
      'workflow.designer.issue.l11_end_without_inline',
      'workflow.designer.issue.end_has_outline',
      'workflow.designer.issue.k2',
      'workflow.designer.issue.n1_target_template_mismatch',
      'workflow.designer.issue.node_config_invalid',
      'workflow.designer.issue.a1_source_required',
      'workflow.designer.issue.a1_source_empty',
      'workflow.designer.issue.a_source_unsupported',
      'workflow.designer.issue.d_ratio_unsupported',
      'workflow.designer.issue.no_route_hint_required',
      'workflow.designer.issue.n5_end_flag_required',
      'workflow.designer.issue.n1_target_template_required',
      'workflow.designer.issue.unknown',
      // 办理/审批方式第三档（all，业务上叫「全部完成」/「会签」）+ 人员来源第六档「发起人」。
      'workflow.designer.panel.handle.completeModeAll',
      'workflow.designer.panel.handle.completeModeAllNote',
      'workflow.designer.panel.approve.completeModeAll',
      'workflow.designer.panel.approve.completeModeAllNote',
      'workflow.designer.assignee.kind.initiator',
      'workflow.designer.assignee.label.initiator',
      // 审批按钮在面板内就地编辑：「＋ 添加按钮」、把手提示、展开/收起无障碍文案、编辑区
      // 「按钮名称」字段标签。
      'workflow.designer.panel.approve.buttonAdd',
      'workflow.designer.panel.approve.buttonHandleTitle',
      'workflow.designer.panel.approve.buttonRowExpand',
      'workflow.designer.panel.approve.buttonRowCollapse',
      'workflow.designer.dialog.buttonSettings.nameLabel',
      // 节点级通知开关——共用『通知』卡
      // （shared/NotifyCard.vue）的分区标题键，与四类主线节点各自的开关文案键。
      'workflow.designer.panel.section.notify',
      'workflow.designer.panel.start.notifyOnReturned',
      'workflow.designer.panel.start.notifyOnWithdrawn',
      'workflow.designer.panel.start.notifyOnTerminated',
      'workflow.designer.panel.handle.notifyOnAssigned',
      'workflow.designer.panel.handle.notifyOnReturned',
      'workflow.designer.panel.approve.notifyOnAssigned',
      'workflow.designer.panel.approve.notifyOnReturned',
      'workflow.designer.panel.end.notifyOnEnded',
      // 后端发布期诊断码 N1_START_CONDITION_HINT_REQUIRED（见 validate-map.ts）。
      'workflow.designer.issue.n1_start_condition_hint_required',
      // 发起节点「发起条件」卡 + 「不满足时的提示」+「谁能发起」第四档（主表字段，N1.7/N1.8）。
      'workflow.designer.panel.section.startCondition',
      'workflow.designer.panel.start.conditionHelp',
      'workflow.designer.panel.start.conditionPlaceholder',
      'workflow.designer.panel.start.conditionHintLabel',
      'workflow.designer.panel.start.conditionHintPlaceholder',
      'workflow.designer.panel.start.conditionHintRequiredHint',
      'workflow.designer.panel.start.permissionHelp',
      'workflow.designer.panel.orgTri.addOrgOption',
      'workflow.designer.panel.orgTri.addMainFieldNeedsTemplate',
      // 『与上步处理人的关系』是独立过滤器——「再缩小范围」卡（shared/RelationFilterCard.vue）的标题/小标签/帮助语，与
      // 对应的发布期诊断码 A1_FILTER_WITHOUT_SOURCE（见 validate-map.ts）。
      'workflow.designer.panel.section.relationFilters',
      'workflow.designer.assignee.relationFilterLabel',
      'workflow.designer.assignee.relationFilterHelp',
      'workflow.designer.issue.a1_filter_without_source'
    ];
    for (const key of expectedKeys) {
      for (const name of localeNames) {
        expect(Object.prototype.hasOwnProperty.call(LOCALES[name], key), `${name} 缺少 key: ${key}`).toBe(true);
      }
    }
  });

  it('不再是嵌套结构（plugin 不是一个对象，而是拉平后的字符串键 plugin.name）', () => {
    for (const name of localeNames) {
      expect((LOCALES[name] as Record<string, unknown>).plugin).toBeUndefined();
    }
  });
});
