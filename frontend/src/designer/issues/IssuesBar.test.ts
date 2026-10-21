/**
 * designer/issues/IssuesBar.test.ts —— IssuesBar.vue 真实挂载单测。
 * 覆盖：空态文案 / 按分区展示 + {node} 占位求值 / 点具体一条触发定位并 emit 'picked' / 上一条·
 * 下一条按钮循环翻页且不 emit 'picked'（见组件头注释"可以连续翻看"）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNodeView } from '../../graph';
import type { RawDiagnostic } from '../../model/validate-map';
import IssuesBar from './IssuesBar.vue';
import { fakeI18n, mountWithIssues, type MountedWithIssues } from './issuesMountHelpers';

function diag(partial: Partial<RawDiagnostic>): RawDiagnostic {
  return { code: 'NODE_CONFIG_INVALID', ...partial };
}

function sampleNodes(): GraphNodeView[] {
  return [
    { id: 'n1', type: 'handle', label: '办理 1', position: { x: 0, y: 0 } },
    { id: 'n2', type: 'approve', label: '审批节点 2', position: { x: 200, y: 0 } }
  ];
}

let mounted: MountedWithIssues | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('IssuesBar：空态', () => {
  it('没有诊断时显示空态文案，上一条/下一条按钮禁用', () => {
    mounted = mountWithIssues(IssuesBar, { i18n: fakeI18n(), nodes: sampleNodes() });
    const empty = mounted.el.querySelector('[data-testid="workflow-issues-empty"]');
    expect(empty?.textContent).toContain('没有需要处理的问题');
    const prevBtn = mounted.el.querySelector('[data-testid="workflow-issues-prev"]') as HTMLButtonElement;
    const nextBtn = mounted.el.querySelector('[data-testid="workflow-issues-next"]') as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(true);
  });
});

describe('IssuesBar：按分区展示 + {node} 占位求值', () => {
  it('挂节点的问题解出真实节点展示名，按节点 → 连线 → 全局分区展示', async () => {
    mounted = mountWithIssues(IssuesBar, { i18n: fakeI18n(), nodes: sampleNodes() });
    mounted.issuesApi.setFromDiagnostics([
      diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' }),
      diag({ code: 'LINK_SELF_LOOP', link_id: 'l1' }),
      diag({ code: 'L11', arguments: { reason: 'no_end_node' } })
    ]);
    // setFromDiagnostics 只改响应式状态，DOM 更新是异步的（Vue 的既定行为），这里等一轮 Vue
    // 的更新队列落定再断言渲染结果（同下面几个 describe 里 await new Promise(setTimeout) 的
    // 既定手法，本文件不引入 nextTick 依赖是因为 Vue 已经是本文件的既有 import）。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mounted.el.textContent).toContain('共 3 项需要处理');
    // A1_SOURCE_REQUIRED 文案模板含 {node} 占位，应替换成"办理 1"（sampleNodes 里 n1 的 label）。
    expect(mounted.el.textContent).toContain('「办理 1」还没有配置办理人来源');
    expect(mounted.el.querySelector('[data-testid="workflow-issues-item-0"]')).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="workflow-issues-item-1"]')).toBeTruthy();
    expect(mounted.el.querySelector('[data-testid="workflow-issues-item-2"]')).toBeTruthy();
  });
});

describe('IssuesBar：点具体一条', () => {
  it('点击某一条：issuesApi.focusAt 定位到对应目标，并 emit picked（createApp 根组件 props 里的 onPicked 等价于模板 @picked 监听）', async () => {
    const onFocus = vi.fn();
    const onPicked = vi.fn();
    mounted = mountWithIssues(IssuesBar, { i18n: fakeI18n(), nodes: sampleNodes(), onPicked }, { onFocus });
    mounted.issuesApi.setFromDiagnostics([diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' })]);
    await new Promise((r) => setTimeout(r, 0));

    const item = mounted.el.querySelector('[data-testid="workflow-issues-item-0"]') as HTMLButtonElement;
    expect(item).toBeTruthy();
    item.dispatchEvent(new Event('click', { bubbles: true }));

    // A1_SOURCE_REQUIRED 登记了分区 basic（model/validate-map.ts CODE_TAB），tab 随 target 一起
    // 流到 onFocus——这是 useIssues 的可选字段透传，不是 IssuesBar.vue 自身的行为。
    expect(onFocus).toHaveBeenCalledWith({ nodeId: 'n1', tab: 'basic' });
    expect(mounted.issuesApi.cursor.value).toBe(0);
    expect(onPicked).toHaveBeenCalledTimes(1);
  });
});

describe('IssuesBar：上一条 / 下一条循环翻页', () => {
  it('下一条：从第 0 条开始，依次前进并回卷，且不 emit picked（允许连续翻看）', async () => {
    const onFocus = vi.fn();
    const onPicked = vi.fn();
    mounted = mountWithIssues(IssuesBar, { i18n: fakeI18n(), nodes: sampleNodes(), onPicked }, { onFocus });
    mounted.issuesApi.setFromDiagnostics([
      diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' }),
      diag({ code: 'A1_SOURCE_EMPTY', node_id: 'n2' })
    ]);
    await new Promise((r) => setTimeout(r, 0));

    const nextBtn = mounted.el.querySelector('[data-testid="workflow-issues-next"]') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);

    nextBtn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(mounted.issuesApi.cursor.value).toBe(0);
    nextBtn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(mounted.issuesApi.cursor.value).toBe(1);
    nextBtn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(mounted.issuesApi.cursor.value).toBe(0); // 回卷

    expect(onFocus).toHaveBeenCalledTimes(3);
    expect(onPicked).not.toHaveBeenCalled();
  });
});
