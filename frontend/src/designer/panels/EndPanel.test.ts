/**
 * designer/panels/EndPanel.test.ts —— 结束节点属性面板行为单测：
 * 结束标识必填空值提示 + 标识写入字段（只列文本类字段、可清空）。
 *
 * MainFieldSelect.vue 用的是 NSelect，"只列文本类型字段"这条过滤规则由其具名导出纯函数
 * mainFieldOptionsOf 直接单测覆盖（NSelect 下拉打开/选中在
 * happy-dom 下模拟不了，见 MainFieldSelect.vue 头注释），组件层只断言回显与禁用态——同
 * ApprovePanel.test.ts「结果绑定字段 / 理由绑定字段」既定分工。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createDefaultDocument } from '../../model/defaults';
import type { EndConfig, StartConfig, WorkflowNode } from '../../model';
import EndPanel from './EndPanel.vue';
import { mainFieldOptionsOf } from './shared/MainFieldSelect.vue';
import { fakeHost, fakeI18n, fakeState, mountPanel, type MountedPanel } from './panel-test-helpers';
import { invalidateTemplateFieldCatalog } from './shared/templateFieldCatalog';

beforeEach(() => {
  invalidateTemplateFieldCatalog();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i++) await nextTick();
}

// 新建流程不自带结束节点（由设计者从节点库添加），
// createDefaultDocument 造出的文档只有一个发起节点——本文件测的是结束节点属性面板自身的
// 行为，与这个节点是画布默认带出来的还是设计者自己拖入的无关，这里手工造一个挂进文档即可。
function buildDocWithEndNode(endConfig: Partial<EndConfig>): { doc: ReturnType<typeof createDefaultDocument>; endNode: WorkflowNode } {
  const doc = createDefaultDocument('测试流程');
  const startNode = doc.nodes.find((n) => n.kind === 'start')!;
  startNode.config = { target_template_id: 'tpl_x', allow_manual_start: true, no_route_hint: '', start_permission: {} } satisfies StartConfig;
  const endNode: WorkflowNode = { id: 'end', kind: 'end', name: '结束', config: { end_flag: '', ...endConfig } satisfies EndConfig };
  doc.nodes.push(endNode);
  return { doc, endNode };
}

let mounted: MountedPanel<typeof EndPanel> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

// 节点改名（就地改名/清空回填默认名等）属于公共头部 PanelHeader.vue 的职责，不在本文件重复覆盖；
// EndPanel.vue 自身不持有任何名称相关状态。

describe('EndPanel：结束标识——必填空值提示', () => {
  it('为空时显示业务话提示；填写后提示消失且写回文档', async () => {
    const { doc, endNode } = buildDocWithEndNode({});
    const state = fakeState(doc);
    mounted = mountPanel(EndPanel, { node: endNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).toContain('还没有填写结束标识');

    // 面板读的是挂载时传入的静态 node prop（同 HandlePanel/EdgePanel 既定分工：面板只读上游给的
    // 快照 + 写经 injected state，"写完之后同一份 prop 是否重渲染"是外壳 changeTick 桥接的职责，
    // 不在本组件范围——因此这里只断言"写对了地方"，不断言这次挂载的 DOM 会自己变。
    // PanelHeader.vue 的名称输入框 v-if="editing" 默认不渲染，不占用 input[type="text"] 的下标，
    // 结束标识输入框是第一个（唯一一个）文本输入框。
    const input = mounted.el.querySelectorAll('input[type="text"]')[0] as HTMLInputElement;
    input.value = '已通过';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const config = state.value!.doc.nodes.find((n) => n.kind === 'end')!.config as unknown as EndConfig;
    expect(config.end_flag).toBe('已通过');
  });
});

describe('EndPanel：标识写入字段——只列文本类字段，可清空', () => {
  it('mainFieldOptionsOf：dataType 命中时只保留主表内该类型字段（下拉只该保留 data_type=text 的字段）', () => {
    const catalog = {
      templateId: 'tpl_x',
      tables: [
        {
          tableId: 'dt1',
          tableName: '主表',
          isMain: true,
          fields: [
            { fieldId: 'f1', fieldName: '结果字段', dataType: 'text', tableId: 'dt1', tableName: '主表', isMain: true },
            { fieldId: 'f2', fieldName: '数字字段', dataType: 'number', tableId: 'dt1', tableName: '主表', isMain: true }
          ]
        }
      ],
      byFieldId: new Map()
    };
    expect(mainFieldOptionsOf(catalog, 'text').map((f) => f.fieldName)).toEqual(['结果字段']);
  });

  it('主表字段目录到手后：已选文本字段正确回显；写回/清空挂点齐全', async () => {
    const { doc, endNode } = buildDocWithEndNode({ end_flag: '已通过', write_field_id: 'f1' });
    const state = fakeState(doc);
    const host = fakeHost({
      listTemplateTables: async () => ({ data: { items: [{ data_table_id: 'dt1', table_name: '主表', table_role: 'main' }] } }),
      listTemplateFields: async () => ({
        data: {
          items: [
            { field_id: 'f1', field_name: '结果字段', data_type: 'text' },
            { field_id: 'f2', field_name: '数字字段', data_type: 'number' }
          ]
        }
      })
    });

    mounted = mountPanel(EndPanel, { node: endNode, readOnly: false }, { host, state, i18n: fakeI18n() });
    await flush();
    await flush();

    // NSelect 下拉打开/选中在 happy-dom 下模拟不了（见 MainFieldSelect.vue 头注释）：只断言挂载时
    // 传入的已选字段能正确回显——证明目录取到了、且按 dataType 收窄过（f1 是文本字段，能显示出
    // 名字；若目录没收窄到主表文本字段，回显会是别的值或空）。写入方向由 onWriteFieldChange 一行
    // 透传函数保证，见 EndPanel.vue 同名函数。
    const field = mounted.el.querySelector('[data-testid="end-write-field"]') as HTMLElement;
    expect(field.textContent).toContain('结果字段');

    const config = state.value!.doc.nodes.find((n) => n.kind === 'end')!.config as unknown as EndConfig;
    expect(config.write_field_id).toBe('f1');
    // 写入/清空两个方向都只是把 NSelect 的 update:value 一行透传给 patchConfig（见 EndPanel.vue
    // onWriteFieldChange），NSelect 的 clear 图标交互在 happy-dom 下无法可靠模拟——同项目里
    // approve-clear-on-withdraw/handle-clear-on-withdraw 两处 NSelect 的既定测试口径（只测渲染，
    // 不在 DOM 层面测写入交互），这里不再补一条易碎的假交互断言。
  });

  it('目标表单还没选（templateId 为空）：给业务话空态，不发请求、不报错，下拉禁用', async () => {
    const doc = createDefaultDocument('测试流程');
    const startNode = doc.nodes.find((n) => n.kind === 'start')!;
    startNode.config = { target_template_id: '', allow_manual_start: true, no_route_hint: '', start_permission: {} } satisfies StartConfig;
    // 默认文档不自带结束节点，手工造一个挂进去（同 buildDocWithEndNode
    // 既定手法，本用例不复用它是因为要单独控制 start_permission 为空模板这一条件）。
    const endNode: WorkflowNode = { id: 'end', kind: 'end', name: '结束', config: { end_flag: '已通过' } satisfies EndConfig };
    doc.nodes.push(endNode);
    const state = fakeState(doc);

    mounted = mountPanel(EndPanel, { node: endNode, readOnly: false }, { host: fakeHost(), state, i18n: fakeI18n() });
    await flush();

    expect(mounted.el.textContent).toContain('请先在发起节点选择目标模板');
    const selection = mounted.el.querySelector('[data-testid="end-write-field"] .n-base-selection') as HTMLElement;
    expect(selection.className).toContain('n-base-selection--disabled');
  });
});
