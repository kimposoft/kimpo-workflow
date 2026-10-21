/**
 * designer/panels/CcPanel.test.ts —— 抄送节点（N4）属性面板『再缩小范围』卡挂载测试。
 *
 * 『再缩小范围』卡需要真实交互（勾选/取消写回 config），静态正则覆盖不了，因此用
 * panel-test-helpers.ts 提供的 createApp 挂载工具（同 HandlePanel.test.ts/ApprovePanel.test.ts）
 * 单独覆盖这一张卡；其余接线覆盖在 CcPanel.static.test.ts，不重复。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { CCConfig, StartConfig, WorkflowNode } from '../../model';
import CcPanel from './CcPanel.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function buildDocWithCcNode(ccConfig: Partial<CCConfig> = {}) {
  const doc = createDefaultDocument('测试流程');
  const startNode = doc.nodes.find((n) => n.kind === 'start')!;
  startNode.config = {
    target_template_id: 'tpl_x',
    allow_manual_start: true,
    no_route_hint: '',
    start_permission: {}
  } satisfies StartConfig;
  const ccNode: WorkflowNode = {
    id: 'cc1',
    kind: 'cc',
    name: '',
    config: {
      recipients: [],
      channels: ['system'],
      title_expr: null,
      content_expr: null,
      ...ccConfig
    } satisfies CCConfig,
    position_x: 320,
    position_y: 200
  };
  doc.nodes.push(ccNode);
  return { doc, ccNode };
}

let mounted: MountedPanel<typeof CcPanel> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function ccConfigOf(state: ReturnType<typeof fakeState>): CCConfig {
  return state.value!.doc.nodes.find((n) => n.id === 'cc1')!.config as unknown as CCConfig;
}

describe('CcPanel：再缩小范围（与上步处理人的关系，过滤器）', () => {
  it('basic 分区渲染出该卡，位置在收件人卡之后', async () => {
    const { doc, ccNode } = buildDocWithCcNode();
    const state = fakeState(doc);
    mounted = mountPanel(CcPanel, { node: ccNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const basicPane = mounted.el.querySelector('[data-testid="cc-tab-basic"]') as HTMLElement;
    const titles = Array.from(basicPane.querySelectorAll('.wf-panel-section__title')).map((el) => el.textContent);
    expect(titles).toEqual(['从哪里选人', '再缩小范围']);
  });

  it('勾选一档：经 patchConfig 写回 config.relation_filters', async () => {
    const { doc, ccNode } = buildDocWithCcNode();
    const state = fakeState(doc);
    mounted = mountPanel(CcPanel, { node: ccNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="relation-filter-parent_department"]') as HTMLElement).click();
    await flush();

    expect(ccConfigOf(state).relation_filters).toEqual(['parent_department']);
  });

  it('取消唯一已勾选的档位：写回 undefined（不是空数组）', async () => {
    const { doc, ccNode } = buildDocWithCcNode({ relation_filters: ['parent_department'] });
    const state = fakeState(doc);
    mounted = mountPanel(CcPanel, { node: ccNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    (mounted.el.querySelector('[data-testid="relation-filter-parent_department"]') as HTMLElement).click();
    await flush();

    expect(ccConfigOf(state).relation_filters).toBeUndefined();
  });

  it('只读态：胶囊禁用，点击不产生写操作', async () => {
    const { doc, ccNode } = buildDocWithCcNode();
    const state = fakeState(doc);
    mounted = mountPanel(CcPanel, { node: ccNode, readOnly: true }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    const pill = mounted.el.querySelector('[data-testid="relation-filter-same_department"]') as HTMLElement;
    expect(pill.getAttribute('aria-disabled')).toBe('true');
    pill.click();
    await flush();

    expect(ccConfigOf(state).relation_filters).toBeUndefined();
  });
});
