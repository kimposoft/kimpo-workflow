package compile

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// Input 一次编译的入参。
type Input struct {
	Document     *model.Document
	AppID        string
	TemplateID   string // 发起节点的目标模板（与文档内一致性由 Validate 保证）
	DefinitionID string
	VersionNo    int64 // 即将发布的版本号
	// TemplatePublished 目标模板是否已发布，由宿主网关核实后传入，引擎只信这个布尔。
	TemplatePublished bool
	// SerialFieldID 主表第一个自动编号字段（H2），由宿主网关查模板后传入；空 = 不附。
	SerialFieldID string
	// DryRun 只做检查，不冻结表达式（DefinitionService.Validate）。
	DryRun bool
}

// Result 编译结果：Diagnostics 非空即发布拒绝（PUBLISH_REJECTED），Compiled 与 FieldRefs 为空。
type Result struct {
	Compiled    *CompiledDefinition
	FieldRefs   []FieldRef
	Diagnostics []model.Diagnostic
}

// Compiler 发布期编译器。
type Compiler struct {
	registry *node.Registry
	freezer  Freezer
	// catalog 字段目录端口（K4 / N6.10 用）：nil 时 bindingFieldTypeChecks 与
	// subflowMappingChecks 都直接跳过——仅允许单测这么用；生产装配（internal/app/app.go）必须
	// 注入 hostclient.NewTemplateCatalog()，漏注入等于 K4 与 N6.10 两道后端闸一起失效，不会有
	// 任何编译期报错提醒。
	catalog ports.FieldCatalog
	// definitions 定义目录端口（K3 / N6.10 用）：nil 时 subflowMappingChecks 整段
	// 跳过（仅测试场景）；生产装配注入 internal/app/app.go 对 hostclient.Ledger 的薄封装。
	definitions ports.DefinitionCatalog
}

// New 构造编译器；freezer 为 nil 时只能 DryRun；catalog 为 nil 时跳过 K4 字段类型闸（仅测试
// 场景）；definitions 为 nil 时跳过 K3 目标流程状态闸与 N6.10 传递字段类型闸（仅测试场景，
// 见 subflowmap.go）。
func New(registry *node.Registry, freezer Freezer, catalog ports.FieldCatalog, definitions ports.DefinitionCatalog) *Compiler {
	if registry == nil {
		registry = node.NewDefaultRegistry()
	}
	return &Compiler{registry: registry, freezer: freezer, catalog: catalog, definitions: definitions}
}

// Compile 见包注释：结构检查 → K2 → 收集表达式 → 冻结 → 组装 CompiledDefinition → 字段引用。
func (c *Compiler) Compile(ctx context.Context, in Input) (Result, error) {
	if in.Document == nil {
		return Result{}, fmt.Errorf("compile: nil document")
	}
	doc := in.Document
	g := buildGraph(doc)
	diags := structuralChecks(doc, g, c.registry)
	if !in.TemplatePublished {
		diags = append(diags, model.NewDiagnostic("K2", "", "", nil))
	}
	// 发起节点的目标模板必须与本定义绑定的模板一致。
	startID := ""
	for i := range doc.Nodes {
		if doc.Nodes[i].Kind == model.NodeKindStart {
			startID = doc.Nodes[i].ID
			if cfg, err := model.StartConfigOf(&doc.Nodes[i]); err == nil && cfg.TargetTemplateID != "" && in.TemplateID != "" && cfg.TargetTemplateID != in.TemplateID {
				diags = append(diags, model.NewDiagnostic("N1_TARGET_TEMPLATE_MISMATCH", doc.Nodes[i].ID, "", map[string]string{"expected": in.TemplateID, "actual": cfg.TargetTemplateID}))
			}
		}
	}
	specs, slots, collectIssues := collectExpressions(doc)
	diags = append(diags, collectIssues...)
	// fieldRefs 提前到诊断汇总门之前收集：K4 字段类型闸（bindingFieldTypeChecks）要用它筛出
	// 结果 / 理由绑定字段与结束标识写入字段，而这三类诊断也要跟结构检查一起进同一份
	// Result.Diagnostics（发布拒绝一次性列全，不分批报错）。
	fieldRefs := collectFieldRefs(doc, in.TemplateID)
	typeDiags, err := c.bindingFieldTypeChecks(ctx, in.AppID, in.TemplateID, fieldRefs)
	if err != nil {
		return Result{}, err
	}
	diags = append(diags, typeDiags...)
	// K3 目标流程状态闸 + N6.10 传递字段类型闸（subflowmap.go）：与 K4 并列，同样
	// 在诊断汇总门之前跑、目录调用失败即整体返回 error（不静默放行）。
	subflowDiags, err := c.subflowMappingChecks(ctx, in.AppID, in.TemplateID, doc)
	if err != nil {
		return Result{}, err
	}
	diags = append(diags, subflowDiags...)
	if len(diags) > 0 {
		return Result{Diagnostics: diags}, nil
	}

	// doc.Notify（流程级）继续原样冻结进编译产物：engine/core 不读它（通知开关在节点级
	// NodeCompiled.NotifyJSON，见各 kind_*.go），这里保留写出只是防御性兼容——万一还有旧客户端
	// 在解析 compiled_json.notify，不至于报错。
	compiled := &CompiledDefinition{StartNodeID: startID, SerialFieldID: in.SerialFieldID, Notify: doc.Notify}
	for _, id := range g.order {
		n := g.nodes[id]
		nc, err := compileNode(n, g)
		if err != nil {
			return Result{Diagnostics: []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", n.ID, "", map[string]string{"message": err.Error()})}}, nil
		}
		compiled.Nodes = append(compiled.Nodes, nc)
	}
	for i := range doc.Links {
		l := &doc.Links[i]
		compiled.Links = append(compiled.Links, LinkCompiled{
			LinkID: l.ID, FromNodeID: l.From, ToNodeID: l.To, IsMain: g.isMainLink(l),
			ConditionDocumentJSON: string(l.ConditionDoc), LinkName: l.Name,
		})
	}

	if in.DryRun || len(specs) == 0 {
		return Result{Compiled: compiled, FieldRefs: fieldRefs}, nil
	}
	if c.freezer == nil {
		return Result{}, fmt.Errorf("compile: freezer is not wired")
	}
	out, err := c.freezer.Freeze(ctx, FreezeInput{AppID: in.AppID, TemplateID: in.TemplateID, DefinitionID: in.DefinitionID, VersionNo: in.VersionNo, Specs: specs})
	if err != nil {
		return Result{}, fmt.Errorf("compile: freeze expressions: %w", err)
	}
	if len(out.Issues) > 0 {
		// 宿主诊断带 expression_id，补上节点 / 引导线定位。
		for _, d := range out.Issues {
			exprID := d.Arguments["expression_id"]
			if slot, ok := slots[exprID]; ok {
				d.NodeID, d.LinkID = slot.nodeID, slot.linkID
			}
			diags = append(diags, d)
		}
		return Result{Diagnostics: diags}, nil
	}
	frozen := map[string]FrozenExpression{}
	for _, f := range out.Frozen {
		frozen[f.ExpressionID] = f
	}
	for id, slot := range slots {
		f, ok := frozen[id]
		if !ok {
			return Result{}, fmt.Errorf("compile: host froze no publication for expression %s", id)
		}
		switch {
		case slot.linkID != "":
			compiled.Link(slot.linkID).ConditionPublicationID = f.PublicationID
			for _, ref := range f.ReferencedFields {
				fieldRefs = append(fieldRefs, FieldRef{TemplateID: in.TemplateID, DataTableID: ref.DataTableID, FieldID: ref.FieldID, RefKind: RefKindLinkCondition, LinkID: slot.linkID})
			}
		default:
			nc := compiled.Node(slot.nodeID)
			switch slot.field {
			case "summary":
				nc.SummaryPublicationID = f.PublicationID
			case "auto":
				nc.AutoConditionPubID = f.PublicationID
			case "title":
				nc.TitlePublicationID = f.PublicationID
			case "body":
				nc.ContentPublicationID = f.PublicationID
			case "start_cond":
				nc.StartConditionPubID = f.PublicationID
			}
			for _, ref := range f.ReferencedFields {
				kind := RefKindSummary
				switch slot.field {
				case "title", "body":
					kind = RefKindCCText
				case "start_cond":
					// 发起条件表达式引用到的字段单独登记，
					// 不并进 RefKindSummary——它是发起闸门，不是摘要文案，删字段时要能明确指出
					// 「这个字段被某条流程的发起条件用到」。
					kind = RefKindStartCondition
				}
				fieldRefs = append(fieldRefs, FieldRef{TemplateID: in.TemplateID, DataTableID: ref.DataTableID, FieldID: ref.FieldID, RefKind: kind, NodeID: slot.nodeID})
			}
		}
	}
	return Result{Compiled: compiled, FieldRefs: fieldRefs}, nil
}

// compileNode 把一个节点的配置摊平进 NodeCompiled：公共字段在这里填好，本类专属字段交给
// specOf(n.Kind) 查到的 kindSpec.compile（compile/kind_<kind>.go）去填。
func compileNode(n *model.Node, g *graph) (NodeCompiled, error) {
	nc := NodeCompiled{NodeID: n.ID, NodeKind: model.StepNodeKind(n.Kind), NodeName: n.Name, IsTerminalAuxiliary: g.isTerminalAuxiliary(n.ID)}
	if nc.NodeName == "" {
		nc.NodeName = defaultNodeName(n.Kind)
	}
	if spec, ok := specOf(n.Kind); ok && spec.compile != nil {
		if err := spec.compile(n, &nc); err != nil {
			return nc, err
		}
	}
	return nc, nil
}

func passRuleOf(m model.CompleteMode) (string, int32) {
	if m.Kind == model.CompleteModePercentage {
		bp := m.PercentageBP
		if bp <= 0 {
			bp = 10000
		}
		return string(model.PassRuleRatio), int32(bp / 100)
	}
	if m.Kind == model.CompleteModeAll {
		// 「全部完成 / 会签」档：语义等同按比例 100%，编译成同一条 RATIO/100 规则，运行期
		// pass.go 只认落库的规则与百分比，不必另外分支。
		return string(model.PassRuleRatio), 100
	}
	return string(model.PassRuleAny), 100
}

func marshalOrEmpty(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	s := string(raw)
	if s == "null" || s == "[]" || s == "{}" {
		return ""
	}
	return s
}

// defaultNodeName 设计器未命名时的展示名（中文默认；四语由前端按 kind 处理，这里只是落库兜底）。
func defaultNodeName(k model.NodeKind) string {
	if spec, ok := specOf(k); ok {
		return spec.defaultName
	}
	return string(k)
}
