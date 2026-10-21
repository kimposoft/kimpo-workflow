package model

import (
	"encoding/json"
	"fmt"
)

// Decode 把一份文档 JSON（设计器保存的草稿，或版本落库的发布内容）解析为 Document，
// 并做结构级校验：
//   - schema 版本必须等于 SchemaVersion；
//   - 每个节点的 kind 必须在 KnownNodeKinds 闭集内；
//   - 节点 id 在文档内唯一；
//   - 恰好一个 NodeKindStart 节点（『发起…恰一个』，N1 表格）。
//
// 校验不做的事（留给后续卡）：引导线端点存在性、L10/L11 发布期结构检查、字段权限清单
// 引用真实存在的字段等——这些需要设计器上下文或宿主字段目录，不是纯本地结构校验。
func Decode(raw []byte) (Document, error) {
	var doc Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Document{}, fmt.Errorf("workflow document: invalid json: %w", err)
	}
	if err := validate(&doc); err != nil {
		return Document{}, err
	}
	return doc, nil
}

func validate(doc *Document) error {
	if doc.Schema != SchemaVersion {
		return fmt.Errorf("workflow document: unsupported schema %q, want %q", doc.Schema, SchemaVersion)
	}

	seenIDs := make(map[string]bool, len(doc.Nodes))
	startCount := 0
	for _, node := range doc.Nodes {
		if node.ID == "" {
			return fmt.Errorf("workflow document: node missing id")
		}
		if seenIDs[node.ID] {
			return fmt.Errorf("workflow document: duplicate node id %q", node.ID)
		}
		seenIDs[node.ID] = true

		if !KnownNodeKinds[node.Kind] {
			return fmt.Errorf("workflow document: unknown node kind %q (node %q)", node.Kind, node.ID)
		}
		if node.Kind == NodeKindStart {
			startCount++
		}
	}

	if startCount != 1 {
		return fmt.Errorf("workflow document: expected exactly one start node, got %d", startCount)
	}

	return nil
}
