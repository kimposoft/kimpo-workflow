/**
 * DesignerRoot.wiring.static.test.ts —— DesignerRoot.vue 接线的静态守护，手法同既有 DesignerCanvas.*.static.test.ts："底层能力单测再绿，没接到真实 UI 上也
 * 等于没做"。DesignerRoot 依赖真实 X6 画布挂载（happy-dom 下可跑，但涉及大量异步生命周期与
 * naive-ui 全局 stub），因此改为对源码文本做结构化断言，覆盖以下要点：
 *   - DesignerCanvas 的全部 emits 都接了处理函数（不是"声明了 prop 但没人处理"）；
 *   - 发布 = 保存 → validate →（无诊断才）publish 的调用顺序；
 *   - 诊断非空时不真正调用 publish；
 *   - 只读态（effectiveReadOnly = props.readOnly ∨ 绑定引擎不可用）在每个会写文档的处理函数里短路；
 *   - 脏态：onChange 回调里 markDirty(nextState.isDirty())，保存成功后 markSaved() 重新置回干净
 *     （markSaved 本身会再触发一次 onChange，从而再调用一次 markDirty(false)，见
 *     model/document-state.ts markSaved()/commit() 注释）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/designer/DesignerRoot.vue'), 'utf8');
const scriptSetup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
// 注意：不单独抽 <template>...</template> 块——本文件模板里用了 <template v-if>/<template v-else>
// 包装三种加载态，这些内层 template 标签的闭合同样写作 </template>，非贪婪正则会在第一个内层
// </template> 处提前收尾，抓不到真正的三栏布局内容。事件绑定断言直接在整份 source 上做子串匹配
// 即可（script 与 template 拼在一起搜索不影响这里的字符串包含判断）。
const template = source;

function fnBody(name: string): string {
  const re = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`);
  return scriptSetup.match(re)?.[1] ?? '';
}

describe('DesignerCanvas emits 全部接线', () => {
  const expected: Array<[string, string]> = [
    ['selection-change', 'onSelectionChange'],
    ['node-move-end', 'onNodeMoveEnd'],
    ['nodes-move-end', 'onNodesMoveEnd'],
    ['connect', 'onConnect'],
    ['delete-selection', 'onDeleteSelection'],
    ['undo', 'onUndo'],
    ['redo', 'onRedo'],
    ['save', 'handleSave'],
    ['rename-node', 'onRenameNode'],
    ['stencil-drop', 'onStencilDrop'],
    ['layout-change', 'onLayoutChange']
  ];
  for (const [event, handler] of expected) {
    it(`@${event} 绑定到 ${handler}`, () => {
      expect(template).toMatch(new RegExp(`@${event}="${handler}"`));
      expect(scriptSetup).toContain(`function ${handler}(`);
    });
  }
});

describe('StencilPanel dblclick-item 接线', () => {
  it('@dblclick-item 绑定到 onStencilDblClick', () => {
    expect(template).toContain('@dblclick-item="onStencilDblClick"');
    expect(scriptSetup).toContain('function onStencilDblClick(');
  });
});

describe('TopBar 事件接线', () => {
  it('update:name/save/publish 全部接线', () => {
    expect(template).toContain('@update:name="onRenameDoc"');
    expect(template).toContain('@save="handleSave"');
    expect(template).toContain('@publish="handlePublish"');
  });
});

describe('发布调用顺序：保存 → validate →（无诊断才）publish', () => {
  const body = fnBody('handlePublish');

  it('handlePublish 内先调用 handleSave，失败即整体中止', () => {
    expect(body).toMatch(/const saveResult = await handleSave\(\);/);
    expect(body).toMatch(/if \(!saveResult\.ok \|\| !state\.value\) return;/);
  });

  it('handleSave 之后才调用 host.validate', () => {
    const saveIdx = body.indexOf('await handleSave()');
    const validateIdx = body.indexOf('props.host.validate(');
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeGreaterThan(saveIdx);
  });

  it('诊断非空时 return，不会继续往下调用 host.publish', () => {
    const guardIdx = body.indexOf('if (validateDiagnostics.length > 0) {');
    const publishIdx = body.indexOf('props.host.publish(');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThan(guardIdx);
    // 诊断分支自身必须以 return 收尾，保证"非空即不发布"。
    const guardBlock = body.slice(guardIdx, publishIdx);
    expect(guardBlock).toContain('return;');
  });

  it('validate 通过（无诊断）之后才真正调用 host.publish', () => {
    const validateIdx = body.indexOf('props.host.validate(');
    const publishIdx = body.indexOf('props.host.publish(');
    expect(publishIdx).toBeGreaterThan(validateIdx);
  });

  // 发布成功后 expectedVersionNo 必须跟着宿主回执推进，否则发布后第一次
  // 保存草稿会拿着发布前的旧版本号去撞乐观锁，白白报一次 VERSION_CONFLICT。
  it('发布成功后用 publishResult.data.definition_version_no 推进 expectedVersionNo（?? 兜底老宿主不带这个字段）', () => {
    const publishIdx = body.indexOf('props.host.publish(');
    const latestIdx = body.indexOf('latestVersionNo.value = publishResult.data.version_no;');
    const expectedIdx = body.indexOf('expectedVersionNo.value = publishResult.data.definition_version_no ?? expectedVersionNo.value;');
    expect(latestIdx).toBeGreaterThan(publishIdx);
    expect(expectedIdx).toBeGreaterThan(latestIdx);
  });
});

describe('只读态短路：每个会写文档的处理函数都在函数体首行判断 effectiveReadOnly', () => {
  const guarded = [
    'handleSave',
    'handlePublish',
    'onNodeMoveEnd',
    'onNodesMoveEnd',
    'onConnect',
    'onDeleteSelection',
    'onUndo',
    'onRedo',
    'onRenameNode',
    'onStencilDrop',
    'onStencilDblClick',
    'onLayoutChange',
    'onRenameDoc'
  ];
  for (const name of guarded) {
    it(`${name} 内含 effectiveReadOnly 判断`, () => {
      const body = fnBody(name);
      expect(body).toMatch(/effectiveReadOnly\.value/);
    });
  }
});

describe('脏态置位与保存后清除', () => {
  it('WorkflowDocumentState.onChange 回调里把 isDirty() 同步给 interactiveSession.markDirty', () => {
    expect(scriptSetup).toContain('props.host.interactiveSession.markDirty(nextState.isDirty())');
  });

  it('handleSave 成功后调用 state.value.markSaved(...)（其内部会再触发一次 onChange 把 dirty 置回 false）', () => {
    const body = fnBody('handleSave');
    expect(body).toContain('state.value.markSaved(');
  });
});

describe('Ctrl/Cmd+S 键盘兜底', () => {
  it('挂载时监听 window keydown，卸载时移除', () => {
    expect(scriptSetup).toContain("window.addEventListener('keydown', onWindowKeydown)");
    expect(scriptSetup).toContain("window.removeEventListener('keydown', onWindowKeydown)");
  });
  it('onWindowKeydown 识别 ctrl/cmd+s 组合键并触发 handleSave', () => {
    const body = fnBody('onWindowKeydown');
    expect(body).toMatch(/event\.ctrlKey \|\| event\.metaKey/);
    expect(body).toContain("event.key.toLowerCase() === 's'");
    expect(body).toContain('void handleSave();');
  });
});

describe('provide 三个注入键，供后续节点属性面板卡消费', () => {
  it('provide(DESIGNER_HOST_KEY, ...) / DESIGNER_I18N_KEY / DESIGNER_STATE_KEY 均已调用', () => {
    expect(scriptSetup).toContain('provide(DESIGNER_HOST_KEY, props.host)');
    expect(scriptSetup).toContain('provide(DESIGNER_I18N_KEY, props.i18n)');
    expect(scriptSetup).toContain('provide(DESIGNER_STATE_KEY, state)');
  });
});

describe('检查项清单：useIssues 组合式接线', () => {
  it('provide(DESIGNER_ISSUES_KEY, issuesApi)，供 shell/IssuesBadge.vue、issues/IssuesBar.vue 直接注入消费', () => {
    expect(scriptSetup).toContain("import { useIssues, DESIGNER_ISSUES_KEY } from './issues/useIssues';");
    expect(scriptSetup).toContain('const issuesApi = useIssues({');
    expect(scriptSetup).toContain('provide(DESIGNER_ISSUES_KEY, issuesApi)');
  });

  it('onFocus 回调绑定 locateTarget（选中 + 画布定位），组合式本身不直接碰画布', () => {
    expect(scriptSetup).toContain('onFocus: (target) => locateTarget(target.nodeId, target.linkId)');
    expect(scriptSetup).toContain('function locateTarget(nodeId?: string, linkId?: string): void {');
  });

  it('挂载/重试加载新文档时清空检查项（issuesApi.clear()），不再手写 GroupedIssues 空对象', () => {
    const body = fnBody('load');
    expect(body).toContain('issuesApi.clear();');
  });

  it('handlePublish：校验/发布拒绝时 issuesApi.setFromDiagnostics(...)，发布成功后 issuesApi.clear()', () => {
    const body = fnBody('handlePublish');
    expect(body).toContain('issuesApi.setFromDiagnostics(validateDiagnostics);');
    expect(body).toContain('issuesApi.setFromDiagnostics(publishDiagnostics);');
    expect(body).toContain('issuesApi.clear();');
  });

  it('节点/连线校验角标读 issuesApi.grouped（graph-bridge toGraphNodes/toGraphEdges 的 issuesByNode/issuesByLink）', () => {
    expect(scriptSetup).toContain('issuesByNode: issuesApi.grouped.value.byNode');
    expect(scriptSetup).toContain('issuesByLink: issuesApi.grouped.value.byLink');
  });

  it('TopBar 不再接收 issues prop / locate-issue emit（检查项经 provide/inject，不逐层转发）', () => {
    expect(template).not.toContain(':issues="issues"');
    expect(template).not.toContain('@locate-issue');
  });
});
