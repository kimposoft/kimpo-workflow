/**
 * x6-adapter.no-color-literal.static.test.ts —— 静态断言 graph/x6-adapter.ts 源码里不出现
 * 颜色字面量（画布暗色支持：颜色由调用方传入的 CanvasPalette 参数提供，不在本地硬编码亮色值
 * ——见 model/design-tokens.ts CanvasPalette 与 x6-adapter.ts 各 applyNodeVisual/
 * applyEdgeVisual/portGroups/mount() 消费处）。
 *
 * 剥注释手法与 designer/nonparallel-i18n-theme.static.test.ts 的 executableAndTemplateText
 * 完全一致（同一份正则）——🔴 反向断言最容易被自己的注释误伤：源码注释里可能写有 '#ffffff'
 * 这类说明文本，若不剥注释直接对整份源码做正则匹配，会把这些说明误判成"仍在用字面量"——
 * 断言目标必须是剥掉注释后的代码体，不是原始源码文本。
 *
 * 白名单说明：`rgba?\(\s*\d` 这条模式要求左括号后紧跟数字，`drop-shadow(0 1px 4px
 * ${palette.shadow})` 这类"从 palette 取值再做字符串拼接"的写法——真正的颜色值是
 * `${palette.shadow}` 变量插值，不是数值字面量，且函数名是 'drop-shadow' 不是 'rgb'/'rgba'，
 * 两条正则都不会命中，不需要额外声明豁免；巡查下来剥注释后的代码体没有任何应该豁免、又被误伤
 * 的合法例外，因此不设置白名单列表。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = 'src/graph/x6-adapter.ts';

/** 剥掉 /* 块注释与 // 行注释——与 designer/nonparallel-i18n-theme.static.test.ts
 * executableAndTemplateText 同一份正则（本文件是纯 .ts、无模板，不需要该文件里处理 Vue 模板
 * 的 `<!-- -->` HTML 注释分支）。 */
function stripComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

describe('graph/x6-adapter.ts 静态断言：不包含颜色字面量（颜色全部来自 CanvasPalette）', () => {
  const code = stripComments(readFileSync(resolve(process.cwd(), SOURCE_PATH), 'utf8'));

  it('剥离注释后的代码体不包含十六进制颜色字面量', () => {
    expect(code).not.toMatch(/#[\da-f]{3,8}\b/iu);
  });

  it('剥离注释后的代码体不包含 rgb()/rgba() 数值颜色字面量', () => {
    expect(code).not.toMatch(/rgba?\(\s*\d/iu);
  });

  // 反向验证锚点：证明上面两条断言确实在检测东西，不是正则写错而恒绿——手造一段带真实颜色
  // 字面量、外加同款历史说明注释的假代码，确认"注释里的文本不误伤、真实代码里的字面量会被抓到"。
  it('反向验证：剥离逻辑对真实颜色字面量有效，且不会被描述性注释误伤', () => {
    const fakeSource = "// 此前字面量 '#ffffff'（历史说明，不应被当作仍在用的字面量）\nconst realLiteral = '#ffffff';\nconst shadow = 'rgba(15, 23, 42, .14)';";
    const fakeCode = stripComments(fakeSource);
    expect(fakeCode).toMatch(/#[\da-f]{3,8}\b/iu);
    expect(fakeCode).toMatch(/rgba?\(\s*\d/iu);
  });
});
