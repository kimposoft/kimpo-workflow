/**
 * graph/x6-adapter.card-geometry.test.ts —— 把导出的 NODE_CARD_GEOMETRY 与 applyNodeVisual 的
 * 真实产出逐项对账。
 *
 * 背景：NODE_CARD_GEOMETRY 是给"画布之外复刻同一张节点卡"用的口径（目前消费方是节点库拖拽预览图
 * designer/stencil/drag-preview.ts），其中圆角/描边宽/字号/行位置几项在 applyNodeVisual 里是内联
 * 字面量，导出口径只是照录。两边一旦漂移，拖动时跟着指针走的图样就会与落下后的节点对不上，而且
 * 没有任何报错——所以用假 cell 真跑一遍 applyNodeVisual，把每一项钉在一起。
 *
 * 假 cell 写法同 x6-adapter.visual.test.ts（按 path 记录最后一次 attr 调用）。
 */
import { describe, expect, it } from 'vitest';
import { NODE_CARD_GEOMETRY, applyNodeVisual, nodeDimensions, type NodeVisualCell } from './x6-adapter';
import type { GraphNodeView } from './port';

function applyAndCollect(view: GraphNodeView): Record<string, Record<string, unknown>> {
  const attrs: Record<string, unknown> = {};
  const cell: NodeVisualCell = {
    position: () => {},
    attr: (path: string, value: unknown) => {
      attrs[path] = value;
    }
  };
  applyNodeVisual(cell, view);
  return attrs as Record<string, Record<string, unknown>>;
}

const baseView: GraphNodeView = { id: 'n-1', type: 'approve', label: '审批节点', position: { x: 0, y: 0 } };

describe('NODE_CARD_GEOMETRY 与 applyNodeVisual 对账', () => {
  it('普通业务节点卡：圆角 / 默认描边宽', () => {
    const attrs = applyAndCollect(baseView);
    expect(attrs.body.rx).toBe(NODE_CARD_GEOMETRY.cardRadius);
    expect(attrs.body.ry).toBe(NODE_CARD_GEOMETRY.cardRadius);
    expect(attrs.body.strokeWidth).toBe(NODE_CARD_GEOMETRY.strokeWidth);
  });

  it('胶囊家族圆角恒为半高（预览图同样按半高画，不读 cardRadius）', () => {
    const attrs = applyAndCollect({ ...baseView, type: 'end' });
    expect(attrs.body.rx).toBe(nodeDimensions('end').height / 2);
  });

  it('图标块与图标：尺寸 / 圆角 / 左边距 / 图标居中偏移 / 描边宽', () => {
    const attrs = applyAndCollect(baseView);
    expect(attrs.iconBg.width).toBe(NODE_CARD_GEOMETRY.iconBgSize);
    expect(attrs.iconBg.height).toBe(NODE_CARD_GEOMETRY.iconBgSize);
    expect(attrs.iconBg.rx).toBe(NODE_CARD_GEOMETRY.iconBgRadius);
    expect(attrs.iconBg.refX).toBe(NODE_CARD_GEOMETRY.iconBgLeft);
    expect(attrs.icon.refX).toBe(
      NODE_CARD_GEOMETRY.iconBgLeft + (NODE_CARD_GEOMETRY.iconBgSize - NODE_CARD_GEOMETRY.iconViewBox) / 2
    );
    // approve 图标是描边型（非 fill），描边宽取 iconStrokeWidth。
    expect(attrs.icon.strokeWidth).toBe(NODE_CARD_GEOMETRY.iconStrokeWidth);
  });

  it('标题：起排位置 / 字号字重 / 单行居中', () => {
    const attrs = applyAndCollect(baseView);
    expect(attrs.label.refX).toBe(NODE_CARD_GEOMETRY.labelStart);
    expect(attrs.label.fontSize).toBe(NODE_CARD_GEOMETRY.labelFontSize);
    expect(attrs.label.fontWeight).toBe(NODE_CARD_GEOMETRY.labelFontWeight);
    expect(attrs.label.refY).toBe(NODE_CARD_GEOMETRY.labelRefYSingle);
  });

  it('有摘要时：标题上移、摘要行位置 / 字号 / 右侧留白', () => {
    const attrs = applyAndCollect({ ...baseView, summary: '未设置审批人' });
    expect(attrs.label.refY).toBe(NODE_CARD_GEOMETRY.labelRefYWithSummary);
    expect(attrs.summary.refX).toBe(NODE_CARD_GEOMETRY.labelStart);
    expect(attrs.summary.refY).toBe(NODE_CARD_GEOMETRY.summaryRefY);
    expect(attrs.summary.fontSize).toBe(NODE_CARD_GEOMETRY.summaryFontSize);
    expect((attrs.summary.textWrap as { width: number }).width).toBe(
      -(NODE_CARD_GEOMETRY.labelStart + NODE_CARD_GEOMETRY.summaryRightPadding)
    );
  });

  // 图标块无描边：X6 会给 markup 里所有 <rect> 标签挂默认深色 2px 描边，
  // applyNodeVisual 必须对 iconBg 显式写 stroke:'none' 才盖得掉（来龙去脉见该处注释）。这条用例
  // 防的是有人"清理多余属性"时把这两行删掉——删了没有任何报错，但黑边会在画布上悄悄回来，
  // 且拖拽预览图（无边框）从此与画布节点对不上。
  it('图标块显式声明无描边，盖掉 X6 给 <rect> 标签挂的默认深色描边', () => {
    for (const type of ['approve', 'handle', 'cc', 'subflow', 'start', 'end'] as const) {
      const attrs = applyAndCollect({ ...baseView, type });
      expect(attrs.iconBg.stroke).toBe('none');
      expect(attrs.iconBg.strokeWidth).toBe(0);
    }
  });
});
