package core

import (
	"testing"

	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// node_registry_test.go 判据：node.Default() 里的全部六类节点都必须在引擎运行期
// 注册表里登记了到达行为——漏登记的类型 runtimeOf 会返回 not-found，arrive() 据此报
// SYSTEM_ERROR，是一个只有运行时踩到那类节点才会暴露的缺陷，靠这条测试在测试阶段立刻挡住。
func TestNodeRuntimeRegistry_CoversAllStaticKinds(t *testing.T) {
	want := []model.NodeKind{
		model.NodeKindStart, model.NodeKindHandle, model.NodeKindApprove,
		model.NodeKindCC, model.NodeKindSubflow, model.NodeKindEnd,
	}
	// 与 node.Default() 的静态特征表交叉核对数量：两边都是「全部六类节点」，数量对不上
	// 说明这条清单本身漏了新加的类型。
	if got := node.Default().Len(); got != len(want) {
		t.Fatalf("node.Default().Len() = %d, want %d（本测试的 want 清单需要跟着补全）", got, len(want))
	}
	for _, kind := range want {
		if _, ok := node.Default().Get(kind); !ok {
			t.Fatalf("node.Default() 未登记静态特征：%q", kind)
		}
		if _, ok := runtimeOf(kind); !ok {
			t.Fatalf("engine/core 运行期注册表未登记到达行为：%q（node_<kind>.go 的 init() 漏了 registerRuntime）", kind)
		}
	}
}

// TestRegisterRuntime_DuplicatePanics 重复注册同一类型必须 panic（装配期编程错误，不能放过到运行期）。
func TestRegisterRuntime_DuplicatePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registerRuntime() duplicate kind: want panic, got none")
		}
	}()
	registerRuntime(model.NodeKindEnd, kindRuntime{arrive: arriveEnd})
}

// TestRegisterRuntime_NilArrivePanics arrive 是必填项，注册一个没有到达行为的类型没有意义，
// 直接 panic 比留一个「注册了但一调用就 nil 解引用」的类型更早暴露问题。
func TestRegisterRuntime_NilArrivePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registerRuntime() nil arrive: want panic, got none")
		}
	}()
	registerRuntime(model.NodeKind("no-such-kind-for-test"), kindRuntime{})
}
