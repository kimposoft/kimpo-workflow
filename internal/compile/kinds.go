package compile

import (
	"encoding/json"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// kinds.go 是发布期编译器的**节点类型注册表**。
//
// 三层各自按类型登记、互不越界：internal/node 登记「设计期怎么校验 + 静态特征」
// （node/registry.go + traits.go），本层登记「发布期配置怎么摊平 / 登记哪些字段引用 /
// 收集哪些待冻结表达式 / 有没有专属结构检查」，engine/core 登记「运行期到达时做什么」。
// 三处都是「一类一个文件 + 一行注册」，消费方（compileNode / defaultNodeName /
// collectFieldRefs / collectExpressions / structuralChecks）只查表，不再按
// model.NodeKindXxx 写 switch/case——加一类节点不用回头改这些消费方。
//
// 加一类节点：node/<kind>.go 声明校验与特征 + compile/kind_<kind>.go 声明本文件这张表 +
// engine/core/node_<kind>.go 声明到达行为，各一行注册。

// kindSpec 是一类节点在发布期的完整规格。
type kindSpec struct {
	// defaultName 设计器未命名时的展示名（中文默认；四语由前端按 kind 处理，这里只是落库兜底）。
	defaultName string
	// publishable 运行期是否已经就绪、发布期可以放行；false 时 structuralChecks 报
	// NODE_KIND_UNSUPPORTED（目前只有子流程为 false，原因见 kind_subflow.go）。
	publishable bool
	// compile 把这一类节点的配置摊平进 NodeCompiled；只填本类专属字段——公共字段
	// （NodeID / NodeKind / NodeName / IsTerminalAuxiliary）已经由调用方 compileNode 填好。
	compile func(n *model.Node, nc *NodeCompiled) error
	// fieldRefs 登记这一类节点配置里引用到的字段（X3 字段引用清单）。
	fieldRefs func(n *model.Node, sink *refSink)
	// expressions 登记这一类节点要冻结的表达式槽（喂给 collectExpressions 的 add 闭包）。
	expressions func(n *model.Node, add exprAdder)
	// checks 这一类节点专属的结构检查；目前只有结束节点用（L11 无入线 / END_HAS_OUTLINE）。
	// 其余类型留空，structuralChecks 对空值直接跳过。
	checks func(n *model.Node, g *graph) []model.Diagnostic
}

// kindRegistry 是 model.NodeKind → kindSpec 的查找表，由各 kind_*.go 的 init() 登记。
var kindRegistry = map[model.NodeKind]kindSpec{}

// registerKind 登记一类节点的发布期规格；同一 Kind 重复注册直接 panic——这是装配期的
// 编程错误，不应该放过到运行期才发现（呼应 node.Registry.Register 的同款判断）。
func registerKind(kind model.NodeKind, spec kindSpec) {
	if _, exists := kindRegistry[kind]; exists {
		panic("compile: kind " + string(kind) + " registered twice")
	}
	kindRegistry[kind] = spec
}

// specOf 按节点类型查发布期规格；未注册返回零值与 false。
func specOf(kind model.NodeKind) (kindSpec, bool) {
	spec, ok := kindRegistry[kind]
	return spec, ok
}

// refSink 是字段引用收集器：各类节点的 fieldRefs 通过 add 登记引用，模板 id 由调用方
// collectFieldRefs 统一灌进去，各 kind 文件不用每条引用都带一遍。
type refSink struct {
	templateID string
	refs       []FieldRef
}

func (s *refSink) add(ref FieldRef) {
	ref.TemplateID = s.templateID
	s.refs = append(s.refs, ref)
}

// exprAdder 是 collectExpressions 内部登记闭包的类型别名，供各 kind 文件的 expressions
// 字段直接引用（原来这个闭包叫 add，就地内联在 collectExpressions 里）。
type exprAdder func(id string, purpose ExpressionPurpose, raw json.RawMessage, slot exprSlot)

// permFieldRefs / clearFieldRefs 是发起 / 办理 / 审批 / 抄送共用的两类字段引用登记辅助
// （原 fieldref.go 里就地内联的 perm / clear 闭包，现在收进本包供各 kind 文件复用）。
func permFieldRefs(sink *refSink, nodeID string, list []model.FieldPermission) {
	for _, p := range list {
		if p.Grade == model.FieldGradeInherit || p.FieldID == "" {
			continue
		}
		sink.add(FieldRef{DataTableID: p.TableID, FieldID: p.FieldID, RefKind: RefKindFieldPerm, NodeID: nodeID})
	}
}

func clearFieldRefs(sink *refSink, nodeID string, list []model.ClearOnWithdrawField) {
	for _, c := range list {
		if c.FieldID == "" {
			continue
		}
		sink.add(FieldRef{DataTableID: c.TableID, FieldID: c.FieldID, RefKind: RefKindClearOnBack, NodeID: nodeID})
	}
}

// staticUserIDsAndSources 是办理 / 审批共用的「人员来源 → StaticUserIDs / SourcesJSON」摊平
// 逻辑：来源里 Kind=user 的直接选人摊成静态用户 id 列表（引擎选路直接用），原始清单整体保留
// 一份 JSON（SourcesJSON，宿主 CandidateService 消费其余四种来源；经 SDK 类型化编码，见 hostkeys.go）。
func staticUserIDsAndSources(sources []model.AssigneeSource) (staticUserIDs []int64, sourcesJSON string, err error) {
	for _, src := range sources {
		if src.Kind == model.AssigneeSourceUser {
			staticUserIDs = append(staticUserIDs, src.UserIDs...)
		}
	}
	sourcesJSON, err = encodeSources(sources)
	return staticUserIDs, sourcesJSON, err
}
