/**
 * surfaces/index.ts —— kimpo-workflow 插件前端 createSurface 分发实现（流程引擎 V2）。
 *
 * 接上设计器 surface（'workflow-designer'）——与 kimpo-action-designer 插件
 * frontend/src/surfaces/index.ts 同一写法：用 SDK 的
 * definePluginSurface 做类型收敛，switch(surfaceType) 分派，非法/未声明的 surfaceType 显式抛错
 * （便于宿主接线错误在开发期第一时间暴露，不静默渲染空白面板）。
 *
 * hostBridge 取用面（对齐宿主前端按 hostCaps 裁剪后实际注入的键集合）：
 *   - hostBridge.interactiveSession        —— platform.interactiveSession
 *   - hostBridge['domain:workflow-designer'] —— 设计面方法（宿主提供）
 *   - hostBridge['domain:alice-v4']        —— (templateId) => Promise<AliceV4Host | null>
 *   - hostBridge['domain:expression']      —— (templateId) => ExpressionHost
 *   - hostBridge.i18n                      —— HostI18n（可选，缺省时 i18n.ts 降级纯本地链）
 *   - hostBridge.ui.*                      —— 由宿主挂载，经 SDK createHostUi
 *     统一收成 HostUi，本文件不直接触碰 .ui 键（未声明的服务访问即抛，交给 createHostUi 兜底）。
 *
 * 四项必需能力（interactiveSession / domain:workflow-designer / domain:alice-v4 /
 * domain:expression）缺失时显式抛错——技术信息（英文，含能力键名）只进 Error message（最终由宿主
 * catch 后落 console.error），不直接进业务界面（界面不展示错误码/宿主/JSON 结构）。i18n/ui 两项本身有各自的判空兜底（createDesignerI18n
 * 缺 host 时纯本地链；createHostUi 缺 hostBridge.ui 时退化为逐服务 reject 的 NotWiredHostUi），
 * 不需要在这里抛错。
 */
import { createHostUi, definePluginSurface, type SurfaceCreateInput } from '@kimposoft/plugin-sdk';
import type { AliceV4Host, ExpressionHost } from '@kimposoft/expression-editor';
import type {
  WorkflowDesignerHostBridge as SdkWorkflowDesignerHostBridge,
  WorkflowDesignerHostContext as SdkWorkflowDesignerHostContext
} from '@kimposoft/plugin-sdk/workflow-designer';
import DesignerRoot from '../designer/DesignerRoot.vue';
import { createDesignerHost } from '../designer/host';
import { createDesignerI18n } from '../designer/i18n';

/** hostBridge 上与设计器 surface 相关的键集合：直接用 SDK 公开契约
 * （两个表达式桥的类型参数取官方表达式编辑器包；其余键如 ui.* 由 createHostUi 直接消费整个 hostBridge）。 */
type WorkflowDesignerHostBridge = SdkWorkflowDesignerHostBridge<AliceV4Host, ExpressionHost>;

/** hostContext 形状（SDK WorkflowDesignerHostContext：`{ appId, definitionId, readOnly, enginePluginId? }`，旧宿主
 * 可能缺键，故按 Partial 读）。appId 要透给面板——宿主的通用模板选择弹窗按应用收窄候选；definitionId
 * 供子流程节点面板从『目标流程』候选里排除自己；enginePluginId 是当前定义绑定的流程引擎。 */
type WorkflowDesignerHostContext = Partial<SdkWorkflowDesignerHostContext>;

export const createSurface = definePluginSurface((input: SurfaceCreateInput) => {
  switch (input.surfaceType) {
    case 'workflow-designer': {
      const hostBridge = input.hostBridge as WorkflowDesignerHostBridge | undefined;

      const hostApi = hostBridge?.['domain:workflow-designer'];
      if (!hostApi) {
        throw new Error('[kimpo-workflow] 宿主未注入 domain:workflow-designer');
      }
      const interactiveSession = hostBridge?.interactiveSession;
      if (!interactiveSession) {
        throw new Error('[kimpo-workflow] 宿主未注入 platform.interactiveSession');
      }
      const aliceV4 = hostBridge?.['domain:alice-v4'];
      if (!aliceV4) {
        throw new Error('[kimpo-workflow] 宿主未注入 domain:alice-v4');
      }
      const expression = hostBridge?.['domain:expression'];
      if (!expression) {
        throw new Error('[kimpo-workflow] 宿主未注入 domain:expression');
      }

      // createHostUi 接收整个（已按 hostCaps 裁剪过的）hostBridge，内部自行取 .ui 键、逐服务
      // try/catch 未声明能力的访问抛错，见 SDK ui.ts 头注释——本文件不需要也不应该
      // 自己再摸一遍 hostBridge.ui。
      const ui = createHostUi(input.hostBridge);
      const i18n = createDesignerI18n(hostBridge?.i18n);
      const hostContext = input.hostContext as WorkflowDesignerHostContext | undefined;
      const host = createDesignerHost({
        hostApi,
        ui,
        interactiveSession,
        aliceV4,
        expression,
        appId: String(hostContext?.appId ?? ''),
        // 把当前定义标识传进 DesignerHost，供子流程节点面板排除自己（见 host.ts
        // DesignerHost.definitionId 注释）。老宿主 hostContext 不带这个键时落 undefined，不强行
        // 落空串（空串会被 SubflowPanel 的 excludeSelf 当成"要排除的 id"参与比较）。
        definitionId: hostContext?.definitionId,
        // 绑定引擎 ID 透给 DesignerHost（旧宿主不传时落 undefined）。
        enginePluginId: hostContext?.enginePluginId
      });

      return {
        component: DesignerRoot,
        props: {
          host,
          i18n,
          readOnly: Boolean(hostContext?.readOnly)
        }
      };
    }
    default:
      throw new Error(`[kimpo-workflow] unsupported surface: ${input.surfaceType}`);
  }
});
