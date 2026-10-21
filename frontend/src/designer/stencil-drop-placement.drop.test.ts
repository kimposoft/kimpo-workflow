// stencil-drop-placement.drop.test.ts —— 节点库拖拽松手落点：节点中心对准指针（见
// stencil-drop-placement.ts computeStencilDropPosition 头注释"根因"）。
//   ① 纯函数：左上角 = 指针坐标 − 节点宽高的一半，三种节点尺寸家族各验一次；
//   ② 接线：DesignerCanvas.vue onDrop 真的经由该函数 + nodeDimensions(key) 算 position，
//      并反向断言坏写法（指针坐标原样当 position）不再存在。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeDimensions } from '../graph/x6-adapter';
import { computeStencilDropPosition } from './stencil-drop-placement';

describe('computeStencilDropPosition —— 拖拽松手时节点中心对准指针', () => {
  it('左上角 = 指针坐标 − 节点宽高的一半（落点的几何中心恰为指针位置）', () => {
    const pointer = { x: 500, y: 300 };
    for (const kind of ['approve', 'start', 'end'] as const) {
      const size = nodeDimensions(kind);
      const position = computeStencilDropPosition(pointer, size);
      expect(position.x + size.width / 2).toBe(pointer.x);
      expect(position.y + size.height / 2).toBe(pointer.y);
    }
  });

  it('🔴 反向验证：结果不等于指针坐标本身（此前的缺陷形态：左上角贴在指针处）', () => {
    const pointer = { x: 120, y: 80 };
    const position = computeStencilDropPosition(pointer, { width: 200, height: 60 });
    expect(position).toEqual({ x: 20, y: 50 });
    expect(position).not.toEqual(pointer);
  });
});

describe('DesignerCanvas.vue onDrop 接线', () => {
  const source = readFileSync(resolve(__dirname, 'canvas/DesignerCanvas.vue'), 'utf8');

  it('position 经 computeStencilDropPosition + nodeDimensions(key) 算出', () => {
    expect(source).toContain(
      'const position = computeStencilDropPosition(adapter.clientToLocal(event.clientX, event.clientY), nodeDimensions(key));'
    );
  });

  it('坏写法不再存在：指针坐标不得原样赋给 position', () => {
    expect(source).not.toMatch(/const position = adapter\.clientToLocal\(/);
  });
});
