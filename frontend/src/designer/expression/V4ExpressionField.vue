<script setup lang="ts">
/**
 * expression/V4ExpressionField.vue —— 通用的「V4 表达式」一行字段（token 化只读呈现）：
 * 一行只读展示 + 编辑 / 清空，供办理节点的步骤摘要、
 * 引导线的判断条件（以及审批「结果摘要」、抄送「标题/正文」等同类字段）共用同一份接口，不各写
 * 一份表达式编辑壳。
 *
 * mode='condition'：判断表达式（引导线条件、自动办理条件等），落库 purpose='condition'；
 * mode='value'：取值表达式（步骤摘要、通知标题/正文等），落库 purpose='output'。
 *
 * 本组件只认「文档」，不认「这是哪个节点/哪条线的哪个字段」——调用方经 expressionId 传入落库要用
 * 的 expression_id（引导线＝ linkId；节点步骤摘要＝ `<nodeId>:summary`），经 update:modelValue 拿到
 * 组装好的信封后自行落到 node.config 或 link.condition_doc 上（走 document-state.ts 的
 * updateNodeConfig / updateLinkCondition，本组件不直接碰文档状态）。
 *
 * 作用域收窄（只能引用主表字段）见 ./v4Scope.ts；真正的编辑器内嵌壳是
 * ./V4ExpressionEditDialog.vue（provide/inject 约束要求 host 就绪后才创建，见其头注释）。
 *
 * 只读展示是"token 化"的——字段引用渲染成主色小块（悬停显示
 * 所属表），识别出的函数调用斜体，其余原样文本；解析逻辑抽在 ./tokenDisplay.ts（零 DOM 依赖的纯
 * 函数，原因见该文件头注释：本插件前端未装 @vue/test-utils，组件级挂载测试做不了，把可测的部分
 * 抽成纯函数）。控件用 NaiveUI（`naive-ui` 已是本插件 UMD external，`window.naive` 由宿主运行时
 * 注入，源码侧按既有兄弟插件 kimpo-action-designer 的约定直接 `import { NButton } from 'naive-ui'`，
 * 构建期外部化、开发/测试期走 node_modules 真实包，两端不冲突）。
 */
import { computed, inject, shallowRef, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { AliceV4Host, V4ExpressionRefWire } from '@kimposoft/expression-editor';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY } from '../host';
import type { V4ExpressionDocumentEnvelope } from '../../model';
import { toHostScope, useMainTableScope } from './v4Scope';
import { parseTokenDisplay, type DisplaySegment } from './tokenDisplay';
import V4ExpressionEditDialog from './V4ExpressionEditDialog.vue';

const props = defineProps<{
  modelValue?: V4ExpressionDocumentEnvelope;
  mode: 'condition' | 'value';
  expressionId: string;
  templateId: string;
  disabled?: boolean;
  disabledHint?: string;
  placeholder?: string;
  /** 可选的业务语境提示（如「自动办理条件」「抄送标题」），供后续面板传入以增强可读性；不传
   *  不影响任何既有行为（现有三处调用点都不传）。用于无障碍标签与编辑弹窗标题后缀。 */
  purpose?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [doc: V4ExpressionDocumentEnvelope | undefined];
}>();

const injectedHost = inject(DESIGNER_HOST_KEY);
const injectedI18n = inject(DESIGNER_I18N_KEY);
if (!injectedHost || !injectedI18n) {
  // 同 designer/host.ts 既定的注入失败口径（缺失即抛具名错误，不静默）：本组件只应挂在
  // DesignerRoot 提供的注入范围内。
  throw new Error('[V4ExpressionField] 缺少 DESIGNER_HOST_KEY/DESIGNER_I18N_KEY 注入，请确认挂载在设计器根组件之下');
}
// 重新声明为非空类型的局部绑定：TS 的控制流窄化不会穿透进下面的 computed/watch 闭包，直接把
// 已经判空的值再赋一次给新变量，声明类型即为非空（不是"记住上面判过"，是当场推导），闭包内
// 读取不会再报"可能是 undefined"。
const host = injectedHost;
const i18n = injectedI18n;

// ── 主表作用域（只喂主表，见 ./v4Scope.ts） ────────────────────────────────────────────────
const templateIdRef = computed(() => props.templateId);
const { scope } = useMainTableScope(host, templateIdRef);

// ── V4 表达式生产桥（按 templateId 异步取；模板未发布时宿主返回 null） ─────────────────────
const v4Host = shallowRef<AliceV4Host | null>(null);
watch(
  templateIdRef,
  async (id) => {
    v4Host.value = null;
    if (!id) return;
    const h = await host.aliceV4(id);
    if (templateIdRef.value === id) v4Host.value = h;
  },
  { immediate: true }
);
// 作用域信封随主表信息就绪即写入 v4Host（diagnose/tokenize/restore 三端点解析 `本报表.[表].[字段]`
// 都要靠它）；host/scope 任一变化都重新写一次，保持两者始终同步。
watch([v4Host, scope], ([h, s]) => {
  if (h && s) h.setScope?.(toHostScope(s));
});

// ── 一行只读展示文字：既有文档存的是 token 化源码，需要经 v4Host.restore 按当前目录换回可读
// 原文（改名后显示新名）；v4Host 未就绪或换取失败时退回原始 source_text，不留空白。displayText
// 喂给编辑弹窗（V4ExpressionEditDialog 需要的"可读原文"，语义不变）；tokenText 是同一次 restore
// 顺带拿到的 token 化形态（`[标签]#{rN}`，标签已按当前目录刷新），喂 ./tokenDisplay.ts 做只读区
// 的 token 化渲染——两者共用同一次 restore 调用，不重复发请求。 ──────────────────────────────
const displayText = shallowRef('');
const tokenText = shallowRef('');
watch(
  [() => props.modelValue, v4Host],
  async ([doc, h]) => {
    if (!doc) {
      displayText.value = '';
      tokenText.value = '';
      return;
    }
    if (!h) {
      // v4Host 未就绪（模板未发布/尚未取到）：回落原始 source_text——它本身已是 `[标签]#{rN}`
      // 形态，tokenDisplay 仍能正常切出 token，只是标签可能是改名前的旧值（同既有回落口径）。
      displayText.value = doc.expression.source_text;
      tokenText.value = doc.expression.source_text;
      return;
    }
    try {
      const res = await h.restore({
        source_text: doc.expression.source_text,
        refs: doc.expression.refs as V4ExpressionRefWire[],
        purpose: props.mode === 'condition' ? 'condition' : 'output'
      });
      // 期间 modelValue/v4Host 可能又变了，只在仍是同一份文档时才回填。
      if (props.modelValue === doc) {
        displayText.value = res.readable_text || (res.ok ? res.text : doc.expression.source_text);
        tokenText.value = res.text || doc.expression.source_text;
      }
    } catch {
      displayText.value = doc.expression.source_text;
      tokenText.value = doc.expression.source_text;
    }
  },
  { immediate: true }
);

// ── 只读区的 token 化展示片段：modelValue 缺席时为空数组（模板按空态渲染「未设置」），否则按
// tokenText（restore 未就绪/失败时即 source_text 本身）+ 当前文档的 refs 稳定绑定表解析。 ──────
const segments = computed<DisplaySegment[]>(() => {
  const doc = props.modelValue;
  if (!doc) return [];
  const text = tokenText.value || doc.expression.source_text;
  return parseTokenDisplay(text, doc.expression.refs as V4ExpressionRefWire[]);
});

// ── 编辑入口可用性：模板未发布/主表尚不可用时禁用（与外部 disabled 叠加） ───────────────────
const scopeReady = computed(() => !!v4Host.value && !!scope.value);
const effectiveDisabled = computed(() => !!props.disabled || !scopeReady.value);
const effectiveHint = computed(() => {
  if (props.disabled) return props.disabledHint;
  if (!scopeReady.value) return i18n.t('workflow.designer.expr.templateNotReady');
  return undefined;
});

const showDialog = shallowRef(false);
const errorText = shallowRef('');

function openEdit(): void {
  if (effectiveDisabled.value) return;
  errorText.value = '';
  showDialog.value = true;
}
function closeDialog(): void {
  showDialog.value = false;
}
function clearValue(): void {
  if (props.disabled) return;
  emit('update:modelValue', undefined);
}
function onDialogConfirm(doc: V4ExpressionDocumentEnvelope): void {
  emit('update:modelValue', doc);
  showDialog.value = false;
}
function onDialogCleared(): void {
  emit('update:modelValue', undefined);
  showDialog.value = false;
}
function onDialogError(): void {
  errorText.value = i18n.t('workflow.designer.expr.editFailed');
}

// ── 无障碍标签：可选 purpose 拼在既有「点击编辑表达式」提示前面，不传 purpose 时与此前行为
// 一致（既有三处调用点都不传，不产生回归）。 ─────────────────────────────────────────────────
const editAriaLabel = computed(() => {
  const base = i18n.t('workflow.designer.expr.editAria');
  return props.purpose ? `${props.purpose} · ${base}` : base;
});

/** 只读展示区（token 区）点击/键盘激活：与「编辑」按钮走同一个 openEdit，满足"点击 token 区
 *  或「编辑」都能进弹窗"（两个入口、一个行为，不重复定义）。 */
function onBoxActivate(): void {
  openEdit();
}
</script>

<template>
  <div class="v4field">
    <div class="v4field__row">
      <div
        class="v4field__box"
        :class="{ 'v4field__box--empty': !modelValue, 'v4field__box--disabled': effectiveDisabled }"
        role="button"
        :tabindex="effectiveDisabled ? -1 : 0"
        :aria-disabled="effectiveDisabled"
        :aria-label="editAriaLabel"
        @click="onBoxActivate"
        @keydown.enter.prevent="onBoxActivate"
        @keydown.space.prevent="onBoxActivate"
      >
        <template v-if="modelValue && segments.length">
          <template v-for="(seg, idx) in segments" :key="idx">
            <span v-if="seg.kind === 'ref'" class="v4field__token" :title="seg.title">{{ seg.label }}</span>
            <em v-else-if="seg.kind === 'func'" class="v4field__func">{{ seg.value }}</em>
            <span v-else class="v4field__plain">{{ seg.value }}</span>
          </template>
        </template>
        <span v-else class="v4field__placeholder">{{ placeholder || i18n.t('workflow.designer.expr.unset') }}</span>
      </div>
      <div class="v4field__actions">
        <NButton
          size="small"
          data-testid="v4field-edit"
          :disabled="effectiveDisabled"
          @click="openEdit"
        >{{ i18n.t('workflow.designer.expr.edit') }}</NButton>
        <NButton
          v-if="modelValue"
          size="small"
          class="v4field__clear-btn"
          data-testid="v4field-clear"
          :disabled="disabled"
          :title="i18n.t('workflow.designer.expr.clear')"
          :aria-label="i18n.t('workflow.designer.expr.clear')"
          @click="clearValue"
        >✕</NButton>
      </div>
    </div>
    <p v-if="effectiveHint" class="v4field__hint">{{ effectiveHint }}</p>
    <p v-if="errorText" class="v4field__error">{{ errorText }}</p>

    <V4ExpressionEditDialog
      v-if="showDialog && v4Host && scope"
      :i18n="i18n"
      :mode="mode"
      :purpose="purpose"
      :expression-id="expressionId"
      :model-value="modelValue"
      :readable-text="displayText"
      :v4-host="v4Host"
      :expression-host="host.expression(templateId)"
      :tables="scope.formTables"
      @confirm="onDialogConfirm"
      @cleared="onDialogCleared"
      @error="onDialogError"
      @cancel="closeDialog"
    />
  </div>
</template>

<style scoped>
/* 小档基线：28 高 / 12 字 / 圆角 4——本组件唯一一处只读表达式展示区，全部控件按此定版。 */
.v4field { display: flex; flex-direction: column; gap: 4px; }
.v4field__row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.v4field__box {
  flex: 1;
  min-width: 0;
  height: 28px;
  line-height: 26px;
  overflow: hidden;
  padding: 0 8px;
  border: 1px solid rgb(var(--border-light-color, 228 231 237));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  cursor: pointer;
}
.v4field__box--disabled { cursor: not-allowed; opacity: 0.7; }
.v4field__box--empty .v4field__placeholder { color: rgb(var(--text-hint-color, 153 153 153)); }
/* 字段引用 token：主色小块（主色浅底 + 主色字），悬停 title 显示所属表 · 字段
 * （见 tokenDisplay.ts refTitle）。颜色仍走"host 运行期注入 CSS 变量 + rgb() 兜底三元组"配色口径
 * （非 model/design-tokens.ts——该文件头注释明写专供 X6 画布视觉），语义色用 --primary-color，
 * 不新增写死色值。 */
.v4field__token {
  display: inline-block;
  margin: 0 1px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgb(var(--primary-color, 10 106 214) / 10%);
  color: rgb(var(--primary-color, 10 106 214));
  font-size: 12px;
  line-height: 18px;
  vertical-align: middle;
}
/* 识别出的函数调用：斜体，不改变颜色（与普通文本同色，仅字形区分）。 */
.v4field__func { font-style: italic; }
.v4field__placeholder { color: rgb(var(--text-hint-color, 153 153 153)); }
.v4field__actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
/* 清除钮：28×28 带边框方钮（实施稿），与左侧「编辑」同高。 */
.v4field .v4field__clear-btn { width: 28px; padding: 0; color: rgb(var(--text-hint-color, 153 153 153)); }
.v4field__hint { margin: 0; color: rgb(var(--text-hint-color, 153 153 153)); font-size: 12px; }
.v4field__error { margin: 0; color: rgb(var(--danger-color, 224 78 65)); font-size: 12px; }
</style>
