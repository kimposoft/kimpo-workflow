/**
 * expression/tokenDisplay.ts —— 把「V4 表达式」的 token 化源码解析成可渲染的展示片段：
 * 字段引用 token 化（主色小块）+ 函数名识别（斜体）+ 普通文本三类片段，供 V4ExpressionField.vue 只读呈现消费。
 *
 * 抽成独立纯函数文件（不写进 .vue 组件内联 computed）的原因：本插件前端未装 @vue/test-utils，
 * 组件级挂载测试做不了；把解析逻辑抽成零 DOM 依赖的纯函数，可以在不挂载组件的前提下把"token 个数与文本 / 函数斜体
 * 识别 / 空文本"这几条断言清楚，.vue 组件只负责调用与渲染，双方各司其职。
 *
 * 解析依据：@kimposoft/expression-editor 的 V4ExpressionDocument.source_text 头注释——字段引用一律
 * 是 `[标签]#{rN}` 组合形态（标签内不出现 `]`，tokenize 侧保证），rN 即 refs[].ref_id；本文件不
 * 需要经 v4Host.restore 才能识别 token 边界——不管是刚保存的 source_text 还是 restore 刷新过
 * 标签的 token 形态（V4RestoreResponse.text），两者都满足这个形态，可以用同一份解析器处理
 * （调用方决定喂哪一份文本，见 V4ExpressionField.vue）。
 */
import type { V4ExpressionRefWire } from '@kimposoft/expression-editor';

/** 一个展示片段：普通文本 / 识别出的函数名（渲染为斜体）/ 字段引用（渲染为主色 token）。 */
export type DisplaySegment =
  | { kind: 'text'; value: string }
  | { kind: 'func'; value: string }
  | { kind: 'ref'; label: string; refId: string; title: string };

/** 字段引用 token 的形态：`[标签]#{rN}`。 */
const REF_TOKEN_RE = /\[([^\]]*)\]#\{(r\d+)\}/g;

/** 函数调用识别：标识符紧跟 `(`（中间允许空白）视为函数名——识别不出（纯字面量/运算符/中文
 *  文案等）就原样当文本，不勉强斜体。 */
const FUNC_CALL_RE = /[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/g;

/**
 * 按 ref_id 在 refs 里找到对应的稳定引用，取 last_label 拼一个人类可读的「所属表 · 字段」提示
 * （供 title 属性）。本组件恒主表作用域（见 ./v4Scope.ts），refs[].kind 恒 'report_field'，
 * last_label 形如 `本报表.[表名].[字段名]`（V4RestoreResponse.readable_text 头注释同款格式）；
 * 形态不符（理论上不会发生，兜底）时原样把 last_label 当提示；查不到该 ref（理论上不会发生，
 * 稳定引用与 refs 数组本应一一对应）时退回 token 里的标签本身，不留空提示。
 */
function refTitle(label: string, refId: string, refs: V4ExpressionRefWire[]): string {
  const ref = refs.find((r) => r.ref_id === refId);
  if (!ref) return label;
  const m = /^本报表\.\[([^\]]+)\]\.\[([^\]]+)\]$/.exec(ref.last_label);
  if (m) return `${m[1]} · ${m[2]}`;
  return ref.last_label || label;
}

/** 把一段不含引用 token 的纯文本进一步拆成「函数名 / 普通文本」两类片段。 */
function splitFuncSegments(text: string): DisplaySegment[] {
  if (!text) return [];
  const out: DisplaySegment[] = [];
  let last = 0;
  FUNC_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_CALL_RE.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    out.push({ kind: 'func', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/**
 * 解析 token 化源码为展示片段数组。text 为空串返回空数组（调用方按空态处理，拼「未设置」文案——
 * 本文件不持有 i18n，不在这里拼中文提示）。
 */
export function parseTokenDisplay(text: string, refs: V4ExpressionRefWire[]): DisplaySegment[] {
  if (!text) return [];
  const out: DisplaySegment[] = [];
  let last = 0;
  REF_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_TOKEN_RE.exec(text))) {
    if (m.index > last) out.push(...splitFuncSegments(text.slice(last, m.index)));
    out.push({ kind: 'ref', label: m[1], refId: m[2], title: refTitle(m[1], m[2], refs) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...splitFuncSegments(text.slice(last)));
  return out;
}

/** 展示片段里字段引用 token 的个数（供组件/测试快速取"引了几个字段"）。 */
export function countRefSegments(segments: DisplaySegment[]): number {
  return segments.filter((s) => s.kind === 'ref').length;
}
