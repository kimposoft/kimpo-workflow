package compile

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// TestKindRegistry_AllRegisteredKindsHaveSpec：node.Default() 注册表里的每一类节点都必须在
// 本包登记发布期规格（kindSpec）——漏登记即红，逼着「加一类节点」的人把三张表（node/registry.go、
// compile/kinds.go、engine/core 的运行期表）都补全，而不是只改了设计期就以为完事。
func TestKindRegistry_AllRegisteredKindsHaveSpec(t *testing.T) {
	kinds := []model.NodeKind{
		model.NodeKindStart, model.NodeKindHandle, model.NodeKindApprove,
		model.NodeKindCC, model.NodeKindSubflow, model.NodeKindEnd,
	}
	for _, k := range kinds {
		if _, ok := node.Default().Get(k); !ok {
			t.Fatalf("node.Default() 未注册 %q，判据本身的清单需要跟着 node/registry.go 一起改", k)
		}
		if _, ok := specOf(k); !ok {
			t.Fatalf("compile 包发布期规格表缺 %q：加一类节点必须同时补 compile/kind_%s.go 的 registerKind", k, k)
		}
	}
}

// TestKindRegistry_SubflowPublishable：子流程运行期第一、二层已补完，发布期放行
// （与 compile_test.go 的 TestSubflowPublishable 呼应，那条测行为、这条测配置）。
func TestKindRegistry_SubflowPublishable(t *testing.T) {
	spec, ok := specOf(model.NodeKindSubflow)
	if !ok {
		t.Fatal("子流程发布期规格缺失")
	}
	if !spec.publishable {
		t.Fatal("子流程运行期已补完，publishable 必须是 true")
	}
}
