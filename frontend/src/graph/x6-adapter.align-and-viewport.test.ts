/**
 * graph/x6-adapter.align-and-viewport.test.ts —— 画布工具条能力单测：
 *   1. 对齐/分布图标按钮（alignSelection/distributeSelection）的目标坐标计算；
 *   2. 三开关（setSnapToGrid 映射到 grid size 16↔1；setSnaplineEnabled 只管参考线）；
 *   3. Alt 精细对齐同时压制吸附与参考线，松开后按各自工具条设定（而非无脑重开）还原；
 *   4. 标尺数据源 getViewport()/onViewportChange()。
 *
 * 同 x6-adapter.center-and-zoom.test.ts 的既定手法：真的
 * `new X6GraphAdapter(...).mount(container)`——setNodes()/setSelection() 之类只是写 X6 内部
 * Cell 模型状态（position/size/grid size 等），不依赖真实 DOM 布局测算，happy-dom 下可靠；
 * 只有"读回渲染后的 DOM 变换矩阵"这类才不可靠（见该文件头注释），本文件不涉及。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Graph } from '@antv/x6';
import { Snapline } from '@antv/x6-plugin-snapline';
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

function mountAdapter(): { adapter: X6GraphAdapter; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const adapter = new X6GraphAdapter(messages);
  adapter.mount(container);
  return { adapter, container };
}

/** 测试专用：拿到 X6GraphAdapter 私有持有的真实 Graph 实例
 * （本文件只用它触发键盘事件，不直接操纵内部状态）。 */
function internalGraph(adapter: X6GraphAdapter): Graph {
  return (adapter as unknown as { graph: Graph }).graph;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('X6GraphAdapter.alignSelection（对齐 3 图标按钮）', () => {
  it('left：全部对齐到选中集合当前最靠左的左边缘，y 不变', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 100, y: 50 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 200 } },
      { id: 'n3', type: 'approve', label: 'C', position: { x: 200, y: 400 } }
    ]);
    adapter.setSelection(['n1', 'n2', 'n3'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.alignSelection('left');

    expect(moves).toHaveLength(3);
    for (const move of moves) expect(move.position.x).toBe(100); // 三者最左＝n1 的 100
    // y 分别保持各自原值不变。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.y).toBe(50);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.y).toBe(200);
    expect(moves.find((m) => m.nodeId === 'n3')?.position.y).toBe(400);
    adapter.unmount();
  });

  it('right：全部对齐到选中集合当前最靠右的右边缘（x + width 的最大值）', () => {
    const { adapter } = mountAdapter();
    // approval 家族固定宽 184（graph/x6-adapter.ts NODE_WIDTH）。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }, // 右边缘 184
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 0 } } // 右边缘 484（最大）
    ]);
    adapter.setSelection(['n1', 'n2'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.alignSelection('right');

    expect(moves.find((m) => m.nodeId === 'n1')?.position.x).toBe(484 - 184); // 300
    expect(moves.find((m) => m.nodeId === 'n2')?.position.x).toBe(300); // 已在目标位置
    adapter.unmount();
  });

  it('middle：对齐到选中集合包围盒的垂直中心线（首尾极值中点，不是加权平均）', () => {
    const { adapter } = mountAdapter();
    // approval 家族固定高 64。n1 顶部 0、底部 64；n2 顶部 200、底部 264 —— 包围盒中心 = (0+264)/2 = 132。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 200 } }
    ]);
    adapter.setSelection(['n1', 'n2'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.alignSelection('middle');

    // n1 目标 y = centerY(132) - height/2(32) = 100；n2 同理 = 100（两者高度相同故落在同一行）。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.y).toBe(100);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.y).toBe(100);
    // x 轴不变。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.x).toBe(0);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.x).toBe(300);
    adapter.unmount();
  });

  it('选中 < 2 个节点：不 emit nodesMoveEnd（护栏——不满足"对齐"的既定语义）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    adapter.setSelection(['n1'], []);
    let called = false;
    adapter.on('nodesMoveEnd', () => {
      called = true;
    });

    adapter.alignSelection('left');

    expect(called).toBe(false);
    adapter.unmount();
  });

  // 以下三档（center/top/bottom）与上面三档按轴补齐成六档，钉住"横向三档只碰 x、
  // 纵向三档只碰 y，另一坐标必须原样不变"这条最重要的纪律。
  it('center：对齐到选中集合包围盒的水平中心线（是 middle 的 x 轴镜像），y 严格不变', () => {
    const { adapter } = mountAdapter();
    // approval 家族固定宽 184。n1 左边缘 0、右边缘 184；n2 左边缘 300、右边缘 484 ——
    // 包围盒水平中心 = (0+484)/2 = 242。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 10 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 999 } }
    ]);
    adapter.setSelection(['n1', 'n2'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.alignSelection('center');

    // n1/n2 宽度相同（184），目标 x = centerX(242) - width/2(92) = 150，两者落到同一列。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.x).toBe(150);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.x).toBe(150);
    // y 轴不变——这是本档与"垂直居中"(middle) 的关键区别。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.y).toBe(10);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.y).toBe(999);
    adapter.unmount();
  });

  it('top：全部对齐到选中集合最靠上的上边缘 min(y)（是 left 的 y 轴镜像），x 严格不变', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 100, y: 50 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 200 } },
      { id: 'n3', type: 'approve', label: 'C', position: { x: 200, y: 400 } }
    ]);
    adapter.setSelection(['n1', 'n2', 'n3'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.alignSelection('top');

    expect(moves).toHaveLength(3);
    for (const move of moves) expect(move.position.y).toBe(50); // 三者最上＝n1 的 50
    // x 分别保持各自原值不变。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.x).toBe(100);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.x).toBe(300);
    expect(moves.find((m) => m.nodeId === 'n3')?.position.x).toBe(200);
    adapter.unmount();
  });

  it('bottom：全部对齐到选中集合最靠下的下边缘 max(y+height)（是 right 的 y 轴镜像），x 严格不变', () => {
    const { adapter } = mountAdapter();
    // approval 家族固定高 64。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }, // 下边缘 64
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 200 } } // 下边缘 264（最大）
    ]);
    adapter.setSelection(['n1', 'n2'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.alignSelection('bottom');

    expect(moves.find((m) => m.nodeId === 'n1')?.position.y).toBe(264 - 64); // 200
    expect(moves.find((m) => m.nodeId === 'n2')?.position.y).toBe(200); // 已在目标位置
    // x 轴不变。
    expect(moves.find((m) => m.nodeId === 'n1')?.position.x).toBe(0);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.x).toBe(300);
    adapter.unmount();
  });

  it('🔴 回归钉子：center 与 middle 是两条不同的轴，同一组夹具跑出的结果不应相等（防止再被对调）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 200 } }
    ]);
    adapter.setSelection(['n1', 'n2'], []);

    const centerMoves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    const offCenter = adapter.on('nodesMoveEnd', (m) => centerMoves.push(...m));
    adapter.alignSelection('center');
    offCenter();

    // 对齐会真的改坐标，重新摆回初始位置再跑 middle，避免上一档的结果污染下一档的输入。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 300, y: 200 } }
    ]);
    adapter.setSelection(['n1', 'n2'], []);
    const middleMoves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => middleMoves.push(...m));
    adapter.alignSelection('middle');

    // center 只动 x（结果 x 相同、y 各自不变）；middle 只动 y（结果 y 相同、x 各自不变）——
    // 两档在同一夹具上产生的坐标必须不同，否则说明轴又被对调回去了。
    const centerN1 = centerMoves.find((m) => m.nodeId === 'n1')?.position;
    const middleN1 = middleMoves.find((m) => m.nodeId === 'n1')?.position;
    expect(centerN1).not.toEqual(middleN1);
    adapter.unmount();
  });
});

describe('X6GraphAdapter.distributeSelection（等间距分布，带方向参数）', () => {
  it("horizontal：保持最左/最右两个节点不动，中间节点按边到边等间距重新摆放", () => {
    const { adapter } = mountAdapter();
    // 三个节点宽度不同（approval 184 / start 胶囊 168），验证"边到边"而不是"中心点"等距。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }, // 宽 184，右边缘 184
      { id: 'n2', type: 'start', label: 'S', position: { x: 300, y: 0 } }, // 宽 168（居中放，位置任意）
      { id: 'n3', type: 'approve', label: 'C', position: { x: 900, y: 0 } } // 宽 184，右边缘 1084
    ]);
    adapter.setSelection(['n1', 'n2', 'n3'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.distributeSelection('horizontal');

    const byId = Object.fromEntries(moves.map((m) => [m.nodeId, m.position]));
    // 首尾不动。
    expect(byId['n1'].x).toBe(0);
    expect(byId['n3'].x).toBe(900);
    // 边到边间距：span = 1084 - 0 = 1084；totalWidth = 184+168+184 = 536；gapCount = 2；
    // gap = (1084-536)/2 = 274；n2.x = n1.x + width(184) + gap(274) = 458。
    expect(byId['n2'].x).toBe(458);
    // 验证真的是"边到边"等距（而不是中心点等距）：n1 右边缘到 n2 左边缘的距离，
    // 与 n2 右边缘到 n3 左边缘的距离相等。
    const gap1 = byId['n2'].x - (byId['n1'].x + 184);
    const gap2 = byId['n3'].x - (byId['n2'].x + 168);
    expect(gap1).toBeCloseTo(gap2, 6);
    adapter.unmount();
  });

  it('horizontal：不改变任何节点的 y 坐标', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 40 } },
      { id: 'n2', type: 'approve', label: 'B', position: { x: 500, y: 999 } }
    ]);
    adapter.setSelection(['n1', 'n2'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.distributeSelection('horizontal');

    expect(moves.find((m) => m.nodeId === 'n1')?.position.y).toBe(40);
    expect(moves.find((m) => m.nodeId === 'n2')?.position.y).toBe(999);
    adapter.unmount();
  });

  // 纵向分布，是 horizontal 用例的同构镜像（x/width 换成 y/height）。
  it('vertical：保持最上/最下两个节点不动，中间节点按边到边等间距重新摆放，x 不变', () => {
    const { adapter } = mountAdapter();
    // approval 家族固定高 64，start 胶囊高 64（同宽差异用节点类型制造高度差不现实，改用不同 y 排布验证算法）。
    adapter.setNodes([
      { id: 'n1', type: 'approve', label: 'A', position: { x: 10, y: 0 } }, // 高 64，下边缘 64
      { id: 'n2', type: 'approve', label: 'B', position: { x: 20, y: 300 } }, // 高 64
      { id: 'n3', type: 'approve', label: 'C', position: { x: 30, y: 900 } } // 高 64，下边缘 964
    ]);
    adapter.setSelection(['n1', 'n2', 'n3'], []);
    const moves: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    adapter.on('nodesMoveEnd', (m) => moves.push(...m));

    adapter.distributeSelection('vertical');

    const byId = Object.fromEntries(moves.map((m) => [m.nodeId, m.position]));
    // 首尾不动。
    expect(byId['n1'].y).toBe(0);
    expect(byId['n3'].y).toBe(900);
    // 边到边间距：span = 964 - 0 = 964；totalHeight = 64*3 = 192；gapCount = 2；
    // gap = (964-192)/2 = 386；n2.y = n1.y + height(64) + gap(386) = 450。
    expect(byId['n2'].y).toBe(450);
    const gap1 = byId['n2'].y - (byId['n1'].y + 64);
    const gap2 = byId['n3'].y - (byId['n2'].y + 64);
    expect(gap1).toBeCloseTo(gap2, 6);
    // x 轴不变——纵向分布不隐式改变节点所在的列。
    expect(byId['n1'].x).toBe(10);
    expect(byId['n2'].x).toBe(20);
    expect(byId['n3'].x).toBe(30);
    adapter.unmount();
  });

  it('选中 < 2 个节点：不 emit（horizontal/vertical 均适用）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 0, y: 0 } }]);
    adapter.setSelection(['n1'], []);
    let called = false;
    adapter.on('nodesMoveEnd', () => {
      called = true;
    });

    adapter.distributeSelection('horizontal');
    adapter.distributeSelection('vertical');

    expect(called).toBe(false);
    adapter.unmount();
  });
});

describe('X6GraphAdapter 三开关拆分：setSnapToGrid / setSnaplineEnabled 各自独立', () => {
  it('setSnapToGrid 映射到 graph.setGridSize(16↔1)——这是唯一正交的网格吸附旋钮', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    expect(graph.getGridSize()).toBe(16); // mount() 默认吸附开

    adapter.setSnapToGrid(false);
    expect(graph.getGridSize()).toBe(1);
    expect(adapter.isSnapToGridEnabled()).toBe(false);

    adapter.setSnapToGrid(true);
    expect(graph.getGridSize()).toBe(16);
    expect(adapter.isSnapToGridEnabled()).toBe(true);
    adapter.unmount();
  });

  it('setSnaplineEnabled 只管参考线，不影响 grid size（语义收窄，不再间接控制吸附）', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);

    adapter.setSnaplineEnabled(false);
    expect(adapter.isSnaplineEnabled()).toBe(false);
    expect(graph.getGridSize()).toBe(16); // 吸附设定不受影响，仍是默认开

    adapter.setSnapToGrid(false); // 反过来：关闭吸附不影响参考线设定
    expect(adapter.isSnaplineEnabled()).toBe(false);
    adapter.setSnapToGrid(true);
    expect(adapter.isSnaplineEnabled()).toBe(false); // 仍保持用户此前关闭参考线的设定
    adapter.unmount();
  });

  it('🔴 反向验证：若 setSnapToGrid 内部改成不调用 graph.setGridSize（只更新自身字段），本用例会变红', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    adapter.setSnapToGrid(false);
    // 直接断言底层 X6 真实状态（不是读 adapter 自己的字段），证明确实调用到了 X6。
    expect(graph.getGridSize()).toBe(1);
    adapter.unmount();
  });
});

describe('X6GraphAdapter Alt 精细对齐：同时压制吸附与参考线，松开后按各自工具条设定还原', () => {
  // bindPanning() 的 down/up 处理器挂在 window 上，但读取的是 event.target 判断"是否正在编辑
  // 输入框"（isEditableTarget）——真实浏览器里 keydown 的 target 是当前获得焦点的元素（通常是
  // document.body），直接 window.dispatchEvent(...) 会让 event.target 退化成 window 本身（无
  // .matches 方法，见 isEditableTarget 实现），因此改在 document.body 上派发、依赖事件冒泡
  // 传到 window 的既有监听器（同真实浏览器 keydown 事件流一致）。
  function pressAlt(): void {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
  }
  function releaseAlt(): void {
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
  }

  it('按住 Alt：吸附（grid size）与参考线同时被压到"关"；松开后恢复到按住前的设定（均为默认开）', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    expect(graph.getGridSize()).toBe(16);
    expect(adapter.isSnaplineEnabled()).toBe(true);

    pressAlt();
    expect(graph.getGridSize()).toBe(1);
    expect(graph.getPlugin<Snapline>('snapline')?.isEnabled()).toBe(false);

    releaseAlt();
    expect(graph.getGridSize()).toBe(16);
    expect(graph.getPlugin<Snapline>('snapline')?.isEnabled()).toBe(true);
    adapter.unmount();
  });

  it('🔴 回归：若用户在按住 Alt 之前已经通过工具条关闭了参考线，松开 Alt 不应把它重新打开', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    adapter.setSnaplineEnabled(false); // 用户工具条操作：参考线关
    expect(graph.getPlugin<Snapline>('snapline')?.isEnabled()).toBe(false);

    pressAlt();
    releaseAlt();

    // 松开 Alt 后应仍然是"关"（用户的工具条设定），不是被 Alt 无脑重新打开。
    expect(adapter.isSnaplineEnabled()).toBe(false);
    expect(graph.getPlugin<Snapline>('snapline')?.isEnabled()).toBe(false);
    adapter.unmount();
  });

  it('同理：按住 Alt 之前已经关闭吸附，松开 Alt 不应把 grid size 恢复成 16', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    adapter.setSnapToGrid(false);
    expect(graph.getGridSize()).toBe(1);

    pressAlt();
    expect(graph.getGridSize()).toBe(1); // 已经是 1，按住 Alt 不变
    releaseAlt();
    expect(graph.getGridSize()).toBe(1); // 松开后仍应是用户设定的"关"，不是恢复成 16
    expect(adapter.isSnapToGridEnabled()).toBe(false);
    adapter.unmount();
  });
});

describe('X6GraphAdapter.getViewport / onViewportChange（标尺数据源）', () => {
  it('getViewport 把 graph.zoom()/graph.translate() 的读数原样转发成 {scaleX, tx, ty}', () => {
    // 🔴 同 x6-adapter.center-and-zoom.test.ts 头注释"happy-dom 环境下……即使直接调用
    // graph.translate(tx,ty)/graph.zoomTo(scale)，随后的读也仍是初始值"——
    // graph.zoomTo()/graph.translate() 的写入不会在 happy-dom 里体现在读端。getViewport() 本身
    // 只是无条件转发 graph.zoom()/graph.translate() 的读数，用 vi.spyOn 桩出确定的读数，断言
    // 转发结果正确，比依赖"先写后读"更贴合这段代码实际要验证的东西（转发对不对，不是
    // 写入本身对不对——写入路径已经由 zoomToPercent/centerOn 的既有用例覆盖）。
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    // zoom()/translate() 都是重载方法（无参数时是读；带参数时是写，返回值签名不同），
    // vi.spyOn 对重载方法的 mockReturnValue 类型推导会锁死在"写"那个重载上（返回 this/Graph），
    // 不接受本处要桩的"读"返回值——直接用 as 断言到只读的读取签名后重赋值，绕开这个纯类型层面
    // 的桩函数限制（运行时行为等价，都是替换掉实例上的这个方法）。
    graph.zoom = (() => 1.5) as typeof graph.zoom;
    graph.translate = (() => ({ tx: 40, ty: -20 })) as typeof graph.translate;

    expect(adapter.getViewport()).toEqual({ scaleX: 1.5, tx: 40, ty: -20 });
    adapter.unmount();
  });

  it('未 mount 时返回缺省视口（scale 1、原点 0），不抛错', () => {
    const adapter = new X6GraphAdapter(messages);
    expect(adapter.getViewport()).toEqual({ scaleX: 1, tx: 0, ty: 0 });
  });

  it('onViewportChange：graph 缩放/平移都会触发回调（复用既有 scale/translate 事件绑定）', () => {
    const { adapter } = mountAdapter();
    const graph = internalGraph(adapter);
    let calls = 0;
    const off = adapter.onViewportChange(() => {
      calls += 1;
    });

    graph.zoomTo(2);
    expect(calls).toBe(1);
    graph.translate(10, 10);
    expect(calls).toBe(2);

    off();
    graph.zoomTo(1);
    expect(calls).toBe(2); // 取消订阅后不再收到通知
    adapter.unmount();
  });

  it('centerOn/zoomToPercent 等既有视口变更入口同样会触发标尺回调（同一条底层事件通道）', () => {
    const { adapter } = mountAdapter();
    adapter.setNodes([{ id: 'n1', type: 'approve', label: 'A', position: { x: 500, y: 400 } }]);
    let calls = 0;
    adapter.onViewportChange(() => {
      calls += 1;
    });

    adapter.zoomToPercent(150);
    expect(calls).toBeGreaterThan(0);
    const afterZoom = calls;
    adapter.centerOn('n1');
    expect(calls).toBeGreaterThan(afterZoom);
    adapter.unmount();
  });
});
