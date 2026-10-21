/**
 * designer/stencil/drag-preview.test.ts —— 节点库拖拽预览图构建器单测。
 *
 * 守护两条约定：①预览图长成"节点落到画布上之后的样子"（尺寸/圆角/图标块/
 * 标题/摘要与画布节点同源）；②返回的宽高是乘过缩放的真实像素尺寸，调用方据此把指针锚在正中。
 * 几何数值一律从 graph/x6-adapter.ts 的 nodeDimensions / NODE_CARD_GEOMETRY 读，不在测试里写死
 * 第二份数字（那两者与 applyNodeVisual 的一致性另由 x6-adapter.card-geometry.test.ts 锁定）。
 */
import { describe, expect, it } from 'vitest';
import { NODE_CARD_GEOMETRY, nodeDimensions } from '../../graph/x6-adapter';
import { LIGHT_PALETTE, buildPalette } from '../../model/design-tokens';
import { NODE_ICONS } from '../../model/node-visual';
import { STENCIL_ITEMS } from './index';
import { buildNodeDragPreview, normalizePreviewScale } from './drag-preview';

describe('buildNodeDragPreview 尺寸与形状', () => {
  it('普通业务节点：宽高取 nodeDimensions，圆角取卡片圆角，白底 + 中性灰描边', () => {
    const size = nodeDimensions('cc');
    const preview = buildNodeDragPreview({ kind: 'cc', label: '抄送 1', palette: LIGHT_PALETTE });
    expect(preview.width).toBe(size.width);
    expect(preview.height).toBe(size.height);
    const style = preview.element.style;
    expect(style.width).toBe(`${size.width}px`);
    expect(style.height).toBe(`${size.height}px`);
    expect(style.borderRadius).toBe(`${NODE_CARD_GEOMETRY.cardRadius}px`);
    expect(style.boxSizing).toBe('border-box');
    expect(preview.element.dataset.nodeType).toBe('cc');
  });

  it('胶囊家族（结束）：尺寸走胶囊档，圆角 = 半高', () => {
    const size = nodeDimensions('end');
    const preview = buildNodeDragPreview({ kind: 'end', label: '结束 1', palette: LIGHT_PALETTE });
    expect(preview.width).toBe(size.width);
    expect(preview.height).toBe(size.height);
    expect(preview.element.style.borderRadius).toBe(`${size.height / 2}px`);
  });

  it('节点库里每一个可拖条目都能造出预览图，且都带图标块', () => {
    for (const item of STENCIL_ITEMS) {
      const preview = buildNodeDragPreview({ kind: item.key, label: item.labelZh, palette: LIGHT_PALETTE });
      expect(preview.width).toBeGreaterThan(0);
      expect(preview.height).toBeGreaterThan(0);
      if (NODE_ICONS[item.key]) {
        expect(preview.element.querySelector('svg path')?.getAttribute('d')).toBe(NODE_ICONS[item.key]!.d);
      }
    }
  });
});

describe('buildNodeDragPreview 文字', () => {
  it('无摘要：只画标题一行，单行居中', () => {
    const preview = buildNodeDragPreview({ kind: 'handle', label: '办理 2', palette: LIGHT_PALETTE });
    const label = preview.element.querySelector<HTMLElement>('[data-role="label"]');
    expect(label?.textContent).toBe('办理 2');
    expect(preview.element.querySelector('[data-role="summary"]')).toBeNull();
    // 行中心落在 labelRefYSingle × 高度处：top + 行高/2 + 边框 = 高度 × 0.5。
    const height = nodeDimensions('handle').height;
    const top = parseFloat(label!.style.top);
    const lineHeight = parseFloat(label!.style.height);
    expect(top + lineHeight / 2 + NODE_CARD_GEOMETRY.strokeWidth).toBeCloseTo(height * NODE_CARD_GEOMETRY.labelRefYSingle, 5);
  });

  it('有摘要：标题上移、摘要落在第二行，二者左起同一位置', () => {
    const preview = buildNodeDragPreview({ kind: 'handle', label: '办理 2', summary: '未设置办理人', palette: LIGHT_PALETTE });
    const label = preview.element.querySelector<HTMLElement>('[data-role="label"]')!;
    const summary = preview.element.querySelector<HTMLElement>('[data-role="summary"]')!;
    expect(summary.textContent).toBe('未设置办理人');
    expect(parseFloat(label.style.top)).toBeLessThan(parseFloat(summary.style.top));
    expect(label.style.left).toBe(summary.style.left);
    const height = nodeDimensions('handle').height;
    const center = (el: HTMLElement) => parseFloat(el.style.top) + parseFloat(el.style.height) / 2 + NODE_CARD_GEOMETRY.strokeWidth;
    expect(center(label)).toBeCloseTo(height * NODE_CARD_GEOMETRY.labelRefYWithSummary, 5);
    expect(center(summary)).toBeCloseTo(height * NODE_CARD_GEOMETRY.summaryRefY, 5);
  });

  it('纯空白摘要按无摘要处理（不留一行空白把标题顶上去）', () => {
    const preview = buildNodeDragPreview({ kind: 'handle', label: '办理 2', summary: '   ', palette: LIGHT_PALETTE });
    expect(preview.element.querySelector('[data-role="summary"]')).toBeNull();
  });

  it('长文字单行截断，不撑破卡片', () => {
    const preview = buildNodeDragPreview({ kind: 'handle', label: '一个特别特别特别特别特别长的节点名称', palette: LIGHT_PALETTE });
    const label = preview.element.querySelector<HTMLElement>('[data-role="label"]')!;
    expect(label.style.whiteSpace).toBe('nowrap');
    expect(label.style.textOverflow).toBe('ellipsis');
    expect(preview.element.style.overflow).toBe('hidden');
  });
});

describe('buildNodeDragPreview 跟随画布缩放与主题', () => {
  it('缩放 150%：外框、图标块、字号全部等比放大，返回的宽高同步放大（指针才能锚在真正的正中）', () => {
    const size = nodeDimensions('approve');
    const preview = buildNodeDragPreview({ kind: 'approve', label: '审批节点 1', scale: 1.5, palette: LIGHT_PALETTE });
    expect(preview.width).toBe(size.width * 1.5);
    expect(preview.height).toBe(size.height * 1.5);
    expect(preview.element.style.width).toBe(`${size.width * 1.5}px`);
    const label = preview.element.querySelector<HTMLElement>('[data-role="label"]')!;
    expect(label.style.fontSize).toBe(`${NODE_CARD_GEOMETRY.labelFontSize * 1.5}px`);
    const svg = preview.element.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(NODE_CARD_GEOMETRY.iconViewBox * 1.5));
    // 不用 CSS transform 做缩放（浏览器抓拖拽快照时对变换过的元素处理不一致，见文件头注释）。
    expect(preview.element.style.transform).toBe('');
  });

  it('非法缩放值回退/夹取', () => {
    expect(normalizePreviewScale(undefined)).toBe(1);
    expect(normalizePreviewScale(Number.NaN)).toBe(1);
    expect(normalizePreviewScale(0)).toBe(1);
    expect(normalizePreviewScale(-2)).toBe(1);
    expect(normalizePreviewScale(0.01)).toBe(0.2);
    expect(normalizePreviewScale(99)).toBe(4);
    expect(normalizePreviewScale(0.8)).toBe(0.8);
  });

  it('配色读传入的 CanvasPalette：暗色主题下卡片底色与图标块底色跟着换', () => {
    // 暗色色板没有现成常量，走 buildPalette 的暗色分支现算（readVar 返回空 = 宿主变量缺失时的兜底值）。
    const darkPalette = buildPalette({ mode: 'dark', readVar: () => undefined });
    // 先确认这两个字段亮暗两档取值确实不同，下面的断言才不是同义反复（图标线条色 iconColor 两档
    // 同值，不能拿来当判据）。
    expect(darkPalette.surface).not.toBe(LIGHT_PALETTE.surface);
    expect(darkPalette.nodeTypes.cc.iconBg).not.toBe(LIGHT_PALETTE.nodeTypes.cc.iconBg);

    // happy-dom 会把颜色规整成自己的写法，故不直接比字符串，而是各造一个元素写入同一个色值再比。
    const normalized = (property: 'background', value: string) => {
      const probe = document.createElement('span');
      probe.style[property] = value;
      return probe.style[property];
    };
    const iconBgOf = (root: HTMLElement) => (root.querySelector('svg')!.parentElement as HTMLElement).style.background;

    const light = buildNodeDragPreview({ kind: 'cc', label: '抄送 1', palette: LIGHT_PALETTE });
    const dark = buildNodeDragPreview({ kind: 'cc', label: '抄送 1', palette: darkPalette });
    expect(light.element.style.background).toBe(normalized('background', LIGHT_PALETTE.surface));
    expect(dark.element.style.background).toBe(normalized('background', darkPalette.surface));
    expect(iconBgOf(light.element)).toBe(normalized('background', LIGHT_PALETTE.nodeTypes.cc.iconBg));
    expect(iconBgOf(dark.element)).toBe(normalized('background', darkPalette.nodeTypes.cc.iconBg));
    expect(dark.element.style.background).not.toBe(light.element.style.background);
  });
});
