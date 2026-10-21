/**
 * designer/canvas —— 流程画布渲染与交互，唯一允许经 ../../graph 边界间接使用 X6 的消费方之一。
 * DesignerCanvas.vue 是画布的 Vue 外壳，内部持有一个 GraphPort 实例（如 graph/svg-adapter.ts
 * 的 SvgGraphAdapter），不直接依赖任何具体渲染器实现。
 */
export { default as DesignerCanvas } from './DesignerCanvas.vue';
