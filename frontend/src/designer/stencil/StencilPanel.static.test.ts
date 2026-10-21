import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { STENCIL_ITEMS } from './index';
import StencilPanel from './StencilPanel.vue';

const source = readFileSync(resolve(process.cwd(), 'src/designer/stencil/StencilPanel.vue'), 'utf8');

// 两个布局问题的静态守护（根因见 StencilPanel.vue 内两处“根因修复”注释）：
// ①形状列表底部出现假横向滚动条；②拖出条目时拖拽预览图“过宽/被拉伸”。
// 两个 bug 的根因都是同一个常驻布局的 hover 描述气泡 .workflow-stencil__tooltip，
// 只是触发路径不同——这组断言分别锁住两处修法，防止后续改动被无意间摘掉。
describe('StencilPanel 拖拽预览图 + 横向滚动条根因修复', () => {
  it('① .workflow-stencil__groups 显式声明 overflow-x: hidden，掐断 overflow-y:auto 隐式联动出的假横向滚动条', () => {
    expect(source).toMatch(/\.workflow-stencil__groups\s*\{[^}]*overflow-x:\s*hidden/);
    // 仍然保留纵向滚动这一既有功能，不是把整个滚动能力都关掉。
    expect(source).toMatch(/\.workflow-stencil__groups\s*\{[^}]*overflow-y:\s*auto/);
  });

  // 🔴 预览图是"该节点落到画布上之后的样子"（drag-preview.ts 在画布之外用 DOM 复刻），而不是
  // 克隆节点库条目按钮，指针锚在图样正中。②的根因（浏览器默认快照会把 hover 气泡抓进预览图）
  // 决定了守护点：必须自己调 setDragImage、图样必须来自
  // buildNodeDragPreview（它压根不含气泡/"拖拽"提示这两个子节点）、不得退回克隆按钮的旧写法。
  it('② dragstart 不依赖浏览器默认快照：图样来自 buildNodeDragPreview，经 setDragImage 接管', () => {
    expect(source).toContain("import { buildNodeDragPreview } from './drag-preview'");
    expect(source).toContain('buildNodeDragPreview({');
    expect(source).toContain('event.dataTransfer.setDragImage(');
  });

  it('② 指针锚在预览图正中（与松手后"节点中心对准指针"的落点口径一致）', () => {
    expect(source).toContain('event.dataTransfer.setDragImage(ghost, preview.width / 2, preview.height / 2)');
  });

  it('② 不再克隆节点库条目按钮本身当预览图（旧写法已退役，防止被改回去）', () => {
    expect(source).not.toContain('cloneNode(true)');
  });
});

// 节点库面板不渲染"只有标题、没有任何条目"的空分组（StencilGroup 只保留有成员的三档）。
// groupedItems 末尾的 `.filter((entry) => entry.items.length > 0)` 是这条规矩的双保险实现
// （见 StencilPanel.vue 该处头注释），本组用例把它当行为断言真实挂载验证，不只是读源码文本。
// 手法同 StencilPanel.hideTitle.test.ts："真实挂载 .vue，用 createApp 挂到一个 detached host"
// ——StencilPanel 本身不依赖 X6/DOM 布局测算，可以真实挂载，不需要假适配器。
describe('StencilPanel：不渲染空分组（groupedItems 双保险，真实挂载验收）', () => {
  const fakeI18n = {
    t: (key: string) => key,
    getLocale: () => 'zh-CN',
    onChange: () => () => undefined,
    setLocale: () => undefined,
    dispose: () => undefined
  };

  const mountedApps: Array<ReturnType<typeof createApp>> = [];

  function mountStencilPanel(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(StencilPanel, { i18n: fakeI18n });
    mountedApps.push(app);
    app.mount(host);
    return host;
  }

  afterEach(() => {
    mountedApps.splice(0).forEach((app) => app.unmount());
    document.body.innerHTML = '';
  });

  it('默认（无搜索）：渲染出来的分组数 == 有条目的分组数，不多不少', () => {
    const el = mountStencilPanel();
    const renderedGroups = el.querySelectorAll('[data-testid^="stencil-group-"]');
    const groupsWithItems = new Set(STENCIL_ITEMS.filter((item) => !item.hidden).map((item) => item.group));
    expect(renderedGroups.length).toBe(groupsWithItems.size);
  });

  it('搜索关键字不命中任何条目时：全部分组一并隐藏，不留下"只有标题没有条目"的空区块', async () => {
    const el = mountStencilPanel();
    const input = el.querySelector<HTMLInputElement>('[data-testid="stencil-search"] input')!;
    input.value = '__不存在的关键字__';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    expect(el.querySelectorAll('[data-testid^="stencil-group-"]').length).toBe(0);
    expect(el.querySelectorAll('.workflow-stencil__group-title').length).toBe(0);
  });
});
