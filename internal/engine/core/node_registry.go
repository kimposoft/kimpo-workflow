package core

import (
	"context"
	"fmt"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/node"
)

// node_registry.go 是引擎运行期的**节点类型注册表**。
//
// 不用 switch / if 散落在 arrive.go / branch.go / back.go 里判断「到达一类节点做什么」「这类节点
// 允许哪些回退方式」——那样加一类节点要回头改好几处、漏一处就是只有运行时才看得见的缺陷
// （见 traits.go 文件头）。运行期只认两件事：
//   - 静态特征（这类节点是什么样的）：走 internal/node 包的 Traits（traitsOf / traitsOfStep）；
//   - 运行期行为（到达时做什么、允许哪些回退方式）：走本文件的注册表（registerRuntime / runtimeOf）。
//
// 依赖方向 model ← node ← compile ← engine/core 决定了「到达」这种带 I/O、要用本包内部
// loaded / csBuilder / arrival 的行为放不进 internal/node，只能留在这里按类型登记；
// 发布期「配置怎么摊平」同理在 internal/compile 里有一份自己的注册表，两者互不依赖。
//
// 加一类节点：node/<kind>.go 声明校验与静态特征 + compile/kind_<kind>.go 声明发布期摊平 +
// engine/core/node_<kind>.go 声明到达行为并在其 init() 里 registerRuntime 一行，不改任何 switch。

// arriveFunc 到达一类节点的运行期行为，与原先 arrive.go 里各 case 分支、以及 arriveCC /
// arriveSubflow 的签名一致，方便直接用方法表达式（如 (*Engine).arriveCC）注册。
type arriveFunc func(e *Engine, ctx context.Context, l *loaded, b *csBuilder, inst *pb.InstanceRow, from *pb.StepRow, target *compile.NodeCompiled, to arriveTarget, submitter ports.Actor, seq int32) (*arrival, error)

// kindRuntime 一类节点的运行期行为。
type kindRuntime struct {
	// arrive 到达这类节点时做什么（建步骤、建任务/抄送行/发起子实例……）。必填。
	arrive arriveFunc
	// backMethods 这类节点「允许哪几档回退」的清单（预告与执行共用同一份口径）。
	// nil 表示这类节点根本没有回退这回事（预告不画目标步骤选择框，Back 也拒）。
	backMethods func(nc *compile.NodeCompiled) []model.WithdrawMethod
}

// runtimeRegistry 是 model.NodeKind → kindRuntime 的运行期查找表，各节点文件的 init() 各登记一行。
var runtimeRegistry = map[model.NodeKind]kindRuntime{}

// registerRuntime 登记一类节点的运行期行为；同一类型重复注册直接 panic——这是装配期的编程错误。
func registerRuntime(kind model.NodeKind, r kindRuntime) {
	if r.arrive == nil {
		panic(fmt.Sprintf("engine/core: registerRuntime(%q) with nil arrive", kind))
	}
	if _, exists := runtimeRegistry[kind]; exists {
		panic(fmt.Sprintf("engine/core: kind %q runtime registered twice", kind))
	}
	runtimeRegistry[kind] = r
}

// runtimeOf 按节点类型取运行期行为；未注册返回 (零值, false)。
func runtimeOf(kind model.NodeKind) (kindRuntime, bool) {
	r, ok := runtimeRegistry[kind]
	return r, ok
}

// traitsOf / traitsOfStep 是 internal/node 静态特征表的薄封装：未注册的类型按「不是主线、
// 不派任务、什么都不能做」的零值处理（宁可保守），调用方不需要再关心第二个 bool 返回值。
func traitsOf(kind model.NodeKind) node.Traits {
	t, _ := node.TraitsOf(kind)
	return t
}

func traitsOfStep(stepKind string) node.Traits {
	t, _ := node.TraitsOfStep(stepKind)
	return t
}

// init 登记发起节点的运行期行为。发起节点不经 arrive——它的「创建」发生在 Engine.Start，
// 由 start.go 直接建步骤建任务；这里注册一条只是让 runtimeOf 对全部节点类型都有答案，
// 真被访问到就是一个编程错误（对照原 arrive.go 的 default 分支语义）。
func init() {
	registerRuntime(model.NodeKindStart, kindRuntime{
		arrive: func(_ *Engine, _ context.Context, _ *loaded, _ *csBuilder, _ *pb.InstanceRow, _ *pb.StepRow, target *compile.NodeCompiled, _ arriveTarget, _ ports.Actor, _ int32) (*arrival, error) {
			return nil, errf("SYSTEM_ERROR", "start node %s cannot be arrived at", target.NodeID)
		},
		// 发起节点没有允许的回退档（清单恒空），Back 走到 E1 判定即拒——与重构前同一错误码。
		backMethods: backMethodsHandle,
	})
}
