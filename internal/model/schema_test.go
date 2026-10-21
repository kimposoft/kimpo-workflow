package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func validDocJSON(t *testing.T, mutate func(*Document)) []byte {
	t.Helper()
	doc := Document{
		Schema: SchemaVersion,
		Name:   "测试流程",
		Nodes: []Node{
			{ID: "n1", Kind: NodeKindStart},
			{ID: "n2", Kind: NodeKindEnd},
		},
		Links:  []Link{{ID: "l1", From: "n1", To: "n2"}},
		Notify: DefaultNotifySettings(),
	}
	if mutate != nil {
		mutate(&doc)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return raw
}

func TestModel_DecodeValidDocument(t *testing.T) {
	raw := validDocJSON(t, nil)
	doc, err := Decode(raw)
	if err != nil {
		t.Fatalf("Decode() unexpected error: %v", err)
	}
	if doc.Name != "测试流程" {
		t.Fatalf("Decode() name = %q, want 测试流程", doc.Name)
	}
}

func TestModel_RejectsUnknownNodeKind(t *testing.T) {
	raw := validDocJSON(t, func(d *Document) {
		d.Nodes = append(d.Nodes, Node{ID: "n3", Kind: NodeKind("teleport")})
	})
	_, err := Decode(raw)
	if err == nil {
		t.Fatal("Decode() with unknown node kind: want error, got nil")
	}
	if !strings.Contains(err.Error(), "unknown node kind") {
		t.Fatalf("Decode() error = %v, want mention of unknown node kind", err)
	}
}

func TestModel_SchemaVersionRequired(t *testing.T) {
	raw := validDocJSON(t, func(d *Document) {
		d.Schema = "workflow/0"
	})
	_, err := Decode(raw)
	if err == nil {
		t.Fatal("Decode() with wrong schema version: want error, got nil")
	}
	if !strings.Contains(err.Error(), "unsupported schema") {
		t.Fatalf("Decode() error = %v, want mention of unsupported schema", err)
	}

	// 空 schema（缺字段）同样必须拒绝。
	raw = validDocJSON(t, func(d *Document) {
		d.Schema = ""
	})
	if _, err := Decode(raw); err == nil {
		t.Fatal("Decode() with empty schema: want error, got nil")
	}
}

func TestModel_ExactlyOneStartNode(t *testing.T) {
	// 零个发起节点。
	raw := validDocJSON(t, func(d *Document) {
		d.Nodes = []Node{{ID: "n2", Kind: NodeKindEnd}}
	})
	if _, err := Decode(raw); err == nil {
		t.Fatal("Decode() with zero start nodes: want error, got nil")
	} else if !strings.Contains(err.Error(), "exactly one start node") {
		t.Fatalf("Decode() error = %v, want mention of exactly one start node", err)
	}

	// 两个发起节点。
	raw = validDocJSON(t, func(d *Document) {
		d.Nodes = append(d.Nodes, Node{ID: "n3", Kind: NodeKindStart})
	})
	if _, err := Decode(raw); err == nil {
		t.Fatal("Decode() with two start nodes: want error, got nil")
	} else if !strings.Contains(err.Error(), "exactly one start node") {
		t.Fatalf("Decode() error = %v, want mention of exactly one start node", err)
	}
}

func TestModel_RejectsDuplicateNodeID(t *testing.T) {
	raw := validDocJSON(t, func(d *Document) {
		d.Nodes = append(d.Nodes, Node{ID: "n1", Kind: NodeKindHandle})
	})
	if _, err := Decode(raw); err == nil {
		t.Fatal("Decode() with duplicate node id: want error, got nil")
	} else if !strings.Contains(err.Error(), "duplicate node id") {
		t.Fatalf("Decode() error = %v, want mention of duplicate node id", err)
	}
}

func TestModel_RejectsInvalidJSON(t *testing.T) {
	if _, err := Decode([]byte("{not json")); err == nil {
		t.Fatal("Decode() with invalid json: want error, got nil")
	}
}
