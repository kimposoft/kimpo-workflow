/// <reference types="vitest" />
// model / graph / designer 的单测运行配置：happy-dom 提供 graph/svg-adapter.ts 单测所需的最小 DOM
// （createElementNS / SVG / 事件），不需要真实浏览器。
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // 强制 vue / naive-ui 只解析出一份，避免共享包各自带一份 Vue / Naive 实例。
    dedupe: ['vue', 'naive-ui']
  },
  // @antv/x6-common publishes a CommonJS entry that statically requires lodash-es, while the
  // installed lodash-es package is ESM-only. If Vitest externalizes this chain, Node executes that
  // require directly and fails with ERR_REQUIRE_ESM before any X6 suite can be collected. Keep the
  // complete X6/lodash-es chain inside vite-node so Vite performs the CJS/ESM interop transform.
  test: {
    globals: true,
    environment: 'happy-dom',
    deps: {
      optimizer: {
        web: {
          enabled: true,
          include: [
            '@antv/x6',
            '@antv/x6-plugin-keyboard',
            '@antv/x6-plugin-minimap',
            '@antv/x6-plugin-selection',
            '@antv/x6-plugin-snapline'
          ]
        }
      }
    },
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**']
  }
});
