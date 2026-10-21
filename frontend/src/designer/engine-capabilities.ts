/**
 * designer/engine-capabilities.ts —— 按当前定义绑定的流程引擎能力收窄设计器。
 *
 * 链路：kimpo 宿主（设计层）getEngineInfo（GET …/definitions/{id}/engine，数据来自引擎 manifest 的
 * capabilities.workflow_engine 声明）→ 本插件设计器（设计层）：
 *   - 节点库里禁用引擎未声明的节点种类，悬停提示「当前引擎不支持」，拖入 / 双击新建一律拦下；
 *   - 子流程节点另须引擎声明 subflow 能力（节点种类在、能力不在同样视为不支持）；
 *   - available=false（引擎未激活 / 未获授 workflow.engine / 声明不完整）时设计器只读——宿主承载页此时已按只读
 *     挂载并显示横幅，这里是双保险，不另起横幅。
 * 取不到引擎信息（旧宿主没有 getEngineInfo、请求失败）一律按「官方引擎、全部能力可用」处理，不因为查询失败把
 * 设计器锁死。本文件是纯函数，不依赖 Vue，便于单测。
 */
import type { NodeKind } from '../model';
import type { DesignerHost, WorkflowEngineInfo } from './host';

/** 设计器据引擎能力得出的限制。 */
export interface EngineRestrictions {
  /** 引擎当前不可派发：设计器只读。 */
  unavailable: boolean;
  /** 节点库里禁用的节点种类（草稿文档小写 kind）。 */
  unsupportedKinds: NodeKind[];
  /** 引擎显示名（宿主已按界面语言取好），取不到为空串。 */
  displayName: string;
}

/** 不限制：旧宿主、取不到引擎信息时用。 */
export const NO_ENGINE_RESTRICTIONS: EngineRestrictions = Object.freeze({ unavailable: false, unsupportedKinds: [], displayName: '' }) as EngineRestrictions;

/** 设计器能新建的节点种类（start 恒有且唯一，不在节点库里，不参与禁用）。 */
const CREATABLE_KINDS: NodeKind[] = ['handle', 'approve', 'cc', 'subflow', 'end'];

/** 某节点种类除节点种类声明之外还依赖的引擎能力。 */
const KIND_REQUIRED_FEATURES: Partial<Record<NodeKind, WorkflowEngineInfo['features'][number]>> = {
  subflow: 'subflow'
};

/** 由引擎信息推出设计器限制；info 为空按不限制。 */
export function resolveEngineRestrictions(info: WorkflowEngineInfo | null | undefined): EngineRestrictions {
  if (!info) return NO_ENGINE_RESTRICTIONS;
  const kinds = new Set((info.nodeKinds ?? []).map((k) => String(k).trim().toUpperCase()));
  const features = new Set((info.features ?? []).map((f) => String(f).trim()));
  const unsupportedKinds = CREATABLE_KINDS.filter((kind) => {
    if (!kinds.has(kind.toUpperCase())) return true;
    const feature = KIND_REQUIRED_FEATURES[kind];
    return feature !== undefined && !features.has(feature);
  });
  return { unavailable: info.available === false, unsupportedKinds, displayName: info.displayName ?? '' };
}

/** 向宿主查当前定义绑定引擎的能力并推出限制：宿主没有 getEngineInfo、返回错误或抛错都按不限制。 */
export async function loadEngineRestrictions(host: Pick<DesignerHost, 'getEngineInfo'>): Promise<EngineRestrictions> {
  if (typeof host.getEngineInfo !== 'function') return NO_ENGINE_RESTRICTIONS;
  try {
    const result = await host.getEngineInfo();
    if (result.error || !result.data) return NO_ENGINE_RESTRICTIONS;
    return resolveEngineRestrictions(result.data);
  } catch {
    return NO_ENGINE_RESTRICTIONS;
  }
}
