/**
 * graph/x6-adapter.panning.test.ts —— 画布平移/框选手势与小地图缩放中，落在 X6GraphAdapter
 * 内部的三项单测：
 *   ① 指针手势（直接拖动空白=平移 / Ctrl·⌘+拖动空白=框选）与 bindPanning() 的
 *     contextmenu 抑制（macOS 上 Ctrl+左键会被翻译成右键）；
 *   ② 不提供空格+拖动平移——Space 按键不产生任何平移相关副作用；
 *   ④ 小地图最小缩放比下限——refreshMinimapScale() 是否真的用 minScale/maxScale 覆盖了插件
 *     自身无下限的 zoomToFit()。
 * ③（提示条左下定位）不落在本文件——那是纯 CSS/静态文本，守护放在
 * DesignerCanvas.minimap-wiring.static.test.ts。
 *
 * 同 x6-adapter.center-and-zoom.test.ts 的既定手法：真的 `new X6GraphAdapter(...).mount(container)`，
 * 但**必须**在 mount() 之前把 `Graph.prototype.zoomToFit` 桩成 no-op——本文件真的
 * 挂了小地图容器（setMinimapContainer）再 mount() 的测试：X6 MiniMap 插件 init() 时会同步调用
 * 一次 targetGraph.zoomToFit()（见 refreshMinimapScale 头注释），其内部 localToGraph() 依赖真实
 * SVGPoint.matrixTransform，happy-dom 未实现该 API，不桩掉会直接抛错（比 center-and-zoom 测试
 * 头注释里"计算结果写不回可读 DOM"更严重——这里是**执行期直接抛错**，不只是读不回）。因此全文件
 * 统一在 beforeEach 里桩掉它，只保留"调用被记录、参数可断言"这一半能力，断言"调用参数正确"而不是
 * "真实几何效果正确"，与该文件既定手法一致。
 *
 * 🔴 额外一层坑：MiniMap 插件自己的 updateViewport（渲染"当前可见区域"高亮框）用
 * `lodash-es debounce(fn, 0)` 包了一层，真实场景下这是"合并同一帧内多次 translate/scale 通知"
 * 的性能优化，但在测试里意味着它会在当前测试同步执行完、断言都跑完之后，才在下一个宏任务里
 * 真正触发——如果不管，这个回调会在 afterEach 已经 `vi.restoreAllMocks()`（把 zoomToFit 等桩
 * 还原成真实实现）之后才执行到同样会撞 SVGPoint.matrixTransform 的代码，变成 vitest 报告里的
 * "Unhandled Errors"（进程仍判定为失败，即使每条 it() 本身都显示通过）。用 `vi.useFakeTimers()`
 * 让这类 setTimeout(0) 类回调在测试期间根本不会真的触发，随测试结束一并作废，不需要逐个去猜
 * X6/MiniMap 内部还有哪些延迟任务。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Graph } from '@antv/x6';
import { X6GraphAdapter, type X6GraphMessages } from './x6-adapter';

const messages: X6GraphMessages = {
  renamePrompt: 'rename',
  rename: 'rename',
  copy: 'copy',
  delete: 'delete',
  editVertices: 'editVertices',
  clearVertices: 'clearVertices',
  deleteEdge: 'deleteEdge',
  paste: 'paste',
  fit: 'fit',
  zoom100: 'zoom100'
};

/** 本文件所有 mountAdapter() 挂出来的实例——afterEach 统一 unmount，同既有测试文件"每条 it()
 * 结尾手动 adapter.unmount()"的既定纪律，这里改成集中收口（同 ShortcutHelpPanel.test.ts
 * mountedApps 数组的既定手法）：避免 bindPanning()/bindGraphEvents() 挂在 window 上的监听器
 * 跨用例残留——那些是 window 级别的，不会因为 container 被换掉而自动失效，残留会让"下一条用例
 * dispatch 在 window 上的 pointerup"同时触发好几个测试各自的 adapter 实例。 */
let activeAdapters: X6GraphAdapter[] = [];

/** 同既有测试文件的 mountAdapter，额外挂一个小地图容器（DesignerCanvas.vue 实际用法：
 * setMinimapContainer 必须排在 mount() 之前，见其调用点注释）。 */
function mountAdapter(): { adapter: X6GraphAdapter; container: HTMLElement; minimapContainer: HTMLElement } {
  const container = document.createElement('div');
  const minimapContainer = document.createElement('div');
  document.body.appendChild(container);
  document.body.appendChild(minimapContainer);
  const adapter = new X6GraphAdapter(messages);
  adapter.setMinimapContainer(minimapContainer);
  adapter.mount(container);
  activeAdapters.push(adapter);
  return { adapter, container, minimapContainer };
}

/** 见文件头注释——全文件统一桩掉 zoomToFit 的真实实现，只保留调用记录。④的用例直接引用这个
 * 变量断言调用参数；①②的用例只是借它让 mount() 不崩，不关心它的调用记录。用一个具名函数
 * 包一层 spyOn 调用，让 zoomToFitSpy 的类型直接从这一次调用推导（zoomToFit 的 `this` 多态返回
 * 类型会让手写的宽泛类型标注与 vitest MockInstance 泛型互相打架，推导反而最省事）。 */
function stubMinimapZoomToFit() {
  return vi.spyOn(Graph.prototype, 'zoomToFit').mockImplementation(function (this: Graph) {
    return this;
  });
}
let zoomToFitSpy: ReturnType<typeof stubMinimapZoomToFit>;

/** 同上——X6 GraphView.onContextMenu()（真实右键菜单要走的原生处理入口）在算 view/guard 之前
 * 无条件调用一次 `graph.snapToGrid(e.clientX, e.clientY)`（只为算出 trigger 载荷里的 x/y 字段，
 * 本文件 openContextMenu 消费的是原始 event.clientX/clientY，不读这两个字段），同样会一路
 * 触达 SVGPoint.matrixTransform 崩溃——凡是"contextmenu 事件真的放行给 X6"的用例（松开左键后
 * 右键菜单照常/反向验证两条）都会触发，一并桩掉，返回值本身不影响本文件的任何断言。 */
function stubSnapToGrid() {
  return vi.spyOn(Graph.prototype, 'snapToGrid').mockImplementation(() => ({ x: 0, y: 0 }) as ReturnType<Graph['snapToGrid']>);
}

beforeEach(() => {
  vi.useFakeTimers(); // 见文件头注释——压住 MiniMap 内部 debounce(fn,0) 的延迟回调
  zoomToFitSpy = stubMinimapZoomToFit();
  stubSnapToGrid();
});

afterEach(() => {
  // unmount 仍在"桩还在生效"的窗口内执行（dispose() 内部也可能触发 zoomToFit 等调用），
  // 因此顺序上先 unmount、再依次交还真实定时器/真实实现——同 mountAdapter 头注释。
  activeAdapters.splice(0).forEach((adapter) => adapter.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('①指针手势：直接拖动空白=平移，Ctrl/⌘+拖动空白=框选（contextmenu 抑制随框选手势保留）', () => {
  it('直接左键拖动空白处平移画布；pointerdown 不被 preventDefault（放行 mousedown 给 X6 的单击/聚焦链路）', () => {
    const translateSpy = vi.spyOn(Graph.prototype, 'translate');
    const { container } = mountAdapter();
    const svg = container.querySelector('svg') as SVGElement;

    const downEvent = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 });
    svg.dispatchEvent(downEvent);
    expect(downEvent.defaultPrevented).toBe(false);
    expect(container.style.cursor).toBe(''); // 只按下未位移：不切光标

    translateSpy.mockClear();
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 40, clientY: 25 }));
    // 起手时 translate() 读到的是 (0,0)，位移 (30,15) 原样写回。
    expect(translateSpy).toHaveBeenCalledWith(30, 15);
    expect(container.style.cursor).toBe('grabbing');

    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    expect(container.style.cursor).toBe('');

    // 松手后再移动不再平移。
    translateSpy.mockClear();
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 90, clientY: 90 }));
    expect(translateSpy).not.toHaveBeenCalled();
  });

  it('中键拖动同样平移，且 pointerdown 被 preventDefault（压掉浏览器中键自动滚动）', () => {
    const translateSpy = vi.spyOn(Graph.prototype, 'translate');
    const { container } = mountAdapter();
    const svg = container.querySelector('svg') as SVGElement;

    const downEvent = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, clientX: 0, clientY: 0 });
    svg.dispatchEvent(downEvent);
    expect(downEvent.defaultPrevented).toBe(true);

    translateSpy.mockClear();
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 5, clientY: 7 }));
    expect(translateSpy).toHaveBeenCalledWith(5, 7);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  });

  it('🔴 Ctrl/⌘+左键拖动空白处不平移（交给 Selection 插件框选），pointerdown 同样不被 preventDefault', () => {
    const translateSpy = vi.spyOn(Graph.prototype, 'translate');
    const { container } = mountAdapter();
    const svg = container.querySelector('svg') as SVGElement;

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const downEvent = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...modifier });
      svg.dispatchEvent(downEvent);
      expect(downEvent.defaultPrevented).toBe(false);
      translateSpy.mockClear();
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 60, clientY: 60, ...modifier }));
      expect(translateSpy).not.toHaveBeenCalled();
      expect(container.style.cursor).toBe('');
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    }
  });

  it('Selection 插件的框选修饰键配置为 ctrl / meta（未按修饰键时 X6 不起框选，与平移互斥）', () => {
    const { adapter } = mountAdapter();
    const plugin = (adapter as unknown as { selectionPlugin: { options: { modifiers?: unknown; rubberband?: boolean } } }).selectionPlugin;
    expect(plugin.options.rubberband).toBe(true);
    expect(plugin.options.modifiers).toEqual(['ctrl', 'meta']);
  });

  it('Ctrl+左键按下起手（框选手势）时，同一手势内的 contextmenu 被拦截，不弹出自定义右键菜单', () => {
    const { container } = mountAdapter();
    const svg = container.querySelector('svg') as SVGElement; // 真实点击落在 svg 这个 container 的
    // 后代节点上，才会经历"capture 阶段先到达 container、bubble 阶段才到达 X6 自身委托监听器"
    // 这条传播顺序（见 bindPanning 里 suppressSelectContextMenu 的头注释）；若直接 dispatch 在
    // container 自身，capture/bubble 会退化成同一个 target 阶段、按注册顺序执行，不能反映真实
    // 浏览器里的传播路径。

    // 起手：Ctrl+左键在空白画布按下——pointerDown 判定为框选手势，modifierSelect 置真。
    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 10, clientY: 10 }));
    // macOS 上同一次按下会紧接着派发 contextmenu（同样 ctrlKey:true）——应被压制。
    const menuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey: true, clientX: 10, clientY: 10 });
    svg.dispatchEvent(menuEvent);

    expect(container.querySelector('.kimpo-workflow-context-menu')).toBeNull();
    expect(menuEvent.defaultPrevented).toBe(true);

    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  });

  it('松开左键后，普通右键菜单照常弹出（不是永久压制）', () => {
    const { container } = mountAdapter();
    const svg = container.querySelector('svg') as SVGElement;

    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); // modifierSelect 置回 false

    svg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }));

    expect(container.querySelector('.kimpo-workflow-context-menu')).not.toBeNull();
  });

  it('🔴 反向验证：未处于框选手势时，contextmenu 不受影响（证明抑制只在手势期间生效，不是无脑吞掉所有 contextmenu）', () => {
    const { container } = mountAdapter();
    const svg = container.querySelector('svg') as SVGElement;

    svg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 }));

    expect(container.querySelector('.kimpo-workflow-context-menu')).not.toBeNull();
  });
});

describe('②无空格+拖动平移：Space 不触发任何平移相关副作用', () => {
  it('按下/松开 Space 不调用 graph.enablePanning/disablePanning，也不改动画布容器的光标样式', () => {
    const enableSpy = vi.spyOn(Graph.prototype, 'enablePanning');
    const disableSpy = vi.spyOn(Graph.prototype, 'disablePanning');
    const { container } = mountAdapter();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(container.style.cursor).toBe(''); // Space 不应把光标切成 'grab'
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    expect(container.style.cursor).toBe('');

    expect(enableSpy).not.toHaveBeenCalled();
    expect(disableSpy).not.toHaveBeenCalled();
  });
});

describe('④小地图最小缩放比下限：refreshMinimapScale() 覆盖插件自身无下限的自动适配', () => {
  it('内容变化（setNodes）后，用 targetGraph 显式带 minScale/maxScale 重新 zoomToFit 一次', () => {
    const { adapter } = mountAdapter();

    // 3 节点紧凑排布——小流程在小地图里容易缩成看不清的点。
    adapter.setNodes([
      { id: 'n1', type: 'start', label: 'S', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'approve', label: 'A', position: { x: 220, y: 0 } },
      { id: 'n3', type: 'end', label: 'E', position: { x: 440, y: 0 } }
    ]);

    // 插件自身的 onModelUpdated（对 sourceGraph 的 model:updated 反应）会先调用一次不带参数的
    // zoomToFit()；setNodes() 末尾紧接着用同一个 targetGraph 再调一次并显式带下限——断言"最后
    // 一次调用确实带上了 { minScale, maxScale }"，是 refreshMinimapScale() 真的接上了线的
    // 唯一可靠证据。
    const lastCall = zoomToFitSpy.mock.calls[zoomToFitSpy.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual({ minScale: 0.3, maxScale: 1 });
  });

  it('setEdges 同样会触发一次带下限的 zoomToFit（不止 setNodes 才接了线）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);

    adapter.setEdges([]);
    const lastCall = zoomToFitSpy.mock.calls[zoomToFitSpy.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual({ minScale: 0.3, maxScale: 1 });
  });

  it('🔴 反向验证：若 refreshMinimapScale 不再传 minScale/maxScale（退化成插件自己那次无参调用），本用例会变红', () => {
    const { adapter } = mountAdapter();

    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);

    // 直接断言底层调用参数里带着下限——不是读 adapter 自己的字段，证明确实调用到了 X6。
    expect(zoomToFitSpy.mock.calls.some((call) => (call[0] as { minScale?: number } | undefined)?.minScale === 0.3)).toBe(true);
  });
});
