/**
 * panels/shared/approvalButtons.ts —— ApprovalButtonList.vue（审批节点『审批按钮』面板内就地
 * 编辑清单）的纯逻辑层：新增默认值、
 * 增删排序、字段更新，与 Vue 组件（事件绑定/模板/拖拽手势）分离，供单测直接覆盖——同
 * ./assigneeSource.ts 头注释的既定分工（本插件前端未装 @vue/test-utils，纯函数是能被真正单测
 * 覆盖的唯一路径）。
 *
 * 上移/下移与拖拽排序共用 moveButtonTo（splice 版本，见 ApprovalButtonList.vue 头注释"拖动排序"
 * 一段）。
 *
 * 所有函数都不改入参，返回新数组（同 assigneeSource.ts 的既定风格），调用方拿到新数组后经
 * update:modelValue 上抛，由 ApprovePanel.vue 的 patchConfig({ buttons }) 写回文档（落库由
 * usePanelHost()/WorkflowDocumentState 统一处理，本文件不关心）。
 */
import type { ApprovalButton, EndConfig, WorkflowNode } from '../../../model';
import { nextOrdinalForKind, typeOrdinalName } from '../../../model/node-naming';
import type { DefaultConfigI18n } from '../../nodes/registry';

/** 新增按钮的默认取值：颜色中性灰、
 *  动作默认「提交通过」，名称/结果标识留空待设计者填写。 */
const DEFAULT_BUTTON_COLOR: ApprovalButton['color'] = 'neutral';
const DEFAULT_BUTTON_ACTION: ApprovalButton['action'] = 'submit_approve';

/** 按钮 id 生成：固定前缀 + 随机短串，仅要求"同一份 buttons 清单内不重复"，不需要全局唯一
 *  （nodes/approve/index.ts 默认两按钮用固定字面量 id）。 */
export function generateButtonId(): string {
  return `btn-${Math.random().toString(36).slice(2, 10)}`;
}

/** 造一个默认按钮（新增一行时用）。 */
export function createDefaultButton(): ApprovalButton {
  return {
    id: generateButtonId(),
    name: '',
    color: DEFAULT_BUTTON_COLOR,
    action: DEFAULT_BUTTON_ACTION,
    result_tag: '',
    require_reason: false
  };
}

/** 追加一个默认按钮，返回新数组。 */
export function addButton(buttons: ApprovalButton[]): ApprovalButton[] {
  return [...buttons, createDefaultButton()];
}

/** 是否还允许删除（审批按钮"至少一个"，发布期 N3_BUTTON_REQUIRED 拦截）：
 *  只剩一个时不允许再删。 */
export function canRemoveButton(buttons: ApprovalButton[]): boolean {
  return buttons.length > 1;
}

/** 删除第 index 个按钮；index 越界或已经只剩一个时原样返回，不静默产生"零按钮"这一非法态。 */
export function removeButtonAt(buttons: ApprovalButton[], index: number): ApprovalButton[] {
  if (index < 0 || index >= buttons.length) return buttons;
  if (!canRemoveButton(buttons)) return buttons;
  const next = [...buttons];
  next.splice(index, 1);
  return next;
}

/** 把第 from 个按钮挪到第 to 个位置（通用版，供上移/下移与拖拽排序共用）；下标越界或 from===to
 *  时原样返回。 */
export function moveButtonTo(buttons: ApprovalButton[], from: number, to: number): ApprovalButton[] {
  if (from < 0 || from >= buttons.length || to < 0 || to >= buttons.length || from === to) return buttons;
  const next = [...buttons];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 上移一格；首行（index<=0）原样返回（moveButtonTo 内部按 to=-1 越界自然拦下，这里单独导出是
 *  给"上移"按钮直接消费，语义比调用方自己算 index-1 更清楚）。 */
export function moveButtonUp(buttons: ApprovalButton[], index: number): ApprovalButton[] {
  return moveButtonTo(buttons, index, index - 1);
}

/** 下移一格；末行原样返回，同上。 */
export function moveButtonDown(buttons: ApprovalButton[], index: number): ApprovalButton[] {
  return moveButtonTo(buttons, index, index + 1);
}

/** 修改第 index 个按钮的若干字段（浅合并 patch）；index 越界时原样返回，不静默改错行——同
 *  assigneeSource.ts updateMainFieldId 的既定口径。名称/结果标识/动作/颜色/需填理由五个字段
 *  都走这一个通用入口，不再各自开一个 updateXxx 函数（本文件比 assigneeSource.ts 少一种"来源
 *  kind"分支，没有必要拆细）。
 *
 *  动作被改成非 end_flow 时，同步清掉 end_node_id（该字段只在 end_flow 下有意义，
 *  残留会让后端其他路径读到脏值）；改成 end_flow 时不自动填目标（保持 undefined），
 *  由设计者从「结束到」下拉里显式选择。patch 里同时显式给了 end_node_id 时以 patch 为准（本函数
 *  只在合并后的动作不是 end_flow 时才强制删除）。 */
export function updateButtonField(buttons: ApprovalButton[], index: number, patch: Partial<ApprovalButton>): ApprovalButton[] {
  if (index < 0 || index >= buttons.length) return buttons;
  const next = [...buttons];
  const merged: ApprovalButton = { ...next[index], ...patch };
  // 合并后动作不是 end_flow → 删除 end_node_id 键本身（而不是置 undefined），保证落库 JSON 干净。
  if (merged.action !== 'end_flow' && 'end_node_id' in merged) delete merged.end_node_id;
  next[index] = merged;
  return next;
}

/** 按 id 数组的拼接串比较两份按钮清单的顺序是否相同（仅比较 id 顺序，不比较其余字段）——供拖拽
 *  排序松手时判断"这次拖拽到底有没有真的改变顺序"，避免原地松手也产生一次多余的写回/撤销栈
 *  条目（同 PanelHeader.vue commitEdit "trimmed !== props.node.name 才写"的既定口径）。 */
export function sameButtonOrder(a: ApprovalButton[], b: ApprovalButton[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((btn, i) => btn.id === b[i]?.id);
}

/** 「结束到」下拉的一个候选：一个结束节点。 */
export interface EndNodeOption {
  /** 结束节点 id，即写回按钮 end_node_id 的取值。 */
  id: string;
  /** 节点显示名：节点自己有名字用名字，否则与画布一致按「类型名 + 序号」兜底（同
   *  designer/graph-bridge.ts toGraphNodes 的展示兜底，共用 model/node-naming.ts 实现）。 */
  label: string;
  /** 结束标识（EndConfig.end_flag）；未填时为空串，界面显示灰字「未填结束标识」。 */
  flag: string;
}

/** 从文档节点清单里取出全部结束节点，作为「不通过并结束流程」按钮的「结束到」候选，顺序同
 *  doc.nodes。序号按节点在整份清单里同类型出现的位置算（与画布展示兜底一致，不是"仅结束节点
 *  之间重新编号"）。纯函数，不改入参。 */
export function listEndNodeOptions(nodes: WorkflowNode[] | undefined, i18n: DefaultConfigI18n | undefined): EndNodeOption[] {
  const list = nodes ?? [];
  const options: EndNodeOption[] = [];
  list.forEach((node, index) => {
    if (node.kind !== 'end') return;
    const ordinal = nextOrdinalForKind(list.slice(0, index), node.kind);
    const label = node.name?.trim() ? node.name : typeOrdinalName(i18n, node.kind, ordinal);
    const flag = ((node.config as Partial<EndConfig> | undefined)?.end_flag ?? '').trim();
    options.push({ id: node.id, label, flag });
  });
  return options;
}
