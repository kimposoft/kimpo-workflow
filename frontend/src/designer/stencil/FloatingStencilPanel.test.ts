/**
 * FloatingStencilPanel.test.ts —— 节点库浮动外壳的运行时行为回归。
 *
 * floating-panel.test.ts（纯几何函数单测）与 FloatingStencilPanel.static.test.ts（对源码文本做
 * 结构化断言的静态守护）之外，本文件真实挂载组件、驱动指针事件做运行时测试，手法同 shell/FloatingPropsPanel.test.ts（真实 Vue createApp 挂载，同仓没有
 * @vue/test-utils，见其头注释）。
 *
 * 回归：拖动展开态标题栏后收起，收起态图标第一次点击没反应，必须点第二次才展开。
 *
 * 根因：beginDrag/updateDrag/endDrag 这一套指针事件同时服务"展开态标题栏"与"收起态图标"，靠
 * 松手时的累计位移 isDragGesture(dragMaxDelta) 区分"这是一次拖动"还是"这是一次点击"——但抑制
 * 标志 suppressNextClick 只有 onIconClick() 一个消费者，若 endDrag 无条件置位：拖动标题栏
 * （展开态，没有"点击展开"语义、没人消费这个标志）也会把它置为 true，残留到之后第一次点收起态
 * 图标时被吞掉。所以只在收起态（collapsed 为 true，说明这次拖的确实是那枚图标）才置位，见
 * FloatingStencilPanel.vue endDrag 处注释。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import FloatingStencilPanel from './FloatingStencilPanel.vue';
import { createDesignerI18n } from '../i18n';

let app: App | undefined;
let el: HTMLElement | undefined;

afterEach(() => {
  app?.unmount();
  el?.remove();
  app = undefined;
  el = undefined;
  localStorage.clear();
});

/**
 * happy-dom 对 PointerEvent 构造函数的支持不稳定，同仓 graph/svg-adapter.test.ts
 * firePointerEvent 既定手法：用 MouseEvent 手工挂 pointerId 代替——beginDrag/updateDrag/
 * endDrag 只读 clientX/clientY/pointerId 三个字段，MouseEvent 已含前两者。
 */
function firePointerEvent(target: EventTarget, type: string, init: { clientX: number; clientY: number; pointerId?: number }): void {
  const event = new MouseEvent(type, { clientX: init.clientX, clientY: init.clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
}

/** 交互触发的 Vue 响应式更新走多轮 microtask 才落定，同 panels/PanelHeader.test.ts flush 既定手法。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
}

describe('FloatingStencilPanel：拖动展开态标题栏后收起，图标第一次点击必须能展开（回归缺陷）', () => {
  it('拖标题栏（超过阈值）→ 收起 → 点图标一次即展开，不需要点第二次', async () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(FloatingStencilPanel, { i18n: createDesignerI18n() });
    app.mount(el);
    await flush();

    const handle = el.querySelector('[data-testid="workflow-stencil-drag-handle"]') as HTMLElement;
    expect(handle, '初始应为展开态，标题栏拖动把手存在').toBeTruthy();

    // 拖动标题栏：位移 50px，远超阈值（STENCIL_PANEL_DRAG_CLICK_THRESHOLD_PX = 4），
    // 这是一次真实的"拖动"手势，不是"点击"。
    firePointerEvent(handle, 'pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    firePointerEvent(handle, 'pointermove', { clientX: 150, clientY: 100, pointerId: 1 });
    firePointerEvent(handle, 'pointerup', { clientX: 150, clientY: 100, pointerId: 1 });
    await flush();

    // 收起——此时若缺陷仍在，suppressNextClick 已经被上面那次拖标题栏残留置为 true。
    const collapseBtn = el.querySelector('[data-testid="workflow-stencil-collapse"]') as HTMLElement;
    collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const icon = el.querySelector('[data-testid="workflow-stencil-icon"]') as HTMLElement;
    expect(icon, '收起后应渲染出收起态图标').toBeTruthy();

    // 第一次点图标：修复前会被残留的 suppressNextClick 吞掉，图标不展开；修复后应立即展开。
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(el.querySelector('[data-testid="workflow-stencil-icon"]'), '点一次图标后应展开，图标不应再存在').toBeNull();
    expect(el.querySelector('[data-testid="workflow-stencil-drag-handle"]'), '展开后标题栏拖动把手应重新出现').toBeTruthy();
  });
});
