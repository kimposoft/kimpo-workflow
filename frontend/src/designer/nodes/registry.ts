/**
 * designer/nodes/registry.ts —— 节点类型注册表的唯一入口。
 *
 * 消费方（stencil/index.ts、model/defaults.ts、model/document-state.ts、designer/graph-bridge.ts
 * 及节点属性面板）一律经本文件的 getNodeTypeDefinition/listNodeTypeDefinitions/
 * listStencilNodeTypeDefinitions 取数据，不直接 import 具体某个 ./start、./handle 等子目录
 * （唯一例外是需要具名引用某个类型默认值的极少数场景，如 model/defaults.ts 构造空白文档时）。
 *
 * 扩展方式：新增一个同构子目录（参照 ./start、./handle、./end 的结构：index.ts 导出一个
 * NodeTypeDefinition 常量），在下方 ALL_NODE_TYPES 数组里追加一项即可——消费方不需要任何改动
 * （不写新的 switch/if-else 分支），这正是"节点类型注册表"机制存在的意义。
 */
import type { NodeKind } from '../../model';
import { approveNodeType } from './approve';
import { ccNodeType } from './cc';
import { endNodeType } from './end';
import { handleNodeType } from './handle';
import { startNodeType } from './start';
import { subflowNodeType } from './subflow';
import type { NodeTypeDefinition } from './types';

export type { DefaultConfigI18n, NodeSummary, NodeTypeDefinition, SummarizeContext } from './types';

/** 当前已登记的全部节点类型定义，按画布/面板期望的展示顺序排列（start 恒在最前，其余按
 * NodeKind 的业务出现频率排——与业务语义无关，只是数组书写顺序，不承载任何隐藏含义）。 */
const ALL_NODE_TYPES: NodeTypeDefinition[] = [startNodeType, handleNodeType, approveNodeType, ccNodeType, subflowNodeType, endNodeType];

const BY_KIND = new Map<NodeKind, NodeTypeDefinition>(ALL_NODE_TYPES.map((def) => [def.kind, def]));

/** 按 kind 查一个节点类型定义；未登记（文档里出现了本插件版本尚不认识的 kind，理论上只会发生
 * 在"更新的宿主/插件保存的文档拿到旧版本插件打开"这类跨版本场景）时返回 undefined——消费方需要
 * 自行决定兜底行为（如 graph-bridge.ts 用节点自身 kind 兜底展示名），本函数不代为猜测。 */
export function getNodeTypeDefinition(kind: NodeKind): NodeTypeDefinition | undefined {
  return BY_KIND.get(kind);
}

/** 全部已登记的节点类型定义（插入顺序，不含未登记的 kind）。 */
export function listNodeTypeDefinitions(): NodeTypeDefinition[] {
  return [...ALL_NODE_TYPES];
}

/** 允许从形状面板新建的节点类型定义（canAddFromStencil===true 的子集）——stencil/index.ts
 * 的 STENCIL_ITEMS 由此派生，不再手工穷举。 */
export function listStencilNodeTypeDefinitions(): NodeTypeDefinition[] {
  return ALL_NODE_TYPES.filter((def) => def.canAddFromStencil);
}
