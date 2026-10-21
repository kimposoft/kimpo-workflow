/**
 * panels/PanelTabs.static.test.ts —— PanelTabs.vue（属性面板分区切换条）的接线静态守护，手法同
 * StartPanel.static.test.ts/CcPanel.static.test.ts："对源码文本
 * 做结构化断言"：本插件前端未装 @vue/test-utils，组件级挂载测试断言不到"点击后 emit 了什么"，
 * 改为对源码文本做结构化断言。
 *
 * 本文件只锁住硬要求——**受控接口**：`active` prop + `update:active` emit
 * （v-model:active 的展开形式）。"点检查清单里的一条 → 面板自动切到该问题所属分区"这个
 * 功能要求外部能单方面把 `active` 改过来并让本组件立刻反映——如果做成非受控（内部自己另开一个
 * ref 持有"当前选中分区"，`active` prop 只影响初值），那条外部单方面赋值就会失效，因此这里除了
 * "接口形状对不对"，还额外断言"组件内部没有另开一个本地 ref 缓存激活分区"这个反面情形。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/designer/panels/PanelTabs.vue'), 'utf8');

describe('PanelTabs：受控接口——存在 active prop 与 update:active emit', () => {
  it('defineProps 声明了 active（字符串）与 tabs/readOnly', () => {
    expect(source).toMatch(/defineProps<\{[\s\S]*?\bactive:\s*string;[\s\S]*?\}>/);
    expect(source).toMatch(/defineProps<\{[\s\S]*?\btabs:\s*PanelTabItem\[\];[\s\S]*?\}>/);
    expect(source).toMatch(/defineProps<\{[\s\S]*?readOnly\?:\s*boolean;[\s\S]*?\}>/);
  });

  it('defineEmits 声明了 update:active（不是 update:value 或其它名字）', () => {
    expect(source).toMatch(/defineEmits<\{\s*\(e:\s*'update:active',\s*key:\s*string\):\s*void;?\s*\}>/);
  });

  it('导出 PanelTabItem 接口，供调用方构造 tabs 数组条目（key + label，预留 hasPendingIssues）', () => {
    expect(source).toContain('export interface PanelTabItem');
    expect(source).toMatch(/PanelTabItem[\s\S]*?key:\s*string;/);
    expect(source).toMatch(/PanelTabItem[\s\S]*?label:\s*string;/);
    expect(source).toContain('hasPendingIssues?: boolean');
  });
});

describe('PanelTabs：真正受控——外部传入的 active 直接喂给底层 NTabs，不在本组件内部另存一份状态', () => {
  it('底层 NTabs 的 value 直接绑定 props.active（不是本地 ref）', () => {
    expect(source).toContain(':value="active"');
  });

  it('NTabs 切换经 update:value 转发成本组件的 update:active，不吞掉/不改写目标 key', () => {
    expect(source).toContain('@update:value="onUpdateActive"');
    expect(source).toMatch(/function onUpdateActive\([^)]*\):\s*void\s*\{[\s\S]*?emit\('update:active',\s*String\(value\)\);/);
  });

  it('反面断言：组件脚本体内没有另开一个 ref 缓存"当前选中分区"（避免退化成非受控组件）', () => {
    // 剥掉 <template>/<style>，只看 <script setup> 主体——避免模板里合法出现的 "ref"
    // 字样（如未来若引入 DOM ref）把这条断言误伤成假红。
    const scriptMatch = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/);
    expect(scriptMatch, '应存在 <script setup> 块').toBeTruthy();
    const script = scriptMatch![1]!;
    expect(script).not.toMatch(/ref\(\s*(props\.)?active\b/);
    expect(script).not.toMatch(/\bconst\s+(active|internalActive|localActive|currentActive)\s*=\s*ref\(/);
  });

  it('data-testid 命名约定：面板条容器 panel-tabs，单个分区 panel-tab-<key>', () => {
    expect(source).toContain('data-testid="panel-tabs"');
    expect(source).toContain('data-testid="`panel-tab-${tab.key}`"');
  });
});
