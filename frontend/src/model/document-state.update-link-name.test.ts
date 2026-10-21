// model/document-state.update-link-name.test.ts —— WorkflowDocumentState.updateLinkName 单测：
// 连线名称的写回/清空/截断/撤销重做/悬空 id 无副作用。写法照抄
// 同级 document-state.update-link-condition.test.ts（EdgePanel.vue 只是薄包装，本文件覆盖的是
// 它依赖的唯一权威写入口）。
import { describe, expect, it } from 'vitest';
import { createDefaultDocument } from './defaults';
import { WorkflowDocumentState } from './document-state';

function makeState(): WorkflowDocumentState {
  return new WorkflowDocumentState(createDefaultDocument('测试流程'));
}

/** 造一条连线：发起节点 -> 新建的办理节点，返回其 id。 */
function makeLink(state: WorkflowDocumentState): string {
  const startId = state.doc.nodes.find((n) => n.kind === 'start')!.id;
  const handle = state.addNode('handle', { x: 0, y: 0 })!;
  const link = state.addLink(startId, handle.id);
  expect(link.ok).toBe(true);
  return link.ok ? link.link.id : '';
}

describe('updateLinkName：设置/清空', () => {
  it('设置一个名称：link.name 更新为去空白后的值，且置脏', () => {
    const state = makeState();
    const linkId = makeLink(state);

    state.updateLinkName(linkId, '审批意见');

    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe('审批意见');
    expect(state.isDirty()).toBe(true);
  });

  it('传 undefined 清空名称：name 变回 undefined', () => {
    const state = makeState();
    const linkId = makeLink(state);
    state.updateLinkName(linkId, '审批意见');

    state.updateLinkName(linkId, undefined);

    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBeUndefined();
  });

  it('传纯空白字符串同样视为清空（去首尾空白后是空串）', () => {
    const state = makeState();
    const linkId = makeLink(state);
    state.updateLinkName(linkId, '审批意见');

    state.updateLinkName(linkId, '   ');

    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBeUndefined();
  });

  it('去首尾空白后写回：" 审批意见 " 存成 "审批意见"', () => {
    const state = makeState();
    const linkId = makeLink(state);

    state.updateLinkName(linkId, ' 审批意见 ');

    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe('审批意见');
  });
});

describe('updateLinkName：截断到 20 字（按 Array.from(str).length 计，不按 UTF-16 长度）', () => {
  it('不超过 20 字的名称原样保留', () => {
    const state = makeState();
    const linkId = makeLink(state);
    const name = '一二三四五六七八九十一二三四五六七八九十'; // 恰 20 字
    expect(Array.from(name).length).toBe(20);

    state.updateLinkName(linkId, name);

    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe(name);
  });

  it('超过 20 字的名称截断到前 20 字', () => {
    const state = makeState();
    const linkId = makeLink(state);
    const name = '一二三四五六七八九十一二三四五六七八九十一二三'; // 23 字
    expect(Array.from(name).length).toBe(23);

    state.updateLinkName(linkId, name);

    const stored = state.doc.links.find((l) => l.id === linkId)?.name;
    expect(stored).toBe('一二三四五六七八九十一二三四五六七八九十');
    expect(Array.from(stored ?? '').length).toBe(20);
  });

  // 按 UTF-16 code unit 计（原生 string.length）与按真实字符数计（Array.from(str).length）在
  // 遇到代理对（占两个 UTF-16 单元的字符，如扩展区生僻字/emoji）时会给出不同答案——用一个只有
  // 12 个真实字符、但 UTF-16 长度达到 24 的名称验证：按 Array.from 计不该触发截断（12 ≤ 20），
  // 若实现错用了原生 .length（24 > 20）会被误判成"超长"而错误截短，本用例专门钉住这条差异。
  it('代理对字符（真实字符数 ≤ 20 但 UTF-16 长度 > 20）不应被误判为超长', () => {
    const state = makeState();
    const linkId = makeLink(state);
    const name = '𠀀'.repeat(12); // U+20000，扩展区 B 汉字，每个占 2 个 UTF-16 code unit
    expect(name.length).toBe(24); // 原生 UTF-16 长度
    expect(Array.from(name).length).toBe(12); // 真实字符数

    state.updateLinkName(linkId, name);

    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe(name);
  });
});

describe('updateLinkName：悬空 id 无副作用', () => {
  it('目标 linkId 不存在时不产生任何变更（不静默创建新连线，也不报错）', () => {
    const state = makeState();
    const before = state.doc;
    state.updateLinkName('no-such-link', '随便什么名字');
    expect(state.doc).toEqual(before);
    expect(state.isDirty()).toBe(false);
  });
});

describe('updateLinkName：撤销 / 重做', () => {
  it('一次 updateLinkName 是一步撤销：undo 后回到设置前（undefined），redo 后恢复', () => {
    const state = makeState();
    const linkId = makeLink(state);

    state.updateLinkName(linkId, '审批意见');
    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe('审批意见');

    state.undo();
    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBeUndefined();

    state.redo();
    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe('审批意见');
  });

  it('连续改动同一条线的名称在合并窗口内算一步撤销：改成 A 后紧接着改成 B，一次 undo 应直接回到两次改动之前，不是先退回 A', () => {
    const state = makeState();
    const linkId = makeLink(state);

    state.updateLinkName(linkId, '名字A');
    state.updateLinkName(linkId, '名字B');
    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBe('名字B');

    state.undo();
    expect(state.doc.links.find((l) => l.id === linkId)?.name).toBeUndefined();
  });
});
