import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * cssInjectInline —— 把构建产出的 CSS 内联进 UMD bundle，运行时自注入 <style>。
 *
 * 缘由：宿主插件加载器只用 <script> 加载 plugin.umd.js，不加载伴随的 style.css；而 vite lib 模式
 * 会把 .vue 的 <style scoped> 抽成独立 style.css——不内联就会丢掉插件自有的布局 / 间距样式。
 * 让 bundle 自带样式注入：插件前端自包含、单一产物（plugin.umd.js），零外部依赖。
 */
function cssInjectInline(pluginId: string): Plugin {
  return {
    name: 'kimpo-css-inject-inline',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let css = '';
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type === 'asset' && fileName.endsWith('.css')) {
          css += typeof asset.source === 'string'
            ? asset.source
            : Buffer.from(asset.source).toString('utf8');
          delete bundle[fileName];
        }
      }
      if (!css) return;
      const marker = `kimpo-plugin-style-${pluginId}`;
      const snippet = `\n(function(){try{if(typeof document==="undefined")return;`
        + `if(document.querySelector("style[data-marker=\\"${marker}\\"]"))return;`
        + `var s=document.createElement("style");s.setAttribute("data-marker","${marker}");`
        + `s.textContent=${JSON.stringify(css)};document.head.appendChild(s);}catch(e){}})();`;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          chunk.code += snippet;
        }
      }
    }
  };
}

/**
 * 流程引擎插件前端 UMD 构建配置。
 *
 * 外部化（运行期由 Kimpo 宿主以全局变量提供，插件不打包）：
 *   vue → window.Vue、naive-ui → window.naive、@kimposoft/ui-kit → window.KimpoUi。
 * 打进 bundle：@kimposoft/plugin-sdk 的少量运行时 helper、@kimposoft/expression-editor（它对 ui-kit 的 import 同样被外部化）。
 * 输出：frontend/dist/plugin.umd.js；打包时 build.sh 把它放到 manifest 声明的包内路径 frontend/plugin.umd.js。
 * UMD 全局名必须与 manifest.json 的 capabilities.frontend.global_name 一致：Kimpo.KimpoWorkflowPlugin。
 */
export default defineConfig({
  plugins: [vue(), cssInjectInline('workflow')],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Kimpo.KimpoWorkflowPlugin',
      // 函数形式强制输出 plugin.umd.js，规避 "type":"module" 时 Vite 自动改后缀为 .cjs。
      fileName: () => 'plugin.umd.js',
      formats: ['umd']
    },
    rollupOptions: {
      external: ['vue', 'naive-ui', '@kimposoft/ui-kit'],
      output: {
        globals: {
          vue: 'Vue',
          'naive-ui': 'naive',
          '@kimposoft/ui-kit': 'KimpoUi'
        }
      }
    }
  }
});
