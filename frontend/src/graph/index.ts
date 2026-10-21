/**
 * graph/ —— 唯一的 X6 适配边界：X6 只能出现在 frontend/src/graph 及极薄的图形组件边界，
 * 业务模型和校验不得 import X6。
 *
 * designer/canvas 等消费方只能通过本目录暴露的适配函数/组件接触 X6，不得直接 import X6
 * API。这样未来更换画布引擎只需要改这一层。
 *
 * port.ts 声明渲染器无关的 GraphPort 接口；svg-adapter.ts 是不依赖 X6 的最小实现（原生
 * SVG DOM），x6-adapter.ts 是基于 @antv/x6 的完整实现，两者实现同一 GraphPort 接口。
 */
export * from './port';
export * from './svg-adapter';
