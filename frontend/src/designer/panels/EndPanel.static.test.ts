/**
 * panels/EndPanel.static.test.ts —— EndPanel.vue（结束节点 N5 属性面板）骨架接线静态守护。
 *
 * 节点改名由公共头部 ../PanelHeader.vue 就地完成，本面板不另设「节点名称」分区。本文件断言
 * <PanelHeader> 存在，且在模板里出现在其余分区标题之前。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/designer/panels/EndPanel.vue'), 'utf8');

describe('EndPanel：骨架统一——PanelHeader 是第一个渲染节点，不另设「节点名称」分区', () => {
  it('模板里存在 <PanelHeader :node :read-only>，且出现在其余分区标题之前', () => {
    const headerIdx = source.indexOf('<PanelHeader');
    expect(headerIdx, '应存在 <PanelHeader> 骨架件').toBeGreaterThan(-1);

    const otherSectionTitles = [
      "i18n.t('workflow.designer.panel.end.flagTitle')",
      "i18n.t('workflow.designer.panel.end.writeFieldTitle')"
    ];
    for (const title of otherSectionTitles) {
      const idx = source.indexOf(title);
      expect(idx, `应存在分区标题 ${title}`).toBeGreaterThan(-1);
      expect(idx, `<PanelHeader> 应在 ${title} 之前`).toBeGreaterThan(headerIdx);
    }
  });

  it('不自带「节点名称」分区标题、不自带 data-testid="end-node-name" 名称输入框（由 PanelHeader 负责）', () => {
    expect(source).not.toContain("i18n.t('workflow.designer.panel.section.name')");
    expect(source).not.toContain('data-testid="end-node-name"');
  });

  it('inject host/i18n/state + changeTick 桥接经 usePanelHost()，不自行 inject', () => {
    expect(source).toContain("import { usePanelHost } from './usePanelHost'");
    expect(source).toContain('usePanelHost()');
    expect(source).not.toContain("inject(DESIGNER_I18N_KEY)");
    expect(source).not.toContain("inject(DESIGNER_STATE_KEY)");
  });

  it('不引入 PanelTabs（结束节点内容少，保持平铺）', () => {
    expect(source).not.toContain('PanelTabs');
  });
});
