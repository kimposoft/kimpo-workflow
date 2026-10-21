// Package node 是节点类型注册表：把每种节点 Kind（model.NodeKind）映射到它的设计期校验
// （Handler.Validate）与静态特征（Handler.Traits，见 traits.go）。
//
// 运行期「到达时做什么」带 I/O、要用引擎内部的变更集构造器，放不进本包（依赖方向是
// model ← node ← compile ← engine/core），所以由 engine/core 自己的运行期注册表按类型登记
// （engine/core/node_registry.go）；发布期「配置怎么摊平」同理在 compile/kinds.go。三处都是
// 「一类一个文件 + 一行注册」，没有跨类型的 switch。
package node

import (
	"fmt"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// Handler 是一种节点类型的行为实现。
type Handler interface {
	// Kind 返回本实现对应的节点类型，必须与注册时的 key 一致（Registry.Register 会校验）。
	Kind() model.NodeKind
	// Validate 对文档里某一个该类型的节点做结构/引用级校验，返回诊断条目清单（可能为空）。
	Validate(doc *model.Document, n *model.Node) []model.Diagnostic
	// Traits 本类节点的静态特征（主线 / 派人 / 可用动作 / 撤销规则 …），见 traits.go。
	Traits() Traits
}

// Registry 是 Kind → Handler 的查找表。零值不可用，须用 NewRegistry 构造。
type Registry struct {
	handlers map[model.NodeKind]Handler
}

// NewRegistry 构造一个空注册表。
func NewRegistry() *Registry {
	return &Registry{handlers: make(map[model.NodeKind]Handler)}
}

// Register 登记一个节点类型的 Handler；同一 Kind 重复注册、或 Handler.Kind() 与注册的 key
// 不一致，都直接 panic——这是装配期的编程错误，不应该放过到运行期才发现。
func (r *Registry) Register(h Handler) {
	if h == nil {
		panic("node: Register(nil)")
	}
	kind := h.Kind()
	if _, exists := r.handlers[kind]; exists {
		panic(fmt.Sprintf("node: kind %q registered twice", kind))
	}
	r.handlers[kind] = h
}

// Get 按节点类型查找 Handler；未注册返回 (nil, false)。
func (r *Registry) Get(kind model.NodeKind) (Handler, bool) {
	h, ok := r.handlers[kind]
	return h, ok
}

// Len 返回已注册的节点类型数量（供测试用）。
func (r *Registry) Len() int {
	return len(r.handlers)
}

// NewDefaultRegistry 构造默认注册表：全部六类节点（发起、办理、审批、抄送、结束、子流程）。
// 加一类节点就是加一个文件加一行注册，不改表、不改协议。
func NewDefaultRegistry() *Registry {
	r := NewRegistry()
	r.Register(NewStartHandler())
	r.Register(NewHandleHandler())
	r.Register(NewApproveHandler())
	r.Register(NewCCHandler())
	r.Register(NewSubflowHandler())
	r.Register(NewEndHandler())
	return r
}
