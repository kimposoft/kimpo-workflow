/**
 * panels/CcPanel.static.test.ts —— CcPanel.vue（抄送节点 N4 属性面板）的
 * 接线静态守护，手法同 ../expression/V4ExpressionField.static.test.ts："对源码文本做结构化断言"。
 * 需要真实交互的行为由 CcPanel.test.ts 挂载覆盖，本文件只覆盖"接线对不对"这一层：分区顺序、data-testid 是否落地、是否误用原生 <select>/checkbox/radio、以及本文件
 * 用到的全部 i18n key 字面量是否都在 zh-CN.json 里登记。
 *
 * 与 ./panels-locale-keys.static.test.ts 的关系：那份共享测试文件的正则只抓 `.t('...')` 直接
 * 字面量调用；本文件另用一条更宽的正则（任意 `'workflow.designer.xxx'` 字面量）兜底，覆盖间接
 * 传参场景（CcPanel.vue 目前没有间接传参的 key，这条宽正则测试仍保留作兜底）。
 *
 * 通知渠道：三档的渲染（含 CHANNEL_OPTIONS 常量数组）、能力查询与"至少保留一种"互斥逻辑
 * （toggleChannel 调用点）都在共享组件 ../shared/NotifyChannelList.vue（节点级通知卡复用同一套
 * UI），CcPanel.vue 只调用该组件、透传 channels 字段。相关断言因此指向 NotifyChannelList.vue，
 * 并有一条反向断言"CcPanel.vue 自身不直接调用 toggleChannel"，防止逻辑被加回本文件。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '../../../locales/zh-CN.json';

const source = readFileSync(resolve(process.cwd(), 'src/designer/panels/CcPanel.vue'), 'utf8');
const notifyChannelListSource = readFileSync(resolve(process.cwd(), 'src/designer/panels/shared/NotifyChannelList.vue'), 'utf8');

// 节点改名由头部 PanelHeader 就地完成，面板按三个分区（tab）组织——基本（收件人）/ 通知
// （渠道/标题/正文）/ 表单（字段权限）。
describe('CcPanel：头部先于分区条，分区（tab）内部小节按规定顺序依次出现', () => {
  it('<PanelHeader> 出现在 <PanelTabs> 之前', () => {
    const headerIdx = source.indexOf('<PanelHeader');
    const tabsIdx = source.indexOf('<PanelTabs');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(tabsIdx).toBeGreaterThan(-1);
    expect(tabsIdx).toBeGreaterThan(headerIdx);
  });

  it('不存在「节点名称」分区（无 panel.section.name / node.cc 字面量）', () => {
    expect(source).not.toContain("i18n.t('workflow.designer.panel.section.name')");
    expect(source).not.toContain("i18n.t('workflow.designer.node.cc')");
  });

  it('五个小节标题（收件人 → 通知渠道 → 通知标题 → 通知正文 → 字段权限）按分区顺序依次出现', () => {
    const order = [
      "i18n.t('workflow.designer.panel.section.recipients')",
      "i18n.t('workflow.designer.panel.section.channels')",
      "i18n.t('workflow.designer.panel.section.notifyTitle')",
      "i18n.t('workflow.designer.panel.section.notifyContent')",
      "i18n.t('workflow.designer.panel.section.fieldPermission')"
    ];
    const indexes = order.map((needle) => source.indexOf(needle));
    for (const idx of indexes) expect(idx).toBeGreaterThan(-1);
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]!).toBeGreaterThan(indexes[i - 1]!);
    }
  });

  it('三个分区 key 与文案键固定为 basic/notify/form，且按此顺序声明在 tabs 里', () => {
    const tabsBlock = source.match(/const tabs = computed<PanelTabItem\[\]>\(\(\) => \[([\s\S]*?)\]\);/)?.[1] ?? '';
    const keys = Array.from(tabsBlock.matchAll(/key:\s*'(\w+)'/g)).map((m) => m[1]);
    expect(keys).toEqual(['basic', 'notify', 'form']);
  });
});

describe('CcPanel：data-testid 落地', () => {
  it('通知标题/正文两个表达式字段带 cc-title/cc-content', () => {
    expect(source).toContain('data-testid="cc-title"');
    expect(source).toContain('data-testid="cc-content"');
  });

  it('通知渠道三档按固定顺序（系统/短信/邮件）配置，且用同一个动态 data-testid 表达式渲染——渠道 UI 在 shared/NotifyChannelList.vue，断言目标指向该文件', () => {
    const optionsBlock = notifyChannelListSource.match(/CHANNEL_OPTIONS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    const values = Array.from(optionsBlock.matchAll(/value:\s*'(system|sms|email)'/g)).map((m) => m[1]);
    expect(values).toEqual(['system', 'sms', 'email']);
    expect(notifyChannelListSource).toContain('`${testidPrefix}-channel-${opt.value}`');
  });

  it('CcPanel.vue 调用共享组件渲染渠道清单，不传 testid-prefix（复用默认值 cc）', () => {
    expect(source).toContain('<NotifyChannelList');
    // 只判定"没有传这个 prop"（属性写法 `testid-prefix="..."`），不判定源码里完全不出现这个词——
    // 本文件与 CcPanel.vue 头注释里都会用散文提到"testid-prefix"这个名字本身，裸字符串匹配会被
    // 注释误伤。
    expect(source).not.toMatch(/testid-prefix\s*=/);
  });
});

describe('CcPanel：不得误用原生表单控件（全面走 NaiveUI）', () => {
  it('不出现原生 <select', () => {
    expect(source).not.toContain('<select');
  });
  it('不出现原生 type="checkbox"', () => {
    expect(source).not.toContain('type="checkbox"');
  });
  it('不出现原生 type="radio"', () => {
    expect(source).not.toContain('type="radio"');
  });
});

describe('CcPanel：写回口径接线', () => {
  it('通知渠道切换经 toggleChannel 纯函数，拒绝（引用不变）时不落库、只置提示位——该判定逻辑在 shared/NotifyChannelList.vue，断言目标指向该文件', () => {
    expect(notifyChannelListSource).toContain('toggleChannel(current, channel)');
    expect(notifyChannelListSource).toContain('if (next === current)');
  });

  it('CcPanel.vue 自身不直接调用 toggleChannel（防止逻辑被加回本文件、出现重复实现）', () => {
    expect(source).not.toContain('toggleChannel(');
  });

  it('通知标题/正文写回前都经 normalizeExprSlot 归一化（undefined→null）', () => {
    expect(source).toContain('title_expr: normalizeExprSlot(value)');
    expect(source).toContain('content_expr: normalizeExprSlot(value)');
  });

  it('必填提示按 config.title_expr/content_expr 是否为假值判定（null 也算"未设置"）', () => {
    expect(source).toContain('v-if="!config.title_expr"');
    expect(source).toContain('v-if="!config.content_expr"');
  });
});

// 节点名称的"清空后失焦回填默认名"由公共头部 PanelHeader.vue 承载（其内部 commitEdit 用
// defaultNameForNodeAt 回填，见该文件头注释）；反面断言本文件不自行维护 onNameBlur/nameDraft。
describe('CcPanel：节点名称改名逻辑由 PanelHeader 负责（本面板不自行维护）', () => {
  it('挂载 <PanelHeader :node :read-only>，透传 node/readOnly', () => {
    expect(source).toMatch(/<PanelHeader\s+:node="node"\s+:read-only="readOnly"\s*\/>/);
  });
  it('不自行定义 onNameBlur/nameDraft/onNameInput（由 PanelHeader 统一实现，避免两处各写一份）', () => {
    expect(source).not.toContain('onNameBlur');
    expect(source).not.toContain('nameDraft');
    expect(source).not.toContain('onNameInput');
    expect(source).not.toContain('defaultNameForNodeAt');
  });
});

describe('CcPanel：本文件用到的全部 i18n key 字面量都在 zh-CN.json 登记', () => {
  it('宽正则扫描出的全部 workflow.designer.* 字符串字面量（含经变量间接传入 .t() 的 key）', () => {
    const keys = Array.from(new Set(Array.from(source.matchAll(/'(workflow\.designer\.[a-zA-Z0-9_.]+)'/g)).map((m) => m[1]!)));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(zhCN, key), `zh-CN.json 缺少 key: ${key}`).toBe(true);
    }
  });
});
