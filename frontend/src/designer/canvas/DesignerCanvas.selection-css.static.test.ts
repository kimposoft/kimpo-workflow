/**
 * DesignerCanvas.selection-css.static.test.ts —— 静态断言"节点选中态光晕已从 CSS + 宿主
 * --primary-color 迁移到 SVG attrs"没有被悄悄改回去。
 *
 * 为什么要单独立一份静态断言：selection wiring 的动态行为已由 graph/x6-adapter.selection.test.ts
 * 覆盖，但"DesignerCanvas.vue 的 <style> 里不该再出现读宿主 --primary-color 做选中态光晕的
 * CSS 规则"这件事，动态测试测不出来（CSS 规则即便重新出现，只要 x6-adapter.ts 的内联 style
 * 优先级更高，视觉断言依然会绿——不能靠"看起来对"反推"没有回归到旧写法"）。
 *
 * 🔴 静态断言两条已知坑（同 x6-adapter.no-color-literal.static.test.ts 头注释同款提醒）：
 *   1. 只查"文本里有没有这一行"是弱判据——必须管住选择器形态（针对 `.x6-node[data-selected`
 *      这个具体选择器），不能只查任意位置出现过 `--primary-color` 字符串（该变量在同一份样式表
 *      里其余规则——如参考线颜色——仍然合法使用，见 DesignerCanvas.vue 该处注释）；
 *   2. 静态断言会扫到注释里的字面量——DesignerCanvas.vue 的注释里可能引用"旧写法"的字面代码
 *      （如 `rgb(var(--primary-color, 20 100 224) / 14%)`）用于说明背景，必须先剥掉
 *      `<style>` 块内的 `/* *\/` 注释再匹配，否则这些描述性文本会把断言误判成"回归了"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = 'src/designer/canvas/DesignerCanvas.vue';
const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8');
const styleBlock = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

/** 剥掉 `<style>` 块内的 `/* *\/` 块注释——CSS 没有 `//` 行注释语法，本文件只需要处理这一种
 * （同 x6-adapter.no-color-literal.static.test.ts stripComments 同款用途，正则本身按 CSS
 * 场景收窄，不照抄它处理 `//` 的那一半）。 */
function stripCssComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('DesignerCanvas.vue 静态断言：选中态光晕不再走 CSS + 宿主 --primary-color', () => {
  const code = stripCssComments(styleBlock);

  it('不存在针对 .x6-node[data-selected="true"] 选择器的 CSS 规则（选中态视觉现在全部由 x6-adapter.ts 的 SVG attrs 落地，不需要本文件任何一条规则消费 data-selected 属性）', () => {
    expect(code).not.toMatch(/\.x6-node\[data-selected[^{]*\{/);
  });

  it('样式表里唯一剩下的 --primary-color 用法是参考线颜色规则（.x6-widget-snapline-*），不是选中态光晕——按选择器逐条核对，不是笼统断言整份样式表零出现', () => {
    // 参考线颜色规则仍合法使用宿主变量（第三方插件渲染、没有暴露颜色配置项，见
    // 该规则上方注释），这里核对的是"--primary-color 没有出现在其它任何规则里"，而不是
    // "样式表里完全不出现这个变量名"（那会把参考线规则也判成回归）。
    const rulesWithVar = code.match(/[^{}]+\{[^{}]*--primary-color[^{}]*\}/g) ?? [];
    expect(rulesWithVar).toHaveLength(1);
    expect(rulesWithVar[0]).toContain('.x6-widget-snapline-vertical');
  });

  it("反向验证：剥离逻辑对真实 CSS 规则有效，不会被描述性注释误伤（手造一段带真实规则、外加同款历史说明注释的假样式表）", () => {
    const fakeStyle =
      "/* 此前写法：`.x6-node[data-selected=\"true\"] { filter: drop-shadow(0 0 3px rgb(var(--primary-color, 20 100 224) / 14%)); }`（历史说明，不应被当作仍在用的规则） */\n" +
      '.x6-node[data-selected="true"] { filter: drop-shadow(0 0 3px rgb(var(--primary-color, 20 100 224) / 14%)); }';
    const fakeCode = stripCssComments(fakeStyle);
    expect(fakeCode).toContain('--primary-color');
    expect(fakeCode).toMatch(/\.x6-node\[data-selected[^{]*\{/);
  });
});
