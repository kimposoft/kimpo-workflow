/**
 * panels/shared/RelationFilterCard.test.ts —— 『再缩小范围』卡组件测试：回显（勾选态）、切换写回、全部取消写回 undefined
 * （不是空数组）、只读禁用、五档胶囊按固定顺序渲染。挂载手法同 ./NotifyCard.test.ts（真实
 * createApp 挂载，本插件前端未装 @vue/test-utils）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../../model/defaults';
import type { AssigneeRelation } from '../../../model';
import RelationFilterCard from './RelationFilterCard.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from '../panel-test-helpers';

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await nextTick();
}

let mounted: MountedPanel<typeof RelationFilterCard> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountCard(
  value: AssigneeRelation[] | undefined,
  opts: { readOnly?: boolean; onUpdate?: (v: AssigneeRelation[] | undefined) => void } = {}
): MountedPanel<typeof RelationFilterCard> {
  const doc = createDefaultDocument('测试流程');
  return mountPanel(
    RelationFilterCard,
    { modelValue: value, readOnly: opts.readOnly ?? false, 'onUpdate:modelValue': opts.onUpdate },
    { host: fakeHost(), state: fakeState(doc), i18n: fakeI18n() }
  );
}

describe('RelationFilterCard：渲染', () => {
  it('标题「再缩小范围」+ 小标签「与上一步处理人的关系」+ 帮助语 + 五档胶囊按固定顺序渲染', async () => {
    mounted = mountCard(undefined);
    await flush();
    const text = mounted.el.textContent ?? '';
    expect(text).toContain('再缩小范围');
    expect(text).toContain('与上一步处理人的关系');
    expect(text).toContain('不是一种来源');
    for (const relation of ['same_department', 'parent_department', 'child_department', 'department_manager', 'parent_department_manager']) {
      expect(mounted.el.querySelector(`[data-testid="relation-filter-${relation}"]`), `应渲染 relation-filter-${relation}`).toBeTruthy();
    }
  });
});

describe('RelationFilterCard：回显', () => {
  it('modelValue 为 undefined：五档均未勾选', async () => {
    mounted = mountCard(undefined);
    await flush();
    for (const relation of ['same_department', 'parent_department', 'child_department', 'department_manager', 'parent_department_manager']) {
      expect((mounted.el.querySelector(`[data-testid="relation-filter-${relation}"]`) as HTMLElement).getAttribute('aria-checked')).toBe('false');
    }
  });

  it('modelValue 已配置若干档：对应胶囊回显选中态，其余未选中', async () => {
    mounted = mountCard(['same_department', 'department_manager']);
    await flush();
    expect((mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect((mounted.el.querySelector('[data-testid="relation-filter-department_manager"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect((mounted.el.querySelector('[data-testid="relation-filter-child_department"]') as HTMLElement).getAttribute('aria-checked')).toBe('false');
  });
});

describe('RelationFilterCard：切换写回', () => {
  it('未勾选时点击：写回含该档的新数组', async () => {
    let emitted: AssigneeRelation[] | undefined;
    mounted = mountCard(undefined, { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual(['same_department']);
  });

  it('已勾选一档、再勾选另一档：写回两档', async () => {
    let emitted: AssigneeRelation[] | undefined;
    mounted = mountCard(['same_department'], { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="relation-filter-child_department"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual(['same_department', 'child_department']);
  });

  it('取消最后一档已勾选的关系：写回 undefined（不是空数组，保持文档干净）', async () => {
    let emitted: AssigneeRelation[] | undefined | 'not-called' = 'not-called';
    mounted = mountCard(['same_department'], { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).click();
    await flush();
    expect(emitted).toBeUndefined();
  });

  it('已勾选两档，取消其中一档：写回剩下那一档（不是 undefined，仍有其它档选中）', async () => {
    let emitted: AssigneeRelation[] | undefined;
    mounted = mountCard(['same_department', 'child_department'], { onUpdate: (v) => { emitted = v; } });
    await flush();
    (mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement).click();
    await flush();
    expect(emitted).toEqual(['child_department']);
  });
});

describe('RelationFilterCard：只读禁用', () => {
  it('只读态：胶囊 aria-disabled，点击不产生写操作', async () => {
    let emitted: AssigneeRelation[] | undefined | 'not-called' = 'not-called';
    mounted = mountCard(undefined, { readOnly: true, onUpdate: (v) => { emitted = v; } });
    await flush();
    const pill = mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement;
    expect(pill.getAttribute('aria-disabled')).toBe('true');
    pill.click();
    await flush();
    expect(emitted).toBe('not-called');
  });
});
