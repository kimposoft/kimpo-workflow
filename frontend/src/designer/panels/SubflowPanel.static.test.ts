/**
 * panels/SubflowPanel.static.test.ts —— SubflowPanel.vue + shared/MappingRows.vue（子流程节点 N6
 * 属性面板）的接线静态守护，手法同 ./CcPanel.static.test.ts / ../expression/
 * V4ExpressionField.static.test.ts："对源码文本做结构化断言"（本插件前端未装 @vue/test-utils）。
 *
 * 覆盖：两文件合计的分区顺序 / 全部 data-testid 是否落地（选择器分布在两个文件里，合并核对）/ SubflowPanel.vue 是否真的经 useTemplateFieldCatalog 取目录而不是自己直连
 * host.listTemplateTables/listTemplateFields（那是 MappingRows.vue 间接依赖的共享目录取数件
 * templateFieldCatalog.ts 的职责，见其头注释）/ 是否误用原生 select、checkbox、radio 控件 / 本文件
 * 用到的全部 i18n key 字面量是否都在 zh-CN.json 里登记。
 *
 * 节点改名由公共头部 ../PanelHeader.vue 就地完成，分区顺序判据以 <PanelHeader> 打头。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '../../../locales/zh-CN.json';

const panelSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/SubflowPanel.vue'), 'utf8');
const rowsSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/shared/MappingRows.vue'), 'utf8');
const combined = `${panelSource}\n${rowsSource}`;

describe('SubflowPanel：骨架统一——PanelHeader 在先，其后是目标流程 → 传递字段 → 等待方式 → 结束后处置', () => {
  it('<PanelHeader> 与四个分区标题按顺序依次出现', () => {
    const order = [
      '<PanelHeader',
      "i18n.t('workflow.designer.panel.section.targetWorkflow')",
      "i18n.t('workflow.designer.panel.section.fieldMappings')",
      "i18n.t('workflow.designer.panel.section.waitMode')",
      "i18n.t('workflow.designer.panel.section.disposition')"
    ];
    const indexes = order.map((needle) => panelSource.indexOf(needle));
    for (const idx of indexes) expect(idx).toBeGreaterThan(-1);
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]!).toBeGreaterThan(indexes[i - 1]!);
    }
  });

  it('不自带「节点名称」分区标题（由 PanelHeader 负责）', () => {
    expect(panelSource).not.toContain("i18n.t('workflow.designer.panel.section.name')");
  });

  it('inject host/i18n/state + changeTick 桥接经 usePanelHost()，不自行 inject', () => {
    expect(panelSource).toContain("import { usePanelHost } from './usePanelHost'");
    expect(panelSource).toContain('usePanelHost()');
    expect(panelSource).not.toContain('inject(DESIGNER_HOST_KEY)');
    expect(panelSource).not.toContain('inject(DESIGNER_I18N_KEY)');
    expect(panelSource).not.toContain('inject(DESIGNER_STATE_KEY)');
  });

  it('不引入 PanelTabs（保持平铺）', () => {
    expect(panelSource).not.toContain('PanelTabs');
  });

  it('结束后处置分区只在 !config.wait 时渲染', () => {
    expect(panelSource).toMatch(/<PanelSection v-if="!config\.wait" :title="i18n\.t\('workflow\.designer\.panel\.section\.disposition'\)"/);
  });
});

describe('SubflowPanel：全部 data-testid 选择器落地（跨 SubflowPanel.vue / MappingRows.vue 合并核对）', () => {
  const required = [
    'subflow-target',
    'subflow-map-add',
    'subflow-wait-true',
    'subflow-wait-false',
    'subflow-disposition-ignore',
    'subflow-disposition-force_end'
  ];
  it.each(required)('静态字面量 data-testid="%s" 存在', (testid) => {
    expect(combined).toContain(`data-testid="${testid}"`);
  });

  it('动态行级 data-testid（subflow-map-row/source/target/remove-${index}）都用同一个 index 变量渲染', () => {
    expect(rowsSource).toContain('`subflow-map-row-${index}`');
    expect(rowsSource).toContain('`subflow-map-source-${index}`');
    expect(rowsSource).toContain('`subflow-map-target-${index}`');
    expect(rowsSource).toContain('`subflow-map-remove-${index}`');
  });
});

describe('SubflowPanel：目录取数经共享组合式 useTemplateFieldCatalog，不自行直连宿主', () => {
  it('引入并调用 useTemplateFieldCatalog 两次（本模板来源目录 + 目标流程模板目录）', () => {
    expect(panelSource).toContain("import { useTemplateFieldCatalog } from './shared/templateFieldCatalog'");
    const calls = panelSource.match(/useTemplateFieldCatalog\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it('SubflowPanel.vue 自身不直接调用 host.listTemplateTables/listTemplateFields（那是共享目录取数件的职责）', () => {
    expect(panelSource).not.toContain('host.listTemplateTables(');
    expect(panelSource).not.toContain('host.listTemplateFields(');
  });

  it('目标流程候选经 host.listAppWorkflows() 取，通知渠道能力面板不消费（那是 CcPanel 的职责）', () => {
    expect(panelSource).toContain('host.listAppWorkflows()');
    expect(panelSource).not.toContain('channelCapabilities');
  });
});

describe('SubflowPanel：目标流程下拉排除自己', () => {
  it('引入 excludeSelf 并用 host.definitionId 过滤已发布/已启用候选', () => {
    expect(panelSource).toContain(
      "import { applyWaitToggle, excludeSelf, isTerminalSubflow } from './shared/subflowMapping';"
    );
    expect(panelSource).toContain('excludeSelf(enabledOnly, host.definitionId)');
  });
});

describe('SubflowPanel：同表约束/末级节点纯函数接线', () => {
  it('末级节点判定经 isTerminalSubflow 纯函数，随 changeTick 重新求值', () => {
    expect(panelSource).toContain('isTerminalSubflow(doc, props.node.id)');
  });
  it('末级节点时"等待"选项被禁用（双重保险：onWaitChange 内也短路一次）', () => {
    expect(panelSource).toMatch(/data-testid="subflow-wait-true"[\s\S]*?:disabled="readOnly \|\| terminal"/);
    expect(panelSource).toContain('if (wait && terminal.value) return;');
  });
  it('等待方式切换经 applyWaitToggle 纯函数联动处置字段', () => {
    expect(panelSource).toContain('applyWaitToggle({ disposition: config.value.disposition }, wait)');
  });
  it('传递字段冲突提示经 detailTableConflicts 纯函数（MappingRows.vue 内）', () => {
    expect(rowsSource).toContain('detailTableConflicts(props.modelValue)');
  });
});

describe('SubflowPanel + MappingRows：不得误用原生表单控件（全面走 NaiveUI）', () => {
  it('不出现原生 <select', () => {
    expect(combined).not.toContain('<select');
  });
  it('不出现原生 type="checkbox"', () => {
    expect(combined).not.toContain('type="checkbox"');
  });
  it('不出现原生 type="radio"', () => {
    expect(combined).not.toContain('type="radio"');
  });
});

describe('SubflowPanel + MappingRows：两文件用到的全部 i18n key 字面量都在 zh-CN.json 登记', () => {
  it('宽正则扫描出的全部 workflow.designer.* 字符串字面量', () => {
    const keys = Array.from(new Set(Array.from(combined.matchAll(/'(workflow\.designer\.[a-zA-Z0-9_.]+)'/g)).map((m) => m[1]!)));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
    }
  });
});
