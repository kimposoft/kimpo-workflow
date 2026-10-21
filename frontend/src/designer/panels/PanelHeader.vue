<script setup lang="ts">
/**
 * designer/panels/PanelHeader.vue —— 属性面板公共头部：节点类型徽标 + 节点名 + 就地改名，
 * 各 *Panel.vue 共用，不再各自放一个「节点名称」分区——头部本来就要显示节点名。
 *
 * 图标 + 配色：唯一权威来源是 ../../model/node-visual.ts 的 NODE_ICONS / NODE_SHAPE_FAMILY /
 * derivePalette（不自造图标、不写死颜色），并经 ../canvas/use-canvas-palette.ts 的
 * useCanvasPalette() 取当前主题下的 CanvasPalette 再派生（跟随宿主暗色模式实时更新），同
 * ../stencil/StencilPanel.vue 图标块的既定手法（见该文件对应注释）。
 *
 * 就地改名交互：点击名称文字变成输入框，Enter/失焦提交，Esc 取消（不落库、还原为改名前的值），
 * 清空后提交回填默认名——这套"点击态切换 + commit 早退保护"手法照抄
 * ../shell/TopBar.vue 的 editingName/startEdit/commitEdit/cancelEdit（复用其已验证过的写法：
 * cancelEdit 先把 editing 置 false 再还原草稿值，commitEdit 开头
 * `if (!editing.value) return` 早退——即使 Esc 之后浏览器把焦点从即将被卸载的输入框移走触发了
 * 一次 blur，也不会被 commitEdit 误当成一次真实提交）；回填默认名调用
 * ../../model/node-naming.ts 的 defaultNameForNodeAt()，与 addNode() 落库默认名共用同一纯
 * 函数（同 StartPanel.vue:58-79 onNameBlur 的既定口径，不重复定义第二套规则）。
 *
 * 🔴 改名输入框是 NaiveUI 组件而不是原生元素：若在同一个事件名上分别挂两条带按键修饰符的监听
 * （"回车提交""取消"各一条），模板编译器会把它们合并成同一个 prop 上的一个函数数组整体传给组件；
 * NaiveUI 对这个 prop 声明的类型是单个函数，收到数组会在运行期报"类型不对"的告警（行为虽然靠
 * NaiveUI 内部"数组则逐个调用"的未公开兼容处理仍生效，但不可依赖）。因此这里只挂一条监听、内部
 * 按 `event.key` 自行分支，不依赖按键修饰符语法糖。
 *
 * 键盘事件冒泡到画布全局快捷键（Delete/Backspace 删节点等）的核实结论：已读
 * ../../graph/x6-adapter.ts 的键盘绑定守卫——它按 `event.target` 是否命中
 * `input, textarea, select` 选择器（或 contentEditable）来判断"当前是否在一个可编辑控件里"，
 * 命中就直接放行、不执行删除等动作。keydown 事件的 target 恒是真正接收按键的那个 DOM 节点（一路
 * 冒泡到 document 也不会变），而改名输入框最终渲染出的、真正获得焦点接收按键的是组件内部那个
 * 原生 input 元素本身——因此该守卫本就能正确识别到这里在编辑改名框，不需要本文件再自行拦截
 * 冒泡；这里仍是最小化处理（不额外调用阻止冒泡的方法），避免叠加一层没有必要的防御掩盖了"守卫
 * 本该管这件事"这一事实、给后续维护者制造"两处都在管、到底哪处生效"的疑惑。
 *
 * data-testid 命名约定：PanelHeader.vue / PanelTabs.vue 一律只用 `data-testid` 做定位钩子，
 * 不用 class；命名前缀固定 `panel-header-*` / `panel-tab-*`。部分面板仍有 class 定位
 * （`.hp__input`/`.ap__input`/…，见 ../../e2e/helpers/panels.ts 头注释），新定位点建议统一用
 * data-testid。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { NInput, type InputInst } from 'naive-ui';
import type { WorkflowNode } from '../../model';
import { NODE_ICONS, NODE_SHAPE_FAMILY, derivePalette } from '../../model/node-visual';
import { useCanvasPalette } from '../canvas/use-canvas-palette';
import { defaultNameForNodeAt, nodeTypeLabel } from '../../model/node-naming';
import { usePanelHost } from './usePanelHost';

const props = defineProps<{ node: WorkflowNode; readOnly?: boolean }>();

const { i18n, state } = usePanelHost();

// 图标/色块跟随宿主主题（见文件头注释），不是本组件另起一套配色。
const { palette: canvasPalette } = useCanvasPalette();
const themedNodePalette = computed(() => derivePalette(canvasPalette.value));
const iconEntry = computed(() => NODE_ICONS[props.node.kind]);
const paletteEntry = computed(() => themedNodePalette.value[props.node.kind]);
const shapeFamily = computed(() => NODE_SHAPE_FAMILY[props.node.kind]);

/** 节点类型名（如「审批」「办理」）：复用 node-naming.ts 的 nodeTypeLabel——与画布展示态
 *  typeLabel、addNode 默认名共用同一条"取类型业务名"链路，不在本文件另写一次
 *  `workflow.designer.node.${kind}` 字面量。 */
// 类型名在面板头部写全称「发起节点 / 办理节点…」，节点库与画布上仍用短名——
// 因此不改 nodeTypeLabel 本身，在这里套一层面板头专用的文案模板。
const shortTypeLabel = computed(() => nodeTypeLabel(i18n, props.node.kind));
const typeLabel = computed(() => i18n.t('workflow.designer.panel.header.kindLabel', { kind: shortTypeLabel.value }));

// ── 就地改名（照抄 ../shell/TopBar.vue editingName 一套既定手法，见文件头注释） ──────────────
const editing = ref(false);
const nameDraft = ref(props.node.name ?? '');
const nameInputRef = ref<InputInst | null>(null);

watch(
  () => props.node.name,
  (next) => {
    if (!editing.value) nameDraft.value = next ?? '';
  }
);
// 选中项从一个节点切到另一个节点时（PropsPanel.vue 按类型分发，同类型节点复用同一个
// *Panel.vue 实例，本组件不会随选中项切换而重新挂载），不能让上一个节点未提交的编辑态残留到
// 新选中的节点身上——切换节点 id 时强制退出编辑态、按新节点的名字重置草稿。
// 覆盖空白：挂载测试工具一次性传入静态 props、不支持挂载后改写根组件 props，这条 watch 因此
// 没有单测直接覆盖，只能靠人工走查验证。
watch(
  () => props.node.id,
  () => {
    editing.value = false;
    nameDraft.value = props.node.name ?? '';
  }
);

function startEdit(): void {
  if (props.readOnly) return;
  nameDraft.value = props.node.name ?? '';
  editing.value = true;
  void nextTick(() => {
    nameInputRef.value?.focus();
    nameInputRef.value?.select();
  });
}

function commitEdit(): void {
  if (!editing.value) return;
  editing.value = false;
  const trimmed = nameDraft.value.trim();
  if (trimmed) {
    if (trimmed !== props.node.name) state.value?.renameNode(props.node.id, trimmed);
    return;
  }
  // 清空后回填默认名（同 StartPanel.vue onNameBlur 既定口径：defaultNameForNodeAt 与 addNode()
  // 落库默认名共用同一纯函数）。
  const doc = state.value?.doc;
  const fallback = doc ? defaultNameForNodeAt(doc.nodes, props.node.id, i18n) : undefined;
  if (!fallback) return;
  nameDraft.value = fallback;
  state.value?.renameNode(props.node.id, fallback);
}

function cancelEdit(): void {
  editing.value = false;
  nameDraft.value = props.node.name ?? '';
}

/** 改名输入框的键盘处理：单条监听、内部按 `event.key` 自行分支（见文件头注释"🔴"一节——
 *  不要拆回"同一事件挂多条带修饰符的监听"那种写法，在组件上会出问题）。Escape 在少数老浏览器
 *  上报的是 `'Esc'`，一并兼容。 */
function onNameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    commitEdit();
  } else if (event.key === 'Escape' || event.key === 'Esc') {
    cancelEdit();
  }
}
</script>

<template>
  <div class="wf-panel-header" data-testid="panel-header">
    <span
      class="wf-panel-header__badge"
      :class="`family-${shapeFamily}`"
      :style="{ background: paletteEntry.iconBg }"
      data-testid="panel-header-badge"
    >
      <svg v-if="iconEntry" viewBox="0 0 16 16" class="wf-panel-header__icon">
        <path
          :d="iconEntry.d"
          :fill="iconEntry.fill ? paletteEntry.iconColor : 'none'"
          :stroke="iconEntry.fill ? 'none' : paletteEntry.iconColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <div class="wf-panel-header__text">
      <span class="wf-panel-header__type" data-testid="panel-header-type">{{ typeLabel }}</span>
      <NInput
        v-if="editing"
        ref="nameInputRef"
        v-model:value="nameDraft"
        size="small"
        class="wf-panel-header__name-input"
        data-testid="panel-header-name-input"
        @keydown="onNameKeydown"
        @blur="commitEdit"
      />
      <!-- 非编辑态：可点击的纯文本区域（不是原生 <button>，同 PanelSection.vue
           .wf-panel-section__header 既定手法——面板域"禁用原生控件"的口径覆盖到可交互元素，
           点击态用 role="button" + tabindex 补上键盘可达性）。 -->
      <div
        v-else
        class="wf-panel-header__name-display"
        data-testid="panel-header-name-display"
        :class="{ 'is-editable': !readOnly }"
        role="button"
        :tabindex="readOnly ? -1 : 0"
        :aria-disabled="readOnly"
        :title="readOnly ? undefined : i18n.t('workflow.designer.panel.header.rename')"
        @click="startEdit"
        @keydown.enter="startEdit"
      >{{ node.name || shortTypeLabel }}</div>
    </div>
    <!-- 铅笔改名入口：与点名字是同一个行为（startEdit），只是补一个看得见的入口——
         只靠"点名字"可发现性太弱。只读态与编辑中不出。 -->
    <span
      v-if="!readOnly && !editing"
      class="wf-panel-header__rename"
      data-testid="panel-header-rename"
      role="button"
      tabindex="0"
      :title="i18n.t('workflow.designer.panel.header.rename')"
      :aria-label="i18n.t('workflow.designer.panel.header.rename')"
      @click="startEdit"
      @keydown.enter="startEdit"
    >
      <svg viewBox="0 0 16 16" class="wf-panel-header__rename-icon" aria-hidden="true">
        <path d="M11.5 2.5l2 2-7.5 7.5-2.6.6.6-2.6z" />
      </svg>
    </span>
  </div>
</template>

<style scoped>
.wf-panel-header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px;
  border-bottom: 1px solid rgb(var(--border-lighter-color, 235 238 245));
  background: rgb(var(--container-bg-color, 255 255 255));
}
.wf-panel-header__badge {
  display: flex;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  /* 面板头徽标统一圆角方块；画布上发起/结束节点的胶囊形状族不带进面板头。 */
  border-radius: 7px;
}
.wf-panel-header__icon { width: 14px; height: 14px; }
.wf-panel-header__text {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}
.wf-panel-header__type {
  color: rgb(var(--text-hint-color, 153 153 153));
  font-size: 11px;
  line-height: 1.4;
}
.wf-panel-header__name-display {
  overflow: hidden;
  color: rgb(var(--base-text-color, 31 31 31));
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
  border-radius: 4px;
  padding: 0 4px;
  margin: 0 -4px;
}
.wf-panel-header__name-display.is-editable {
  cursor: pointer;
}
.wf-panel-header__name-display.is-editable:hover {
  background: rgb(var(--fill-light-color, 245 247 250));
}
.wf-panel-header__rename {
  display: flex;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: rgb(var(--primary-color, 10 106 214));
  cursor: pointer;
}
.wf-panel-header__rename:hover { background: rgb(var(--fill-light-color, 245 247 250)); }
.wf-panel-header__rename:focus-visible { outline: 2px solid rgb(var(--primary-color, 10 106 214)); outline-offset: 1px; }
.wf-panel-header__rename-icon { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.wf-panel-header__name-input :deep(.n-input__input-el) {
  font-size: 13px;
  font-weight: 600;
}
</style>
