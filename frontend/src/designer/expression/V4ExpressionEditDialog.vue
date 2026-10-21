<script setup lang="ts">
/**
 * expression/V4ExpressionEditDialog.vue —— V4ExpressionField.vue 的内部实现细节（不对外单独使用）：
 * 真正内嵌 @kimposoft/expression-editor 的 AdvancedExpressionPanel 的编辑弹窗。
 *
 * 拆成独立组件而不是塞进 V4ExpressionField.vue 的原因是 Vue 的 provide/inject 约束——
 * AliceV4Host/RefSyntax/ExpressionHost 三个注入必须在「持有它们的组件」setup 顶层同步调用一次
 * （见 ../ConditionV4Editor.vue 参照实现头注释①），而 V4ExpressionField 本身要异步向宿主要
 * AliceV4Host（host.aliceV4(templateId) 是 Promise），无法在自己的 setup 顶层拿到非空值。做法
 * 照抄该参照实现的分工：外层（V4ExpressionField）负责异步取到 host 后才创建本组件（v-if 挂载），
 * 本组件收到的 v4Host 是已经就绪的必填 prop，可以放心在 setup 顶层同步 provide。
 *
 * 本组件不认识业务上的「办理人 / 引导线」等概念，只认「condition（判断表达式，purpose='where'）/
 * value（取值表达式，purpose='value'）」两种模式与一份可选的既有文档，是纯粹的表达式编辑壳。
 *
 * 窗口外壳用 KDialog（standard 档）+ KDialogFooter：固定 860×600、不可缩放 / 最大化 / 拖动、挂载即显示
 * （调用方 v-if 控制挂载 / 卸载）；点遮罩无动作，Esc = 取消；页脚按钮的 e2e 选择器为 `[data-kdlf="confirm|cancel"]`。
 * 内容区（`.v4dlg-body`）自带 8px 12px 内边距，故 KDialog 用 flush 通栏。
 */
import { computed, ref } from 'vue';
// 窗口外壳与页脚统一用 @kimposoft/ui-kit（运行时取宿主注入的 KimpoUi，构建时外部化）
import { KDialog, KDialogFooter } from '@kimposoft/ui-kit';
import {
  AdvancedExpressionPanel,
  createV4ExpressionHost,
  provideAliceV4Host,
  provideExpressionHost,
  provideRefSyntax,
  textSourceToV4ExpressionDocument,
  type AliceV4Host,
  type ConditionGroup,
  type ExpressionHost,
  type FormTableLite,
  type TextSource,
  type V4ExpressionRefWire,
  type ValueRef
} from '@kimposoft/expression-editor';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { V4ExpressionDocumentEnvelope } from '../../model';
import { buildExpressionEnvelope } from './envelope';

const props = defineProps<{
  i18n: PluginI18n;
  mode: 'condition' | 'value';
  /** 可选的业务语境提示（如「自动办理条件」「抄送标题」），随 V4ExpressionField.vue 同名 prop
   *  透传；仅用于弹窗标题后缀，不影响任何求值/落库逻辑。不传时标题与此前行为一致。 */
  purpose?: string;
  /** 落库文档的 expression_id（引导线＝ linkId；步骤摘要＝ `<nodeId>:summary`，由调用方拼好）。 */
  expressionId: string;
  /** 既有文档；undefined＝从空文本开始。 */
  modelValue?: V4ExpressionDocumentEnvelope;
  /** modelValue 对应的可读原文（V4ExpressionField 已经用 v4Host.restore 换好，本组件不重复换）；
   *  modelValue 存在但本字段仍为空串时退回 token 化源码显示（V4ExpressionField 的既定回落口径）。 */
  readableText: string;
  /** 已就绪的 V4 表达式生产桥（调用方保证非空才会创建本组件，见头注释）。 */
  v4Host: AliceV4Host;
  /** 宿主注入的旧版表达式域桥（目录/表/字段等原样委派，V4 只接管 lowerText，见 createV4ExpressionHost）。 */
  expressionHost: ExpressionHost;
  /** 本表单主表（且仅主表）的字段目录，见 ../expression/v4Scope.ts useMainTableScope。 */
  tables: FormTableLite[];
}>();

const emit = defineEmits<{
  /** 用户改了表达式并确认：带组装好的信封，直接可落库。 */
  confirm: [doc: V4ExpressionDocumentEnvelope];
  /** 用户把文本清空后确认：等价于「清空」按钮，调用方应把字段置为 undefined。 */
  cleared: [];
  /** 无法产出 V4 文档（随身包缺席，理论上只会在宿主桥异常时发生）：就地提示，不关窗。 */
  error: [];
  /** 用户点取消/关闭：不产生任何变更。 */
  cancel: [];
}>();

// 🔴 三个 provide 必须在 setup 顶层同步执行（Vue 注入约束），不能塞进 watch/事件回调里——本组件
// 只在 v4Host 就绪后才会被外层创建，故这里的 props.v4Host 恒非空，可以直接同步 provide。
provideAliceV4Host(props.v4Host);
// 🔴 字段引用语法必须是方括号：缺省 braces 时字段树点击插入的是旧引擎的 `{字段}`，V4 表达式分词
// 会报语法错误（同 ../ConditionV4Editor.vue 头注释②的既有教训）。
provideRefSyntax('brackets');
// condition 档谓词根允许聚合（与动作条件分支一致）；value 档不经过 wherePurpose 分支（见
// createV4ExpressionHost 内 toV4Purpose：purpose='value' 时恒落 output，与 wherePurpose 无关）。
provideExpressionHost(createV4ExpressionHost(props.expressionHost, props.v4Host, { wherePurpose: 'condition' }));

// ── condition 档：purpose='where'，走 confirm-where/confirm-unchanged 两个事件 ──────────────
const whereTextSource = computed<TextSource | null>(() => {
  const doc = props.modelValue;
  if (!doc) return null;
  const refs = doc.expression.refs as V4ExpressionRefWire[];
  return {
    text: props.readableText || doc.expression.source_text,
    pack_revision: 'alice-v4',
    digest: doc.expression.normalized_digest ?? '',
    refs: refs.map((r) => ({ stable_id: r.ref_id, label: r.last_label })),
    v4: { source_text: doc.expression.source_text, refs }
  };
});

function onConfirmWhere(payload: { condition: ConditionGroup | null; textSource: TextSource | null }): void {
  const textSource = payload.textSource;
  if (!textSource) {
    // 文本被清空后确认＝「无条件，恒可走」，不是异常态。
    emit('cleared');
    return;
  }
  const doc = textSourceToV4ExpressionDocument(textSource, props.expressionId, 'condition');
  if (!doc) {
    emit('error');
    return;
  }
  emit('confirm', buildExpressionEnvelope(doc, 'condition', props.expressionId, 'condition'));
}

function onConfirmUnchanged(): void {
  // 文本未改：既有文档原样保留，等价于「取消」（不产生变更事件），由调用方保持原状。
  emit('cancel');
}

// ── value 档：purpose='value'，走 confirm 一个事件（未改/清空都在同一事件里区分） ────────────
const valueModelValue = computed<ValueRef | null>(() => {
  const doc = props.modelValue;
  if (!doc) return null;
  const refs = doc.expression.refs as V4ExpressionRefWire[];
  const sidecar: TextSource = {
    text: props.readableText || doc.expression.source_text,
    pack_revision: 'alice-v4',
    digest: doc.expression.normalized_digest ?? '',
    refs: refs.map((r) => ({ stable_id: r.ref_id, label: r.last_label })),
    v4: { source_text: doc.expression.source_text, refs }
  };
  return { kind: 'raw', text: sidecar.text, text_source: sidecar };
});

function onConfirmValue(v: ValueRef): void {
  const textSource = v.text_source;
  if (!textSource) {
    // 空文本确认（含全新字段从未写过一个字）：按「清空」处理，不报错。
    emit('cleared');
    return;
  }
  const doc = textSourceToV4ExpressionDocument(textSource, props.expressionId, 'output');
  if (!doc) {
    emit('error');
    return;
  }
  emit('confirm', buildExpressionEnvelope(doc, 'value', props.expressionId, 'output'));
}

/** 面板 defineExpose 的可消费面（同 ../ConditionV4Editor.vue PanelExposed）。 */
interface PanelExposed {
  confirm: () => Promise<void> | void;
  confirmDisabled?: boolean;
  /** Esc 内层分流用：函数「更多」目录 / 树坞搜索（面板 defineExpose，可选调用兼容单测 stub）。 */
  isFunctionCatalogOpen?: () => boolean;
  closeFunctionCatalog?: () => void;
  isSearching?: () => boolean;
  clearSearch?: () => void;
}
const panelRef = ref<PanelExposed | null>(null);
const confirmDisabled = computed(() => panelRef.value?.confirmDisabled ?? false);

/**
 * Esc 内层分流（KDialog 的 escapeInterceptor，从局部到整体；返回 true = 已消费，本次 Esc 不再取消弹窗）。
 * 核实结论：内嵌的 AdvancedExpressionPanel 自带两处 Esc 语义——函数「更多」目录、树坞搜索框（@keydown.esc 清空）。
 * 弹层栈在 window 捕获阶段先于输入框自带的 @keydown.esc 派发，不接管的话搜索到一半按 Esc 会直接取消整个弹窗、
 * 丢掉正在写的表达式。口径与 expression-editor 包 ExpressionDialogShell.onEscapeInner 一致。
 */
function onEscapeInner(): boolean {
  const panel = panelRef.value;
  if (panel?.isFunctionCatalogOpen?.()) {
    panel.closeFunctionCatalog?.();
    return true;
  }
  if (panel?.isSearching?.()) {
    panel.clearSearch?.();
    return true;
  }
  return false;
}
/**
 * 函数目录是 NPopover，开着时弹层栈会把 Esc 让给 Naive 弹层，而 NPopover 自己不响应 Esc；
 * 所以在窗口外壳上捕获阶段再兜一道：目录开着时 Esc 只收目录、不再往下传（同 ExpressionDialogShell.onShellKeydownCapture）。
 */
function onShellKeydownCapture(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const panel = panelRef.value;
  if (!panel?.isFunctionCatalogOpen?.()) return;
  e.stopPropagation();
  panel.closeFunctionCatalog?.();
}

function onFooterConfirm(): void {
  void panelRef.value?.confirm();
}
function onFooterCancel(): void {
  emit('cancel');
}
</script>

<template>
  <!-- show 恒为 true：调用方 v-if 控制挂载 / 卸载（见头注释）；关闭（右上角 ✕ / Esc）= 取消，不产生任何变更。
       不传 dirty：取消语义本就是「丢弃草稿」，不额外加二次确认。 -->
  <KDialog
    size-preset="M"
    :show="true"
    density="standard"
    :title="
      (mode === 'condition' ? i18n.t('workflow.designer.expr.editCondition') : i18n.t('workflow.designer.expr.editValue')) +
      (purpose ? ' · ' + purpose : '')
    "
    :maximizable="false"
    :resizable="false"
    :draggable="false"
    flush
    :default-size="{ width: 860, height: 600 }"
    :escape-interceptor="onEscapeInner"
    @close="onFooterCancel"
    @keydown.capture="onShellKeydownCapture"
  >
    <div class="v4dlg-body">
      <AdvancedExpressionPanel
        v-if="mode === 'condition'"
        ref="panelRef"
        :show="true"
        purpose="where"
        :model-value="null"
        :text-source="whereTextSource"
        :source-tables="[]"
        :form-tables="tables"
        :hide-persistent-hints="true"
        :compact-function-bar="true"
        @confirm-where="onConfirmWhere"
        @confirm-unchanged="onConfirmUnchanged"
      />
      <AdvancedExpressionPanel
        v-else
        ref="panelRef"
        :show="true"
        purpose="value"
        :model-value="valueModelValue"
        :source-tables="[]"
        :form-tables="tables"
        :hide-persistent-hints="true"
        :compact-function-bar="true"
        @confirm="onConfirmValue"
      />
    </div>
    <template #footer>
      <KDialogFooter
        :confirm-text="i18n.t('workflow.designer.expr.confirm')"
        :cancel-text="i18n.t('workflow.designer.expr.cancel')"
        :confirm-disabled="confirmDisabled"
        @confirm="onFooterConfirm"
        @cancel="onFooterCancel"
      />
    </template>
  </KDialog>
</template>

<style scoped>
/* 内嵌面板自行测量实际内容高度，不再把固定窗口高当作可编辑高度。 */
/* 内容区：自带 8px 12px 内边距（KDialog 用 flush 通栏）；窗口外壳、标题栏、页脚样式由 KDialog / KDialogFooter 提供 */
.v4dlg-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 8px 12px;
}
</style>
