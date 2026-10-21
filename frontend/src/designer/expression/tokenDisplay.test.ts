// expression/tokenDisplay.test.ts —— parseTokenDisplay 单测：断言字段
// 引用 token 化、函数名斜体识别、纯文本回落三条规则，见 ./tokenDisplay.ts 头注释（本文件是 token 化
// 只读呈现里唯一能在不挂载 .vue 组件的前提下断言到的部分——本插件前端未装 @vue/test-utils）。
import { describe, expect, it } from 'vitest';
import type { V4ExpressionRefWire } from '@kimposoft/expression-editor';
import { countRefSegments, parseTokenDisplay } from './tokenDisplay';

const refs: V4ExpressionRefWire[] = [
  { ref_id: 'r1', kind: 'report_field', table_id: 't1', field_id: 'f1', last_label: '本报表.[采购申请单].[金额]' },
  { ref_id: 'r2', kind: 'report_field', table_id: 't1', field_id: 'f2', last_label: '本报表.[采购申请单].[单号]' }
];

describe('parseTokenDisplay：字段引用 token 化', () => {
  it('单个字段引用：解析出 1 个 ref 片段，标签取 token 里的短标签，title 取 last_label 拆出的「表 · 字段」', () => {
    const segments = parseTokenDisplay('[金额]#{r1} > 0', refs);
    expect(countRefSegments(segments)).toBe(1);
    const ref = segments.find((s) => s.kind === 'ref');
    expect(ref).toEqual({ kind: 'ref', label: '金额', refId: 'r1', title: '采购申请单 · 金额' });
    // 引用后面的运算符与数字保留为纯文本片段，不丢内容。
    const text = segments.filter((s) => s.kind !== 'ref').map((s) => (s as { value: string }).value).join('');
    expect(text).toBe(' > 0');
  });

  it('两个字段引用共同出现在同一段表达式里，各自独立解析、不串标签', () => {
    const segments = parseTokenDisplay('[单号]#{r2} = [单号]#{r2} AND [金额]#{r1} > 0', refs);
    expect(countRefSegments(segments)).toBe(3);
    const refSegs = segments.filter((s) => s.kind === 'ref') as Array<{ label: string; refId: string; title: string }>;
    expect(refSegs.map((s) => s.refId)).toEqual(['r2', 'r2', 'r1']);
    expect(refSegs[2].title).toBe('采购申请单 · 金额');
  });

  it('查不到对应 ref（refs 数组缺席该 ref_id）时兜底用 token 里的标签本身作为 title，不留空', () => {
    const segments = parseTokenDisplay('[已删除字段]#{r9}', refs);
    const ref = segments.find((s) => s.kind === 'ref');
    expect(ref).toEqual({ kind: 'ref', label: '已删除字段', refId: 'r9', title: '已删除字段' });
  });

  it('last_label 不是"本报表.[表].[字段]"形态时，title 原样退回 last_label（兜底，理论不会发生）', () => {
    const oddRefs: V4ExpressionRefWire[] = [{ ref_id: 'r1', kind: 'source_field', table_id: 't1', field_id: 'f1', last_label: '[供应商档案].[供应商编码]' }];
    const segments = parseTokenDisplay('[供应商编码]#{r1}', oddRefs);
    const ref = segments.find((s) => s.kind === 'ref');
    expect(ref).toEqual({ kind: 'ref', label: '供应商编码', refId: 'r1', title: '[供应商档案].[供应商编码]' });
  });
});

describe('parseTokenDisplay：函数名斜体识别', () => {
  it('标识符紧跟左括号识别为函数调用，独立成 func 片段；括号本身留在其后的文本片段里', () => {
    const segments = parseTokenDisplay('UPPER([单号]#{r2})', refs);
    expect(segments[0]).toEqual({ kind: 'func', value: 'UPPER' });
    expect(segments[1].kind).toBe('text');
    expect((segments[1] as { value: string }).value).toBe('(');
    expect(segments[2]).toMatchObject({ kind: 'ref', refId: 'r2' });
    expect(segments[3]).toEqual({ kind: 'text', value: ')' });
  });

  it('标识符后没有左括号（不是函数调用）时保持普通文本，不勉强斜体', () => {
    const segments = parseTokenDisplay('AND OR NOT', refs);
    expect(segments.every((s) => s.kind === 'text')).toBe(true);
  });

  it('函数名允许标识符与左括号之间有空白（如 IF (...)）', () => {
    const segments = parseTokenDisplay('IF (1)', refs);
    expect(segments[0]).toEqual({ kind: 'func', value: 'IF' });
  });
});

describe('parseTokenDisplay：空态与纯文本回落', () => {
  it('空字符串返回空数组（调用方按空态渲染"未设置"占位，不在本函数里拼中文）', () => {
    expect(parseTokenDisplay('', refs)).toEqual([]);
  });

  it('不含任何 token 标记的纯字面量表达式，整体解析为一个 text 片段', () => {
    const segments = parseTokenDisplay("'启用'", refs);
    expect(segments).toEqual([{ kind: 'text', value: "'启用'" }]);
  });
});
