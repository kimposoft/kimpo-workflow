/**
 * expression/V4ExpressionField.static.test.ts —— V4ExpressionField.vue（token 化只读呈现）的接线
 * 静态守护，手法同 ../DesignerRoot.wiring.static.test.ts："对源码文本做结构化断言"：
 * 本插件前端未装 @vue/test-utils，组件级挂载测试（禁用态渲染 / 点击触发事件 / 弹窗真实打开）
 * 做不了；能在不挂载组件的前提下断得清楚的解析逻辑已抽进 ./tokenDisplay.ts 走真实
 * 单测（见 tokenDisplay.test.ts），本文件只覆盖"接线对不对"这一层：
 *   - 清空按钮点击必须触发 emit('update:modelValue', undefined)（不是 null，也不是留空不 emit）；
 *   - 编辑入口（按钮 + token 区）的可用性必须绑定同一个 effectiveDisabled；
 *   - restore 失败（catch 分支）必须回落 doc.expression.source_text，displayText/tokenText 两个
 *     都要回落，不能只回落其中一个（tokenText 缺回落会导致失败态下 token 区渲染不出任何内容）；
 *   - data-testid="v4field-edit"/"v4field-clear" 两个 e2e 选择器必须原样保留（e2e 依赖这两个名字）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/designer/expression/V4ExpressionField.vue'), 'utf8');
const scriptSetup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';

function fnBody(name: string): string {
  const re = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`);
  return scriptSetup.match(re)?.[1] ?? '';
}

describe('V4ExpressionField：清空/编辑接线', () => {
  it('clearValue 触发 update:modelValue(undefined)，且被 props.disabled 短路', () => {
    const body = fnBody('clearValue');
    expect(body).toContain("emit('update:modelValue', undefined)");
    expect(body).toContain('if (props.disabled) return');
  });

  it('openEdit 与 onBoxActivate 共用同一入口：token 区点击/键盘激活即等价于点「编辑」', () => {
    expect(fnBody('onBoxActivate')).toContain('openEdit()');
    expect(fnBody('openEdit')).toContain('if (effectiveDisabled.value) return');
  });

  it('两个 e2e 选择器原样保留', () => {
    expect(source).toContain('data-testid="v4field-edit"');
    expect(source).toContain('data-testid="v4field-clear"');
  });

  it('编辑按钮与 token 区都绑定 effectiveDisabled（不是两套各写各的判断）', () => {
    // NButton 编辑按钮：:disabled="effectiveDisabled"
    expect(source).toMatch(/data-testid="v4field-edit"[\s\S]*?:disabled="effectiveDisabled"/);
    // token 区：:aria-disabled="effectiveDisabled"（disabled 态下不可 tab 聚焦、点击短路见 openEdit）
    expect(source).toContain(':aria-disabled="effectiveDisabled"');
  });

  it('清空按钮绑定的是外部 disabled（不是 effectiveDisabled）——模板未发布但已有值时仍可清空', () => {
    expect(source).toMatch(/data-testid="v4field-clear"[\s\S]*?:disabled="disabled"/);
  });
});

describe('V4ExpressionField：restore 失败/未就绪回落', () => {
  it('v4Host 未就绪分支：displayText 与 tokenText 都回落 source_text', () => {
    const watchBody = scriptSetup.match(/watch\(\s*\[\(\) => props\.modelValue, v4Host\],([\s\S]*?)\{ immediate: true \}\s*\);/)?.[1] ?? '';
    // 未就绪分支（!h）与 catch 分支都各自出现两行回落赋值。
    const fallbackAssignments = watchBody.match(/(?:displayText|tokenText)\.value = doc\.expression\.source_text;/g) ?? [];
    expect(fallbackAssignments.length).toBe(4); // 未就绪分支 2 行 + catch 分支 2 行
  });

  it('restore 成功分支：tokenText 优先取刷新过标签的 res.text，兜底 source_text', () => {
    expect(scriptSetup).toContain('tokenText.value = res.text || doc.expression.source_text;');
  });
});

describe('V4ExpressionField：token 化渲染接线', () => {
  it('segments 计算属性喂给 tokenDisplay.ts 的 parseTokenDisplay，入参含当前文档 refs', () => {
    expect(scriptSetup).toContain('parseTokenDisplay(text, doc.expression.refs as V4ExpressionRefWire[])');
  });

  it('模板按片段种类分流渲染：ref 主色 token / func 斜体 / 其余纯文本', () => {
    expect(source).toContain("seg.kind === 'ref'");
    expect(source).toContain('class="v4field__token"');
    expect(source).toContain("seg.kind === 'func'");
    expect(source).toContain('class="v4field__func"');
  });

  it('空态（无 modelValue 或片段为空）渲染 placeholder/未设置文案', () => {
    expect(source).toContain('class="v4field__placeholder"');
    expect(source).toContain("placeholder || i18n.t('workflow.designer.expr.unset')");
  });

  it('purpose 可选 prop 透传给弹窗，且不改变既有必填 props 形状', () => {
    expect(scriptSetup).toContain('purpose?: string;');
    expect(source).toContain(':purpose="purpose"');
  });
});
