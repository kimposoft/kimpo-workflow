/**
 * designer-shell-locale-keys.static.test.ts —— 设计器壳（DesignerRoot + shell/ 目录下各组件）里
 * 出现的 i18n key 字面量，逐一核对 zh-CN.json 是否真的登记了。
 *
 * 🔴 本文件的 FILES 是**硬编码清单**，不是按目录扫描——shell/ 目录下新增任何一个 .vue 组件，
 * 都要同步加进下面的 FILES 数组，不能假设"放对目录就自动生效"。
 *
 * 只扫字面量 key（`.t('workflow.designer....')`），动态拼接的 key（DesignerRoot.vue 里
 * `workflow.designer.link.reject.${result.reason}` 这一处）正则抓不到字符串常量，单独在下面
 * 按 AddLinkRejectReason 的五种取值逐条核对。locale-parity.test.ts 已经保证四份语言文件 key
 * 集合彼此一致，这里只需要核对 zh-CN 一份，不需要对四份都重复同一件事。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '../../locales/zh-CN.json';

const FILES = [
  'src/designer/DesignerRoot.vue',
  'src/designer/shell/TopBar.vue',
  'src/designer/shell/IssuesBadge.vue',
  'src/designer/shell/PropsPanel.vue',
  // 属性面板浮动外壳（拖动把手/钉住/收起三个按钮的提示文案）。
  'src/designer/shell/FloatingPropsPanel.vue',
  // 画布工具栏（撤销/重做/缩放/网格/吸附/参考线/对齐/分布/小地图）。
  'src/designer/shell/CanvasToolbar.vue',
  // 底部状态栏（检查项计数/节点连线数/保存状态/缩放/全屏）。
  'src/designer/shell/DesignerStatusBar.vue',
  // 检查项清单条（见 issues/IssuesBar.vue 头注释）。
  'src/designer/issues/IssuesBar.vue'
];

function extractLiteralKeys(sourceText: string): string[] {
  const keys: string[] = [];
  const re = /\.t\(\s*'([a-zA-Z0-9_.]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sourceText))) keys.push(match[1]);
  return keys;
}

describe('设计器壳组件里的 i18n key 字面量在 zh-CN.json 里都存在', () => {
  for (const file of FILES) {
    it(file, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      const keys = extractLiteralKeys(source);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
      }
    });
  }

  it('workflow.designer.link.reject.<reason>：DesignerRoot.onConnect 用模板字符串拼接 key，正则抓不到，逐个 reason 核对', () => {
    // 与 model/document-state.ts AddLinkRejectReason 的取值集合保持一致。
    const reasons = ['unknownEndpoint', 'selfLoop', 'duplicate', 'intoStart', 'outOfEnd'];
    for (const reason of reasons) {
      const key = `workflow.designer.link.reject.${reason}`;
      expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
    }
  });
});
