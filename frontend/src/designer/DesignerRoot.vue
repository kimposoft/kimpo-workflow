<script setup lang="ts">
/**
 * DesignerRoot —— 流程设计器 surface 的真实根组件。
 *
 * 布局（自上而下四段式）：顶部 TopBar（流程名/版本徽标/检查角标/保存发布
 * 按钮）→ CanvasToolbar（撤销重做/缩放/网格吸附参考线/对齐分布/小地图）→ 中间画布区（
 * DesignerCanvas 占满整个中间区域）→ 底部 DesignerStatusBar（检查项计数/节点连线数/保存状态/
 * 缩放滑块/全屏按钮，见其头注释——保存时间也在这里展示，TopBar 不再显示）。
 * 节点库 FloatingStencilPanel 与属性面板 FloatingPropsPanel 都不是固定栏位，而是浮动盖在画布
 * 之上（可拖动/可收起成图标，分别见 stencil/FloatingStencilPanel.vue、
 * shell/FloatingPropsPanel.vue 头注释）——属性面板额外支持"钉住"贴回
 * 右缘、画布真实让出宽度（见 canvasYieldStyle 定义处），因此两者都不计入"栏"的固定布局分配，
 * 中间画布区不再有 flex 兄弟栏位吃掉宽度。
 *
 * 数据流：挂载时 host.getDefinition() 拿定义与草稿 → ensureDocumentShape 补形状 → 造一个
 * WorkflowDocumentState 作为设计器文档状态的唯一权威——本组件只经它读写文档，不直接改
 * 内部 _doc（见 model/document-state.ts 头注释"唯一权威"）。state.onChange 回调里：① 递增
 * changeTick 驱动 nodes/edges/layout 等 computed 重新求值（WorkflowDocumentState 本身不是 Vue
 * 响应式对象，靠这个 tick 桥接）；② 把 state.isDirty() 同步给 host.interactiveSession.markDirty
 * ——Host 据此判断"这次关闭要不要弹未保存确认"，脏态置位与保存后清除都经这一条路径，不需要
 * 在 handleSave 里另外调用 markDirty(false)（markSaved() 本身会触发 onChange）。
 *
 * 发布 = 先保存（复用 handleSave，失败即整体中止）→ host.validate(草稿) → 有诊断则不发布、把
 * 诊断灌进检查角标与节点/连线角标、toast 提示条数 → 无诊断才真正 host.publish()。
 *
 * 硬约束：面向业务设计者的产品界面，不出现错误码/内部编号/字段 id/JSON 结构/"宿主/运行期/只读态"
 * 这类内部词——host.*() 返回的错误只用于 if/switch 分支判断，从不把 error.message 直接吐给用户，
 * 一律经本文件下方的业务话 toast 映射。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import type { PluginI18n } from '@kimposoft/plugin-sdk';
import type { GraphNodeView } from '../graph';
import { nodeDimensions } from '../graph/x6-adapter';
import type { NodeKind, WorkflowDocument } from '../model';
import { ensureDocumentShape } from '../model/defaults';
import { WorkflowDocumentState } from '../model/document-state';
import DesignerCanvas from './canvas/DesignerCanvas.vue';
import { toGraphEdges, toGraphNodes, layoutFromDocument, applyLayoutToDocument } from './graph-bridge';
import { getNodeTypeDefinition, type NodeSummary } from './nodes/registry';
// 节点库浮动在画布左上，不是固定左栏——DesignerRoot 只挂
// FloatingStencilPanel 这个浮动外壳（拖动/收起/本地记忆），不再直接用 StencilPanel（其行为本身
// 未变，见 stencil/FloatingStencilPanel.vue 头注释）。
import { FloatingStencilPanel } from './stencil';
// DesignerCanvas 首次打开锚定发起节点时要"绕开"浮动节点库面板，但画布
// 本身不认识"节点库"这个业务概念（见 DesignerCanvas.vue stencilAvoidZone prop 注释）——只有本
// 文件（认识 stencil/ 目录）负责读面板的持久化状态、估算它此刻的占位，再经 prop 转手交给画布。
// 双击节点库条目新增节点的落点计算同理引入。
import { estimateStencilPanelAvoidZone, readPersistedStencilPanelState } from './stencil/floating-panel';
import { computeStencilDblClickPosition, type PlacedNodeRect } from './stencil-drop-placement';
import TopBar from './shell/TopBar.vue';
// 画布工具栏（撤销/重做/缩放/网格/吸附/参考线/对齐/分布/小地图），
// 见其头注释——本组件只 emit 用户意图，具体调用 canvasRef.xxx() 的职责仍在本文件。
import CanvasToolbar from './shell/CanvasToolbar.vue';
// 底部状态栏（检查项计数/节点连线数/保存状态/缩放/全屏），见其头注释——
// 同 CanvasToolbar 既定分工，本组件只 emit 用户意图，缩放/全屏的具体调用仍在本文件。
import DesignerStatusBar from './shell/DesignerStatusBar.vue';
// 属性面板是浮层——DesignerRoot 只挂 FloatingPropsPanel 这个浮动外壳（拖动/收起/钉住/本地
// 记忆全在这一层），不直接用 PropsPanel（内部分发逻辑见 shell/FloatingPropsPanel.vue 头注释）。
import FloatingPropsPanel from './shell/FloatingPropsPanel.vue';
// 钉住态要让画布真实让出宽度（不是被盖住）——本文件负责把 FloatingPropsPanel emit 的钉住态
// 转成对 DesignerCanvas 元素的 margin-right 样式，具体常量与钉住时的贴边几何全在这个纯函数
// 模块，见其头注释"参数化点"。
import { PROPS_PANEL_DOCK_GAP, PROPS_PANEL_WIDTH, readPersistedPropsPanelState } from './shell/props-panel-position';
import { DESIGNER_HOST_KEY, DESIGNER_I18N_KEY, DESIGNER_STATE_KEY, type DesignerHost } from './host';
import { useIssues, DESIGNER_ISSUES_KEY } from './issues/useIssues';
// 小地图收起态"一处状态两处入口"（见 canvas/minimap-collapse.ts 头注释）：画布内嵌折叠胶囊与本
// 文件新增的工具栏"小地图"按钮各调一次本 composable，拿到同一份响应式状态，天然联动，本文件
// 不新造第二份状态。
import { useMinimapCollapsed } from './canvas/minimap-collapse';
// 按绑定引擎能力收窄设计器（禁用不支持的节点、引擎不可用只读），见其头注释。
import { NO_ENGINE_RESTRICTIONS, loadEngineRestrictions, type EngineRestrictions } from './engine-capabilities';

// window.$message 由宿主页面在运行时提供（naive-ui discrete message API 挂载于宿主 window）；
// 插件与宿主同页运行、共享同一 window，运行时可用，仅编译期本插件 tsconfig 不含宿主环境声明，
// 需本地补一份类型（仅类型声明，无运行时依赖），与动作设计器插件的做法一致。
declare global {
  interface Window {
    $message?: {
      success(content: string): void;
      warning(content: string): void;
      error(content: string): void;
    };
  }
}

function toast(kind: 'success' | 'warning' | 'error', text: string): void {
  window.$message?.[kind]?.(text);
}

const props = withDefaults(
  defineProps<{
    host: DesignerHost;
    i18n: PluginI18n;
    readOnly?: boolean;
  }>(),
  { readOnly: false }
);

// ── i18n 语言切换驱动重渲染（同 DesignerCanvas.vue/StencilPanel.vue 既定的 localeTick 手法：
// i18n.t() 是普通函数调用，不天然具备 Vue 响应性，靠这个 tick 让依赖它的 computed 重新求值）。
const localeTick = ref(0);
let unsubscribeLocale: (() => void) | undefined;

// ── provide：后续节点属性面板卡经 inject(DESIGNER_HOST_KEY)/inject(DESIGNER_STATE_KEY)/
// inject(DESIGNER_I18N_KEY) 直接拿到这三样，不需要每一层都手工转发 props（见 host.ts 头注释）。
provide(DESIGNER_HOST_KEY, props.host);
provide(DESIGNER_I18N_KEY, props.i18n);
const state = shallowRef<WorkflowDocumentState | undefined>(undefined);
provide(DESIGNER_STATE_KEY, state);

// ── 检查项清单（useIssues 组合式，见 issues/useIssues.ts 头注释）：
// onFocus 复用 locateTarget（本文件下方定义，函数声明会提升，这里引用它在时序上没有问题）——
// IssuesBar 的点击/上一条/下一条共用同一份定位逻辑。provide 出去供 shell/IssuesBadge.vue、
// issues/IssuesBar.vue 经 inject(DESIGNER_ISSUES_KEY) 直接消费，不再逐层转发 props。
const issuesApi = useIssues({ onFocus: (target) => locateTarget(target.nodeId, target.linkId) });
provide(DESIGNER_ISSUES_KEY, issuesApi);

// ── 绑定引擎能力：挂载 / 重试时向宿主现查一次，取不到按不限制。 ──────────────
const engineRestrictions = shallowRef<EngineRestrictions>(NO_ENGINE_RESTRICTIONS);
/** 实际只读态：宿主要求只读（他人正在编辑、绑定失败、绑定引擎不可用时宿主已按只读挂载），或本插件自己查到绑定引擎
 *  不可用（双保险）。所有写文档的处理函数与子组件的 read-only 都看它，不再直接看 props.readOnly。 */
const effectiveReadOnly = computed(() => props.readOnly || engineRestrictions.value.unavailable);
/** 节点库里因引擎不支持而禁用的节点种类，悬停提示「当前引擎不支持」。 */
const engineUnsupportedKinds = computed<NodeKind[]>(() => engineRestrictions.value.unsupportedKinds);
const engineUnsupportedHint = computed(() => {
  void localeTick.value;
  return props.i18n.t('workflow.designer.stencil.engineUnsupported');
});

/** 拖入 / 双击新建前的引擎能力闸：不支持的节点种类提示并拦下（节点库已禁用，这里防别的入口绕过）。 */
function rejectUnsupportedKind(key: NodeKind): boolean {
  if (!engineRestrictions.value.unsupportedKinds.includes(key)) return false;
  toast('warning', engineUnsupportedHint.value);
  return true;
}

const loading = ref(true);
const loadError = ref(false);
const changeTick = ref(0);
const expectedVersionNo = ref(0);
const latestVersionNo = ref(0);
const savedAt = shallowRef<number | undefined>(undefined);
const selectedNodeIds = ref<string[]>([]);
const selectedEdgeIds = ref<string[]>([]);
const saving = ref(false);
const publishing = ref(false);
// 属性面板是否钉住——初值直接读本地存储（与 FloatingPropsPanel.vue
// 挂载时读的是同一个 key），避免首帧还没等到子组件 onMounted 的 pinned-change 事件之前画布宽度
// 短暂不对；后续变化经 onPropsPanelPinnedChange 同步（本文件不持有钉住态的权威，只镜像它，
// 权威仍在 FloatingPropsPanel.vue 内部，同 estimateStencilPanelAvoidZone 消费处"各自独立读同一
// 份持久化状态"的既定手法）。
const propsPanelPinned = ref(readPersistedPropsPanelState()?.pinned ?? false);

function onPropsPanelPinnedChange(pinned: boolean): void {
  propsPanelPinned.value = pinned;
}

/** 钉住态下画布让出的宽度：面板宽度 + 与画布之间的视觉间隙（见 props-panel-position.ts
 * PROPS_PANEL_DOCK_GAP 头注释）。只改 margin-right 这一处 CSS，不改 DesignerCanvas.vue 内部
 * 任何逻辑——画布自身的 ResizeObserver/X6 resize 已支持"容器变窄就重新适配"。 */
const canvasYieldStyle = computed(() =>
  propsPanelPinned.value ? { marginRight: `${PROPS_PANEL_WIDTH + PROPS_PANEL_DOCK_GAP}px` } : undefined
);
const canvasRef = shallowRef<InstanceType<typeof DesignerCanvas> | null>(null);
// 整个设计器根节点的 DOM 引用，供全屏按钮调用
// element.requestFullscreen()/document.exitFullscreen()——本组件是同文档挂载（markRaw +
// <component :is>，非 iframe，见 kimpo-plugin-sdk SurfaceMountResult 头注释），不受 iframe
// allowfullscreen 限制。
const rootRef = ref<HTMLDivElement | null>(null);
const isFullscreen = ref(false);

// ── 工具栏状态 ──────────────────────────────────────────────────────────────

/** 缩放百分比展示态：唯一权威是 DesignerCanvas 内部的 zoomPercent（120ms 定时器 + 各 zoom*
 *  方法维持），本文件只订阅它的 zoom-change emit 存一份展示值，不自己再轮询 getZoomPercent()
 *  （见 DesignerCanvas.vue 该 emit 定义处注释、下方 onZoomChange 消费处）。 */
const toolbarZoomPercent = ref(100);

/** 网格 / 吸附 / 参考线三个开关：UI 的唯一真值源是这三个本地 ref，不读画布的
 *  isGridVisible()/isSnapToGridEnabled()/isSnaplineEnabled() 查询方法——那几个方法读的是 DOM
 *  背景图、且与 Alt 精细对齐存在耦合（见 x6-adapter.ts 对应方法头注释"🔴 三开关拆分后的副作用"），
 *  不适合当界面持续状态源。初值：网格开、吸附开、参考线关（工具栏默认态）——
 *  X6GraphAdapter 构造期内部默认三者都是 true（见其 snapToGridEnabled/snaplineDesiredEnabled
 *  字段初值），参考线这一项与工具栏默认值不一致，因此下方 watch(canvasRef, ...) 里每次画布
 *  （重新）挂载都要主动把这三个 ref 的当前值推给它一次，不能假设两边默认值天然一致。 */
const gridVisible = ref(true);
const snapToGridEnabled = ref(true);
const snaplineEnabled = ref(false);

/** 小地图展开态（!collapsed）：与画布内嵌折叠胶囊共享同一份状态，见上方 import 注释。 */
const { collapsed: minimapCollapsed, toggle: toggleMinimapCollapsed } = useMinimapCollapsed();

let unsubscribeChange: (() => void) | undefined;

/** 挂载/重试都走这一个函数：先收掉上一轮可能残留的 onChange 订阅，再重新拉一份定义。 */
async function load(): Promise<void> {
  unsubscribeChange?.();
  unsubscribeChange = undefined;
  loading.value = true;
  loadError.value = false;
  state.value = undefined;

  // 引擎能力与定义并行取：getEngineInfo 失败不影响打开（按不限制），见 engine-capabilities.ts。
  const [result, restrictions] = await Promise.all([props.host.getDefinition(), loadEngineRestrictions(props.host)]);
  engineRestrictions.value = restrictions;
  if (result.error || !result.data) {
    loading.value = false;
    loadError.value = true;
    return;
  }

  const definition = result.data.definition;
  // 透传 props.i18n，网关新建草稿（只落一个 start 节点）打开时若还没有
  // name，按当前设计器语言补默认名（同 onStencilDrop 把 props.i18n 转手传给 addNode 的既定
  // 分工，见 model/defaults.ts ensureDocumentShape 头注释）。
  const doc = ensureDocumentShape(definition.draft, props.i18n);
  const nextState = new WorkflowDocumentState(doc);
  unsubscribeChange = nextState.onChange(() => {
    changeTick.value++;
    props.host.interactiveSession.markDirty(nextState.isDirty());
  });

  expectedVersionNo.value = definition.version_no;
  latestVersionNo.value = definition.latest_version_no;
  savedAt.value = definition.draft_updated_at ? Date.parse(definition.draft_updated_at) || undefined : undefined;
  issuesApi.clear();
  selectedNodeIds.value = [];
  selectedEdgeIds.value = [];

  state.value = nextState;
  loading.value = false;
}

function retryLoad(): void {
  void load();
}

function onWindowKeydown(event: KeyboardEvent): void {
  const isSaveCombo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
  if (!isSaveCombo) return;
  event.preventDefault();
  if (effectiveReadOnly.value) return;
  void handleSave();
}

/** 浏览器全屏态变化（用户按 Esc 退出/程序调用 exitFullscreen 都会触发）
 *  同步给 isFullscreen——document.fullscreenElement 是全屏 API 的唯一权威，不在别处另外维护一份
 *  "是否全屏"的猜测值。 */
function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === rootRef.value;
}

/** 状态栏全屏按钮 emit 的用户意图落到这里——同 onToolbarZoomOut 等既定分工，组件只 emit，具体
 *  DOM 调用在本文件。全屏是纯视图操作，不受只读态影响（同状态栏其余展示/视图能力）。 */
function onToggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void rootRef.value?.requestFullscreen();
  }
}

onMounted(() => {
  unsubscribeLocale = props.i18n.onChange(() => {
    localeTick.value++;
  });
  window.addEventListener('keydown', onWindowKeydown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  void load();
});

onBeforeUnmount(() => {
  unsubscribeChange?.();
  unsubscribeLocale?.();
  window.removeEventListener('keydown', onWindowKeydown);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});

// ── 文档展示态派生（changeTick 变化时重新求值，见上方 onChange 订阅注释） ───────────────────

const docSnapshot = computed<WorkflowDocument | undefined>(() => {
  void changeTick.value;
  return state.value?.doc;
});

const docName = computed(() => docSnapshot.value?.name ?? '');

function computeSummaries(doc: WorkflowDocument): Record<string, NodeSummary | undefined> {
  const map: Record<string, NodeSummary | undefined> = {};
  for (const node of doc.nodes) {
    // 给摘要算法注入「发起人」这个固定业务术语的译文——只配了发起人档的
    // 节点，画布摘要要显示「办理人：发起人」而不是退化成「已配置 1 项来源」。用户/角色/部门的
    // 名字反查仍未接线（宿主没有按 id 批量反查展示名的接口，见 nodes/types.ts 注释），不在此处补。
    map[node.id] = getNodeTypeDefinition(node.kind)?.summarize(node, {
      resolveInitiatorLabel: () => props.i18n.t('workflow.designer.assignee.label.initiator')
    });
  }
  return map;
}

const nodes = computed<GraphNodeView[]>(() => {
  const doc = docSnapshot.value;
  if (!doc) return [];
  return toGraphNodes(doc, { i18n: props.i18n, issuesByNode: issuesApi.grouped.value.byNode, summaries: computeSummaries(doc) });
});

const edges = computed(() => {
  const doc = docSnapshot.value;
  if (!doc) return [];
  return toGraphEdges(doc, { i18n: props.i18n, issuesByLink: issuesApi.grouped.value.byLink });
});

const layout = computed(() => {
  const doc = docSnapshot.value;
  return doc ? layoutFromDocument(doc) : undefined;
});

const selection = computed(() => ({ nodeIds: selectedNodeIds.value, linkIds: selectedEdgeIds.value }));

// 撤销/重做是否可用——state.canUndo()/canRedo()（model/document-state.ts
// :91/95）本身不是响应式的，照本文件既有的 docSnapshot 写法包成 computed，靠 changeTick 桥接
// （state.onChange 里递增，见上方 load() 内的订阅）。
const canUndo = computed(() => {
  void changeTick.value;
  return state.value?.canUndo() ?? false;
});
const canRedo = computed(() => {
  void changeTick.value;
  return state.value?.canRedo() ?? false;
});

// 状态栏节点/连线计数——只读 docSnapshot 已缓存的数组长度，严禁另外
// 读 state.doc（getter 每次访问都会深拷贝整份文档，见 model/document-state.ts doc getter 注释）。
const nodeCount = computed(() => docSnapshot.value?.nodes.length ?? 0);
const linkCount = computed(() => docSnapshot.value?.links.length ?? 0);

// 状态栏脏态展示——state.isDirty() 同 canUndo/canRedo 一样是命令式查询，
// 照既有写法用 changeTick 桥接成响应式 computed。
const isDirty = computed(() => {
  void changeTick.value;
  return state.value?.isDirty() ?? false;
});

// 画布每次（重新）挂载都要把网格/吸附/参考线三个 ref 的当前值主动推给它一次——不能假设
// X6GraphAdapter 构造期默认值与工具栏默认值天然一致（参考线一项恰好不一致，见上方 ref 声明
// 注释），也不能只推一次首次值就不管（reload/重试打开会换一个新的画布实例，见 load()）。
watch(
  canvasRef,
  (canvas) => {
    if (!canvas) return;
    canvas.setGridVisible(gridVisible.value);
    canvas.setSnapToGrid(snapToGridEnabled.value);
    canvas.setSnaplineEnabled(snaplineEnabled.value);
  },
  { immediate: true }
);

// ── 保存 / 发布 ─────────────────────────────────────────────────────────────────────────

/** 供 handlePublish 复用，也是画布 'save' emit / Ctrl-S 的直接目标。返回是否保存成功，
 * 失败时业务话 toast 已经在本函数内触发，调用方不需要再重复提示。 */
async function handleSave(): Promise<{ ok: boolean }> {
  if (!state.value) return { ok: false };
  if (effectiveReadOnly.value) {
    toast('warning', props.i18n.t('workflow.designer.readOnly.cannotSave'));
    return { ok: false };
  }
  if (saving.value) return { ok: false };

  saving.value = true;
  try {
    const result = await props.host.saveDraft(state.value.toJSON(), expectedVersionNo.value);
    if (result.error || !result.data) {
      const code = result.error?.code;
      if (code === 'VERSION_CONFLICT') {
        toast('error', props.i18n.t('workflow.designer.save.versionConflict'));
      } else if (code === 'EDIT_LEASE_REQUIRED' || code === 'EDIT_LEASE_NOT_OWNER') {
        toast('error', props.i18n.t('workflow.designer.save.leaseExpired'));
      } else {
        toast('error', props.i18n.t('workflow.designer.save.failed'));
      }
      return { ok: false };
    }
    const definition = result.data.definition;
    expectedVersionNo.value = definition.version_no;
    latestVersionNo.value = definition.latest_version_no;
    savedAt.value = Date.now();
    // 服务端可能对草稿做过规范化（如补齐 id），markSaved 传入服务端回传的版本作为新基线，
    // 见 model/document-state.ts markSaved() 注释。
    state.value.markSaved(ensureDocumentShape(definition.draft, props.i18n));
    return { ok: true };
  } finally {
    saving.value = false;
  }
}

async function handlePublish(): Promise<void> {
  if (!state.value) return;
  if (effectiveReadOnly.value) {
    toast('warning', props.i18n.t('workflow.designer.readOnly.cannotPublish'));
    return;
  }
  if (publishing.value) return;

  publishing.value = true;
  try {
    const saveResult = await handleSave();
    if (!saveResult.ok || !state.value) return;

    const validateResult = await props.host.validate(state.value.toJSON());
    if (validateResult.error || !validateResult.data) {
      toast('error', props.i18n.t('workflow.designer.publish.failed'));
      return;
    }
    const validateDiagnostics = validateResult.data.diagnostics ?? [];
    if (validateDiagnostics.length > 0) {
      issuesApi.setFromDiagnostics(validateDiagnostics);
      toast('warning', props.i18n.t('workflow.designer.publish.hasIssues', { n: validateDiagnostics.length }));
      return;
    }

    const publishResult = await props.host.publish(expectedVersionNo.value);
    const publishDiagnostics = publishResult.diagnostics ?? [];
    if (publishDiagnostics.length > 0) {
      issuesApi.setFromDiagnostics(publishDiagnostics);
      toast('warning', props.i18n.t('workflow.designer.publish.hasIssues', { n: publishDiagnostics.length }));
      return;
    }
    if (publishResult.error || !publishResult.data) {
      const code = publishResult.error?.code;
      if (code === 'VERSION_CONFLICT') {
        toast('error', props.i18n.t('workflow.designer.save.versionConflict'));
      } else if (code === 'EDIT_LEASE_REQUIRED' || code === 'EDIT_LEASE_NOT_OWNER') {
        toast('error', props.i18n.t('workflow.designer.save.leaseExpired'));
      } else {
        toast('error', props.i18n.t('workflow.designer.publish.failed'));
      }
      return;
    }

    latestVersionNo.value = publishResult.data.version_no;
    // 发布会顺带把定义行自己的乐观锁版本号推进一版，回执带了新值就跟着更新
    // expectedVersionNo——不然发布后第一次保存草稿会拿着发布前的旧版本号去撞乐观锁，
    // 白白报一次 VERSION_CONFLICT。老宿主（回执不带这个字段）保持原值，行为不变。
    expectedVersionNo.value = publishResult.data.definition_version_no ?? expectedVersionNo.value;
    issuesApi.clear();
    toast('success', props.i18n.t('workflow.designer.publish.success', { n: publishResult.data.version_no }));
  } finally {
    publishing.value = false;
  }
}

// ── 画布事件接线（全部按 effectiveReadOnly 短路，只读态不产生任何写操作） ──────────────────────

function onSelectionChange(nodeIds: string[], edgeIds: string[]): void {
  selectedNodeIds.value = nodeIds;
  selectedEdgeIds.value = edgeIds;
  state.value?.setSelection(nodeIds, edgeIds);
}

function onNodeMoveEnd(nodeId: string, position: { x: number; y: number }): void {
  if (!state.value || effectiveReadOnly.value) return;
  state.value.moveNodes([{ id: nodeId, x: position.x, y: position.y }]);
}

function onNodesMoveEnd(moves: Array<{ nodeId: string; position: { x: number; y: number } }>): void {
  if (!state.value || effectiveReadOnly.value) return;
  state.value.moveNodes(moves.map((m) => ({ id: m.nodeId, x: m.position.x, y: m.position.y })));
}

function onConnect(from: string, to: string): void {
  if (!state.value || effectiveReadOnly.value) return;
  const result = state.value.addLink(from, to);
  if (!result.ok) {
    toast('warning', props.i18n.t(`workflow.designer.link.reject.${result.reason}`));
  }
}

function onDeleteSelection(): void {
  if (!state.value || effectiveReadOnly.value) return;
  const doc = state.value.doc;
  const blockedStart = selectedNodeIds.value.some((id) => {
    const node = doc.nodes.find((n) => n.id === id);
    return node && getNodeTypeDefinition(node.kind)?.canDelete === false;
  });
  if (blockedStart) {
    toast('warning', props.i18n.t('workflow.designer.delete.startBlocked'));
  }
  if (selectedNodeIds.value.length) state.value.removeNodes(selectedNodeIds.value);
  if (selectedEdgeIds.value.length) state.value.removeLinks(selectedEdgeIds.value);
  selectedNodeIds.value = [];
  selectedEdgeIds.value = [];
  state.value.setSelection([], []);
}

function onUndo(): void {
  if (!state.value || effectiveReadOnly.value) return;
  state.value.undo();
}

function onRedo(): void {
  if (!state.value || effectiveReadOnly.value) return;
  state.value.redo();
}

// ── 工具栏事件接线：CanvasToolbar.vue 只 emit 用户意图，本节负责
// 把意图翻译成对 canvasRef/state 的实际调用，同上面画布事件接线一节的既定分工。────────────────

function onZoomChange(percent: number): void {
  toolbarZoomPercent.value = percent;
}

function onToolbarZoomOut(): void {
  canvasRef.value?.zoomOut();
}

function onToolbarZoomIn(): void {
  canvasRef.value?.zoomIn();
}

function onToolbarZoomFit(): void {
  canvasRef.value?.zoomToFit();
}

function onToolbarZoomActual(): void {
  canvasRef.value?.zoomTo100();
}

/** 状态栏缩放滑块 emit 的任意百分比值——同 onToolbarZoomOut/In 等既定分工，直接转手调
 *  canvasRef.zoomToPercent()，画布内部会把值钳在 20~400（见 x6-adapter.ts 该方法注释），本文件
 *  不重复钳值。滑块拖动后画布经 zoom-change emit 把新值回灌 toolbarZoomPercent（见下方
 *  onZoomChange），状态栏与工具栏共享同一份缩放百分比真值源，不会出现两处显示不一致。 */
function onStatusBarZoom(percent: number): void {
  canvasRef.value?.zoomToPercent(percent);
}

function onToolbarToggleGrid(): void {
  gridVisible.value = !gridVisible.value;
  canvasRef.value?.setGridVisible(gridVisible.value);
}

function onToolbarToggleSnap(): void {
  snapToGridEnabled.value = !snapToGridEnabled.value;
  canvasRef.value?.setSnapToGrid(snapToGridEnabled.value);
}

function onToolbarToggleSnapline(): void {
  snaplineEnabled.value = !snaplineEnabled.value;
  canvasRef.value?.setSnaplineEnabled(snaplineEnabled.value);
}

/** 对齐/分布只读态下禁用（同 onUndo/onRedo/onDeleteSelection 的既定短路写法）——工具栏按钮本身
 *  也会按 readOnly 置灰，这里是双保险，防止有别的调用路径绕过按钮态直接触发。
 *  mode 六档同 CanvasToolbar.vue 的 align emit 与 x6-adapter.ts 的 alignSelection：横向三档
 *  （left/center/right）只碰 x，纵向三档（top/middle/bottom）只碰 y——
 *  工具栏"水平居中"按钮对应 'center'，不是 'middle'。 */
function onToolbarAlign(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void {
  if (effectiveReadOnly.value) return;
  canvasRef.value?.alignSelection(mode);
}

/** 分布方向由 CanvasToolbar 的 distribute emit 带参传入，直接透传给
 *  X6GraphAdapter.distributeSelection(mode)，横向与纵向等距分布共用这一个入口。 */
function onToolbarDistribute(mode: 'horizontal' | 'vertical'): void {
  if (effectiveReadOnly.value) return;
  canvasRef.value?.distributeSelection(mode);
}

function onRenameNode(nodeId: string, name: string): void {
  if (!state.value || effectiveReadOnly.value) return;
  state.value.renameNode(nodeId, name);
}

/** 形状面板拖到画布空白处新建节点；超出该类型数量上限（如再拖一个"发起"）时 addNode 返回
 * undefined，此时业务话提示，不产生任何变更（同 model/document-state.ts addNode 注释）。 */
function onStencilDrop(key: NodeKind, position: { x: number; y: number }): void {
  if (!state.value || effectiveReadOnly.value) return;
  if (rejectUnsupportedKind(key)) return;
  // props.i18n 转手传给 addNode → createDefaultConfig：审批节点默认按钮名称需要按当前语言生成
  // （见 model/document-state.ts addNode 该参数注释）。
  const node = state.value.addNode(key, position, props.i18n);
  if (!node) toast('warning', props.i18n.t('workflow.designer.stencil.limitReached'));
}

/**
 * resolveStencilDragPreview —— 传给节点库的 resolveDragPreview prop：从节点库往画布拖节点时，跟着
 * 指针走的预览图要画成"这个节点落下之后的样子"（见 stencil/drag-preview.ts
 * 头注释），而"落下后叫什么、第二行摘要写什么、画布此刻多大"只有本文件知道——节点库不认识文档
 * 也不认识画布，故在这里按 key 算好交过去：
 *   - label：与 onStencilDrop → addNode 真正写入的默认名同一份实现（nextDefaultNodeName）；
 *   - summary：拿该类型的默认配置临时拼一个节点跑注册表 summarize()，与 computeSummaries 给画布
 *     节点算摘要是同一条路径（临时节点只用于求摘要，不进文档、不进撤销栈）；
 *   - scale：画布当前缩放（toolbarZoomPercent，画布经 zoom-change 回灌的展示值），预览图按它等比
 *     放缩才能与落下后的节点一样大。
 * 数量已达上限的类型（松手后 addNode 会拒绝并提示）照常给预览，不在拖动阶段提前拦——拦截与提示
 * 的唯一出口仍是 onStencilDrop。
 */
function resolveStencilDragPreview(key: NodeKind): { label: string; summary?: string; scale?: number } | undefined {
  if (!state.value) return undefined;
  const def = getNodeTypeDefinition(key);
  const label = state.value.nextDefaultNodeName(key, props.i18n);
  const draft = { id: '__stencil_drag_preview__', kind: key, name: label, config: def?.createDefaultConfig(props.i18n) ?? {} };
  const summary = def?.summarize(draft, {
    resolveInitiatorLabel: () => props.i18n.t('workflow.designer.assignee.label.initiator')
  });
  return {
    label,
    summary: summary ? props.i18n.t(summary.key, summary.params) : '',
    scale: toolbarZoomPercent.value / 100
  };
}

/**
 * computeStencilAvoidZone —— 传给 DesignerCanvas 的 stencilAvoidZone prop：DesignerCanvas.vue 首次打开锚定发起节点时调用，入参是它近似换算出的"面板定位容器"
 * （.wf-designer-canvas-wrap）像素尺寸，本函数只需要读面板的持久化状态（与 FloatingStencilPanel
 * 挂载时读的是同一份，见 readPersistedStencilPanelState 头注释）、把两者交给
 * estimateStencilPanelAvoidZone 这个纯函数即可——具体的几何估算全部在那边，本函数只是接线。
 */
function computeStencilAvoidZone(wrapSize: { width: number; height: number }): { right: number; top: number; bottom: number } | null {
  return estimateStencilPanelAvoidZone(readPersistedStencilPanelState(), wrapSize);
}

/** 双击形状面板条目：在画布上新建同一类型节点，落点由 stencil-drop-placement.ts 的纯函数算出
 * （见该文件头注释）——有选中节点
 * 落在其右侧，没有则落在当前最靠右的节点右侧，且与已有节点重叠时自动向下顺延。新建成功后：
 *   ① 新节点自动成为选中节点（连续双击可沿它一路向右顺接，属性面板也直接打开它）；
 *   ② 若新节点包围盒没有完整落在当前可视区内，把视口平移到刚好完整可见（只动视口，见
 *      DesignerCanvas.vue revealRect() 头注释）——不需要等 sync() watcher 把新节点真正画成
 *      X6 cell 才能调用（revealRect 纯粹基于文档坐标计算，不查 X6 cell，因此这里不用包
 *      nextTick，与 locateTarget() 里 centerOn() 需要 nextTick 的既定用法不同，见其消费处）。
 * 达到该类型节点数量上限时 addNode 返回 undefined，此时业务话提示、不做①②两步（保持既有提示
 * 逻辑不变）。 */
function onStencilDblClick(key: NodeKind): void {
  if (!state.value || effectiveReadOnly.value) return;
  if (rejectUnsupportedKind(key)) return;
  const existingNodes: PlacedNodeRect[] = state.value.doc.nodes.map((n) => {
    const size = nodeDimensions(n.kind);
    return { id: n.id, x: n.position_x ?? 0, y: n.position_y ?? 0, width: size.width, height: size.height };
  });
  const newNodeSize = nodeDimensions(key);
  const position = computeStencilDblClickPosition({
    existingNodes,
    newNodeSize,
    selectedNodeId: selectedNodeIds.value[0]
  });
  const node = state.value.addNode(key, position, props.i18n);
  if (!node) {
    toast('warning', props.i18n.t('workflow.designer.stencil.limitReached'));
    return;
  }
  selectedNodeIds.value = [node.id];
  selectedEdgeIds.value = [];
  state.value.setSelection(selectedNodeIds.value, selectedEdgeIds.value);
  canvasRef.value?.revealRect({ x: node.position_x ?? position.x, y: node.position_y ?? position.y, width: newNodeSize.width, height: newNodeSize.height });
}

function onLayoutChange(): void {
  if (!state.value || effectiveReadOnly.value) return;
  const currentLayout = canvasRef.value?.getLayout();
  if (currentLayout) applyLayoutToDocument(state.value, currentLayout);
}

function onRenameDoc(name: string): void {
  if (!state.value || effectiveReadOnly.value) return;
  state.value.setName(name);
}

/** 检查项清单条目定位：选中对应节点/连线并把画布平移到其可见范围内——issuesApi 的 onFocus 回调
 *  绑的就是本函数（见上方 useIssues 调用处），IssuesBar.vue 点具体一条 / 点上一条 / 点下一条最终
 *  都落到这里，本函数不关心是哪种触发方式。 */
function locateTarget(nodeId?: string, linkId?: string): void {
  const target = nodeId ?? linkId;
  if (!target) return;
  selectedNodeIds.value = nodeId ? [nodeId] : [];
  selectedEdgeIds.value = linkId ? [linkId] : [];
  state.value?.setSelection(selectedNodeIds.value, selectedEdgeIds.value);
  void nextTick(() => canvasRef.value?.centerOn(target));
}
</script>

<template>
  <div class="wf-designer-root" ref="rootRef">
    <template v-if="loading">
      <div class="wf-designer-empty">{{ i18n.t('workflow.designer.root.loading') }}</div>
    </template>
    <template v-else-if="loadError">
      <div class="wf-designer-empty">
        <p>{{ i18n.t('workflow.designer.root.loadFailed') }}</p>
        <button type="button" class="wf-designer-retry" @click="retryLoad">{{ i18n.t('workflow.designer.root.retry') }}</button>
      </div>
    </template>
    <template v-else>
      <TopBar
        :i18n="i18n"
        :locale-tick="localeTick"
        :name="docName"
        :latest-version-no="latestVersionNo"
        :nodes="nodes"
        :read-only="effectiveReadOnly"
        :engine-unavailable="engineRestrictions.unavailable"
        :saving="saving"
        :publishing="publishing"
        @update:name="onRenameDoc"
        @save="handleSave"
        @publish="handlePublish"
      />
      <CanvasToolbar
        :i18n="i18n"
        :locale-tick="localeTick"
        :read-only="effectiveReadOnly"
        :selected-count="selectedNodeIds.length"
        :zoom-percent="toolbarZoomPercent"
        :can-undo="canUndo"
        :can-redo="canRedo"
        :grid-visible="gridVisible"
        :snap-enabled="snapToGridEnabled"
        :snapline-enabled="snaplineEnabled"
        :minimap-visible="!minimapCollapsed"
        @undo="onUndo"
        @redo="onRedo"
        @zoom-out="onToolbarZoomOut"
        @zoom-in="onToolbarZoomIn"
        @zoom-fit="onToolbarZoomFit"
        @zoom-actual="onToolbarZoomActual"
        @toggle-grid="onToolbarToggleGrid"
        @toggle-snap="onToolbarToggleSnap"
        @toggle-snapline="onToolbarToggleSnapline"
        @toggle-minimap="toggleMinimapCollapsed"
        @align="onToolbarAlign"
        @distribute="onToolbarDistribute"
        @delete-selection="onDeleteSelection"
      />
      <div class="wf-designer-body">
        <!-- 节点库浮动盖在画布左上——这层 wrap 只提供一个 position:relative 的定位基准，
             FloatingStencilPanel 在其内部用 absolute 定位，不参与 flex 布局分配（画布因此能向左占满）。 -->
        <div class="wf-designer-canvas-wrap">
          <DesignerCanvas
            ref="canvasRef"
            class="wf-designer-canvas"
            :style="canvasYieldStyle"
            :nodes="nodes"
            :edges="edges"
            :selected-node-ids="selectedNodeIds"
            :selected-edge-ids="selectedEdgeIds"
            :layout="layout"
            :i18n="i18n"
            :locale-tick="localeTick"
            :read-only="effectiveReadOnly"
            :stencil-avoid-zone="computeStencilAvoidZone"
            @selection-change="onSelectionChange"
            @node-move-end="onNodeMoveEnd"
            @nodes-move-end="onNodesMoveEnd"
            @connect="onConnect"
            @delete-selection="onDeleteSelection"
            @undo="onUndo"
            @redo="onRedo"
            @save="handleSave"
            @rename-node="onRenameNode"
            @stencil-drop="onStencilDrop"
            @layout-change="onLayoutChange"
            @zoom-change="onZoomChange"
          />
          <FloatingStencilPanel
            :i18n="i18n"
            :locale-tick="localeTick"
            :disabled="effectiveReadOnly"
            :disabled-keys="engineUnsupportedKinds"
            :disabled-hint="engineUnsupportedHint"
            :resolve-drag-preview="resolveStencilDragPreview"
            @dblclick-item="onStencilDblClick"
          />
          <!-- 属性面板浮层——与节点库浮层同级挂在这个定位容器内，三态
               （浮动/钉住/收起）与拖动/记忆全部封装在组件内部，见其头注释。钉住态让画布真实变窄
               的那部分由本文件的 canvasYieldStyle 完成（见上方定义），本组件只负责汇报"自己
               此刻是不是钉住了"。 -->
          <FloatingPropsPanel
            :i18n="i18n"
            :locale-tick="localeTick"
            :doc="docSnapshot"
            :selection="selection"
            :read-only="effectiveReadOnly"
            @pinned-change="onPropsPanelPinnedChange"
          />
        </div>
      </div>
      <DesignerStatusBar
        :i18n="i18n"
        :locale-tick="localeTick"
        :node-count="nodeCount"
        :link-count="linkCount"
        :dirty="isDirty"
        :saved-at="savedAt"
        :zoom-percent="toolbarZoomPercent"
        :is-fullscreen="isFullscreen"
        @zoom="onStatusBarZoom"
        @toggle-fullscreen="onToggleFullscreen"
      />
    </template>
  </div>
</template>

<style scoped>
.wf-designer-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: rgb(var(--layout-bg-color, 250 251 252));
}
.wf-designer-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgb(var(--text-secondary-color, 102 102 102));
  font-size: 13px;
}
.wf-designer-retry {
  height: 30px;
  padding: 0 16px;
  border: 1px solid rgb(var(--border-dark-color, 212 215 222));
  border-radius: 4px;
  background: rgb(var(--container-bg-color, 255 255 255));
  color: rgb(var(--base-text-color, 31 31 31));
  cursor: pointer;
}
.wf-designer-retry:hover { background: rgb(var(--fill-color, 240 242 245)); }
/* 本层只有 .wf-designer-canvas-wrap 这一个 flex 子元素，因此不需要 gap；padding 是画布区域
   与顶栏/状态栏之间的呼吸间距。 */
.wf-designer-body {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 10px;
}
/* 画布的定位基准——FloatingStencilPanel 在其内部用 absolute 定位盖在
   画布之上（见其组件头注释），本层只是个 position:relative 容器，不参与画布自身的 flex:1 撑满
   逻辑（.wf-designer-canvas 仍是撑满这个 wrap 的那个 flex 子元素）。属性面板浮层
   （FloatingPropsPanel）也挂在这一层内，钉住态下画布让出的宽度由
   DesignerRoot.vue 的 canvasYieldStyle 经 margin-right 实现，见其定义处注释——本层与
   .wf-designer-canvas 自身的样式规则不需要为"钉住"这件事新增任何东西。 */
.wf-designer-canvas-wrap { position: relative; display: flex; flex: 1; min-width: 0; }
.wf-designer-canvas { flex: 1; min-width: 0; }
</style>
