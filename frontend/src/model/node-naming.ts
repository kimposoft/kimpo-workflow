/**
 * model/node-naming.ts —— "类型名 + 序号" 默认节点命名规则的唯一实现。
 *
 * 背景：画布展示态 toGraphNodes()（designer/graph-bridge.ts）早就有一套"node.name 为空时退化
 * 为「类型名+序号」"的展示层兜底算法（如"办理 1""抄送 2"）；填报层（流程进度页/任务列表
 * 「当前站」/管理页）直接读文档 `name` 字段渲染，没有画布这套兜底，因此
 * WorkflowDocumentState.addNode()（新建办理/审批/抄送/子流程/结束节点的唯一入口）要把这个
 * "即将显示的名字"写进文档。两层各自实现同一条规则迟早会分叉，本文件把序号算法与拼接规则抽成纯函数，graph-bridge.ts 的展示兜底与
 * document-state.ts 的 addNode() 落库默认名两处唯一共用（同一个函数调用，不是"抄一份逻辑"）。
 *
 * 序号算法：按节点类型分组，按节点
 * 在 doc.nodes 数组中出现的顺序从 1 计数——同一类型的第 N 个节点恒是序号 N，与该节点的 name
 * 是否已经被设计者手动改写过无关。这是纯位置派生的算法，不持久化"序号"本身，因此删除同类型里
 * 靠前的节点会让排在后面的同类型节点在下一次求值时"往前补位"（序号变小）——这是画布展示态的
 * 既定行为。addNode() 新增节点恒追加在数组
 * 末尾（见其实现），因此新节点的序号 = 追加前该类型已有节点数 + 1，与"追加后把整份文档重新
 * 过一遍本文件算法"得到的结果恒一致。
 *
 * 🔴 已知边界（"把动态展示值落库"必然带来的取舍）：一旦
 * 默认名写进文档，它就和设计者手动改过的名字一样被"冻结"，不再随其它同类型节点的增删动态
 * 重算——因此"删除一个靠前的同类型节点、再新建一个"这个序列，新节点算出的序号可能与仍然存活
 * 的另一个节点冻结的旧序号撞车（如：办理 1/办理 2 中先删掉"办理 1"，此时文档里只剩一个办理
 * 节点但它的名字仍是冻结的"办理 2"；这时再新建一个办理节点，按"当前已有同类型节点数 + 1"算出
 * 的序号同样是 2，与前者撞名）。这与"两个都未命名的节点在同一次展示态求值里绝不会撞号"
 * 不矛盾——那条保证只对"当次求值、全部未命名"的动态场景成立，一旦有节点被冻结了名字（无论是
 * 设计者手动改的，还是本文件写的默认值），全局唯一就不是不变量（设计者也完全可能手动把
 * 两个节点都改成同一个名字）。
 *
 * 不覆盖发起节点的"引导态默认名"（createDefaultStartNode，model/defaults.ts）：该函数造的是
 * "文档自带、从不经过 addNode() 的唯一节点"，固定写「发起」这个不带序号的字面量
 * （见 defaults.ts 头注释），是刻意的特例，不适用本文件面向"可重复新增节点"的通用"类型名+
 * 序号"规则；但两者共用同一个"取类型业务名"的取值链路（resolveDefaultText + 注册表
 * labelKey），不重复定义第二套 i18n 兜底逻辑。新建流程不自带结束节点；下方
 * defaultNameForNodeAt() 对"文档里第一个结束节点不带序号"的特例处理，是给设计者从节点库拖入
 * 的第一个结束节点用的通用规则。
 */
import type { NodeKind, WorkflowNode } from './document';
import { getNodeTypeDefinition, type DefaultConfigI18n } from '../designer/nodes/registry';
import { resolveDefaultText } from '../designer/nodes/default-i18n-fallback';

/** 某类型节点的业务类型名（画布展示 typeLabel 与本文件默认名共用同一四语键：注册表
 *  labelKey）；没有 i18n 时退回 zh-CN 文案，同 default-i18n-fallback.ts 既定手法——保证
 *  "没有注入 i18n 也不报错、也不是恒定英文 key"这条既有约束继续成立。 */
export function nodeTypeLabel(i18n: DefaultConfigI18n | undefined, kind: NodeKind): string {
  const def = getNodeTypeDefinition(kind);
  return def ? resolveDefaultText(i18n, def.labelKey) : kind;
}

/** 给"即将追加到 existingNodes 末尾的一个 kind 类型新节点"算序号：existingNodes 里该类型的
 *  节点个数 + 1（对齐 graph-bridge.ts toGraphNodes() 的"数组出现顺序、按类型分别计数"算法，
 *  新节点恒追加在数组末尾这一前提，见 document-state.ts addNode() 实现）。 */
export function nextOrdinalForKind(existingNodes: WorkflowNode[], kind: NodeKind): number {
  return existingNodes.filter((n) => n.kind === kind).length + 1;
}

/** "类型名 + 序号" 拼接——graph-bridge 展示兜底与 addNode 落库默认名两处唯一共用的拼接规则，
 *  不许各自另起一份字符串模板（哪怕看起来只是一个空格分隔，两处各写一份也会在改动其中一处时
 *  悄悄分叉）。 */
export function typeOrdinalName(i18n: DefaultConfigI18n | undefined, kind: NodeKind, ordinal: number): string {
  return `${nodeTypeLabel(i18n, kind)} ${ordinal}`;
}

/**
 * defaultNameForNodeAt —— 给"文档里已经存在的某个节点"重新算一次默认名，供"设计者把名称清空、
 * 失焦后回填默认名"场景使用（面板名称输入框统一行为，见各 *Panel.vue 的 onNameBlur）。与 addNode() 落库默认名的差别只在于：这里面对的是"已存在、有
 * 自己在数组里的确定位置"的节点，不是"即将追加到末尾"的新节点，序号按它当前的数组位置算。
 *
 * 发起节点特例：全图恒唯一（注册表 start.maxCount=1），序号恒为 1，不带序号，直接用类型名本身
 * ——对齐 createDefaultStartNode（model/defaults.ts）的默认名规则，保证"清空发起节点名称、
 * 失焦"回填出的字面量与它最初的默认名（"发起"）完全一致，不会变成"发起 1"这种看起来像是有
 * 第二个发起节点的误导文案。
 * 结束节点特例：当它是当前文档里唯一/第一个结束节点（序号 1）时同样不带序号，对齐 e2e
 * 校准夹具字面值"结束"（不是"结束 1"）——结束节点恒由设计者从节点库拖入（model/defaults.ts
 * 不自带结束节点）；从第二个结束节点起
 * （序号 ≥2）按通用"类型名+序号"规则显示，与办理/审批等其余可重复节点一致。
 *
 * 节点在 nodes 里找不到（理论不应发生，防御性兜底）时返回 undefined，调用方按"不回填"处理。
 */
export function defaultNameForNodeAt(nodes: WorkflowNode[], nodeId: string, i18n: DefaultConfigI18n | undefined): string | undefined {
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index === -1) return undefined;
  const kind = nodes[index]!.kind;
  if (kind === 'start') {
    return nodeTypeLabel(i18n, kind);
  }
  const ordinal = nextOrdinalForKind(nodes.slice(0, index), kind);
  if (kind === 'end' && ordinal === 1) {
    return nodeTypeLabel(i18n, kind);
  }
  return typeOrdinalName(i18n, kind, ordinal);
}
