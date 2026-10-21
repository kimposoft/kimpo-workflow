/**
 * graph/x6-adapter.visual.test.ts —— 只测 x6-adapter.ts 里"可纯函数化"的画布视觉逻辑
 * （buildNodeVisual/applyNodeVisual/applyEdgeVisual），不实例化真实的 X6 Graph。
 *
 * 为什么不 new Graph：X6 Graph 挂载依赖真实 DOM 布局测算，happy-dom 环境下代价大且脆。
 * apply* 函数刻意设计成只依赖一个最小接口
 * （position()/attr()/setSource()/setTarget()/setLabels()），因此可以用手写的假 cell（记录
 * 调用参数的 spy）代入验证，不需要真的渲染——这正是"让画布视觉逻辑变得可测"的
 * 落地方式。
 *
 * 守护的缺陷面：若 setNodes/setEdges 的"更新分支"各自单独实现，很容易只同步极少数属性
 * （节点摘要、hasIssues 对应的描边宽度、边的虚线/加粗漏更新）。本文件把 apply* 函数当作
 * 单一实现来源直接测——只要它是幂等的、且不残留旧 view 的状态，
 * "改了审批人之后摘要不刷新"这类缺陷就不会出现。
 */
import { describe, expect, it } from 'vitest';
import { applyEdgeVisual, applyNodeVisual, buildNodeVisual, type EdgeVisualCell, type NodeVisualCell } from './x6-adapter';
import type { GraphEdgeView, GraphNodeView } from './port';
import { LIGHT_PALETTE } from '../model/design-tokens';

function makeNodeView(overrides: Partial<GraphNodeView> = {}): GraphNodeView {
  return {
    id: 'n-1',
    type: 'approve',
    label: '审批',
    position: { x: 0, y: 0 },
    ...overrides
  };
}

function makeEdgeView(overrides: Partial<GraphEdgeView> = {}): GraphEdgeView {
  return { id: 'e-1', from: 'n-1', to: 'n-2', ...overrides };
}

/**
 * 假节点 cell：记录 position()/attr() 的调用。attrs 按 path 只保留"最后一次"设的值——这正是
 * X6 attr(path, value) 的真实语义（同一 path 后写覆盖前写，见 @antv/x6-common ObjectExt.setByPath），
 * 用它可以直接反推"apply 之后节点当前的视觉状态"，不需要真的挂到 DOM 上再读回来。
 */
function makeFakeNodeCell(): { cell: NodeVisualCell; position: () => { x: number; y: number } | undefined; attrs: () => Record<string, unknown> } {
  let lastPosition: { x: number; y: number } | undefined;
  const attrs: Record<string, unknown> = {};
  const cell: NodeVisualCell = {
    position: (x: number, y: number) => {
      lastPosition = { x, y };
    },
    attr: (path: string, value: unknown) => {
      attrs[path] = value;
    }
  };
  return { cell, position: () => lastPosition, attrs: () => attrs };
}

/** 假边 cell：同上，另外记录 setSource/setTarget/setLabels 的最后一次调用。 */
function makeFakeEdgeCell(): {
  cell: EdgeVisualCell;
  source: () => unknown;
  target: () => unknown;
  attrs: () => Record<string, unknown>;
  labels: () => unknown[];
} {
  let lastSource: unknown;
  let lastTarget: unknown;
  let lastLabels: unknown[] = [];
  const attrs: Record<string, unknown> = {};
  const cell: EdgeVisualCell = {
    attr: (path: string, value: unknown) => {
      attrs[path] = value;
    },
    setSource: (source) => {
      lastSource = source;
    },
    setTarget: (target) => {
      lastTarget = target;
    },
    setLabels: (labels) => {
      lastLabels = labels;
    }
  };
  return { cell, source: () => lastSource, target: () => lastTarget, attrs: () => attrs, labels: () => lastLabels };
}

describe('graph/x6-adapter buildNodeVisual 形状家族矩阵', () => {
  // 🔴 九类节点共用同一张白底卡，human/automatic/capsule 三家族之间没有 markup 结构差异
  // （不再有 human 独有的 colorBar 左侧色条或 automatic 独有的虚线描边）——三家族应产出完全
  // 相同的 markup 骨架（body + iconBg + icon + label + summary），仅 structure（菱形）家族保留
  // 独立结构。
  // 🔴 选中态四角手柄：markup 恒建四个 selectHandleXX rect
  // 元素（同 summary"元素恒存在、apply 里控显隐"的既定手法），下面三个非 structure 家族的
  // 断言因此在五元素之后追加这四个。
  const SELECT_HANDLES = [
    { tagName: 'rect', selector: 'selectHandleTL' },
    { tagName: 'rect', selector: 'selectHandleTR' },
    { tagName: 'rect', selector: 'selectHandleBL' },
    { tagName: 'rect', selector: 'selectHandleBR' }
  ];

  it('human 家族（如 approve）：body + iconBg + icon + label + summary + 四角选中手柄，不再含 colorBar', () => {
    expect(buildNodeVisual('human', 'approve')).toEqual([
      { tagName: 'rect', selector: 'body' },
      { tagName: 'rect', selector: 'iconBg' },
      { tagName: 'path', selector: 'icon' },
      { tagName: 'text', selector: 'label' },
      { tagName: 'text', selector: 'summary' },
      ...SELECT_HANDLES
    ]);
  });

  it('automatic 家族（如 subflow）：body + iconBg + icon + label + summary + 四角选中手柄——与 human 家族结构相同（没有虚线描边差异，见 applyNodeVisual）', () => {
    const markup = buildNodeVisual('automatic', 'subflow');
    expect(markup).toEqual([
      { tagName: 'rect', selector: 'body' },
      { tagName: 'rect', selector: 'iconBg' },
      { tagName: 'path', selector: 'icon' },
      { tagName: 'text', selector: 'label' },
      { tagName: 'text', selector: 'summary' },
      ...SELECT_HANDLES
    ]);
  });

  it('capsule 家族（如 start/end）：body + iconBg + icon + label + summary + 四角选中手柄（胶囊圆角是 attrs 的 rx/ry，不改变 markup 形状本身）', () => {
    expect(buildNodeVisual('capsule', 'start')).toEqual([
      { tagName: 'rect', selector: 'body' },
      { tagName: 'rect', selector: 'iconBg' },
      { tagName: 'path', selector: 'icon' },
      { tagName: 'text', selector: 'label' },
      { tagName: 'text', selector: 'summary' },
      ...SELECT_HANDLES
    ]);
  });

  // 🔴 反向验证锚点：colorBar 是已删除的元素——若有人把它加回任意家族的 markup，
  // 这条断言必须变红。
  it('colorBar 选择器在任何家族的 markup 里都不出现（已删除的元素）', () => {
    const markups = [buildNodeVisual('human', 'approve'), buildNodeVisual('automatic', 'subflow'), buildNodeVisual('capsule', 'start')];
    for (const markup of markups) {
      expect(markup.some((item) => item.selector === 'colorBar')).toBe(false);
    }
  });

  // 不设 structure 家族（branch_split/branch_join）的 markup 用例：当前没有任何 NodeKind 映射到
  // 'structure' 形状家族（见 model/node-visual.ts NODE_SHAPE_FAMILY 注释），buildNodeVisual 的第二个
  // 参数类型是 GraphNodeView['type']（=NodeKind），已无法传 'branch_split'/'branch_join' 这两个
  // 字面量（'structure' 分支本身仍在 x6-adapter.ts 源码里保留，只是没有真实输入能走到它）。

  it('markup 恒含 summary 元素——不按"创建那一刻有没有摘要"条件加入（human/automatic/capsule 三家族）', () => {
    // buildNodeVisual 不接收摘要文本入参，天然不可能按"有没有摘要"分叉 markup；
    // 这里显式断言三个非 structure 家族的 markup 里都能找到 summary 文本元素，锁死这一条
    // 不回归——否则会出现"创建时没摘要 → 元素不存在 → 之后摘要从无变有也出不来"。
    const markups = [buildNodeVisual('human', 'approve'), buildNodeVisual('automatic', 'subflow'), buildNodeVisual('capsule', 'end')];
    for (const markup of markups) {
      expect(markup.some((item) => item.tagName === 'text' && item.selector === 'summary')).toBe(true);
    }
  });
});

describe('graph/x6-adapter applyNodeVisual', () => {
  it('position 随 view.position 同步', () => {
    const { cell, position } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ position: { x: 120, y: 40 } }));
    expect(position()).toEqual({ x: 120, y: 40 });
  });

  it('有摘要时标题上移(refY=0.38)、摘要文本为 trim 后的内容；无摘要时标题回落单行居中(refY=0.5)、摘要文本置空', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ summary: '  处理人：张三  ' }));
    expect((attrs().label as { refY: number }).refY).toBe(0.38);
    expect((attrs().summary as { text: string }).text).toBe('处理人：张三');

    // 同一个 cell 上再 apply 一次"无摘要"的 view——这正是"审批人从有配置改成没配置"或反过来
    // 的真实场景（更新分支必须同步 summary/label refY）。
    applyNodeVisual(cell, makeNodeView({ summary: '' }));
    expect((attrs().label as { refY: number }).refY).toBe(0.5);
    expect((attrs().summary as { text: string }).text).toBe('');
  });

  // "仅靠图标块着色区分类型"——body 描边不按节点类型着色，正常态恒为中性灰
  // NEUTRAL.border（#D8DCE2），只有 hasIssues 命中才转红；fill 恒为白色。
  it('hasIssues=false：body 恒为白底 + 中性灰描边（#D8DCE2）——不按节点类型着色', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ type: 'approve', hasIssues: false }));
    const approveBody = attrs().body as { fill: string; stroke: string; strokeWidth: number };
    expect(approveBody.fill).toBe('#ffffff');
    expect(approveBody.stroke).toBe('#D8DCE2');
    expect(approveBody.strokeWidth).toBe(1.5);

    // 换一个完全不同色相的节点类型（subflow=绿色系）：body 描边仍是同一个中性灰，不随类型变化
    // ——这正是"家族/类型间没有描边差异"的核心判据，不是巧合撞色。
    applyNodeVisual(cell, makeNodeView({ type: 'subflow', hasIssues: false }));
    const subflowBody = attrs().body as { fill: string; stroke: string };
    expect(subflowBody.fill).toBe('#ffffff');
    expect(subflowBody.stroke).toBe('#D8DCE2');
  });

  it('hasIssues=true：body 的 stroke 与 strokeWidth 都转为校验错误红', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ hasIssues: true }));
    const issue = attrs().body as { stroke: string; strokeWidth: number };
    expect(issue.stroke).toBe('#ff4d4f');
    expect(issue.strokeWidth).toBe(2.5);
  });

  // 图标块：26×26 圆角 7，左边距 12、垂直居中；fill 取该类型的 iconBg（approve=浅蓝，见
  // design-tokens.ts NODE_TYPE_TOKENS）。
  it('iconBg：26×26 圆角 7，左边距 12（refX）、垂直居中（refY=0.5,yAlign=middle），fill=该类型 iconBg 色', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ type: 'approve' }));
    const iconBg = attrs().iconBg as { width: number; height: number; rx: number; ry: number; fill: string; refX: number; refY: number; yAlign: string };
    expect(iconBg.width).toBe(26);
    expect(iconBg.height).toBe(26);
    expect(iconBg.rx).toBe(7);
    expect(iconBg.ry).toBe(7);
    expect(iconBg.fill).toBe('#EAF2FF'); // NODE_TYPE_TOKENS.approve.iconBg
    expect(iconBg.refX).toBe(12);
    expect(iconBg.refY).toBe(0.5);
    expect(iconBg.yAlign).toBe('middle');
  });

  it('icon：fill/stroke 取该类型的 iconColor（approve=品牌蓝 #1464E0）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ type: 'approve' })); // approve 图标是描边风格（fill:false）
    const icon = attrs().icon as { fill: string; stroke: string };
    expect(icon.fill).toBe('none');
    expect(icon.stroke).toBe('#1464E0');
  });

  it('胶囊家族（start/end）：body 的 rx/ry = CAPSULE_HEIGHT/2 = 28（胶囊独立尺寸 168×56）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ type: 'start' }));
    const body = attrs().body as { rx: number; ry: number };
    expect(body.rx).toBe(28);
    expect(body.ry).toBe(28);
  });

  it('普通业务节点（human/automatic 家族）：body 的 rx/ry = 10', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ type: 'approve' }));
    const body = attrs().body as { rx: number; ry: number };
    expect(body.rx).toBe(10);
    expect(body.ry).toBe(10);
  });

  // 不设 structure 家族（分支点/汇合点）的 applyNodeVisual 用例：makeNodeView 无法构造出
  // type:'branch_split' 的合法 GraphNodeView（原因同上方 buildNodeVisual 的说明）。

  it('幂等性：对同一个假 cell 连续 apply 同一个 view 两次，产生的属性结果一致', () => {
    const { cell, attrs } = makeFakeNodeCell();
    const view = makeNodeView({ summary: '处理人：张三', hasIssues: true });
    applyNodeVisual(cell, view);
    const first = JSON.stringify(attrs());
    applyNodeVisual(cell, view);
    expect(JSON.stringify(attrs())).toBe(first);
  });

  it('apply 两个不同 view 后，结果等于直接 apply 后者——不残留前一个 view 的状态（摘要从有变无场景）', () => {
    const { cell: sequentialCell, attrs: sequentialAttrs } = makeFakeNodeCell();
    applyNodeVisual(sequentialCell, makeNodeView({ summary: '处理人：张三' }));
    applyNodeVisual(sequentialCell, makeNodeView({ summary: '' }));

    const { cell: directCell, attrs: directAttrs } = makeFakeNodeCell();
    applyNodeVisual(directCell, makeNodeView({ summary: '' }));

    expect(JSON.stringify(sequentialAttrs())).toBe(JSON.stringify(directAttrs()));
    expect((sequentialAttrs().summary as { text: string }).text).toBe('');
  });

  // "待配置"橙标：needsConfig=true 时摘要文字转橙（与设计器顶栏"未保存"同一个
  // #fa8c16），false 时保持灰色——颜色计算与摘要文案是否为空无关（DesignerRoot.vue 负责把
  // 具体文案/占位文案装进 view.summary，本函数只管配色，见 applyNodeVisual 里 summary attrs
  // 的注释）。
  it('needsConfig=true/false：summary 文字色随之在橙/灰之间切换', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ summary: '未设置处理人', needsConfig: true }));
    expect((attrs().summary as { fill: string }).fill).toBe('#fa8c16');

    // 灰色读 design-tokens.ts NEUTRAL.textSecondary（#8F959E，按 token 权威源的书写形式断言）。
    applyNodeVisual(cell, makeNodeView({ summary: '处理人：张三', needsConfig: false }));
    expect((attrs().summary as { fill: string }).fill).toBe('#8F959E');
  });

  it('幂等性：needsConfig 橙标连续 apply 同一个 view 两次结果一致；换成另一个 view 后不残留橙色', () => {
    const { cell, attrs } = makeFakeNodeCell();
    const orangeView = makeNodeView({ summary: '未设置处理人', needsConfig: true });
    applyNodeVisual(cell, orangeView);
    const first = JSON.stringify(attrs());
    applyNodeVisual(cell, orangeView);
    expect(JSON.stringify(attrs())).toBe(first);

    applyNodeVisual(cell, makeNodeView({ summary: '处理人：张三', needsConfig: false }));
    // 同上：对齐 NEUTRAL.textSecondary 的书写形式 #8F959E。
    expect((attrs().summary as { fill: string }).fill).toBe('#8F959E');
  });
});

describe('graph/x6-adapter applyNodeVisual 选中态', () => {
  it('selected=true：body 描边换品牌蓝 PRIMARY_COLOR 并加粗到 2px，底色改用 selectedFill 轻微着色，root 打 data-selected="true"', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ selected: true, hasIssues: false }));
    const body = attrs().body as { stroke: string; strokeWidth: number; fill: string };
    expect(body.stroke).toBe('#1464E0');
    // 🔴 strokeWidth 选中态加粗到 2px——只换色不够醒目，选中样式要求描边加粗。
    expect(body.strokeWidth).toBe(2);
    expect(body.fill).toBe(LIGHT_PALETTE.selectedFill);
    // root/data-selected 是 applyNodeVisual 把选中态写进节点根 <g> DOM 属性的唯一路径（见该
    // 函数头注释"data-selected 落 DOM 的路径"），fake cell 按原始 path 字符串记录，直接断言。
    expect(attrs()['root/data-selected']).toBe('true');
  });

  it('selected=true：root 打上外圈光环 filter（内层 1px 实描边 + 外层 4px selectionGlow 柔光，两层 drop-shadow 叠加）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ selected: true }));
    const filter = attrs()['root/style/filter'] as string;
    expect(filter).toContain(`drop-shadow(0 0 1px ${LIGHT_PALETTE.primary})`);
    expect(filter).toContain(`drop-shadow(0 0 4px ${LIGHT_PALETTE.selectionGlow})`);
  });

  it('selected=false：body 描边保持中性灰、底色保持 surface 原色，root 打 data-selected="false"、filter 清空为 none（显式两态，不留残留）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ selected: false }));
    const body = attrs().body as { stroke: string; fill: string };
    expect(body.stroke).toBe('#D8DCE2');
    expect(body.fill).toBe(LIGHT_PALETTE.surface);
    expect(attrs()['root/data-selected']).toBe('false');
    expect(attrs()['root/style/filter']).toBe('none');
  });

  it('hasIssues 优先于 selected：两者同时为 true 时描边仍是校验错误红（校验问题比选中态更需要被看见），但光环照常叠加（两者是独立信号）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ selected: true, hasIssues: true }));
    const body = attrs().body as { stroke: string; strokeWidth: number };
    expect(body.stroke).toBe('#ff4d4f');
    expect(body.strokeWidth).toBe(2.5);
    // 光环不受 hasIssues 影响，只看 selected——"问题节点被选中时同样要能看出正在编辑它"。
    const filter = attrs()['root/style/filter'] as string;
    expect(filter).toContain(`drop-shadow(0 0 1px ${LIGHT_PALETTE.primary})`);
  });

  // 不设 structure 家族（branch_split）选中态用例，原因同上方结构家族说明。

  it('四角手柄：selected=true 时四个 selectHandleXX 均显示（8×8 圆角 2、白底蓝边），selected=false 时均隐藏', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ selected: true }));
    for (const selector of ['selectHandleTL', 'selectHandleTR', 'selectHandleBL', 'selectHandleBR']) {
      const handle = attrs()[selector] as {
        width: number;
        height: number;
        rx: number;
        ry: number;
        fill: string;
        stroke: string;
        strokeWidth: number;
        style: { display: string };
      };
      expect(handle.width).toBe(8);
      expect(handle.height).toBe(8);
      expect(handle.rx).toBe(2);
      expect(handle.ry).toBe(2);
      expect(handle.fill).toBe('#ffffff');
      expect(handle.stroke).toBe('#1464E0');
      expect(handle.strokeWidth).toBe(1.5);
      // 🔴 反向验证锚点：若 applyNodeVisual 漏调 applySelectionHandles（比如只在 buildNodeVisual
      // 建了 markup、apply 里忘了控显隐），这里 display 会读到 'none'（初始未设置态的语义），
      // 断言随之变红。
      expect(handle.style.display).toBe('');
    }

    applyNodeVisual(cell, makeNodeView({ selected: false }));
    for (const selector of ['selectHandleTL', 'selectHandleTR', 'selectHandleBL', 'selectHandleBR']) {
      expect((attrs()[selector] as { style: { display: string } }).style.display).toBe('none');
    }
  });

  it('四角手柄坐标：左/上用负偏移居中于角点，右/下用 100%+负偏移居中于角点（与节点尺寸无关的相对定位公式）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({ selected: true }));
    expect(attrs().selectHandleTL).toMatchObject({ refX: -4, refY: -4 });
    expect(attrs().selectHandleTR).toMatchObject({ refX: '100%', refX2: -4, refY: -4 });
    expect(attrs().selectHandleBL).toMatchObject({ refX: -4, refY: '100%', refY2: -4 });
    expect(attrs().selectHandleBR).toMatchObject({ refX: '100%', refX2: -4, refY: '100%', refY2: -4 });
  });

  it('幂等性：选中态连续 apply 两次结果一致；selected 从 true 切到 false 后不残留蓝色描边/常显手柄/光环', () => {
    const { cell, attrs } = makeFakeNodeCell();
    const selectedView = makeNodeView({ selected: true });
    applyNodeVisual(cell, selectedView);
    const first = JSON.stringify(attrs());
    applyNodeVisual(cell, selectedView);
    expect(JSON.stringify(attrs())).toBe(first);

    applyNodeVisual(cell, makeNodeView({ selected: false }));
    expect((attrs().body as { stroke: string; fill: string }).stroke).toBe('#D8DCE2');
    expect((attrs().body as { stroke: string; fill: string }).fill).toBe(LIGHT_PALETTE.surface);
    expect((attrs().selectHandleTL as { style: { display: string } }).style.display).toBe('none');
    expect(attrs()['root/style/filter']).toBe('none');
  });

  // 🔴 反向验证锚点：GraphNodeView.selected 是可选字段，未显式传 selected 的视图对象
  // 不应被误判为选中态——未传时必须按 false 处理，不能因为"没传"就意外常显选中视觉。
  it('selected 未传时按 false 处理（可选字段的缺省语义）', () => {
    const { cell, attrs } = makeFakeNodeCell();
    applyNodeVisual(cell, makeNodeView({}));
    expect(attrs()['root/data-selected']).toBe('false');
    expect((attrs().selectHandleTL as { style: { display: string } }).style.display).toBe('none');
    expect(attrs()['root/style/filter']).toBe('none');
  });
});

describe('graph/x6-adapter applyEdgeVisual', () => {
  const ports = { source: 'port-right', target: 'port-left' };

  it('source/target 按传入的 ports 参数设置', () => {
    const { cell, source, target, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView(), ports);
    expect(source()).toEqual({ cell: 'n-1', port: 'port-right' });
    expect(target()).toEqual({ cell: 'n-2', port: 'port-left' });
    expect(attrs()['root/data-edge-id']).toBe('e-1');
    expect(attrs()['root/data-from-node-id']).toBe('n-1');
    expect(attrs()['root/data-to-node-id']).toBe('n-2');
  });

  it('重复 apply 时根 DOM 身份随业务端点更新，不残留首次渲染值', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView(), ports);
    applyEdgeVisual(cell, makeEdgeView({ from: 'n-3', to: 'n-4' }), ports);
    expect(attrs()['root/data-edge-id']).toBe('e-1');
    expect(attrs()['root/data-from-node-id']).toBe('n-3');
    expect(attrs()['root/data-to-node-id']).toBe('n-4');
  });

  it('hasIssues=true/false：line 的 stroke 与 strokeWidth 都随之变化', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ hasIssues: false }), ports);
    const normal = attrs().line as { stroke: string; strokeWidth: number };
    // 默认线色/线宽：design-tokens.ts NEUTRAL.edge（#7A828E）/1.8px。
    expect(normal.stroke).toBe('#7A828E');
    expect(normal.strokeWidth).toBe(1.8);

    applyEdgeVisual(cell, makeEdgeView({ hasIssues: true }), ports);
    const issue = attrs().line as { stroke: string; strokeWidth: number };
    expect(issue.stroke).toBe('#ff4d4f');
    expect(issue.strokeWidth).toBe(2.2);
  });

  it('line 的 targetMarker 是自定义 path 箭头（marker 视口 9×7），不是内置 block 预设', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView(), ports);
    const marker = (attrs().line as { targetMarker: { name: string; d: string; width: number; height: number } }).targetMarker;
    // 🔴 尖端必须画在 d 的"低 x"一侧（M10 0 L0 4 L10 8，尖端在 x=0）——见
    // applyEdgeVisual 里 targetMarker 那处注释：X6 的 targetMarker 对 marker-end 无条件叠加一次
    // `rotate(180)`，尖端画在"高 x"一侧（如 M0 0 L10 4 L0 8，尖端在 x=10）会被这记内置翻转
    // 成指向 -x（逆着连线前进方向），表现为箭头反指。本用例是箭头方向的唯一守护——
    // 只断言这一份精确的 d 字符串，不接受任何"看起来差不多"的等价写法。
    expect(marker).toEqual({ name: 'path', d: 'M10 0 L0 4 L10 8 Z', width: 9, height: 7 });
  });

  // 🔴 反证：applyEdgeVisual 是纯视觉计算，从未在 line attrs 里写过 sourceMarker——
  // 选中态多出的"反向箭头"另有其因（'edge:click' 里 addTools 的 source-arrowhead 交互工具，
  // 与这里的静态 marker 是完全不同的两套机制，见 bindGraphEvents 里 'edge:click' 处的注释），
  // 这条用例锁死"这里不该有、也确实没有 sourceMarker"这件事，避免以后有人手滑在这里补一个。
  it('line attrs 不包含 sourceMarker——source 端不渲染任何静态箭头', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView(), ports);
    expect((attrs().line as { sourceMarker?: unknown }).sourceMarker).toBeUndefined();
  });

  it('isElseRoute=true 时 line 走虚线（6 4），false/未设置时恢复实线', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ isElseRoute: true }), ports);
    expect((attrs().line as { strokeDasharray: string }).strokeDasharray).toBe('6 4');

    applyEdgeVisual(cell, makeEdgeView({ isElseRoute: false }), ports);
    expect((attrs().line as { strokeDasharray: string }).strokeDasharray).toBe('');
  });

  // 连线标识：条件分支＝fx 珠、默认路线＝「默」珠、按钮流转＝按钮名短标签、
  // 普通无条件直连＝不显示任何标记。condition/else 珠为
  // 22×22 正圆（circle r=11），配色读 design-tokens.ts MARKER_TOKENS，不走原生 title
  // 悬停（走 tooltip 透传字段，见 x6-adapter.ts buildMarkerLabelConfig 头注释）。
  it('marker.kind="condition" 且 configured=true：fx 珠正圆 + 品牌蓝描边/文字 + Georgia 斜体', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'condition', shortLabel: 'fx', configured: true, tooltip: '金额较大' } }), ports);
    expect(labels()).toEqual([
      {
        position: 0.5,
        tooltip: '金额较大', // 不是原生 title attr，走独立透传字段供 onEdgeLabelRendered 读取
        markup: [
          { tagName: 'circle', selector: 'body' },
          { tagName: 'text', selector: 'label' }
        ],
        attrs: {
          // fx 珠：Georgia 衬线斜体 11px 700，fill 读 design-tokens.ts PRIMARY_COLOR。
          label: { text: 'fx', fill: '#1464E0', fontSize: 11, fontWeight: 700, fontFamily: 'Georgia, serif', fontStyle: 'italic' },
          // 22×22 正圆（r=11）、白底 + 品牌蓝描边。
          body: { r: 11, fill: '#ffffff', stroke: '#1464E0', strokeWidth: 1.5, style: { filter: 'drop-shadow(0 1px 4px rgba(15, 23, 42, .14))' } }
        }
      }
    ]);
  });

  it('marker.kind="condition" 且 configured=false：fx 珠仍正圆，橙色警示语义（同节点"待配置"橙色语义），与已配置态可区分', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'condition', shortLabel: 'fx', configured: false, tooltip: '未设置条件' } }), ports);
    const body = (labels()[0] as { attrs: { body: { fill: string; stroke: string; r: number } } }).attrs.body;
    // 白底不变（三态统一白底，见 MARKER_TOKENS 头注释），只有描边/文字色随"待配置"态变化。
    expect(body.fill).toBe('#ffffff');
    expect(body.r).toBe(11);
    expect(body.stroke).toBe('#FFD591');
    expect((labels()[0] as { attrs: { label: { fill: string } } }).attrs.label.fill).toBe('#D46B08');
  });

  it('marker.kind="else"：显示「默」珠，正圆 + 中性灰描边、字体不设 fontFamily/fontStyle（"正体继承字体"）', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'else', shortLabel: '默', tooltip: '其他情况' } }), ports);
    expect(labels()).toEqual([
      {
        position: 0.5,
        tooltip: '其他情况',
        markup: [
          { tagName: 'circle', selector: 'body' },
          { tagName: 'text', selector: 'label' }
        ],
        attrs: {
          // 默珠：10px 600、不带 fontFamily/fontStyle（继承默认字体、正体），fill 复用
          // NEUTRAL.textSecondary（#8F959E）。
          label: { text: '默', fill: '#8F959E', fontSize: 10, fontWeight: 600 },
          body: { r: 11, fill: '#ffffff', stroke: '#C9CDD4', strokeWidth: 1.5, style: { filter: 'drop-shadow(0 1px 4px rgba(15, 23, 42, .14))' } }
        }
      }
    ]);
  });

  // button 态为自定义 markup（白底胶囊 + 6×6 语义色圆点 + 文字），不沿用 X6 内置默认 rect+text。
  it('marker.kind="button"：白底胶囊（壳配色 MARKER_TOKENS.button）+ 语义色圆点 + 按钮名文字', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(
      cell,
      makeEdgeView({ marker: { kind: 'button', shortLabel: '同意', buttonColor: '#16A34A', tooltip: '同意' } }),
      ports
    );
    const label = labels()[0] as {
      markup?: { tagName: string; selector: string }[];
      attrs: { body: { fill: string; stroke: string; height: number }; dot: { fill: string; r: number }; label: { text: string; fill: string } };
    };
    expect(label.markup).toEqual([
      { tagName: 'rect', selector: 'body' },
      { tagName: 'circle', selector: 'dot' },
      { tagName: 'text', selector: 'label' }
    ]);
    // 胶囊壳：白底 + design-tokens.ts MARKER_TOKENS.button 描边/文字色，高度固定 22。
    expect(label.attrs.body.fill).toBe('#ffffff');
    expect(label.attrs.body.stroke).toBe('#E1E4E9');
    expect(label.attrs.body.height).toBe(22);
    // 语义色圆点：色值原样来自 marker.buttonColor（这里传的语义绿）。
    expect(label.attrs.dot.fill).toBe('#16A34A');
    expect(label.attrs.dot.r).toBe(3); // 6×6 -> 半径 3
    // 文字：按钮名 + 壳配色文字色 #4E5561。
    expect(label.attrs.label.text).toBe('同意');
    expect(label.attrs.label.fill).toBe('#4E5561');
  });

  it('marker.kind="button" 且未提供 buttonColor（调用方只传 buttonLabel）：圆点退回中性灰兜底，不报错', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'button', shortLabel: '退回', tooltip: '退回' } }), ports);
    const dot = (labels()[0] as { attrs: { dot: { fill: string } } }).attrs.dot;
    // 中性灰兜底＝MARKER_TOKENS.else.stroke（"默"珠既有色相，不新造语义色，见 buildMarkerLabelConfig 注释）。
    expect(dot.fill).toBe('#C9CDD4');
  });

  it('marker.kind="none" 或 marker 缺省：不显示任何标记（无条件直连无任何标记）', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'none', shortLabel: '', tooltip: '' } }), ports);
    expect(labels()).toEqual([]);

    applyEdgeVisual(cell, makeEdgeView({ marker: undefined }), ports);
    expect(labels()).toEqual([]);
  });

  // 'name' 态（画布中点珠子只认名称）：白底胶囊，无 button 态那颗语义色
  // 圆点，文字直接居中；配色复用 conditionConfigured（品牌蓝描边+品牌蓝文字，见
  // buildMarkerLabelConfig 头注释"🔴"一节"palette 没有单独一档浅描边 token，复用最接近取值"）。
  // 🔴 宽度/位置用 X6 markup 的 ref 相对定位——外壳跟随文字真实渲染宽度，
  // 每个轴只保留一个位置属性（refX）、一个尺寸属性（refWidth），refHeight/refY 显式 null 关掉
  // 默认的"跟随文字高度/纵向相对定位"（若同时给 refX 和 refX2、refHeight 和 refHeight2
  // 两两一组，会被累加/按"值+文字尺寸"误算，例如高度变成 24+文字高、位置多偏半个文字宽，见函数
  // 头注释"🔴 ref 配方"一节）。本组用例钉死三件事：① body 顶层 key 下只有
  // 视觉属性 + 固定的 y/height 两个普通几何属性，不出现 x/width（交给 rect 的 ref 属性算）；
  // ② rect key 的 refHeight/refY 确实是 null（覆盖默认的 1/0，不是被跳过残留），且没有任何
  // `*2` 系列键；③ 只用一份 rx/ry 圆角。
  it('marker.kind="name"：连线名称珠——body 给视觉属性+固定 y/height，rect key 给 ref 相对定位（每轴一个位置/尺寸属性，null 关默认值）', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'name', shortLabel: '审批', tooltip: '审批' } }), ports);
    const label = labels()[0] as {
      markup?: { tagName: string; selector: string }[];
      attrs: { body: Record<string, unknown>; rect: Record<string, unknown>; label: Record<string, unknown> };
    };
    expect(label.markup).toEqual([
      { tagName: 'rect', selector: 'body' },
      { tagName: 'text', selector: 'label' }
    ]);
    // body：视觉属性——白底 + 品牌蓝描边 + 阴影，没有 dot 选择器（没有语义色圆点）；外加固定的
    // 垂直位置/高度（高度是固定值，不需要相对文字包围盒计算，直接给绝对值最简单可靠）。
    expect(label.attrs.body.fill).toBe('#ffffff');
    expect(label.attrs.body.stroke).toBe('#1464E0');
    expect(label.attrs.body.strokeWidth).toBe(1);
    expect(label.attrs.body.y).toBe(-12);
    expect(label.attrs.body.height).toBe(24);
    // 🔴 钉死回归：body 下不出现 x/width（交给 rect 的 refX/refWidth 算，不是本文件算好的绝对值）。
    expect(label.attrs.body).not.toHaveProperty('x');
    expect(label.attrs.body).not.toHaveProperty('width');
    // rect：同一个 DOM 元素、走 X6 默认按标签名 'rect' 命中的那条合并链路，这里覆盖它的
    // ref/refWidth/refX/refHeight/refY/rx/ry 字段——每轴/每维度只有一个属性，没有 `*2` 系列键。
    expect(label.attrs.rect).toEqual({
      ref: 'label',
      refWidth: 20,
      refX: -10,
      refHeight: null,
      refY: null,
      rx: 12,
      ry: 12
    });
    expect(label.attrs.rect).not.toHaveProperty('refWidth2');
    expect(label.attrs.rect).not.toHaveProperty('refHeight2');
    expect(label.attrs.rect).not.toHaveProperty('refX2');
    expect(label.attrs.rect).not.toHaveProperty('refY2');
    // 文字：珠子文案 + 品牌蓝文字色 + 居中锚点（没有 button 态的 x 偏移/start 对齐）。
    expect(label.attrs.label.text).toBe('审批');
    expect(label.attrs.label.fill).toBe('#1464E0');
    expect(label.attrs.label.textAnchor).toBe('middle');
    expect(label.attrs.label.textVerticalAnchor).toBe('middle');
  });

  it('marker.kind="name" 且名称更长：rect 的 ref 配方与文字内容无关（宽度交给 X6 按 refWidth:20 读文字真实渲染宽度再加内边距计算，不是本文件按字符数算出来的）', () => {
    const { cell, labels } = makeFakeEdgeCell();
    applyEdgeVisual(cell, makeEdgeView({ marker: { kind: 'name', shortLabel: '审批意见较长一些', tooltip: '审批意见较长一些' } }), ports);
    const label = labels()[0] as { attrs: { rect: Record<string, unknown>; label: { text: string } } };
    // 换了更长的文案，rect 的 ref 配方不变（同一份 NAME_BEAD_* 常量派生），真正的胶囊宽度由 X6
    // 在渲染期按 setWrapper 语义（refWidth=20 不在 [0,1] ⇒ 宽度=文字真实宽度+20）读文字真实
    // 包围盒算出，不是本文件按字符数估算出来的——因此这里只需确认 rect 配方没有随文案变化
    // （证明宽度计算已经完全交给 X6），以及文字本身确实是这条更长的文案。
    expect(label.attrs.rect).toEqual({
      ref: 'label',
      refWidth: 20,
      refX: -10,
      refHeight: null,
      refY: null,
      rx: 12,
      ry: 12
    });
    expect(label.attrs.label.text).toBe('审批意见较长一些');
  });

  // "是否条件分支"驱动线色，读 GraphEdgeView.hasCondition 这个独立字段，不读 marker.kind——
  // marker 只表达"名称珠"，与线色完全解耦，见 applyEdgeVisual 头注释"🔴"一节。
  it('hasCondition=true 时 line 走蓝色，与 marker 是否存在/是何 kind 完全无关；hasCondition=false 时线保持中性灰', () => {
    const { cell, attrs } = makeFakeEdgeCell();
    // 有条件但没起名字（marker 因此是 'none'，不画珠）——线仍要走蓝色。
    applyEdgeVisual(cell, makeEdgeView({ hasCondition: true, marker: { kind: 'none', shortLabel: '', tooltip: '' } }), ports);
    expect((attrs().line as { stroke: string }).stroke).toBe('#1464E0');

    // hasCondition=false 时，哪怕 marker.kind 恰好是 'condition'（当前
    // toGraphEdges 不会产出这个组合，这里只为证明"线色不看 marker.kind"），线仍保持中性灰。
    applyEdgeVisual(cell, makeEdgeView({ hasCondition: false, marker: { kind: 'condition', shortLabel: 'fx', configured: true, tooltip: '' } }), ports);
    expect((attrs().line as { stroke: string }).stroke).toBe('#7A828E');
  });

  it('幂等性：连续 apply 同一个 view 两次结果一致；apply 两个不同 view 后等于直接 apply 后者', () => {
    const viewA = makeEdgeView({ hasIssues: true, isElseRoute: true, marker: { kind: 'else', shortLabel: '默', tooltip: '其他情况' } });
    const viewB = makeEdgeView({ hasIssues: false, isElseRoute: false, marker: undefined });

    const { cell: onceCell, attrs: onceAttrs, labels: onceLabels } = makeFakeEdgeCell();
    applyEdgeVisual(onceCell, viewA, ports);
    const snapshot1 = JSON.stringify({ attrs: onceAttrs(), labels: onceLabels() });
    applyEdgeVisual(onceCell, viewA, ports);
    expect(JSON.stringify({ attrs: onceAttrs(), labels: onceLabels() })).toBe(snapshot1);

    const { cell: seqCell, attrs: seqAttrs, labels: seqLabels } = makeFakeEdgeCell();
    applyEdgeVisual(seqCell, viewA, ports);
    applyEdgeVisual(seqCell, viewB, ports);

    const { cell: directCell, attrs: directAttrs, labels: directLabels } = makeFakeEdgeCell();
    applyEdgeVisual(directCell, viewB, ports);

    expect(JSON.stringify({ attrs: seqAttrs(), labels: seqLabels() })).toBe(
      JSON.stringify({ attrs: directAttrs(), labels: directLabels() })
    );
  });
});
