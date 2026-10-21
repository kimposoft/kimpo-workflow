/**
 * panels/panels-locale-keys.static.test.ts —— 属性面板/表达式字段组件里的 i18n key 字面量，
 * 逐一核对 zh-CN.json 是否登记了（同 designer-shell-locale-keys.static.test.ts 的检查手法）。
 *
 * 动态拼接的 key（如 `workflow.designer.assignee.relation.${r}`）正则抓不到字符串常量，单独在
 * 下面按枚举值逐个核对，同既有测试对 AddLinkRejectReason 的处理方式。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '../../../locales/zh-CN.json';
import { RELATION_OPTIONS } from './shared/assigneeSource';

const FILES = [
  'src/designer/panels/HandlePanel.vue',
  'src/designer/panels/EdgePanel.vue',
  'src/designer/panels/shared/AssigneeSourceList.vue',
  'src/designer/expression/V4ExpressionField.vue',
  'src/designer/expression/V4ExpressionEditDialog.vue',
  // 审批/抄送/子流程三类节点的属性面板。
  'src/designer/panels/ApprovePanel.vue',
  'src/designer/panels/CcPanel.vue',
  'src/designer/panels/SubflowPanel.vue',
  // 审批按钮面板内就地编辑清单。
  'src/designer/panels/shared/ApprovalButtonList.vue',
  // 字段权限设置弹窗。
  'src/designer/panels/dialogs/FieldPermissionDialog.vue',
  // 属性面板公共头部（节点类型徽标+节点名+就地改名）。
  // 注：PanelTabs.vue 未加入本清单——它不做任何 `.t('...')` 字面量调用（分区显示文案由调用方
  // 经 tabs prop 传入的已本地化字符串提供，本组件纯展示），加入会让下面
  // `expect(keys.length).toBeGreaterThan(0)` 这条断言恒假红，因此按"文件里确有字面量 key
  // 才登记"的口径不收录；usePanelHost.ts 同理（只是注入桥接 composable，不含任何 i18n key）。
  'src/designer/panels/PanelHeader.vue',
  // 通知渠道三档竖排勾选清单（供 CcPanel.vue 与节点级通知卡 shared/NotifyCard.vue 共用），直接
  // 调用 i18n.t() 字面量（渠道名/不可用提示/服务未配置标签/帮助文案，沿用 workflow.designer.cc.*
  // 前缀键）。shared/NotifyCard.vue 本身不加入——同 PanelSection.vue/PanelTabs.vue，它是纯结构
  // 组件，业务文案经 props 传入，不做任何 `.t('...')` 字面量调用。
  'src/designer/panels/shared/NotifyChannelList.vue',
  // 『再缩小范围』卡（办理/审批/抄送三类节点共用），直接 inject i18n 调用字面量 key（标题/
  // 小标签/帮助语，同 NotifyChannelList.vue）。
  'src/designer/panels/shared/RelationFilterCard.vue'
];

function extractLiteralKeys(sourceText: string): string[] {
  const keys: string[] = [];
  const re = /\.t\(\s*'([a-zA-Z0-9_.]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sourceText))) keys.push(match[1]);
  return keys;
}

describe('属性面板/表达式字段组件里的 i18n key 字面量在 zh-CN.json 里都存在', () => {
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

  it('workflow.designer.assignee.relation.<relation>：shared/RelationFilterCard.vue 用模板字符串拼接 key，逐档核对', () => {
    for (const relation of RELATION_OPTIONS) {
      const key = `workflow.designer.assignee.relation.${relation}`;
      expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
    }
  });

  it('workflow.designer.assignee.pick{User,Role,Department}：先赋值给变量再传给 .t()，正则抓不到，逐个核对', () => {
    for (const key of ['workflow.designer.assignee.pickUser', 'workflow.designer.assignee.pickRole', 'workflow.designer.assignee.pickDepartment']) {
      expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
    }
  });
});
