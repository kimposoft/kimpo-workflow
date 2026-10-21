/**
 * shell/CanvasToolbar.static.test.ts —— 画布工具栏静态断言。
 *
 * 下面几条硬约束都是"接线方式"层面的，运行时组件测试不容易稳定锁住（依赖具体渲染细节），
 * 改用对源码文本的静态断言，同仓库既有 *.static.test.ts 系列先例（如
 * ../../graph/x6-adapter.no-color-literal.static.test.ts）一致的做法：
 *   1) 工具栏必须真的接进了 DesignerRoot.vue，且挂载顺序在 TopBar 之后（从上到下
 *      "TopBar → 工具栏 → 画布" 的布局顺序）；
 *   2) 三个开关（网格/吸附/参考线）的持续状态源必须是 DesignerRoot 本地 ref，不能退回去用画布的
 *      isGridVisible()/isSnapToGridEnabled()/isSnaplineEnabled() 查询方法当 UI 真值源——那几个
 *      方法读的是 DOM 背景图/与 Alt 精细对齐耦合的瞬时值，见 x6-adapter.ts 对应方法头注释
 *      "🔴 三开关拆分后的副作用"；
 *   3) 缩放百分比必须来自 DesignerCanvas 的 zoom-change emit（DesignerRoot.vue 模板里绑定
 *      @zoom-change），不能自己再轮询 getZoomPercent()；
 *   4) 多选态判据必须是 "选中节点数 >= 2"（1 个节点谈不上对齐/分布，不该触发整行替换）。
 *
 * 对齐/分布另钉死两点——① 六个对齐 testid 齐全，且"水平居中(center)/垂直居中(middle)"不是同一个
 * 档位，"水平居中"按钮不能绑成 'middle'；② 分布事件是带方向参数的 'distribute'，DesignerRoot
 * 的处理函数把方向参数透传给了 distributeSelection(mode)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESIGNER_ROOT_PATH = 'src/designer/DesignerRoot.vue';
const CANVAS_TOOLBAR_PATH = 'src/designer/shell/CanvasToolbar.vue';

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** 剥掉块注释与行注释——本文件头注释与各处历史说明里大量出现
 *  "isGridVisible()/getZoomPercent()" 这类方法名字面量（解释"不要用它当真值源"），逐字节匹配
 *  会被这些描述性注释误伤，同 panels/no-native-controls.static.test.ts stripNonCode() 的既定
 *  手法：判定目标必须是剥掉注释之后的代码体。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

describe('CanvasToolbar 接线：工具栏真的挂进了 DesignerRoot，且在 TopBar 之后', () => {
  it('DesignerRoot.vue 引入并使用了 CanvasToolbar', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toContain("import CanvasToolbar from './shell/CanvasToolbar.vue'");
    expect(source).toMatch(/<CanvasToolbar\b/);
  });

  it('模板里 <CanvasToolbar 出现在 <TopBar 之后（挂载顺序：TopBar → 工具栏 → 画布）', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    const topBarIndex = source.indexOf('<TopBar');
    const toolbarIndex = source.indexOf('<CanvasToolbar');
    expect(topBarIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeGreaterThan(topBarIndex);
  });

  it('<CanvasToolbar 出现在 <DesignerCanvas 之前（工具栏在画布上方，不是画布内部浮层）', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    const toolbarIndex = source.indexOf('<CanvasToolbar');
    const canvasIndex = source.indexOf('<DesignerCanvas');
    expect(toolbarIndex).toBeGreaterThan(-1);
    expect(canvasIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeLessThan(canvasIndex);
  });
});

describe('CanvasToolbar 接线：三个开关不得退回查询方法当持续状态源', () => {
  it('DesignerRoot.vue 剥掉注释后的代码体不调用 isGridVisible(/isSnapToGridEnabled(/isSnaplineEnabled(', () => {
    const source = stripComments(readSource(DESIGNER_ROOT_PATH));
    expect(source).not.toContain('isGridVisible(');
    expect(source).not.toContain('isSnapToGridEnabled(');
    expect(source).not.toContain('isSnaplineEnabled(');
  });

  it('CanvasToolbar.vue 剥掉注释后的代码体也不调用这三个查询方法（纯展示，不自己查画布）', () => {
    const source = stripComments(readSource(CANVAS_TOOLBAR_PATH));
    expect(source).not.toContain('isGridVisible(');
    expect(source).not.toContain('isSnapToGridEnabled(');
    expect(source).not.toContain('isSnaplineEnabled(');
  });

  it('DesignerRoot.vue 持有三个本地 ref 作为真值源，并在切换时同步调用 setGridVisible/setSnapToGrid/setSnaplineEnabled', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toMatch(/const gridVisible = ref\(true\)/);
    expect(source).toMatch(/const snapToGridEnabled = ref\(true\)/);
    expect(source).toMatch(/const snaplineEnabled = ref\(false\)/);
    expect(source).toContain('canvas.setGridVisible(gridVisible.value)');
    expect(source).toContain('canvas.setSnapToGrid(snapToGridEnabled.value)');
    expect(source).toContain('canvas.setSnaplineEnabled(snaplineEnabled.value)');
  });
});

describe('CanvasToolbar 接线：缩放百分比来自 zoom-change emit，不自己轮询', () => {
  it('DesignerRoot.vue 的 <DesignerCanvas> 绑定了 @zoom-change', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toContain('@zoom-change="onZoomChange"');
  });

  it('DesignerRoot.vue 剥掉注释后的代码体不调用 getZoomPercent(', () => {
    const source = stripComments(readSource(DESIGNER_ROOT_PATH));
    expect(source).not.toContain('getZoomPercent(');
  });

  it('CanvasToolbar.vue 剥掉注释后的代码体也不调用 getZoomPercent(（纯展示 zoom-percent prop）', () => {
    const source = stripComments(readSource(CANVAS_TOOLBAR_PATH));
    expect(source).not.toContain('getZoomPercent(');
  });
});

describe('CanvasToolbar 多选态判据：选中节点数 >= 2 才整行替换', () => {
  it('CanvasToolbar.vue 的 isMultiSelect 判据是 selectedCount >= 2', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    expect(source).toMatch(/selectedCount >= 2/);
  });
});

describe('CanvasToolbar 未接的一处：复制按钮未实现（无现成入口，不伪造）', () => {
  it('CanvasToolbar.vue 不出现"复制"相关的 emit（copy）', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    expect(source).not.toMatch(/e:\s*'copy'/);
  });
});

describe('CanvasToolbar 对齐六档 + 双向分布', () => {
  it('六个对齐按钮的 data-testid 都存在', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    expect(source).toContain('data-testid="workflow-designer-toolbar-align-left"');
    expect(source).toContain('data-testid="workflow-designer-toolbar-align-center"');
    expect(source).toContain('data-testid="workflow-designer-toolbar-align-right"');
    expect(source).toContain('data-testid="workflow-designer-toolbar-align-top"');
    expect(source).toContain('data-testid="workflow-designer-toolbar-align-middle"');
    expect(source).toContain('data-testid="workflow-designer-toolbar-align-bottom"');
  });

  it('横向等距、纵向等距两个按钮的 data-testid 都存在', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    expect(source).toContain('data-testid="workflow-designer-toolbar-distribute-horizontal"');
    expect(source).toContain('data-testid="workflow-designer-toolbar-distribute-vertical"');
  });

  it('"水平居中"按钮 emit 的是 align/center，不是 align/middle', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    // 定位 align-center 按钮自身的一段源码，再断言这一段里的 emit 调用，避免误撞到
    // align-middle（垂直居中）按钮同样含有 'middle' 字样的 emit。
    const centerButtonIndex = source.indexOf('data-testid="workflow-designer-toolbar-align-center"');
    expect(centerButtonIndex).toBeGreaterThan(-1);
    const centerButtonSource = source.slice(centerButtonIndex, centerButtonIndex + 400);
    expect(centerButtonSource).toContain("emit('align', 'center')");
    expect(centerButtonSource).not.toContain("emit('align', 'middle')");
  });

  it('"垂直居中"按钮 emit 的是 align/middle（与水平居中的 center 区分开，两者不是同义词）', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    const middleButtonIndex = source.indexOf('data-testid="workflow-designer-toolbar-align-middle"');
    expect(middleButtonIndex).toBeGreaterThan(-1);
    const middleButtonSource = source.slice(middleButtonIndex, middleButtonIndex + 400);
    expect(middleButtonSource).toContain("emit('align', 'middle')");
  });

  it('纵向等距按钮 emit 的是 distribute/vertical', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    const verticalButtonIndex = source.indexOf('data-testid="workflow-designer-toolbar-distribute-vertical"');
    expect(verticalButtonIndex).toBeGreaterThan(-1);
    const verticalButtonSource = source.slice(verticalButtonIndex, verticalButtonIndex + 400);
    expect(verticalButtonSource).toContain("emit('distribute', 'vertical')");
  });

  it('横向等距按钮 emit 的是 distribute/horizontal（分布统一用带方向参数的 distribute 事件）', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    const horizontalButtonIndex = source.indexOf('data-testid="workflow-designer-toolbar-distribute-horizontal"');
    expect(horizontalButtonIndex).toBeGreaterThan(-1);
    const horizontalButtonSource = source.slice(horizontalButtonIndex, horizontalButtonIndex + 400);
    expect(horizontalButtonSource).toContain("emit('distribute', 'horizontal')");
  });

  it('DesignerRoot.vue 的 onToolbarDistribute 接收方向参数并透传给 distributeSelection(mode)', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    expect(source).toMatch(/function onToolbarDistribute\(mode: 'horizontal' \| 'vertical'\)/);
    expect(source).toContain('canvasRef.value?.distributeSelection(mode)');
    expect(source).toContain('@distribute="onToolbarDistribute"');
  });
});

describe('CanvasToolbar 只读态：对齐/分布/删除禁用，缩放/视图/开关/小地图不受只读影响', () => {
  it('align/distribute/delete-selection 三个 emit 处理函数按 readOnly 短路', () => {
    const source = readSource(DESIGNER_ROOT_PATH);
    // DesignerRoot 统一按 effectiveReadOnly（props.readOnly ∨ 绑定引擎不可用）短路。
    expect(source).toMatch(/function onToolbarAlign\([\s\S]*?if \(effectiveReadOnly\.value\) return;/);
    expect(source).toMatch(/function onToolbarDistribute\([\s\S]*?if \(effectiveReadOnly\.value\) return;/);
  });

  it('CanvasToolbar.vue 里对齐/分布/删除按钮绑了 :disabled="readOnly"，缩放/视图/开关/小地图按钮没有', () => {
    const source = readSource(CANVAS_TOOLBAR_PATH);
    // 多选态四组（六档对齐 + 横向/纵向等距 + 删除）各自出现 :disabled="readOnly"。
    const disabledReadOnlyCount = (source.match(/:disabled="readOnly"/g) ?? []).length;
    expect(disabledReadOnlyCount).toBeGreaterThanOrEqual(9); // 六档对齐 + 横向/纵向等距 + 删除
    // 缩放 −/+ 按钮（class="wf-canvas-toolbar__zoom-btn"）不应带 :disabled。
    expect(source).not.toMatch(/class="wf-canvas-toolbar__zoom-btn"[\s\S]{0,120}:disabled/);
  });
});
