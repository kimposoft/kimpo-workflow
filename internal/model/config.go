package model

import (
	"encoding/json"
	"fmt"
)

// 按 Kind 解码节点专属配置。Config 为空时返回零值配置（不报错），由节点校验决定必填项。

func decodeConfig(n *Node, into any) error {
	if n == nil {
		return fmt.Errorf("workflow document: nil node")
	}
	if len(n.Config) == 0 {
		return nil
	}
	if err := json.Unmarshal(n.Config, into); err != nil {
		return fmt.Errorf("workflow document: node %q config invalid: %w", n.ID, err)
	}
	return nil
}

// StartConfigOf 解码发起节点配置。
func StartConfigOf(n *Node) (StartConfig, error) {
	var c StartConfig
	c.AllowManualStart = true // 默认开
	err := decodeConfig(n, &c)
	return c, err
}

// HandleConfigOf 解码办理节点配置。解码后按 A12 做归一化：旧草稿/旧文档里按来源配置的关系
// （AssigneeSourceRelation）就地改记为过滤器，见 normalizeRelationSources。
func HandleConfigOf(n *Node) (HandleConfig, error) {
	var c HandleConfig
	err := decodeConfig(n, &c)
	if err == nil {
		c.Assignees, c.RelationFilters = normalizeRelationSources(c.Assignees, c.RelationFilters)
	}
	return c, err
}

// ApproveConfigOf 解码审批节点配置。归一化同 HandleConfigOf。
func ApproveConfigOf(n *Node) (ApproveConfig, error) {
	var c ApproveConfig
	err := decodeConfig(n, &c)
	if err == nil {
		c.Approvers, c.RelationFilters = normalizeRelationSources(c.Approvers, c.RelationFilters)
	}
	return c, err
}

// CCConfigOf 解码抄送节点配置。归一化同 HandleConfigOf。
func CCConfigOf(n *Node) (CCConfig, error) {
	var c CCConfig
	err := decodeConfig(n, &c)
	if err == nil {
		c.Recipients, c.RelationFilters = normalizeRelationSources(c.Recipients, c.RelationFilters)
	}
	return c, err
}

// normalizeRelationSources 是 HandleConfigOf / ApproveConfigOf / CCConfigOf 三处共用的解码后
// 归一化：把来源清单里 Kind=relation 的条目摘出来，其 Relation
// 值去重、保持首次出现顺序，并入过滤器清单（已经在过滤器里的不重复加），从来源清单里删掉。
// 全仓唯一解码入口做这一步归一化之后，下游（发布期校验 node/assignee_rules.go、编译期
// compile/kind_*.go）看到的来源清单里永远不会再有 relation 条目，不用各自再判一次。
//
// 幂等：对没有 relation 来源的输入（新文档、或已经归一化过的旧文档）原样返回同一个 sources
// 切片，不分配新数组、不改变 filters 相对顺序——重复调用（例如同一份配置先后被校验、编译各解码
// 一次）不会因为归一化本身产生漂移。
func normalizeRelationSources(sources []AssigneeSource, filters []AssigneeRelation) ([]AssigneeSource, []AssigneeRelation) {
	hasRelation := false
	for _, s := range sources {
		if s.Kind == AssigneeSourceRelation {
			hasRelation = true
			break
		}
	}
	if !hasRelation {
		return sources, filters
	}
	seen := make(map[AssigneeRelation]bool, len(filters))
	outFilters := append([]AssigneeRelation(nil), filters...)
	for _, f := range outFilters {
		seen[f] = true
	}
	outSources := make([]AssigneeSource, 0, len(sources))
	for _, s := range sources {
		if s.Kind != AssigneeSourceRelation {
			outSources = append(outSources, s)
			continue
		}
		if !seen[s.Relation] {
			seen[s.Relation] = true
			outFilters = append(outFilters, s.Relation)
		}
	}
	return outSources, outFilters
}

// EndConfigOf 解码结束节点配置。
func EndConfigOf(n *Node) (EndConfig, error) {
	var c EndConfig
	err := decodeConfig(n, &c)
	return c, err
}

// SubflowConfigOf 解码子流程节点配置。
func SubflowConfigOf(n *Node) (SubflowConfig, error) {
	var c SubflowConfig
	err := decodeConfig(n, &c)
	return c, err
}

// NewDiagnostic 造一条诊断（code = 子码或 WorkflowErrorCode 名；message_key = err.workflow.<code 小写>）。
func NewDiagnostic(code, nodeID, linkID string, args map[string]string) Diagnostic {
	return Diagnostic{Code: code, MessageKey: "err.workflow." + lowerSnake(code), NodeID: nodeID, LinkID: linkID, Arguments: args}
}

func lowerSnake(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z':
			out = append(out, c+('a'-'A'))
		case c == '.':
			out = append(out, '_')
		default:
			out = append(out, c)
		}
	}
	return string(out)
}
