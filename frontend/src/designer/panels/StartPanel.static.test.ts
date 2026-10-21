/**
 * panels/StartPanel.static.test.ts —— StartPanel.vue（发起节点 N1 属性面板）分区骨架接线静态
 * 守护：断言公共头部 PanelHeader + 分区 tab 顺序。
 *
 * 手法同 CcPanel.static.test.ts「分区顺序」一节：本插件前端未装 @vue/test-utils，组件级挂载
 * 测试断言不到"渲染出来的 DOM 顺序"，改为对源码文本做结构化断言——PanelSection/PanelHeader/
 * PanelTabs 标签字面量出现的先后顺序即渲染顺序（模板是顺序求值的，见 Vue 单文件组件既定语义）。
 *
 * 面板骨架按分区（tab）组织，节点改名由公共头部 PanelHeader.vue 就地完成，本面板不另设「节点
 * 名称」分区。本文件断言"PanelHeader 在最前、其后紧跟三个固定顺序的分区 tab"，并反向断言
 * "节点名称"这个分区标题字面量不存在。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/designer/panels/StartPanel.vue'), 'utf8');

describe('StartPanel：分区顺序——PanelHeader 在最前，其后是三个固定顺序的分区 tab', () => {
  it('模板根节点第一个子节点是 <PanelHeader>，出现在 <PanelTabs> 之前', () => {
    const headerIdx = source.indexOf('<PanelHeader');
    const tabsIdx = source.indexOf('<PanelTabs');
    expect(headerIdx, '应使用公共头部 PanelHeader').toBeGreaterThan(-1);
    expect(tabsIdx, '应使用分区切换条 PanelTabs').toBeGreaterThan(-1);
    expect(headerIdx, 'PanelHeader 应在 PanelTabs 之前').toBeLessThan(tabsIdx);
  });

  it('PanelHeader 透传 node/readOnly 两个 prop', () => {
    expect(source).toMatch(/<PanelHeader\s+:node="node"\s+:read-only="readOnly"\s*\/>/);
  });

  it('tabs 数组按 basic → initiator → formAndHint 固定顺序声明', () => {
    const tabsDeclIdx = source.indexOf('const tabs = computed<PanelTabItem[]>');
    expect(tabsDeclIdx, '应存在 tabs computed 声明').toBeGreaterThan(-1);
    const basicIdx = source.indexOf("key: 'basic'");
    const initiatorIdx = source.indexOf("key: 'initiator'");
    const formAndHintIdx = source.indexOf("key: 'formAndHint'");
    for (const idx of [basicIdx, initiatorIdx, formAndHintIdx]) expect(idx).toBeGreaterThan(tabsDeclIdx);
    expect(initiatorIdx, 'initiator 应在 basic 之后').toBeGreaterThan(basicIdx);
    expect(formAndHintIdx, 'formAndHint 应在 initiator 之后').toBeGreaterThan(initiatorIdx);
  });

  it('basic 分区内含目标表单 / 允许人工发起 / 步骤摘要三个分区标题，按此顺序出现在 initiator 分区 tab 之前', () => {
    const basicPaneIdx = source.indexOf("v-show=\"activeTab === 'basic'\"");
    const initiatorPaneIdx = source.indexOf("v-show=\"activeTab === 'initiator'\"");
    expect(basicPaneIdx).toBeGreaterThan(-1);
    expect(initiatorPaneIdx).toBeGreaterThan(basicPaneIdx);

    const templateTitleIdx = source.indexOf("i18n.t('workflow.designer.panel.start.templateTitle')");
    const manualTitleIdx = source.indexOf("i18n.t('workflow.designer.panel.start.manualTitle')");
    const summaryIdx = source.indexOf("i18n.t('workflow.designer.panel.section.summary')");
    for (const idx of [templateTitleIdx, manualTitleIdx, summaryIdx]) {
      expect(idx).toBeGreaterThan(basicPaneIdx);
      expect(idx).toBeLessThan(initiatorPaneIdx);
    }
    expect(manualTitleIdx, '允许人工发起应在目标表单之后').toBeGreaterThan(templateTitleIdx);
    expect(summaryIdx, '步骤摘要应在允许人工发起之后').toBeGreaterThan(manualTitleIdx);
  });

  it('initiator 分区内只有发起权限一个分区标题，在 formAndHint 分区 tab 之前', () => {
    const initiatorPaneIdx = source.indexOf("v-show=\"activeTab === 'initiator'\"");
    const formAndHintPaneIdx = source.indexOf("v-show=\"activeTab === 'formAndHint'\"");
    const permissionTitleIdx = source.indexOf("i18n.t('workflow.designer.panel.start.permissionTitle')");
    expect(permissionTitleIdx).toBeGreaterThan(initiatorPaneIdx);
    expect(permissionTitleIdx).toBeLessThan(formAndHintPaneIdx);
  });

  it('formAndHint 分区内含字段权限、无路可走时的提示，按此顺序', () => {
    const formAndHintPaneIdx = source.indexOf("v-show=\"activeTab === 'formAndHint'\"");
    const fieldPermissionIdx = source.indexOf("i18n.t('workflow.designer.panel.section.fieldPermission')");
    const noRouteHintIdx = source.indexOf("i18n.t('workflow.designer.panel.section.noRouteHint')");
    expect(fieldPermissionIdx).toBeGreaterThan(formAndHintPaneIdx);
    expect(noRouteHintIdx, '无路可走时的提示应在字段权限之后').toBeGreaterThan(fieldPermissionIdx);
  });

  it('反面断言：不存在单独维护的「节点名称」分区（由 PanelHeader 就地改名）', () => {
    expect(source).not.toContain("i18n.t('workflow.designer.panel.section.name')");
    expect(source).not.toContain('data-testid="start-node-name"');
  });
});
