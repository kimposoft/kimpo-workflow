/**
 * panels/dialogs/FieldPermissionDialog.static.test.ts —— 字段权限弹窗的结构化静态断言：
 * 源码文本扫描，覆盖"点了下拉第几项"这类 happy-dom 环境下不可靠的交互无法
 * 用挂载测试覆盖的部分——本文件与 FieldPermissionDialog.vue 的挂载行为测试（如有）互补，不重复。
 *
 * 🔴 否定性判据涉及的字面量（如 grade 值 'edit'）不写进本文件注释，避免"扫描整份文件文本、注释
 * 也算"的坑。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/designer/panels/dialogs/FieldPermissionDialog.vue'), 'utf8');

describe('FieldPermissionDialog.vue：取数方式', () => {
  it('用共享目录取数件 useTemplateFieldCatalog，不自行另起一套字段目录请求', () => {
    expect(SOURCE).toContain('useTemplateFieldCatalog(');
  });
  it('调宿主 templateFieldRestrictions 取模板限制对照', () => {
    expect(SOURCE).toContain('host.templateFieldRestrictions(');
  });
  it('档位可选集合经 gradesFor 产出（只看型不渲染可编辑档，见其纯函数单测）', () => {
    expect(SOURCE).toContain('gradesFor(');
    // 只看型时批量「设为可编辑」按钮整体不渲染——排除渲染层面出现"选了也不会生效"的档位入口。
    expect(SOURCE).toContain('v-if="!readonlyOnly"');
  });
});

describe('FieldPermissionDialog.vue：data-testid 齐全', () => {
  const REQUIRED_TESTIDS = [
    'fpd-root',
    'fpd-search',
    'fpd-bulk-inherit',
    'fpd-bulk-readonly',
    'fpd-bulk-hidden',
    'fpd-bulk-edit',
    'fpd-retry'
  ];
  for (const testid of REQUIRED_TESTIDS) {
    it(`包含 data-testid="${testid}"`, () => {
      expect(SOURCE).toContain(testid);
    });
  }

  it('动态 data-testid 前缀齐全：表分组 / 行 / 勾选 / 档位单选 / 孤儿字段删除', () => {
    expect(SOURCE).toContain('fpd-table-${table.tableId}');
    expect(SOURCE).toContain('fpd-row-${field.fieldId}');
    expect(SOURCE).toContain('fpd-check-${field.fieldId}');
    expect(SOURCE).toContain('fpd-grade-${field.fieldId}-${grade}');
    expect(SOURCE).toContain('fpd-orphan-remove-${entry.fieldId}');
  });
});

describe('FieldPermissionDialog.vue：确定/取消/只读态语义', () => {
  it('确定按钮在 disabled 时整体不渲染（只读态可看不可改，不留一个点了也没用的按钮）', () => {
    // 只读态经 KDialogFooter 的 hideConfirm 隐藏确认，不另写按钮
    expect(SOURCE).toContain(':hide-confirm="disabled"');
  });
  it('确定写回 confirm 事件并关闭；取消 / 关闭（✕、Esc）只关闭不 emit confirm；点遮罩无动作', () => {
    expect(SOURCE).toContain("emit('confirm'");
    // 关闭走 KDialog 的 close 事件 → onCancel；不自绘遮罩，也没有遮罩点击取消
    expect(SOURCE).toContain('@close="onCancel"');
    expect(SOURCE).not.toContain('@mousedown.self');
  });
  it('页脚用 KDialogFooter（确认 / 取消按钮由 data-kdlf="confirm|cancel" 定位），不手写页脚按钮', () => {
    expect(SOURCE).toContain('<KDialogFooter');
    expect(SOURCE).not.toContain('fpd-footer-readonly');
  });
});

