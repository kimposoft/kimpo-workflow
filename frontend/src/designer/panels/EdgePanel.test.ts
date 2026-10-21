// designer/panels/EdgePanel.test.ts —— EdgePanel.vue（连线属性面板）行为单测，覆盖「连线
// 名称」输入：草稿 + 失焦/回车提交、选中另一条连线时草稿重置、
// 只读态不可编辑。写法沿用同目录 PanelHeader.test.ts 的挂载手法（panel-test-helpers.ts）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { WorkflowDocument, WorkflowLink } from '../../model';
import EdgePanel from './EdgePanel.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';

/** 同 PanelHeader.test.ts 既定手法：多轮 microtask 把交互触发的 Vue 响应式更新一并落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i++) await nextTick();
}

/** 造一份「发起节点 -> 办理节点」之间连一条线」的文档，返回该线与整份文档。 */
function buildLinkFixture(name?: string): { link: WorkflowLink; doc: WorkflowDocument } {
  const doc = createDefaultDocument('测试流程');
  const startId = doc.nodes[0].id;
  const handleId = 'handle_1';
  doc.nodes = [...doc.nodes, { id: handleId, kind: 'handle', config: { assignees: [], complete_mode: { kind: 'any' }, no_route_hint: '' } }];
  const link: WorkflowLink = { id: 'l1', from: startId, to: handleId, name };
  doc.links = [link];
  return { link, doc };
}

let mounted: MountedPanel<typeof EdgePanel> | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('EdgePanel：连线名称——展示态', () => {
  it('已有名称时输入框回显该名称', async () => {
    const { link, doc } = buildLinkFixture('审批通过');
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('审批通过');
  });

  it('没有名称时输入框为空', async () => {
    const { link, doc } = buildLinkFixture(undefined);
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('');
  });
});

describe('EdgePanel：连线名称——提交路径', () => {
  it('失焦提交：写回 updateLinkName', async () => {
    const { link, doc } = buildLinkFixture(undefined);
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    input.value = '金额较大';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.links.find((l) => l.id === link.id)!.name).toBe('金额较大');
  });

  it('回车提交：写回 updateLinkName', async () => {
    const { link, doc } = buildLinkFixture(undefined);
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    input.value = '回车提交后';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();

    expect(state.value!.doc.links.find((l) => l.id === link.id)!.name).toBe('回车提交后');
  });

  it('不是每敲一个字就写一次：只输入不失焦/不回车时不产生任何变更', async () => {
    const { link, doc } = buildLinkFixture(undefined);
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    input.value = '还没提交';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(state.value!.doc.links.find((l) => l.id === link.id)!.name).toBeUndefined();
    expect(state.value!.isDirty()).toBe(false);
  });

  it('清空后失焦：写回 undefined（不是空串）', async () => {
    const { link, doc } = buildLinkFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.links.find((l) => l.id === link.id)!.name).toBeUndefined();
  });
});

describe('EdgePanel：连线名称——选中另一条连线时草稿重置', () => {
  // 挂载测试工具一次性传入静态 props、不支持挂载后改写根组件 props（同 PanelHeader.test.ts
  // 该场景头注释既定说明），因此用"卸载旧实例、以新连线 props 重新挂载"模拟 PropsPanel.vue 真实
  // 选中态切换时"同一个 EdgePanel 组件实例、props.link 整体替换"的效果——EdgePanel.vue 内部
  // watch(() => props.link.id, …) 正是为这个切换场景写的，重新挂载后 nameDraft 的初值本就等于
  // watch 的目标结果，断言口径与真实运行时一致。
  it('切换到另一条（不同 id）连线后，输入框按新连线的名字重置，不残留上一条未提交的草稿', async () => {
    const { doc } = buildLinkFixture('原线的名字');
    const state = fakeState(doc);
    const firstLink = state.value!.doc.links[0];
    mounted = mountPanel(EdgePanel, { link: firstLink, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    input.value = '还没提交的草稿';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(input.value).toBe('还没提交的草稿');

    mounted.unmount();
    const nextLink: WorkflowLink = { id: 'l2', from: doc.nodes[0].id, to: doc.nodes[1].id, name: '新线的名字' };
    mounted = mountPanel(EdgePanel, { link: nextLink, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const nextInput = mounted.el.querySelector('input') as HTMLInputElement;
    expect(nextInput.value).toBe('新线的名字');
  });
});

describe('EdgePanel：连线名称——只读态', () => {
  it('只读态：输入框禁用，输入/失焦不产生写入', async () => {
    const { link, doc } = buildLinkFixture('原名字');
    const state = fakeState(doc);
    mounted = mountPanel(EdgePanel, { link, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const input = mounted.el.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    input.value = '只读态强改';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();

    expect(state.value!.doc.links.find((l) => l.id === link.id)!.name).toBe('原名字');
  });
});
