/**
 * shell/DesignerStatusBar.static.test.ts —— 底部状态栏静态断言。
 *
 * 同 shell/CanvasToolbar.static.test.ts 头注释的既定手法：这里的硬约束都是"接线方式/数据来源"
 * 层面的，运行时组件测试不容易稳定锁住状态栏一整条数据流（依赖真实画布/文档状态），改用对
 * 源码文本的静态断言，覆盖以下几点：
 *   1) 状态栏必须真的接进了 DesignerRoot.vue，且在 `.wf-designer-body` 之后（三段式布局
 *      "TopBar → 工具栏 → 画布区 → 状态栏"从上到下的挂载顺序）；
 *   2) 节点/连线计数只能读 docSnapshot，严禁再读 state.doc（每次访问都会深拷贝整份文档，见
 *      model/document-state.ts doc getter 注释）——反向断言 DesignerStatusBar.vue 本身不出现
 *      `state.doc`/`state.value.doc` 字面量；
 *   3) 脏态必须经 changeTick 桥接成 computed，不能直接把 state.isDirty() 这个命令式查询当
 *      响应式值用（同 canUndo/canRedo 的既定手法）；
 *   4) 缩放滑块必须复用 DesignerRoot 已有的 toolbarZoomPercent，不能新建第二份缩放状态。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESIGNER_ROOT_PATH = 'src/designer/DesignerRoot.vue';
const STATUS_BAR_PATH = 'src/designer/shell/DesignerStatusBar.vue';

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** 剥掉块注释与行注释——本文件与被测文件里大量出现方法/字段名字面量（解释"为什么不这样做"），
 *  逐字节匹配会被这些描述性注释误伤，同 CanvasToolbar.static.test.ts stripComments() 的既定
 *  手法：判定目标必须是剥掉注释之后的代码体。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

describe('DesignerStatusBar 接线：状态栏真的挂进了 DesignerRoot，且在画布区（.wf-designer-body）之后', () => {
  it('DesignerRoot.vue 引入并使用了 DesignerStatusBar', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toContain("import DesignerStatusBar from './shell/DesignerStatusBar.vue'");
    expect(source).toMatch(/<DesignerStatusBar\b/);
  });

  it('模板里 <DesignerStatusBar 出现在 .wf-designer-body 打开之后（三段式布局：TopBar → 工具栏 → 画布区 → 状态栏）', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    const bodyIndex = source.indexOf('class="wf-designer-body"');
    const statusBarIndex = source.indexOf('<DesignerStatusBar');
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(statusBarIndex).toBeGreaterThan(-1);
    expect(statusBarIndex).toBeGreaterThan(bodyIndex);
  });

  // 属性面板是浮层 FloatingPropsPanel，挂在 .wf-designer-canvas-wrap 定位容器内，不是独立的右侧
  // 栏位（见 shell/FloatingPropsPanel.vue 头注释），所以锚点取"画布区里最后一个浮层组件"——验证
  // 状态栏声明在画布区全部内容之后，不是嵌在画布区内部。
  it('<DesignerStatusBar 出现在画布区最后一个浮层组件 <FloatingPropsPanel 之后（不是嵌在画布区内部）', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    const propsPanelIndex = source.lastIndexOf('<FloatingPropsPanel');
    const statusBarIndex = source.indexOf('<DesignerStatusBar');
    expect(propsPanelIndex).toBeGreaterThan(-1);
    expect(statusBarIndex).toBeGreaterThan(propsPanelIndex);
  });
});

describe('DesignerStatusBar 计数：只读 docSnapshot，严禁直接读 state.doc', () => {
  it('DesignerRoot.vue 新增的 nodeCount/linkCount computed 读的是 docSnapshot', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toMatch(/const nodeCount = computed\(\(\) => docSnapshot\.value\?\.nodes\.length \?\? 0\);/);
    expect(source).toMatch(/const linkCount = computed\(\(\) => docSnapshot\.value\?\.links\.length \?\? 0\);/);
  });

  it('DesignerStatusBar.vue 剥掉注释后的代码体不出现 state.doc/state.value.doc 字面量（本组件不持有文档状态，只读 props）', () => {
    const source = stripComments(readSource(STATUS_BAR_PATH));
    expect(source).not.toContain('state.doc');
    expect(source).not.toContain('state.value.doc');
  });

  it('DesignerStatusBar.vue 不 import model/document-state（佐证②：本组件确实不可能直接摸到 WorkflowDocumentState）', () => {
    const source = readSource(STATUS_BAR_PATH);
    expect(source).not.toContain("from '../../model/document-state'");
  });
});

describe('DesignerStatusBar 脏态：经 changeTick 桥接，不直接暴露命令式查询', () => {
  it('DesignerRoot.vue 新增的 isDirty computed 用 changeTick 桥接 state.isDirty()（同 canUndo/canRedo 既定写法）', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toMatch(/const isDirty = computed\(\(\) => \{\s*void changeTick\.value;\s*return state\.value\?\.isDirty\(\) \?\? false;\s*\}\);/);
  });

  it('DesignerStatusBar.vue 剥掉注释后的代码体不调用 isDirty()（纯展示 dirty prop，不自己查文档状态）', () => {
    const source = stripComments(readSource(STATUS_BAR_PATH));
    expect(source).not.toContain('isDirty()');
  });

  it('DesignerRoot.vue 把 isDirty 转手传给状态栏的 dirty prop', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toContain(':dirty="isDirty"');
  });
});

describe('DesignerStatusBar 缩放：复用 toolbarZoomPercent，不新建第二份缩放状态', () => {
  it('DesignerRoot.vue 把已有的 toolbarZoomPercent 转手传给状态栏的 zoom-percent prop', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toContain(':zoom-percent="toolbarZoomPercent"');
  });

  it('DesignerStatusBar.vue 剥掉注释后的代码体不出现 const ... = ref( 这类新建缩放状态的写法（只有 now 一个内部 ref，用于保存时间刷新，不是缩放）', () => {
    const source = stripComments(readSource(STATUS_BAR_PATH));
    const refDeclarations = source.match(/const \w+ = ref\(/g) ?? [];
    // 唯一允许存在的本地 ref 是 now（保存时间相对刷新用），不应再出现任何名字带 zoom 的 ref。
    for (const decl of refDeclarations) {
      expect(decl.toLowerCase()).not.toContain('zoom');
    }
  });

  it('DesignerStatusBar.vue 拖动滑块时把值原样 emit 给 zoom 事件，交由 DesignerRoot 调用 canvasRef.zoomToPercent()', () => {
    const source = readSource(STATUS_BAR_PATH);
    expect(source).toContain("(e: 'zoom', percent: number): void;");
    expect(source).toContain("emit('zoom', value)");
  });

  it('DesignerRoot.vue 的 onStatusBarZoom 转手调用 canvasRef.value?.zoomToPercent(percent)，本文件不重复钳值', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toMatch(/function onStatusBarZoom\(percent: number\): void \{\s*canvasRef\.value\?\.zoomToPercent\(percent\);\s*\}/);
  });
});

describe('DesignerStatusBar 检查项计数：同 IssuesBadge.vue 既定手法直接 inject，不经 props 转发', () => {
  it('DesignerStatusBar.vue 直接 inject(DESIGNER_ISSUES_KEY)，不接收 issues 相关 prop', () => {
    const source = readSource(STATUS_BAR_PATH);
    expect(source).toContain("import { DESIGNER_ISSUES_KEY } from '../issues/useIssues';");
    expect(source).toContain('inject(DESIGNER_ISSUES_KEY)');
  });
});

describe('TopBar 保存时间整套已迁出：TopBar.vue 不再持有 savedAt/savedText/30s 定时器', () => {
  it('TopBar.vue 不再声明 savedAt prop', () => {
    const source = readSource('src/designer/shell/TopBar.vue');
    expect(source).not.toContain('savedAt?:');
  });

  it('TopBar.vue 剥掉注释后的代码体不再出现 wf-topbar__saved / savedText / topbar.savedJustNow / topbar.savedMinutesAgo（注释里可能用文字提到这些名字，因此断言目标必须剥掉注释，同上面 DesignerStatusBar.vue 相关断言的既定手法）', () => {
    const source = stripComments(readSource('src/designer/shell/TopBar.vue'));
    expect(source).not.toContain('wf-topbar__saved');
    expect(source).not.toContain('savedText');
    expect(source).not.toContain('topbar.savedJustNow');
    expect(source).not.toContain('topbar.savedMinutesAgo');
  });

  it('DesignerRoot.vue 不再把 savedAt 传给 TopBar（改传给 DesignerStatusBar）', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    const topBarBlock = source.match(/<TopBar\b[\s\S]*?\/>/)?.[0] ?? '';
    const statusBarBlock = source.match(/<DesignerStatusBar\b[\s\S]*?\/>/)?.[0] ?? '';
    expect(topBarBlock.length).toBeGreaterThan(0);
    expect(topBarBlock).not.toContain('saved-at');
    expect(statusBarBlock).toContain(':saved-at="savedAt"');
  });
});

// ── 反向验证锚点：证明上面 stripComments 相关断言确实在检测东西，不是恒绿。 ──────────────────
describe('反向验证：stripComments 对真实代码有效，不会把注释误当代码', () => {
  it('含描述性注释 state.doc 的假源码，剥注释后不再命中 state.doc（证明注释本身不会误伤①），但真实代码行会命中（证明断言有牙齿）', () => {
    const fakeCommentOnly = '// 此前直接读 state.doc（历史说明，已废弃）\nconst x = 1;';
    const fakeRealUsage = 'const y = state.doc.nodes.length;';
    expect(stripComments(fakeCommentOnly)).not.toContain('state.doc');
    expect(stripComments(fakeRealUsage)).toContain('state.doc');
  });
});
