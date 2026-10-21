<script lang="ts">
/**
 * designer/canvas/CanvasRulers.vue —— 画布标尺（常驻、无开关）：
 * 顶部横标尺（高 20px）+ 左侧竖标尺（宽 20px），随画布缩放/平移实时重绘刻度。
 *
 * 本文件拆两个 <script> 块：这一段是普通（非 setup）脚本，只导出**纯函数**
 * computeRulerTicks——刻度换算公式与 canvas 绘制指令解耦，是这段逻辑能在 happy-dom 下被单测
 * 覆盖的唯一方式（同 designer/canvas/viewport.ts 头注释"happy-dom 环境下……抽出纯函数是唯一
 * 可验证的方式"、graph/x6-adapter.ts computeCenterTranslate 头注释的既定手法——多处画布
 * 几何计算都是这个套路：canvas 2D 绘图 API 在 happy-dom 下多为 no-op 桩，测不出真实绘制结果，
 * 但换算公式本身是普通 TS 函数，可以直接单测）。下方 <script setup> 块只负责"把这份数据画
 * 出来"，不重复实现换算逻辑。Vue SFC 允许 <script> 与 <script setup> 共存，前者的具名导出会
 * 随编译后的组件模块一并导出，测试文件可以 `import { computeRulerTicks } from
 * './CanvasRulers.vue'` 直接拿到。
 */

/** 标尺带宽度（顶部高 / 左侧宽）。 */
export const RULER_SIZE = 20;
/** 小刻度像素间隔（画布逻辑坐标，未缩放前）。 */
export const RULER_MINOR_STEP = 10;
/** 大刻度像素间隔。 */
export const RULER_MAJOR_STEP = 50;

/** 一个标尺刻度：逻辑坐标 + 换算后的屏幕像素位置（相对标尺自身起点）+ 是否为大刻度。 */
export interface RulerTick {
  logical: number;
  screen: number;
  major: boolean;
}

/** 取模但结果恒非负——logical 可能是负数（画布原点左/上方），JS 原生 `%` 对负数取模结果同样
 * 为负，不能直接用来判断"是否整除于 majorStep"，需要这个小工具函数先归一化到 [0, divisor)。 */
function nonNegativeMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * computeRulerTicks —— 标尺换算核心：给定画布视口在某一轴上的缩放（scale）与平移（origin，
 * 即 X6GraphAdapter.getViewport() 的 tx 或 ty）、标尺可视长度（像素），算出该范围内全部可见
 * 刻度的"逻辑坐标"与"标尺自身坐标系里的屏幕像素位置"，并标注是否为大刻度（50 画布单位一档）。
 *
 * 换算公式：屏幕像素位置 = 逻辑坐标 * scale + origin——与 X6 的 zoom(scale)/translate(tx,ty)
 * 组合本身就是这套仿射变换（graph/x6-adapter.ts computeCenterTranslate 的
 * `translate = containerCenter - point*scale` 是这条公式反过来的应用，两处系出同源）。
 *
 * 只遍历可视范围内的刻度（先反解出可视范围对应的逻辑坐标区间，再正向遍历），不从 0 开始遍历
 * 整个逻辑坐标轴——避免大幅平移后刻度全部落在可视区域之外时循环空转（"变化即全量
 * 重绘（canvas 单帧 <1ms）"的性能前提）。
 */
export function computeRulerTicks(
  scale: number,
  origin: number,
  lengthPx: number,
  minorStep: number = RULER_MINOR_STEP,
  majorStep: number = RULER_MAJOR_STEP
): RulerTick[] {
  const safeScale = scale > 0 ? scale : 1;
  const startLogical = Math.floor((0 - origin) / safeScale / minorStep) * minorStep;
  const endLogical = Math.ceil((lengthPx - origin) / safeScale / minorStep) * minorStep;
  const ticks: RulerTick[] = [];
  for (let logical = startLogical; logical <= endLogical; logical += minorStep) {
    const screen = logical * safeScale + origin;
    if (screen < 0 || screen > lengthPx) continue; // 只保留真正落在可视范围内的刻度
    ticks.push({ logical, screen, major: nonNegativeMod(logical, majorStep) === 0 });
  }
  return ticks;
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * 数据源：x6-adapter.ts 的 getViewport()/onViewportChange()（画布专属能力，同 zoom/grid/snap
 * 等既定分工——不进 graph/port.ts 的 GraphPort 最小契约，见 DesignerCanvas.vue 里这几个方法的
 * 既有注释）。本组件不直接持有 X6GraphAdapter，由挂载方 DesignerCanvas.vue（已经直接持有具体
 * 的 X6GraphAdapter 实例）订阅后把 {scaleX, tx, ty} 三元组通过 props 转发下来——本组件本身
 * 不知道也不依赖 X6，只认这三个数字。
 *
 * 绘制：两个 <canvas>（不是 SVG）——刻度线条+文字量随缩放/平移逐帧连续变化，SVG 每次重绘都要
 * 重新构造/挂载大量 DOM 节点，canvas 的 2D 绘图指令没有这个开销。按 devicePixelRatio 缩放画布
 * 物理像素，避免高分屏下刻度线发虚。
 */
const props = defineProps<{
  scaleX: number;
  tx: number;
  ty: number;
}>();

const topCanvasRef = ref<HTMLCanvasElement | null>(null);
const leftCanvasRef = ref<HTMLCanvasElement | null>(null);
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;

function themeColor(canvas: HTMLCanvasElement, token: string, fallback: string): string {
  const value = getComputedStyle(canvas).getPropertyValue(token).trim();
  return value ? `rgb(${value})` : fallback;
}

function rulerPalette(canvas: HTMLCanvasElement) {
  return {
    background: themeColor(canvas, '--container-bg-color', 'rgb(255 255 255)'),
    divider: themeColor(canvas, '--border-lighter-color', 'rgb(236 237 240)'),
    minor: themeColor(canvas, '--border-color', 'rgb(223 226 231)'),
    major: themeColor(canvas, '--border-deep-color', 'rgb(198 203 211)'),
    text: themeColor(canvas, '--text-hint-color', 'rgb(180 186 195)')
  };
}

/** 按 devicePixelRatio 把画布 CSS 尺寸与物理像素尺寸对齐，返回 2D 上下文（已完成
 * setTransform(dpr,...) 缩放，调用方后续绘制指令直接用 CSS 像素坐标即可）。 */
function prepareContext(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  // 只有尺寸真的变化时才重设 canvas.width/height——该赋值会清空画布并重置绘图状态，
  // 每帧都无条件赋值在缩放拖动时是不必要的开销。
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

/** 顶部横标尺：x 轴用 props.tx 作为 computeRulerTicks 的 origin。 */
function drawTopRuler(): void {
  const canvas = topCanvasRef.value;
  const width = canvas?.parentElement?.clientWidth ?? 0;
  if (!canvas || width <= 0) return;
  const ctx = prepareContext(canvas, width, RULER_SIZE);
  if (!ctx) return;
  const palette = rulerPalette(canvas);

  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, RULER_SIZE);
  ctx.strokeStyle = palette.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_SIZE - 0.5);
  ctx.lineTo(width, RULER_SIZE - 0.5);
  ctx.stroke();

  ctx.font = '9px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const tick of computeRulerTicks(props.scaleX, props.tx, width)) {
    ctx.strokeStyle = tick.major ? palette.major : palette.minor;
    const tickLength = tick.major ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(tick.screen + 0.5, RULER_SIZE);
    ctx.lineTo(tick.screen + 0.5, RULER_SIZE - tickLength);
    ctx.stroke();
    if (tick.major) {
      ctx.fillStyle = palette.text;
      ctx.fillText(String(Math.round(tick.logical)), tick.screen + 2, RULER_SIZE / 2);
    }
  }
}

/** 左侧竖标尺：y 轴用 props.ty 作为 origin；大刻度数字旋转 -90deg 沿标尺纵向排布，
 * 20px 宽度放不下横排数字。 */
function drawLeftRuler(): void {
  const canvas = leftCanvasRef.value;
  const height = canvas?.parentElement?.clientHeight ?? 0;
  if (!canvas || height <= 0) return;
  const ctx = prepareContext(canvas, RULER_SIZE, height);
  if (!ctx) return;
  const palette = rulerPalette(canvas);

  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, RULER_SIZE, height);
  ctx.strokeStyle = palette.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(RULER_SIZE - 0.5, 0);
  ctx.lineTo(RULER_SIZE - 0.5, height);
  ctx.stroke();

  ctx.font = '9px sans-serif';
  ctx.textBaseline = 'middle';
  for (const tick of computeRulerTicks(props.scaleX, props.ty, height)) {
    ctx.strokeStyle = tick.major ? palette.major : palette.minor;
    const tickLength = tick.major ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(RULER_SIZE, tick.screen + 0.5);
    ctx.lineTo(RULER_SIZE - tickLength, tick.screen + 0.5);
    ctx.stroke();
    if (tick.major) {
      ctx.fillStyle = palette.text;
      ctx.save();
      ctx.translate(10, tick.screen);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(tick.logical)), 2, 0);
      ctx.restore();
    }
  }
}

function draw(): void {
  drawTopRuler();
  drawLeftRuler();
}

onMounted(() => {
  draw();
  // 容器尺寸随窗口/侧栏折叠变化（与画布本身 autoResize 同一诱因），标尺需要跟着重新量一次
  // CSS 尺寸——viewport props 不变时也可能需要重绘（比如仅仅是窗口变宽，画布可视范围变了）。
  resizeObserver = new ResizeObserver(() => draw());
  if (topCanvasRef.value?.parentElement) resizeObserver.observe(topCanvasRef.value.parentElement);
  if (leftCanvasRef.value?.parentElement) resizeObserver.observe(leftCanvasRef.value.parentElement);
  themeObserver = new MutationObserver(() => draw());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
});

// 变化即全量重绘：三个 props 任一变化都重新画一次，不做增量 diff——canvas
// 单帧绘制成本本就极低（几十条线 + 十几个数字），增量 diff 的复杂度收益不成正比。
watch(() => [props.scaleX, props.tx, props.ty], draw);

defineExpose({ redraw: draw });
</script>

<template>
  <!-- 顶部横标尺：绝对定位在画布容器顶部，横跨整个宽度（含左上角 20×20 的角落方块——由横标尺
       自己画出这一小块空白+分隔线，不依赖 z-index 与竖标尺争顶层，见下方 --left 的 top 偏移）。 -->
  <div class="workflow-canvas-ruler workflow-canvas-ruler--top" data-testid="canvas-ruler-top">
    <canvas ref="topCanvasRef"></canvas>
  </div>
  <!-- 左侧竖标尺：从 RULER_SIZE 往下（避开顶部标尺已经占用的角落方块），宽度固定 RULER_SIZE。 -->
  <div class="workflow-canvas-ruler workflow-canvas-ruler--left" data-testid="canvas-ruler-left">
    <canvas ref="leftCanvasRef"></canvas>
  </div>
</template>

<style scoped>
.workflow-canvas-ruler {
  position: absolute;
  z-index: 15;
  overflow: hidden;
  pointer-events: none;
}
.workflow-canvas-ruler--top {
  top: 0;
  right: 0;
  left: 0;
  height: 20px;
}
.workflow-canvas-ruler--left {
  top: 20px;
  bottom: 0;
  left: 0;
  width: 20px;
}
.workflow-canvas-ruler canvas {
  display: block;
}
</style>
