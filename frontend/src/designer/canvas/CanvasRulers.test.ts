// designer/canvas/CanvasRulers.test.ts —— 标尺换算核心 computeRulerTicks 单测（scale/translate
// → 刻度起点与间距）。canvas 2D 绘制本身在 happy-dom 下不可验证（多为 no-op 桩，同其余画布
// 几何计算的既定结论），本文件只测纯函数换算逻辑，见 CanvasRulers.vue 顶部 <script> 块头注释。
import { describe, expect, it } from 'vitest';
import { computeRulerTicks, RULER_MAJOR_STEP, RULER_MINOR_STEP, RULER_SIZE } from './CanvasRulers.vue';

describe('computeRulerTicks：刻度起点与间距', () => {
  it('scale=1、origin=0：刻度从 0 开始，间距等于 minorStep（10），大刻度每 5 个一档（50）', () => {
    const ticks = computeRulerTicks(1, 0, 100);
    expect(ticks[0]).toEqual({ logical: 0, screen: 0, major: true });
    expect(ticks[1]).toEqual({ logical: 10, screen: 10, major: false });
    expect(ticks.map((t) => t.logical)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(ticks.filter((t) => t.major).map((t) => t.logical)).toEqual([0, 50, 100]);
  });

  it('scale=2：屏幕间距随缩放加倍（10 画布单位 → 20 屏幕像素）', () => {
    const ticks = computeRulerTicks(2, 0, 100);
    expect(ticks[0]).toEqual({ logical: 0, screen: 0, major: true });
    expect(ticks[1]).toEqual({ logical: 10, screen: 20, major: false });
    // scale=2 时可视 100px 只能容纳到逻辑坐标 50。
    expect(ticks[ticks.length - 1].logical).toBe(50);
  });

  it('scale=0.5：屏幕间距减半（10 画布单位 → 5 屏幕像素）', () => {
    const ticks = computeRulerTicks(0.5, 0, 40);
    expect(ticks[1].screen - ticks[0].screen).toBe(5);
  });

  it('origin=25（画布向右平移 25px）：全部刻度屏幕位置整体右移 25px，起点仍是逻辑坐标 0 附近的刻度', () => {
    const withoutPan = computeRulerTicks(1, 0, 100);
    const withPan = computeRulerTicks(1, 25, 100);
    // 同一个逻辑坐标刻度，屏幕位置正好相差 25（平移量）。
    const zeroTick = withPan.find((t) => t.logical === 0);
    expect(zeroTick?.screen).toBe(25);
    expect(withoutPan.find((t) => t.logical === 0)?.screen).toBe(0);
  });

  it('origin 为负（画布向左平移，视口显示的是负坐标区域）：能正确算出正数区间的刻度', () => {
    const ticks = computeRulerTicks(1, -60, 100);
    // origin=-60 时，屏幕 0 对应逻辑坐标 60；屏幕 100 对应逻辑坐标 160。
    expect(ticks[0].logical).toBe(60);
    expect(ticks[ticks.length - 1].logical).toBe(160);
  });

  it('origin 为正且足够大（视口显示的是负坐标区域）：屏幕 0 对应负的逻辑坐标', () => {
    const ticks = computeRulerTicks(1, 60, 100);
    // origin=60 时屏幕 0 对应逻辑坐标 -60。
    expect(ticks[0].logical).toBe(-60);
  });

  it('负逻辑坐标的大刻度判定：-50 应判定为大刻度（不是 JS 原生 % 对负数取模的错误结果）', () => {
    const ticks = computeRulerTicks(1, 50, 20); // origin=50 时屏幕 0 对应逻辑坐标 -50
    const tick = ticks.find((t) => t.logical === -50);
    expect(tick).toBeDefined();
    expect(tick?.major).toBe(true);
  });

  it('自定义 minorStep/majorStep：换算按传入的步长而不是默认值', () => {
    const ticks = computeRulerTicks(1, 0, 40, 5, 20);
    expect(ticks.map((t) => t.logical)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40]);
    expect(ticks.filter((t) => t.major).map((t) => t.logical)).toEqual([0, 20, 40]);
  });

  it('只返回落在可视范围 [0, lengthPx] 内的刻度（不产生越界刻度，避免全量遍历整条逻辑坐标轴）', () => {
    const ticks = computeRulerTicks(1, 0, 33);
    for (const tick of ticks) {
      expect(tick.screen).toBeGreaterThanOrEqual(0);
      expect(tick.screen).toBeLessThanOrEqual(33);
    }
    expect(ticks[ticks.length - 1].logical).toBe(30); // 33 以内最后一个 10 的倍数
  });

  it('scale<=0（异常输入防御）：退化为 scale=1，不产生 NaN/Infinity', () => {
    const ticks = computeRulerTicks(0, 0, 50);
    expect(ticks.every((t) => Number.isFinite(t.screen))).toBe(true);
  });
});

describe('标尺常量（规格取值）', () => {
  it('RULER_SIZE=20，RULER_MINOR_STEP=10，RULER_MAJOR_STEP=50', () => {
    expect(RULER_SIZE).toBe(20);
    expect(RULER_MINOR_STEP).toBe(10);
    expect(RULER_MAJOR_STEP).toBe(50);
  });
});
