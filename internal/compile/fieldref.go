package compile

import "github.com/kimposoft/kimpo-workflow/internal/model"

// FieldRef 字段引用登记（引导线条件、字段权限清单、回退时清空清单、审批绑定字段、
// 子流程传递字段、抄送标题正文、步骤摘要，以及发起条件、发起权限的主表字段来源，统一登记）；
// 发布时整体替换 workflow_field_ref。
type FieldRef struct {
	TemplateID  string
	DataTableID string
	FieldID     string
	RefKind     string // link_condition | summary | end_label_target | field_perm | clear_on_back | approve_bind | subflow_map | cc_text | start_condition
	NodeID      string
	LinkID      string
}

// 引用种类常量。
const (
	RefKindLinkCondition  = "link_condition"
	RefKindSummary        = "summary"
	RefKindEndLabelTarget = "end_label_target"
	RefKindFieldPerm      = "field_perm"
	RefKindClearOnBack    = "clear_on_back"
	RefKindApproveBind    = "approve_bind"
	RefKindSubflowMap     = "subflow_map"
	RefKindCCText         = "cc_text"
	// RefKindStartCondition 发起条件表达式里引用到的字段。
	// 发起权限的主表字段来源不用这个常量——按「人员来源=主表字段」既有口径落 RefKindFieldPerm
	// （见 kind_start.go fieldRefs，与 kind_handle.go/kind_approve.go 的同类写法一致）。
	RefKindStartCondition = "start_condition"
)

// collectFieldRefs 从节点配置抽字段引用（表达式内的引用由宿主 Freeze 回 referenced_fields）。
// 每类节点具体抽哪些字段由 specOf(n.Kind) 查到的 kindSpec.fieldRefs 决定（compile/kind_<kind>.go），
// 本函数只负责按文档顺序遍历节点、把模板 id 灌进收集器。
func collectFieldRefs(doc *model.Document, templateID string) []FieldRef {
	sink := &refSink{templateID: templateID}
	for i := range doc.Nodes {
		n := &doc.Nodes[i]
		if spec, ok := specOf(n.Kind); ok && spec.fieldRefs != nil {
			spec.fieldRefs(n, sink)
		}
	}
	return sink.refs
}
