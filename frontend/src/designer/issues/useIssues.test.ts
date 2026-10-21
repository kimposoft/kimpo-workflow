/**
 * designer/issues/useIssues.test.ts —— useIssues() 组合式单测。纯 TS，
 * 不挂载任何组件（Vue 的 computed/ref 脱离组件实例也能正常工作，同本插件其余组合式测试手法，如
 * designer/panels/shared/templateFieldCatalog.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { RawDiagnostic } from '../../model/validate-map';
import { useIssues } from './useIssues';

function diag(partial: Partial<RawDiagnostic>): RawDiagnostic {
  return { code: 'NODE_CONFIG_INVALID', ...partial };
}

describe('useIssues：分组/展平/计数', () => {
  it('setFromDiagnostics 后 issues/grouped/count 按 model/validate-map.ts 的既定口径产出', () => {
    const api = useIssues();
    api.setFromDiagnostics([
      diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' }),
      diag({ code: 'LINK_SELF_LOOP', link_id: 'l1' }),
      diag({ code: 'L11', arguments: { reason: 'no_end_node' } })
    ]);

    expect(api.count.value).toBe(3);
    expect(api.grouped.value.byNode['n1']?.length).toBe(1);
    expect(api.grouped.value.byLink['l1']?.length).toBe(1);
    expect(api.grouped.value.global.length).toBe(1);
    // 展平顺序：节点 → 连线 → 全局（见 issuesLogic.test.ts 对 flattenGroupedIssues 的单测）。
    expect(api.issues.value.map((i) => i.nodeId ?? i.linkId ?? 'global')).toEqual(['n1', 'l1', 'global']);
  });

  it('countOf 按节点/连线 id 返回条数，未命中返回 0', () => {
    const api = useIssues();
    api.setFromDiagnostics([diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' }), diag({ code: 'A1_SOURCE_EMPTY', node_id: 'n1' })]);
    expect(api.countOf('n1')).toBe(2);
    expect(api.countOf('missing')).toBe(0);
  });

  it('clear 后回到空清单，游标复位', () => {
    const api = useIssues();
    api.setFromDiagnostics([diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' })]);
    api.focus(api.issues.value[0]!);
    expect(api.cursor.value).toBe(0);
    api.clear();
    expect(api.count.value).toBe(0);
    expect(api.cursor.value).toBe(-1);
  });
});

describe('useIssues：定位（focus/focusAt/next/prev）经 onFocus 回调，不直接碰画布', () => {
  it('focus 一条挂节点的问题：更新游标 + 调用 onFocus({ nodeId, tab })', () => {
    const onFocus = vi.fn();
    const api = useIssues({ onFocus });
    // A1_SOURCE_REQUIRED 登记了分区 basic（见 model/validate-map.ts CODE_TAB），onFocus 收到的
    // target 里应带上它。
    api.setFromDiagnostics([diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' })]);

    api.focus(api.issues.value[0]!);

    expect(api.cursor.value).toBe(0);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith({ nodeId: 'n1', tab: 'basic' });
  });

  it('focus 一条挂节点但未登记分区的问题：onFocus 收到的 target 里 tab 为 undefined', () => {
    const onFocus = vi.fn();
    const api = useIssues({ onFocus });
    // NODE_CONFIG_INVALID 是结构类兜底诊断，未登记分区。
    api.setFromDiagnostics([diag({ code: 'NODE_CONFIG_INVALID', node_id: 'n1' })]);

    api.focus(api.issues.value[0]!);

    expect(onFocus).toHaveBeenCalledWith({ nodeId: 'n1', tab: undefined });
  });

  it('focus 一条不挂任何目标的全局问题：游标仍更新，但不调用 onFocus', () => {
    const onFocus = vi.fn();
    const api = useIssues({ onFocus });
    api.setFromDiagnostics([diag({ code: 'L11', arguments: { reason: 'no_end_node' } })]);

    api.focus(api.issues.value[0]!);

    expect(api.cursor.value).toBe(0);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('focusAt 下标越界时忽略，不改变游标也不调用 onFocus', () => {
    const onFocus = vi.fn();
    const api = useIssues({ onFocus });
    api.setFromDiagnostics([diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' })]);

    api.focusAt(5);

    expect(api.cursor.value).toBe(-1);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('next()/prev() 在多条问题之间循环跳，越界回卷', () => {
    const onFocus = vi.fn();
    const api = useIssues({ onFocus });
    api.setFromDiagnostics([
      diag({ code: 'A1_SOURCE_REQUIRED', node_id: 'n1' }),
      diag({ code: 'A1_SOURCE_EMPTY', node_id: 'n2' }),
      diag({ code: 'LINK_SELF_LOOP', link_id: 'l1' })
    ]);

    api.next();
    expect(api.cursor.value).toBe(0);
    api.next();
    expect(api.cursor.value).toBe(1);
    api.next();
    expect(api.cursor.value).toBe(2);
    api.next(); // 回卷到第 0 条
    expect(api.cursor.value).toBe(0);

    api.prev(); // 从第 0 条再往前，回卷到最后一条
    expect(api.cursor.value).toBe(2);

    expect(onFocus).toHaveBeenCalledTimes(5);
    expect(onFocus).toHaveBeenNthCalledWith(3, { linkId: 'l1' });
  });

  it('清单为空时 next()/prev() 不产生任何效果', () => {
    const onFocus = vi.fn();
    const api = useIssues({ onFocus });
    api.next();
    api.prev();
    expect(api.cursor.value).toBe(-1);
    expect(onFocus).not.toHaveBeenCalled();
  });
});
