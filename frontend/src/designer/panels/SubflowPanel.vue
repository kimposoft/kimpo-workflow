<script setup lang="ts">
/**
 * panels/SubflowPanel.vue —— 子流程节点（N6）属性面板。
 *
 * 分区顺序：目标流程 → 传递字段 → 等待方式 → 父流程结束后的处置。
 *
 * 节点改名由公共头部 ../PanelHeader.vue 就地完成；inject host/i18n/state + changeTick 桥接经
 * usePanelHost() 取得。内容较多，但仍平铺展示，不引入分区标签条组件。
 *
 * 目标流程候选来自 host.listAppWorkflows()（宿主已按 latest_version_no>0 过滤，只回已发布），
 * 本层再按 enabled 过滤掉已停用的一档（防御性重复过滤，接口若已经只回启用项也不受影响），并经
 * ./shared/subflowMapping.ts excludeSelf() 排除当前正在设计的这条流程自己（见 host.ts
 * DesignerHost.definitionId 注释；host.definitionId 为空/未知时 excludeSelf 原样返回，不做任何排除，不是静默出错）。存量值恰好
 * 是自己（历史脏数据，或流程发布后又被设为自己的子流程目标）时：因为它已经不在过滤后的候选
 * 里，会自然落入下方 targetUnavailable 分支，按"该流程已不可用"同款橙色占位展示，不需要另外
 * 分支处理。发布期后端 N6 校验不含"禁止自引用"这条，真正的自环风险仍需引擎侧另行判断，这里只
 * 做前端候选层面的过滤。
 *
 * 传递字段（来源=本模板字段目录 + 目标=目标流程模板主表字段目录）的取数/写回/类型兼容/同表约束
 * 全部经 ./shared/subflowMapping.ts 纯函数完成，展示层是 ./shared/MappingRows.vue，本文件只做
 * 目录取数接线。
 */
import { computed, onMounted, ref } from 'vue';
import { NButton, NRadioButton, NRadioGroup, NSelect } from 'naive-ui';
import type { SubflowConfig, SubflowDisposition, SubflowFieldMapping, WorkflowNode } from '../../model';
import type { WorkflowDesignerPublishedDefinition } from '../host';
import { mainTemplateIdOf } from '../expression/v4Scope';
import { useTemplateFieldCatalog } from './shared/templateFieldCatalog';
import { applyWaitToggle, excludeSelf, isTerminalSubflow } from './shared/subflowMapping';
import MappingRows from './shared/MappingRows.vue';
import PanelHeader from './PanelHeader.vue';
import PanelSection from './PanelSection.vue';
import { usePanelHost } from './usePanelHost';

const props = defineProps<{ node: WorkflowNode; readOnly?: boolean }>();

// inject host/i18n/state + changeTick 桥接统一经 usePanelHost() 取得（见该文件头注释）。
const { host, i18n, state, changeTick } = usePanelHost();

/** 节点 config 理论上不该缺席（addNode 恒用 createDefaultConfig 兜底），这里只是给类型系统一个
 *  兜底占位（同 HandlePanel.vue EMPTY_HANDLE_CONFIG 既定手法）。 */
const EMPTY_SUBFLOW_CONFIG: SubflowConfig = { target_workflow_id: '', field_mappings: [], wait: false, disposition: 'ignore' };

/** 本流程目标模板 id（发起节点绑定的那个模板）——传递字段『来源』的目录锚点，同 HandlePanel.vue/
 *  ApprovePanel.vue 既定手法。 */
const templateId = computed(() => {
  void changeTick.value;
  return mainTemplateIdOf(state.value?.doc);
});

/** 本节点是否处于"末级"位置：全部出边都指向结束节点，或没有出边。changeTick 变化时
 *  （画布连线增删）重新求值。 */
const terminal = computed(() => {
  void changeTick.value;
  const doc = state.value?.doc;
  if (!doc) return false;
  return isTerminalSubflow(doc, props.node.id);
});

const config = computed<SubflowConfig>(() => (props.node.config as SubflowConfig | undefined) ?? EMPTY_SUBFLOW_CONFIG);

function patchConfig(patch: Partial<SubflowConfig>): void {
  if (props.readOnly) return;
  state.value?.updateNodeConfig(props.node.id, patch as Record<string, unknown>);
}

// ── 目标流程 ────────────────────────────────────────────────────────────────────────────
const definitions = ref<WorkflowDesignerPublishedDefinition[]>([]);
const definitionsLoading = ref(false);
const definitionsFailed = ref(false);

async function loadDefinitions(): Promise<void> {
  definitionsLoading.value = true;
  definitionsFailed.value = false;
  try {
    const result = await host.listAppWorkflows();
    if (result.error || !result.data) {
      definitionsFailed.value = true;
      return;
    }
    // 只列已发布（宿主已过滤）、未停用、且不是当前正在设计的这条流程自己（见头注释）。
    const enabledOnly = result.data.definitions.filter((d) => d.enabled !== false);
    definitions.value = excludeSelf(enabledOnly, host.definitionId);
  } catch (err) {
    console.error('[kimpo-workflow] SubflowPanel 取已发布流程目录失败', err);
    definitionsFailed.value = true;
  } finally {
    definitionsLoading.value = false;
  }
}
onMounted(() => void loadDefinitions());

/** 当前选中目标流程是否已不在可用候选里（被停用/删除，但字段仍保留原值，不静默改写）。 */
const targetUnavailable = computed(() => {
  const id = config.value.target_workflow_id;
  return Boolean(id) && !definitions.value.some((d) => d.definition_id === id);
});

/** 索引签名同 ../panels/ApprovePanel.vue ClearFieldSelectOption 头注释：naive-ui 的 SelectOption
 *  联合类型要求结构上兼容它的 SelectBaseOption（带 `[k: string]: unknown` 索引签名），本类型要能
 *  直接赋给 NSelect 的 options prop 就必须带同样的索引签名，不是随手加的冗余。 */
interface WorkflowOption {
  label: string;
  value: string;
  disabled?: boolean;
  [k: string]: unknown;
}

/** NSelect 选项：可用候选 + （若当前值已不可用）一个禁用的占位项，避免选中值找不到对应选项时
 *  控件显示空白，让设计者仍能看到"选过什么"。 */
const workflowOptions = computed<WorkflowOption[]>(() => {
  const opts: WorkflowOption[] = definitions.value.map((d) => ({ label: d.name, value: d.definition_id }));
  const id = config.value.target_workflow_id;
  if (id && targetUnavailable.value) {
    opts.push({ label: i18n.t('workflow.designer.subflow.targetUnavailable'), value: id, disabled: true });
  }
  return opts;
});

/** 目标流程所绑模板 id（从候选目录里按当前选中的 definition_id 反查 template_id）；选不到（未选/
 *  已不可用）时为空串，传递字段『目标』目录相应留空。 */
const targetTemplateId = computed(() => {
  const id = config.value.target_workflow_id;
  if (!id) return '';
  return definitions.value.find((d) => d.definition_id === id)?.template_id ?? '';
});

/** 换目标流程时若原来已有传递字段，清空并提示一次（"下次交互消失"：下一次目标流程/传递字段
 *  操作都会把它重置）。 */
const mappingsClearedNotice = ref(false);
function onTargetChange(value: string | null): void {
  if (props.readOnly) return;
  const nextId = value ?? '';
  if (nextId === config.value.target_workflow_id) return;
  const hadMappings = (config.value.field_mappings ?? []).length > 0;
  state.value?.updateNodeConfig(props.node.id, (cfg) => ({ ...(cfg ?? {}), target_workflow_id: nextId, field_mappings: [] }));
  mappingsClearedNotice.value = hadMappings;
}

// ── 传递字段 ────────────────────────────────────────────────────────────────────────────
const { catalog: sourceCatalog, loading: sourceLoading, failed: sourceFailed, reload: reloadSourceCatalog } = useTemplateFieldCatalog(() => templateId.value);
const { catalog: targetCatalog, loading: targetLoading, failed: targetFailed, reload: reloadTargetCatalog } = useTemplateFieldCatalog(
  () => targetTemplateId.value
);

const mappingsLoading = computed(() => sourceLoading.value || (Boolean(targetTemplateId.value) && targetLoading.value));
const mappingsFailed = computed(() => sourceFailed.value || (Boolean(targetTemplateId.value) && targetFailed.value));

function reloadMappingCatalogs(): void {
  void reloadSourceCatalog();
  if (targetTemplateId.value) void reloadTargetCatalog();
}

function onMappingsUpdate(next: SubflowFieldMapping[]): void {
  mappingsClearedNotice.value = false;
  patchConfig({ field_mappings: next });
}

// ── 等待方式（末级节点只能选"不等待"） ───────────────────────────────────────────────
function onWaitChange(wait: boolean): void {
  if (props.readOnly) return;
  if (wait && terminal.value) return; // 双重保险：末级节点即便强行触发也不接受"等待"。
  patchConfig(applyWaitToggle({ disposition: config.value.disposition }, wait));
}

// ── 父流程结束后子流程的处置（仅 wait===false 时展示） ──────────────────────────────────────
function onDispositionChange(value: SubflowDisposition): void {
  if (props.readOnly) return;
  patchConfig({ disposition: value });
}
</script>

<template>
  <div class="wf-subflow-panel">
    <PanelHeader :node="node" :read-only="readOnly" />

    <!-- 目标流程：subflow.go Validate 里 cfg.TargetWorkflowID == "" 即 N6_TARGET_REQUIRED 拒绝
         发布，因此标必填。 -->
    <PanelSection
      :title="i18n.t('workflow.designer.panel.section.targetWorkflow')"
      required
      :required-label="i18n.t('workflow.designer.panel.requiredMark')"
    >
      <div class="wf-subflow-panel__target-row">
        <NSelect
          class="wf-subflow-panel__target-select"
          size="small"
          filterable
          data-testid="subflow-target"
          :value="config.target_workflow_id || null"
          :options="workflowOptions"
          :loading="definitionsLoading"
          :disabled="readOnly"
          :placeholder="i18n.t('workflow.designer.subflow.targetPlaceholder')"
          @update:value="onTargetChange"
        />
        <span v-if="targetUnavailable" class="wf-subflow-panel__badge">{{ i18n.t('workflow.designer.subflow.targetUnavailable') }}</span>
      </div>
      <p v-if="definitionsFailed" class="wf-subflow-panel__hint wf-subflow-panel__hint--warn">
        {{ i18n.t('workflow.designer.subflow.targetListLoadFailed') }}
        <NButton text size="small" data-testid="subflow-target-reload" @click="loadDefinitions">{{ i18n.t('workflow.designer.root.retry') }}</NButton>
      </p>
      <p class="wf-subflow-panel__hint">{{ i18n.t('workflow.designer.subflow.targetHelp') }}</p>
    </PanelSection>

    <PanelSection :title="i18n.t('workflow.designer.panel.section.fieldMappings')">
      <p v-if="mappingsClearedNotice" class="wf-subflow-panel__hint wf-subflow-panel__hint--warn">
        {{ i18n.t('workflow.designer.subflow.targetChangedMappingsCleared') }}
      </p>
      <MappingRows
        :model-value="config.field_mappings ?? []"
        :source-catalog="sourceCatalog"
        :target-catalog="targetCatalog"
        :loading="mappingsLoading"
        :failed="mappingsFailed"
        :read-only="readOnly"
        :add-disabled="!config.target_workflow_id"
        @update:model-value="onMappingsUpdate"
        @reload="reloadMappingCatalogs"
      />
      <p class="wf-subflow-panel__hint">{{ i18n.t('workflow.designer.subflow.mapping.help') }}</p>
    </PanelSection>

    <PanelSection :title="i18n.t('workflow.designer.panel.section.waitMode')">
      <!-- 分段按钮，size="small" 与其它面板的单选控件同尺寸。 -->
      <NRadioGroup class="wf-subflow-panel__seg" size="small" :value="config.wait" :disabled="readOnly" @update:value="onWaitChange">
        <NRadioButton :value="false" data-testid="subflow-wait-false">{{ i18n.t('workflow.designer.subflow.wait.notWait') }}</NRadioButton>
        <NRadioButton :value="true" data-testid="subflow-wait-true" :disabled="readOnly || terminal">{{ i18n.t('workflow.designer.subflow.wait.wait') }}</NRadioButton>
      </NRadioGroup>
      <p v-if="terminal" class="wf-subflow-panel__hint">{{ i18n.t('workflow.designer.subflow.wait.terminalHint') }}</p>
      <p v-if="terminal && config.wait" class="wf-subflow-panel__hint wf-subflow-panel__hint--warn">{{ i18n.t('workflow.designer.subflow.wait.terminalSelectedWarn') }}</p>
    </PanelSection>

    <!-- 父流程结束后的处置：subflow.go Validate 里 !cfg.Wait 时 cfg.Disposition 不在
         ignore/force_end 闭集内即 N6_DISPOSITION_REQUIRED 拒绝发布，因此标必填。本分区只在 !config.wait 时渲染，
         与"必填"条件天然一致。 -->
    <PanelSection v-if="!config.wait" :title="i18n.t('workflow.designer.panel.section.disposition')" required :required-label="i18n.t('workflow.designer.panel.requiredMark')">
      <NRadioGroup class="wf-subflow-panel__seg" size="small" :value="config.disposition ?? 'ignore'" :disabled="readOnly" @update:value="onDispositionChange">
        <NRadioButton value="ignore" data-testid="subflow-disposition-ignore">{{ i18n.t('workflow.designer.subflow.disposition.ignore') }}</NRadioButton>
        <NRadioButton value="force_end" data-testid="subflow-disposition-force_end">{{ i18n.t('workflow.designer.subflow.disposition.forceEnd') }}</NRadioButton>
      </NRadioGroup>
    </PanelSection>
  </div>
</template>

<style scoped>
.wf-subflow-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 10px;
}
/* 不分区面板：分区卡片自己左右各留 10px，身份头贴边（同 EndPanel.vue 同名规则处注释）。 */
.wf-subflow-panel > .wf-panel-section { margin: 0 10px; }
.wf-subflow-panel__seg { display: flex; width: 100%; }
.wf-subflow-panel__seg :deep(.n-radio-button) { flex: 1 1 auto; min-width: 0; padding: 0 6px; text-align: center; white-space: nowrap; }
/* 选中档实心主色底 + 白字，NRadioButton 默认只是描边高亮。白字写死是因为它压在主色
   底上，不随明暗主题变（同本目录"只做明亮模式"的既定口径）。 */
.wf-subflow-panel__seg :deep(.n-radio-button--checked) { background: rgb(var(--primary-color, 10 106 214)); color: #fff; }
.wf-subflow-panel__target-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wf-subflow-panel__target-select { flex: 1; min-width: 0; }
.wf-subflow-panel__badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(var(--warning-color, 240 160 32) / 14%);
  color: rgb(var(--warning-color, 240 160 32));
  font-size: 11px;
  white-space: nowrap;
}
.wf-subflow-panel__hint { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 11px; line-height: 1.5; }
.wf-subflow-panel__hint--warn { color: rgb(var(--warning-color, 240 160 32)); }
</style>
