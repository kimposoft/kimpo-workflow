/**
 * designer/canvas/minimap-collapse.ts —— 小地图收起态本地记忆（小地图可收起成 28px
 * 胶囊，收起状态本地记忆）。
 *
 * 不复用 ../panels/panel-section-collapse.ts 的 usePanelSectionOpen：那个 composable 按
 * "(节点类型, 小节标识)" 两维记忆节点属性面板内 <details> 小节的展开态（见其头注释"记忆维度：
 * 节点类型 + 小节标识"），语义前提是"同一小节在不同节点类型面板里各自独立记忆"。小地图收起态
 * 是画布级别的单一全局开关，与当前选中的节点类型完全无关——套用该签名要伪造一个 nodeType
 * 参数，既不必要也会让 storage key 掺入一个恒定占位值，语义不通，因此这里不复用。
 *
 * 沿用它"localStorage key 带插件命名空间前缀 + try/catch best-effort 降级为内存态"两条既定
 * 手法另写一个更简单的版本（不裸写 localStorage key，同一前缀风格
 * `kimpo_workflow_designer_` 开头，可与 panel-section-collapse.ts 的 key 共存不冲突）。
 */
import { ref, type Ref } from 'vue';

const STORAGE_KEY = 'kimpo_workflow_designer_minimap_collapsed';

/** 导出供测试直接校验 key 值不跑偏（同 panel-section-collapse.ts panelSectionStorageKey 的
 * 既定导出手法）。 */
export const MINIMAP_COLLAPSE_STORAGE_KEY = STORAGE_KEY;

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // 隐私模式等场景下访问 localStorage 本身就可能抛错
  }
}

function readPersisted(storage: Storage | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface MinimapCollapseState {
  /** 当前是否收起；绑定到小地图容器的 class 切换。 */
  collapsed: Ref<boolean>;
  /** 折叠按钮的点击处理：翻转状态并落盘（best effort，写入失败不影响本次交互）。 */
  toggle: () => void;
}

/**
 * 模块级单例（"一处状态两处入口"）：小地图收起态有画布内嵌的折叠胶囊与工具条"小地图"按钮
 * （DesignerRoot.vue）两处入口。两处入口必须
 * 是**同一份**响应式状态而不是各自独立的 ref——否则会出现"工具条按钮显示已展开，画布里其实
 * 是收起的胶囊"这种视觉割裂（Vue 响应式联动的前提是持有同一个 Ref 对象，不是两个初值恰好相同
 * 的不同对象）。
 *
 * 单例创建后，每次调用本函数都会用当前 storage 重新校准一次 `collapsed.value`（不是只在首次
 * 创建时读一次）。这条"每次都重新校准"规则同时满足两个看似矛盾的要求：
 *   1) 真实页面内 DesignerRoot.vue 与 DesignerCanvas.vue 各自 setup() 时都会调用一次本
 *      composable，必须拿到同一个 Ref 实例才能互相联动；
 *   2) 单测（minimap-collapse.test.ts）反复调用
 *      useMinimapCollapsed() 模拟"重新挂载""localStorage 清空/不可用"等场景，每次都要求拿到
 *      当前 storage 状态的最新读数，而不是沿用第一次调用时的陈旧值——若做成"只在首次创建时读
 *      一次"的纯粹单例，会导致后一测试的 storage 前提（beforeEach 清空/删除 localStorage）
 *      读不到，看到上一个测试遗留的状态。
 * 两者用"共享同一个 Ref 对象 + 每次调用都重新校准其值"即可同时满足，不冲突——重新校准只是把
 * `.value` 设成 storage 当前值，不产生新的 Ref 对象，已经建立的响应式联动不受影响。
 */
let singleton: MinimapCollapseState | undefined;

/** 小地图收起态 composable：初值从 localStorage 读回（拿不到时默认展开，同折叠小节的既有
 * "从未记忆过时保持原有默认展示"约定），每次切换都尝试落盘。 */
export function useMinimapCollapsed(): MinimapCollapseState {
  const storage = safeStorage();
  if (!singleton) {
    const collapsed = ref(readPersisted(storage));

    function toggle(): void {
      collapsed.value = !collapsed.value;
      // 🔴 每次 toggle 都重新取一次 safeStorage()（不复用外层创建时闭包捕获的 storage）——
      // 与上面"每次调用 useMinimapCollapsed 都重新校准"同一条纪律：toggle 也应该按*当前*的
      // storage 可用性决定要不要落盘，而不是沿用单例创建那一刻的陈旧判断。
      const currentStorage = safeStorage();
      if (!currentStorage) return;
      try {
        currentStorage.setItem(STORAGE_KEY, collapsed.value ? '1' : '0');
      } catch {
        /* best effort：写入失败不影响本次交互，只是这次的收起态不会被记住，同
           panel-section-collapse.ts onToggle 既定处理 */
      }
    }

    singleton = { collapsed, toggle };
  } else {
    singleton.collapsed.value = readPersisted(storage);
  }

  return singleton;
}
