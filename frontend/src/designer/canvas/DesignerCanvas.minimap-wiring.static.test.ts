import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DesignerCanvas.minimap-wiring.static.test.ts —— 小地图收起的接线静态守护。useMinimapCollapsed 本身的记忆行为已由 ./minimap-collapse.test.ts 覆盖，本文件补
 * "DesignerCanvas.vue 是否真的把它接到了小地图的展示态"这一层。
 */
const source = readFileSync(resolve(process.cwd(), 'src/designer/canvas/DesignerCanvas.vue'), 'utf8');
const scriptSetup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
const templateStart = source.indexOf('<template>');
const templateEnd = source.lastIndexOf('</template>');
const template = source.slice(templateStart, templateEnd);

describe('小地图收起接线', () => {
  it('导入并使用 useMinimapCollapsed（不是本地另起一个裸 ref）', () => {
    expect(scriptSetup).toContain("import { useMinimapCollapsed } from './minimap-collapse';");
    expect(scriptSetup).toContain('useMinimapCollapsed()');
  });

  it('shell 容器的收起态 class 绑定 minimapCollapsed，折叠按钮的点击调用 toggleMinimapCollapsed', () => {
    const shellBlock = template.match(/data-testid="workflow-minimap-shell"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
    expect(template).toContain(':class="{ \'is-collapsed\': minimapCollapsed }"');
    expect(shellBlock).toContain('@click="toggleMinimapCollapsed"');
  });

  it('minimapRef 挂载的 div 全程保留在 DOM 里（收起是纯 CSS 尺寸变化，不卸载 X6 MiniMap 挂载点）', () => {
    const shellBlock = template.match(/data-testid="workflow-minimap-shell"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
    expect(shellBlock).not.toContain('v-if="!minimapCollapsed"');
    expect(shellBlock).not.toContain('v-show="!minimapCollapsed"');
    expect(shellBlock).toContain('ref="minimapRef"');
  });
});

describe('提示条左下定位（避免与右下角小地图重叠）', () => {
  it('.workflow-canvas-hint 用 left 定位而不是 right（right:10/bottom:7 会与小地图 shell 的 right:16/bottom:12 重叠）', () => {
    const hintRule = source.match(/\.workflow-canvas-hint\s*\{[^}]*\}/)?.[0] ?? '';
    expect(hintRule).not.toBe('');
    expect(hintRule).toContain('left:');
    expect(hintRule).not.toContain('right:');
  });
});

describe('画布专属能力 expose（centerOn/zoomToPercent 三处同步的第二处）', () => {
  it('defineExpose 暴露 centerOn/zoomToPercent，转发到 adapter 且更新回读', () => {
    const exposeBlock = scriptSetup.match(/defineExpose\(\{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(exposeBlock).toContain('centerOn: (id: string) => adapter?.centerOn(id)');
    expect(exposeBlock).toContain('zoomToPercent: (percent: number) => { adapter?.zoomToPercent(percent); updateZoom(); }');
  });

  it('未加进 GraphPort（graph/port.ts 保持最小 svg/x6 双实现契约，见其头注释）', () => {
    const portSource = readFileSync(resolve(process.cwd(), 'src/graph/port.ts'), 'utf8');
    expect(portSource).not.toContain('centerOn');
    expect(portSource).not.toContain('zoomToPercent');
  });
});

