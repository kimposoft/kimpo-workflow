/**
 * model/validate-map.backend-parity.static.test.ts —— 前端诊断码登记表（KNOWN_DIAGNOSTIC_CODES）
 * 与插件后端实际产码的对拍静态测试。
 *
 * 判据方向：**后端产码集合 ⊆ 前端登记表**。后端多一个码前端没登记 → 红（业务设计者会看到发布
 * 拒绝原因走兜底文案"流程配置有问题"，丢失具体指引）；前端比后端多登记几个"历史上产过、现在
 * 不产了"的幽灵码（如 D_RATIO_UNSUPPORTED）→ 不算错，本测试只在断言失败信息里列出来供人工
 * 核对，不拦这个方向。
 *
 * 扫描口径（静态断言扫的是整份文件文本，连注释也算——正则必须只认真正会落成 Diagnostic.Code
 * 的调用语法，不能认注释里出现的裸码名）：
 *   1. 先剥离 Go 源码的 `//` 行注释与 `/* … *\/` 块注释；
 *   2. 只认两种真正会产码的写法：
 *      a) `model.NewDiagnostic("XXX_YYY", ...)`——字面量直传，绝大多数调用点；
 *      b) `NewDiagnostic(someIdent, ...)` + 同文件内 `someIdent = "XXX_YYY"` 的字符串常量
 *         间接引用——internal/compile/fieldtype.go 的 `fieldTypeUnsupportedCode` 这一处
 *         （`const fieldTypeUnsupportedCode = "FIELD_TYPE_UNSUPPORTED"`）。
 * 只扫 internal/node/ 与 internal/compile/ 两个目录（诊断码的权威产地，见 validate-map.ts
 * 文件头引用），且排除 `_test.go`。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_DIAGNOSTIC_CODES } from './validate-map';

/** 剥离 Go 源码里的行注释与块注释（不追求 Go 词法级精确——本文件只用来防"注释里的裸码名"
 * 误伤成"产码"，字符串字面量内部出现 `//`/`/* ` 这类极端情况在诊断码扫描场景不会发生）。 */
function stripGoComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** 扫描一个目录下全部非测试 .go 文件，收集后端实际会产出的诊断 code 集合。 */
function collectBackendCodes(dir: string): Set<string> {
  const codes = new Set<string>();
  const files = readdirSync(dir).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
  for (const file of files) {
    const raw = stripGoComments(readFileSync(resolve(dir, file), 'utf8'));

    // 先收集本文件内"形如诊断码的字符串常量"：IDENT = "SCREAMING_SNAKE"（含 := 短声明）。
    const constCodes = new Map<string, string>();
    const constRe = /(\w+)\s*:?=\s*"([A-Z][A-Z0-9_]*)"/g;
    let cm: RegExpExecArray | null;
    while ((cm = constRe.exec(raw))) constCodes.set(cm[1], cm[2]);

    // 再扫真正的调用点：NewDiagnostic(<第一实参>, ...)，第一实参要么是字面量，要么是上面收集
    // 到的字符串常量标识符。
    const callRe = /NewDiagnostic\(\s*(?:"([A-Z][A-Z0-9_]*)"|(\w+))\s*,/g;
    let call: RegExpExecArray | null;
    while ((call = callRe.exec(raw))) {
      const literal = call[1];
      const ident = call[2];
      if (literal) codes.add(literal);
      else if (ident && constCodes.has(ident)) codes.add(constCodes.get(ident)!);
    }
  }
  return codes;
}

describe('后端诊断码 ⊆ 前端 KNOWN_DIAGNOSTIC_CODES', () => {
  it('internal/node + internal/compile 实际会产出的 code 全部已在前端登记表', () => {
    const backendCodes = new Set<string>([
      ...collectBackendCodes(resolve(process.cwd(), '../internal/node')),
      ...collectBackendCodes(resolve(process.cwd(), '../internal/compile'))
    ]);

    // 扫描本身要先自证有效——若这个数字塌成 0，说明正则或路径失效，红比"假绿"更安全。
    expect(backendCodes.size).toBeGreaterThan(20);

    const known = new Set<string>(KNOWN_DIAGNOSTIC_CODES);
    const missing = [...backendCodes].filter((c) => !known.has(c)).sort();
    expect(missing, `前端漏登记的后端码：${missing.join(', ')}`).toEqual([]);

    // 反向：前端比后端多登记的码（历史幽灵码），允许存在，只打印供人工核对，不拦红。
    const extra = [...known].filter((c) => !backendCodes.has(c)).sort();
    if (extra.length > 0) {
      console.log('[validate-map.backend-parity] 前端多登记、后端当前不产的码：', extra.join(', '));
    }
  });
});
