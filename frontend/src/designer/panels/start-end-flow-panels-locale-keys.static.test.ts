/**
 * start-end-flow-panels-locale-keys.static.test.ts —— 发起 / 结束面板及其共享子组件
 * 里出现的 i18n key 字面量，逐一核对 zh-CN.json 是否真的登记了。
 *
 * 文件名里的"flow"指已移除的流程属性面板（属性面板改浮层后，未选中任何项时不再显示"流程属性"），
 * 清单中已不含该文件。其余设计器面板的 key 核对见 designer/designer-shell-locale-keys.static.test.ts。
 *
 * locale-parity.test.ts 已经保证四份语言文件 key 集合彼此一致，这里只需要核对 zh-CN 一份。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '../../../locales/zh-CN.json';

const FILES = [
  'src/designer/panels/PanelSection.vue',
  'src/designer/panels/StartPanel.vue',
  'src/designer/panels/EndPanel.vue',
  'src/designer/panels/shared/MainFieldSelect.vue',
  'src/designer/panels/shared/OrgTriLine.vue',
  'src/designer/panels/shared/FieldPermissionSummary.vue'
];

function extractLiteralKeys(sourceText: string): string[] {
  const keys: string[] = [];
  const re = /\.t\(\s*'([a-zA-Z0-9_.]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sourceText))) keys.push(match[1]);
  return keys;
}

describe('发起/结束面板里的 i18n key 字面量在 zh-CN.json 里都存在', () => {
  for (const file of FILES) {
    it(file, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      const keys = extractLiteralKeys(source);
      // PanelSection.vue 是纯结构组件（标题/说明经 props 传入已翻译好的文本，自身不持有任何
      // i18n key），本就该扫出 0 个字面量——只对 StartPanel/EndPanel/三个 shared 子组件这几个
      // "真正拼 i18n key"的文件断言"至少有一个"，避免这条断言反而掩盖了漏扫的情况。
      if (file !== 'src/designer/panels/PanelSection.vue') {
        expect(keys.length).toBeGreaterThan(0);
      }
      for (const key of keys) {
        expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
      }
    });
  }

  it('PanelSection.vue 本身确实不含任何 i18n key 字面量（结构组件，文本经 props 传入）', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/designer/panels/PanelSection.vue'), 'utf8');
    expect(extractLiteralKeys(source)).toEqual([]);
  });
});
