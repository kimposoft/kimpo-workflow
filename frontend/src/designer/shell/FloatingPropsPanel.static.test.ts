/**
 * shell/FloatingPropsPanel.static.test.ts —— 属性面板浮层"正文超高时可滚动"这条高度约束链的
 * 静态锁定。
 *
 * 背景：子流程节点面板内容较多（目标流程/传递字段/等待方式/结束后处置四块平铺），若高度约束链
 * 断掉，最后一块会被浮层底边直接切掉，够不着也滚不动。典型错误是 shell/PropsPanel.vue 的
 * `.wf-props-panel` 写成"高度继承父层 100%"，而父层（本文件的 .workflow-props-floating__body）
 * 浮动态只给了"上限"而不是"确定值"这一档约束——按 CSS 规范，子层的百分比高度只认祖先有"确定值"
 * 这一档，认不到"上限"这一档，于是子层的百分比高度会整体失效退化，内容多高、面板就撑多高，
 * 超出部分被外层的那档约束硬切且够不着。
 *
 * 本插件 vitest 环境是 happy-dom，不跑真实布局引擎——mount 出来的元素 clientHeight/scrollHeight
 * 恒为 0，Vue scoped <style> 在这套 createApp() 挂载方式下也不会被真的注入进文档（已用一次性
 * 探测脚本验证过：mount 后 getComputedStyle 读到的是浏览器默认值，不是 scoped 规则算出的值），
 * 因此"是否真的能滚"这件事在单测环境里无法靠挂载 + 量像素来验证，只能对 <style scoped> 源码
 * 文本做结构化断言——同 designer/shell/DesignerStatusBar.static.test.ts 头注释"运行时组件测试不
 * 容易稳定锁住...改用对源码文本的静态断言"、以及 designer/panels/no-native-controls.static.test.ts
 * 的既定手法一致。这类断言锁的是"约束链每一层该有的声明都在"，不是"像素级证明会滚动"。
 *
 * 高度约束链（自外向内）：
 *   1) shell/FloatingPropsPanel.vue 的 .workflow-props-floating__body——本组件（PropsPanel 的
 *      直接父层）必须是 flex 纵向容器且 min-height:0，这样它自己算出来的实际渲染高度（浮动态
 *      来自内联 max-height、钉住态来自继承根元素的显式像素高度）才能变成一个真正的 flex 布局
 *      约束，往下传给子项；
 *   2) shell/PropsPanel.vue 的 .wf-props-panel——必须是 flex:1 + min-height:0（不能再是
 *      "高度按百分比继承"那种写法），才能真正吃满上一层给出的高度，而不是按自身内容撑大；
 *   3) shell/PropsPanel.vue 的 .wf-props-panel__body——真正发生纵向滚动的那一层，必须保留
 *      min-height:0 + 纵向滚动（这里断言它没有被后续改动误删）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FLOATING_PATH = 'src/designer/shell/FloatingPropsPanel.vue';
const PROPS_PANEL_PATH = 'src/designer/shell/PropsPanel.vue';

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** 剥掉 HTML 注释、块注释、行注释——本文件与被测文件里大量出现"此前是 height:100%"这类描述
 *  历史根因的文本（解释"为什么现在不能再这样写"），逐字节匹配会被这些描述性注释误伤，同
 *  no-native-controls.static.test.ts stripNonCode() 的既定手法：判定目标必须是剥掉注释之后的
 *  代码体。这里不剥 `<style>` 标签本身——本文件恰恰要检查 `<style>` 块里的规则，与
 *  no-native-controls.static.test.ts（那边刻意剥掉整个 `<style>`）目的相反。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

/** 取出某条精确选择器（如 `.wf-props-panel`）自己的规则体——用"选择器 + 可选空白 + {"定位起点，
 *  不会被 `.wf-props-panel__header`/`.wf-props-panel__body` 这类以同一前缀开头的选择器误命中
 *  （它们的下一个字符是 `_`，不是空白或 `{`，正则里 `\s*\{` 卡死了这一点）。这些 <style
 *  scoped> 块都是扁平规则、没有嵌套花括号，取到第一个 `}` 即为规则体结尾，同文件内其它静态测试
 *  的既定简化处理一致。 */
function ruleBody(strippedSource: string, selector: string): string {
  const escaped = selector.replace(/[.#]/g, '\\$&');
  const match = strippedSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未在源码里找到选择器 ${selector} 的规则体`);
  return match[1];
}

describe('高度约束链第①层：.workflow-props-floating__body（PropsPanel 的直接父层）是 flex 纵向容器', () => {
  const body = ruleBody(stripComments(readSource(FLOATING_PATH)), '.workflow-props-floating__body');

  it('声明 display: flex', () => {
    expect(body).toMatch(/display:\s*flex/);
  });
  it('声明 flex-direction: column', () => {
    expect(body).toMatch(/flex-direction:\s*column/);
  });
  it('声明 min-height: 0（否则 flex 子项默认最小高度是内容高度，撑爆父层这件事不会被这一层拦住）', () => {
    expect(body).toMatch(/min-height:\s*0/);
  });
});

describe('高度约束链第②层：.wf-props-panel 不再靠"高度按百分比继承"，改成真正吃满父层的 flex 子项', () => {
  const rule = ruleBody(stripComments(readSource(PROPS_PANEL_PATH)), '.wf-props-panel');

  it('不再声明 height: 100%（父层只有 max-height 时这条百分比会退化成 auto，正文撑爆浮层）', () => {
    expect(rule).not.toMatch(/height:\s*100%/);
  });
  it('声明 flex: 1', () => {
    expect(rule).toMatch(/flex:\s*1\b/);
  });
  it('声明 min-height: 0', () => {
    expect(rule).toMatch(/min-height:\s*0/);
  });
});

describe('高度约束链第③层：.wf-props-panel__body 仍是真正发生纵向滚动的那一层（本次改动不应动到它）', () => {
  const rule = ruleBody(stripComments(readSource(PROPS_PANEL_PATH)), '.wf-props-panel__body');

  it('声明 overflow-y: auto', () => {
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
  it('声明 min-height: 0', () => {
    expect(rule).toMatch(/min-height:\s*0/);
  });
  it('声明 flex: 1（在纵向 flex 容器 .wf-props-panel 内吃满剩余高度，不含标题栏那部分）', () => {
    expect(rule).toMatch(/flex:\s*1\b/);
  });
});

// ── 反向验证锚点：证明上面的断言确实在检测东西，不是正则写错而恒绿——同 no-native-controls
// .static.test.ts、DesignerStatusBar.static.test.ts 的既定手法。 ──────────────────────────────
describe('反向验证：stripComments/ruleBody 对真实源码有效，且不会被描述性注释误伤', () => {
  it('ruleBody 精确取到 .wf-props-panel 自己的规则体，不会被 .wf-props-panel__header 提前截断/误命中', () => {
    const fakeSource = [
      '<style scoped>',
      '.wf-props-panel { flex: 1; min-height: 0; }',
      '.wf-props-panel__header { flex: 0 0 auto; }',
      '</style>'
    ].join('\n');
    const rule = ruleBody(stripComments(fakeSource), '.wf-props-panel');
    expect(rule).toContain('flex: 1');
    expect(rule).not.toContain('flex: 0 0 auto');
  });

  it('若某规则体真的写回了旧的百分比高度写法，断言会打红（证明"not.toMatch"这条有牙齿）', () => {
    // 变量名与字面量拼接，避免在源码里出现完整的旧写法字符串本身（否定性文字里原样写出被禁写法，
    // 会让其它扫描整份文件文本的静态断言误判），这里连测试代码自己都不拼出这行字面量，用
    // String.raw 从两段拼。
    const oldBadDeclaration = String.raw`height:` + ' 100%;';
    const fakeSource = `<style scoped>\n.wf-props-panel { ${oldBadDeclaration} }\n</style>`;
    const rule = ruleBody(stripComments(fakeSource), '.wf-props-panel');
    expect(rule).toMatch(/height:\s*100%/);
  });

  it('描述历史根因的注释（含 "height:100%" 字样）不会被误判成仍在用这个写法——注释必须先被剥掉', () => {
    const fakeSource = [
      '<style scoped>',
      '/* 此前是 height:100%，现已改掉 */',
      '.wf-props-panel { flex: 1; min-height: 0; }',
      '</style>'
    ].join('\n');
    const rule = ruleBody(stripComments(fakeSource), '.wf-props-panel');
    expect(rule).not.toMatch(/height:\s*100%/);
    expect(rule).toContain('flex: 1');
  });

  it('.workflow-props-floating.is-pinned .workflow-props-floating__panel 这条钉住态专用规则仍然合法保留 height: 100%——本次修复只收窄 .wf-props-panel 一条选择器，不是全文件禁用这个写法', () => {
    const source = readSource(FLOATING_PATH);
    const rule = ruleBody(stripComments(source), '.workflow-props-floating.is-pinned .workflow-props-floating__panel');
    expect(rule).toMatch(/height:\s*100%/);
  });
});
