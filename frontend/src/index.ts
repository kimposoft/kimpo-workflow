/**
 * kimpo-workflow 插件前端 UMD 入口（流程引擎 V2）。
 *
 * 入口文件只做一行 re-export，具体分发/装配逻辑在 ./surfaces/index.ts（与
 * kimpo-action-designer 插件 frontend/src/index.ts 同一约定）。
 */
export { createSurface } from './surfaces';
