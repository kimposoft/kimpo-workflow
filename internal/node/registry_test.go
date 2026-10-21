package node

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// 注册表里是全部六类节点（注册 = 有发布期校验实现）。
//
// 注意：**注册表里有 ≠ 发布期放行**——发布期是否放行由 compile 包的 kindSpec.publishable
// 决定。子流程运行期链路完整（app 层建单 → Start → 回写父子链接），与其余五类节点一样
// 在发布期放行（见 compile 包的 TestSubflowPublishable）。
func TestRegistry_AllSixKindsRegistered(t *testing.T) {
	r := NewDefaultRegistry()
	want := []model.NodeKind{
		model.NodeKindStart, model.NodeKindHandle, model.NodeKindApprove,
		model.NodeKindCC, model.NodeKindSubflow, model.NodeKindEnd,
	}
	if got := r.Len(); got != len(want) {
		t.Fatalf("NewDefaultRegistry() registered %d kinds, want %d", got, len(want))
	}
	for _, kind := range want {
		h, ok := r.Get(kind)
		if !ok {
			t.Fatalf("Get(%q) = not found, want registered", kind)
		}
		if h.Kind() != kind {
			t.Fatalf("Get(%q).Kind() = %q, want %q", kind, h.Kind(), kind)
		}
	}
}

func TestRegistry_DuplicateRegisterPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("Register() duplicate kind: want panic, got none")
		}
	}()
	r := NewRegistry()
	r.Register(NewStartHandler())
	r.Register(NewStartHandler())
}
