import { beforeEach, describe, expect, it } from 'vitest';
import { MINIMAP_COLLAPSE_STORAGE_KEY, useMinimapCollapsed } from './minimap-collapse';

/**
 * minimap-collapse.test.ts —— 小地图收起状态本地记忆。同
 * ../panels/panel-section-collapse.test.ts 的既定手法：项目未引入 @vue/test-utils，无法挂载 SFC
 * 断言真实 DOM 交互，但 useMinimapCollapsed 是不依赖组件实例的纯 composable，直接 import 调用
 * 即可覆盖真实逻辑。
 */
describe('useMinimapCollapsed（小地图收起状态本地记忆）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('从未记忆过时默认展开（collapsed=false）', () => {
    expect(useMinimapCollapsed().collapsed.value).toBe(false);
  });

  it('收起 → 模拟重新挂载（重新调用 composable）→ 状态被恢复', () => {
    const first = useMinimapCollapsed();
    expect(first.collapsed.value).toBe(false);
    first.toggle(); // 用户点击收起
    expect(first.collapsed.value).toBe(true);

    // "重新挂载"用重新调用 useMinimapCollapsed 模拟，等价于组件卸载重挂载后 setup() 重新执行。
    const remounted = useMinimapCollapsed();
    expect(remounted.collapsed.value).toBe(true);

    // 再次展开也要能被记住。
    remounted.toggle();
    const remountedAgain = useMinimapCollapsed();
    expect(remountedAgain.collapsed.value).toBe(false);
  });

  it('storage key 带插件命名空间前缀，不是裸 key（避免污染宿主/其他插件的存储空间）', () => {
    expect(MINIMAP_COLLAPSE_STORAGE_KEY).toBe('kimpo_workflow_designer_minimap_collapsed');
    useMinimapCollapsed().toggle();
    expect(localStorage.getItem(MINIMAP_COLLAPSE_STORAGE_KEY)).toBe('1');
  });

  it('与 panel-section-collapse.ts 的 key 空间互不冲突（不同前缀主体）', () => {
    expect(MINIMAP_COLLAPSE_STORAGE_KEY.startsWith('kimpo_workflow_designer_')).toBe(true);
    expect(MINIMAP_COLLAPSE_STORAGE_KEY).not.toContain('panel_section');
  });

  it('localStorage 不可用时（隐私模式等）：不抛错，退化为本次会话内存态', () => {
    const original = globalThis.localStorage;
    // @ts-expect-error 模拟 localStorage 访问抛错的降级路径（同 panel-section-collapse.ts
    // safeStorage() 的 try/catch 兜底），不是真的要求它是 undefined 类型。
    delete globalThis.localStorage;
    try {
      const state = useMinimapCollapsed();
      expect(state.collapsed.value).toBe(false);
      expect(() => state.toggle()).not.toThrow();
      expect(state.collapsed.value).toBe(true); // 内存态本身仍正常翻转，只是不落盘
    } finally {
      globalThis.localStorage = original;
    }
  });
});
