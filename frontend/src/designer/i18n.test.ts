/**
 * i18n.test.ts —— createDesignerI18n 的最小单测：确认 namespace/
 * defaultLocale 装配正确、缺省 host 时纯本地链仍可用、未知 key 走④原样返回兜底。
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostI18n } from '@kimposoft/plugin-sdk';
import { createDesignerI18n } from './i18n';

describe('createDesignerI18n', () => {
  it('缺省 host（单测/开发场景）时默认语言 zh-CN，可以查到插件自带文案', () => {
    const i18n = createDesignerI18n();
    expect(i18n.getLocale()).toBe('zh-CN');
    expect(i18n.t('workflow.designer.topbar.save')).toBe('保存');
    expect(i18n.t('plugin.name')).toBe('流程引擎');
  });

  it('未知 key 原样返回（四级查找链兜底④），不是抛错也不是空串', () => {
    const i18n = createDesignerI18n();
    const key = 'workflow.designer.does.not.exist';
    expect(i18n.t(key)).toBe(key);
  });

  it('注入 HostI18n 时跟随宿主 locale 初始值', () => {
    const host: HostI18n = {
      locale: { value: 'en-US' },
      t: () => '',
      resolve: (v) => (typeof v === 'string' ? v : ''),
      onLocaleChange: vi.fn(() => () => {})
    };
    const i18n = createDesignerI18n(host);
    expect(i18n.getLocale()).toBe('en-US');
    expect(i18n.t('workflow.designer.topbar.save')).toBe('Save');
  });
});
