/**
 * shell/FloatingPropsPanel.test.ts —— 属性面板浮层标题去重的运行时锁定。
 *
 * 外壳（本组件）自己有拖动标题栏，若被它包住的 PropsPanel.vue 头部标题不隐藏，正文第一行会再
 * 出现一个重复标题。解法同 stencil/FloatingStencilPanel.vue 给内层 StencilPanel.vue 传
 * hide-title 完全一套：PropsPanel.vue 提供 hideTitle prop，本组件挂载内层时传 hide-title。
 *
 * 用真实 Vue 挂载（createApp，同 panels/panel-test-helpers.ts 头注释的既定手法，本插件没有
 * @vue/test-utils）断言"渲染出来的 DOM 里到底有几个标题文案节点"，比只读源码文本的静态断言更
 * 有说服力——它验证的是 hideTitle 这个 prop 真的从外壳传到了内层、内层真的按它决定要不要渲染
 * 那个 <header>，而不是只验证源码里出现过 "hide-title" 这几个字符。
 *
 * 选用"未选中任何项"这一态挂载：此时 PropsPanel.vue 内部只落到最后一条通用空态 <p>，不经
 * getNodeTypeDefinition/EdgePanel 等任何需要 DESIGNER_HOST_KEY/DESIGNER_STATE_KEY 注入的分支，
 * 挂载不需要伪造 host/state，测试本身也更聚焦"标题去重"这一件事。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import FloatingPropsPanel from './FloatingPropsPanel.vue';
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

function mount(): HTMLElement {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(FloatingPropsPanel, {
    i18n: createDesignerI18n(),
    selection: { nodeIds: [], linkIds: [] }
  });
  app.mount(el);
  return el;
}

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

describe('FloatingPropsPanel：标题只渲染一次（不再是外壳 + 内层各一份重复的两行）', () => {
  it('外壳拖动标题栏渲染了标题——选中节点时叫「节点设置」（标题随选中对象变，不再恒为"属性面板"）', () => {
    const root = mount();
    const handleTitle = root.querySelector('.workflow-props-floating__handle-title');
    expect(handleTitle).not.toBeNull();
    expect(handleTitle?.textContent).toBe('节点设置');
  });

  it('内层 PropsPanel 自己的 <header class="wf-props-panel__header"> 完全没有渲染（不是 CSS 隐藏，是 DOM 里就不存在）', () => {
    const root = mount();
    expect(root.querySelector('.wf-props-panel__header')).toBeNull();
  });

  it('整个浮层 DOM 里"属性面板"这个文案只出现一次，不是两次叠在一起', () => {
    const root = mount();
    // 同一标题在外壳与内层各自渲染一次就会叠出两行——直接数整块 DOM 文本里这行字出现几次，比
    // 只看某一个选择器是否存在更直接地对应"用户看到两行重复标题"这件事本身。
    // 外壳标题现为「节点设置」：它恰好出现一次；内层那份旧标题「属性面板」一次都不该出现。
    const text = root.textContent ?? '';
    expect(text.split('节点设置').length - 1).toBe(1);
    expect(text.split('属性面板').length - 1).toBe(0);
  });
});

describe('FloatingPropsPanel：PropsPanel 单独挂载（不经浮动外壳）时 hideTitle 仍可关闭，默认不受影响', () => {
  it('不传 hideTitle 时标题正常渲染（同 stencil/StencilPanel.vue hideTitle 默认值 false 的既定行为，验证本次改动没有让"单独挂载"这条既有用法回归）', async () => {
    const { default: PropsPanel } = await import('./PropsPanel.vue');
    const standaloneEl = document.createElement('div');
    document.body.appendChild(standaloneEl);
    const standaloneApp = createApp(PropsPanel, {
      i18n: createDesignerI18n(),
      selection: { nodeIds: [], linkIds: [] }
    });
    standaloneApp.mount(standaloneEl);
    expect(standaloneEl.querySelector('.wf-props-panel__header')?.textContent).toBe('属性面板');
    standaloneApp.unmount();
    standaloneEl.remove();
  });
});

/**
 * 回归：拖动展开态标题栏后，收起态图标第一次点击不能没反应。
 *
 * 根因：beginDrag/updateDrag/endDrag 这一套指针事件同时服务"展开态标题栏"与"收起态图标"，
 * 靠松手时的累计位移 isDragGesture(dragMaxDelta) 区分"这是一次拖动"还是"这是一次点击"——但
 * 抑制标志 suppressNextClick 只有 onIconClick() 一个消费者，此前 endDrag 无条件置位：拖动
 * 标题栏（展开态，没有"点击展开"语义、没人消费这个标志）也会把它置为 true，残留到之后第一次
 * 点收起态图标时被吞掉。修法：只在收起态（collapsed 为 true，说明这次拖的确实是那枚图标）才
 * 置位，见 FloatingPropsPanel.vue endDrag 处注释。
 */
describe('FloatingPropsPanel：拖动展开态标题栏后收起，图标第一次点击必须能展开（回归缺陷）', () => {
  it('拖标题栏（超过阈值）→ 收起 → 点图标一次即展开，不需要点第二次', async () => {
    // 用非空选中保证浮层处于可见的展开态起点（selection 为空时 v-show 会隐藏浮层，
    // 但不影响这里对拖动/点击这套指针事件本身的验证）。
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(FloatingPropsPanel, {
      i18n: createDesignerI18n(),
      selection: { nodeIds: ['n1'], linkIds: [] }
    });
    app.mount(el);
    await flush();

    const handle = el.querySelector('[data-testid="workflow-props-drag-handle"]') as HTMLElement;
    expect(handle, '初始应为展开态，标题栏拖动把手存在').toBeTruthy();

    // 拖动标题栏：位移 50px，远超阈值（PROPS_PANEL_DRAG_CLICK_THRESHOLD_PX = 4），
    // 这是一次真实的"拖动"手势，不是"点击"。
    firePointerEvent(handle, 'pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    firePointerEvent(handle, 'pointermove', { clientX: 150, clientY: 100, pointerId: 1 });
    firePointerEvent(handle, 'pointerup', { clientX: 150, clientY: 100, pointerId: 1 });
    await flush();

    // 收起——此时若缺陷仍在，suppressNextClick 已经被上面那次拖标题栏残留置为 true。
    const collapseBtn = el.querySelector('[data-testid="workflow-props-collapse"]') as HTMLElement;
    collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const icon = el.querySelector('[data-testid="workflow-props-icon"]') as HTMLElement;
    expect(icon, '收起后应渲染出收起态图标').toBeTruthy();

    // 第一次点图标：修复前会被残留的 suppressNextClick 吞掉，图标不展开；修复后应立即展开。
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(el.querySelector('[data-testid="workflow-props-icon"]'), '点一次图标后应展开，图标不应再存在').toBeNull();
    expect(el.querySelector('[data-testid="workflow-props-drag-handle"]'), '展开后标题栏拖动把手应重新出现').toBeTruthy();
  });
});

/**
 * 回归："多选时浮层直接隐藏"——恰好选中 1 个节点时浮层必须显示，选中 2 个
 * 节点（多选）时浮层必须隐藏，不再渲染任何"选中节点或连线后在这里配置"这类自相矛盾的占位文案
 * （画布工具条上已经显示"已选中 N 个节点"）。
 *
 * 用 selection 挂载后直接断言组件根元素（.workflow-props-floating）的 v-show 结果——Vue 的
 * v-show 直接写 el.style.display，happy-dom 不需要真实布局引擎也能读到这个内联样式，同本文件
 * 头注释既定的"真实 Vue 挂载 + 断言 DOM"手法，比只读源码文本的静态断言更能验证"这两种选中态
 * 下浮层真的显示/隐藏了"这件事本身。
 *
 * 局限说明：本组件是用 createApp(FloatingPropsPanel, { selection: ... })
 * 直接把 selection 当根组件 props 挂载的（同本文件其余用例的既定手法），根组件 props 走
 * shallowReactive，只有整个 selection 对象被替换才会被追踪，事后原地 mutate 同一个 selection
 * 对象（如 push 进 nodeIds 数组）不会触发重渲染——实测验证过（会一直读到挂载时的旧值）。因此
 * 这里按"每种选中态各自单独挂载一次"来断言，不测"同一实例动态切换选中态"这条路径；真实设计器
 * 里 selection 变化是 DesignerRoot.vue 用响应式 state 驱动子组件 props 更新，与这里测试用的根
 * 组件挂载方式不同，动态切换路径不在本文件覆盖范围内。
 */
describe('FloatingPropsPanel：多选时浮层隐藏、单选时浮层显示', () => {
  it('恰好选中 1 个节点时浮层显示', () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(FloatingPropsPanel, {
      i18n: createDesignerI18n(),
      selection: { nodeIds: ['n1'], linkIds: [] }
    });
    app.mount(el);
    const root = el.querySelector('.workflow-props-floating') as HTMLElement;
    expect(root, '组件根元素应已渲染').not.toBeNull();
    expect(root.style.display).not.toBe('none');
  });

  it('选中 2 个节点（多选）时浮层隐藏', () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(FloatingPropsPanel, {
      i18n: createDesignerI18n(),
      selection: { nodeIds: ['n1', 'n2'], linkIds: [] }
    });
    app.mount(el);
    const root = el.querySelector('.workflow-props-floating') as HTMLElement;
    expect(root, '组件根元素应已渲染（v-show 只控制 display，不影响是否挂载）').not.toBeNull();
    expect(root.style.display).toBe('none');
  });

  it('多选两条连线（无节点）时浮层同样隐藏——不只是"多个节点"这一种多选形态', () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(FloatingPropsPanel, {
      i18n: createDesignerI18n(),
      selection: { nodeIds: [], linkIds: ['e1', 'e2'] }
    });
    app.mount(el);
    const root = el.querySelector('.workflow-props-floating') as HTMLElement;
    expect(root.style.display).toBe('none');
  });

  it('节点与连线混选（各 1 个）时浮层隐藏——不满足"恰好 1 个节点且 0 条连线"或"恰好 1 条连线且 0 个节点"任一条件', () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(FloatingPropsPanel, {
      i18n: createDesignerI18n(),
      selection: { nodeIds: ['n1'], linkIds: ['e1'] }
    });
    app.mount(el);
    const root = el.querySelector('.workflow-props-floating') as HTMLElement;
    expect(root.style.display).toBe('none');
  });
});
