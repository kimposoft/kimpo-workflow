/**
 * panels/no-native-controls.static.test.ts —— 静态断言：下方清单里的面板/对话框/共享控件源码里
 * 不出现原生 `<select`/`<textarea`/`type="checkbox"`/`type="radio"`/`<button`（控件基线：面板与
 * 对话框一律走 NaiveUI）。
 *
 * 剥注释手法同 ../../graph/x6-adapter.no-color-literal.static.test.ts 头注释——
 * 🔴 反向断言最容易被注释误伤：注释里可能写"此前是原生 <input>"这类说明文本，若不剥注释直接
 * 对源码正文做正则匹配，会把这些文本误判成"仍在用原生控件"——断言目标必须是剥掉注释、剥掉
 * `<style>` 块之后的代码体，不是原始源码文本。
 * 与 x6-adapter 那份不同的是本文件是 `.vue` 单文件组件，还要额外剥 Vue 模板的 `<!-- -->` HTML
 * 注释、以及 `<style>...</style>`（scoped CSS 里可能出现同名类选择器片段，不该参与判定）。
 *
 * 扫描范围：下方显式清单，不做整目录 glob。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = [
  'src/designer/panels/StartPanel.vue',
  'src/designer/panels/EndPanel.vue',
  'src/designer/panels/EdgePanel.vue',
  'src/designer/panels/ApprovePanel.vue',
  'src/designer/panels/HandlePanel.vue',
  'src/designer/panels/CcPanel.vue',
  'src/designer/panels/PanelSection.vue',
  'src/designer/panels/shared/MainFieldSelect.vue',
  'src/designer/panels/shared/OrgTriLine.vue',
  'src/designer/panels/shared/AssigneeSourceList.vue',
  'src/designer/panels/shared/ApprovalButtonList.vue',
  'src/designer/panels/shared/FieldPermissionSummary.vue',
  'src/designer/expression/V4ExpressionEditDialog.vue'
];

/** 剥掉 `<style>...</style>` 整块、Vue 模板 HTML 注释、JS/TS 块注释与行注释——顺序不能反：
 *  先整块删 `<style>`（其内容不参与任何判定，避免 scoped CSS 选择器片段误伤），再删 HTML 注释，
 *  最后删 JS 风格注释（<script> 块内的历史说明文本落在这一步）。 */
function stripNonCode(source: string): string {
  return source
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

describe('面板/对话框/共享控件：剥离注释与 <style> 后不再出现原生 <select', () => {
  for (const file of FILES) {
    it(file, () => {
      const code = stripNonCode(readFileSync(resolve(process.cwd(), file), 'utf8'));
      expect(code).not.toMatch(/<select\b/);
    });
  }
});

describe('面板/对话框/共享控件：剥离注释与 <style> 后不再出现原生 <textarea', () => {
  for (const file of FILES) {
    it(file, () => {
      const code = stripNonCode(readFileSync(resolve(process.cwd(), file), 'utf8'));
      expect(code).not.toMatch(/<textarea\b/);
    });
  }
});

describe('面板/对话框/共享控件：剥离注释与 <style> 后不再出现原生 type="checkbox"', () => {
  for (const file of FILES) {
    it(file, () => {
      const code = stripNonCode(readFileSync(resolve(process.cwd(), file), 'utf8'));
      expect(code).not.toContain('type="checkbox"');
    });
  }
});

describe('面板/对话框/共享控件：剥离注释与 <style> 后不再出现原生 type="radio"', () => {
  for (const file of FILES) {
    it(file, () => {
      const code = stripNonCode(readFileSync(resolve(process.cwd(), file), 'utf8'));
      expect(code).not.toContain('type="radio"');
    });
  }
});

describe('面板/对话框/共享控件：剥离注释与 <style> 后不再出现原生 <button（全部已换成 NButton）', () => {
  for (const file of FILES) {
    it(file, () => {
      const code = stripNonCode(readFileSync(resolve(process.cwd(), file), 'utf8'));
      expect(code).not.toMatch(/<button\b/);
    });
  }
});

// ── 反向验证锚点：证明上面五条断言确实在检测东西，不是正则写错而恒绿——同时验证"说明性
// 注释不会被误伤"（注释里可能出现"此前是原生 <input>"这类文本）。 ─────────────────────────
describe('反向验证：剥离逻辑对真实原生控件有效，且不会被描述性注释/<style> 误伤', () => {
  it('真实原生控件会被断言抓到；描述性注释与 <style> 内容不会误伤', () => {
    const fakeSource = [
      '<script setup lang="ts">',
      '// 此前是原生 <input type="checkbox">（历史说明，不应被当作仍在用的原生控件）',
      '/* 此前是原生 <select>（同上，块注释形式） */',
      '</script>',
      '<template>',
      '  <!-- 此前是原生 <textarea>（Vue 模板注释，同样不应被当作仍在用） -->',
      '  <select class="real-native-select"></select>',
      '  <textarea class="real-native-textarea"></textarea>',
      '  <input type="checkbox" />',
      '  <input type="radio" />',
      '  <button type="button">真实原生按钮</button>',
      '</template>',
      '<style scoped>',
      '.fake-style-block { content: "<select><textarea>type=\\"checkbox\\"type=\\"radio\\"<button"; }',
      '</style>'
    ].join('\n');
    const code = stripNonCode(fakeSource);
    expect(code).toMatch(/<select\b/);
    expect(code).toMatch(/<textarea\b/);
    expect(code).toContain('type="checkbox"');
    expect(code).toContain('type="radio"');
    expect(code).toMatch(/<button\b/);
    // <style> 块整体被剥掉，块内的"看似命中"的字符串不会漏进代码体。
    expect(code).not.toContain('fake-style-block');
  });
});
