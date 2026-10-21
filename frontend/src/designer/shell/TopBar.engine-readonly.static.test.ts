/**
 * shell/TopBar.engine-readonly.static.test.ts —— 顶栏只读原因区分。
 *
 * 绑定的流程引擎不可用时设计器只读挂载，顶栏若一律显示「该流程正由他人编辑，当前只读」，会与宿主横幅
 * 「绑定的流程引擎不可用」互相矛盾。断言：TopBar 按 engineUnavailable 选文案键；DesignerRoot 把引擎能力
 * 收窄结果（engineRestrictions.unavailable）传给 TopBar；四语都有新键。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('TopBar 只读原因：引擎不可用 vs 他人编辑', () => {
  it('TopBar 按 engineUnavailable 选择文案键', () => {
    const src = read('src/designer/shell/TopBar.vue');
    expect(src).toContain('engineUnavailable?: boolean');
    expect(src).toMatch(/engineUnavailable \? 'workflow\.designer\.topbar\.readOnlyEngineUnavailable' : 'workflow\.designer\.topbar\.readOnlyNotice'/);
  });
  it('DesignerRoot 把引擎不可用传给 TopBar', () => {
    expect(read('src/designer/DesignerRoot.vue')).toContain(':engine-unavailable="engineRestrictions.unavailable"');
  });
  it('四语都有引擎不可用只读文案', () => {
    for (const l of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP']) {
      const m = JSON.parse(read(`locales/${l}.json`)) as Record<string, string>;
      expect(m['workflow.designer.topbar.readOnlyEngineUnavailable'], l).toBeTruthy();
    }
  });
});
