package model

// SchemaVersion 是 Document.Schema 字段当前唯一承认的取值。设计器保存的每一份文档都必须
// 带这个字符串；Decode 校验时不认识的版本一律拒绝（schema.go）。
const SchemaVersion = "workflow/1"

// Document 是流程定义草稿/版本的完整内容：节点图 + 引导线 + 流程属性。设计器保存草稿、
// 发布产生版本时，存的都是这个结构的 JSON 序列化。
type Document struct {
	// Schema 文档格式版本，恒为 SchemaVersion；用于未来格式演进时的兼容判定。
	Schema string `json:"schema"`
	// Name 流程定义名称。
	Name string `json:"name"`
	// Nodes 节点清单，恰一个 NodeKindStart（Decode 校验）。
	Nodes []Node `json:"nodes"`
	// Links 引导线清单。
	Links []Link `json:"links"`
	// Notify 流程定义级通知开关（收到任务/被回退/被撤销/流程结束四类事件）。
	//
	// 已不再读取：通知开关在节点级（见 node.go NodeNotify），设计器/发布期
	// 编译器不再消费这份流程级设置。结构与字段原样保留，只为兼容旧文档解码——老草稿 JSON 里
	// 还带着这个键，Decode 得认识它才不报错；新建流程不需要再填它。
	Notify NotifySettings `json:"notify"`
}

// NotifySettings 是四类引擎事件的流程级通知开关，默认全开。
//
// 已停止读取（见上）：通知开关在节点级配置（NodeNotify），这份结构与
// DefaultNotifySettings 只保留给旧文档 / 旧编译产物解码用，新代码不要再往这里挂行为。
//
// 开关名与事件名历史上撞车（json 键早已落库，不改），只把 Go 字段名取得语义可读，
// 对照表如下（以此表为准）：
//
//	收到任务：开关 task_assigned（TaskAssigned）  → 事件 TASK_ASSIGNED（NotifyTaskAssigned）
//	被回退  ：开关 task_withdrawn（TaskReturned）  → 事件 TASK_RETURNED（NotifyTaskReturned）
//	被撤销  ：开关 task_revoked（TaskRevoked）      → 事件 TASK_WITHDRAWN（NotifyTaskWithdrawn）
//	流程结束：开关 instance_ended（InstanceEnded）  → 事件 INSTANCE_ENDED（NotifyInstanceEnded）
type NotifySettings struct {
	// TaskAssigned 收到任务。
	TaskAssigned bool `json:"task_assigned"`
	// TaskReturned 被回退（json 键沿用历史命名 task_withdrawn，不改）。
	TaskReturned bool `json:"task_withdrawn"`
	// TaskRevoked 被撤销。
	TaskRevoked bool `json:"task_revoked"`
	// InstanceEnded 流程结束。
	InstanceEnded bool `json:"instance_ended"`
}

// DefaultNotifySettings 返回默认全开的流程级通知设置。设计器新建流程不再调用
// （通知在节点级配置），保留给旧文档/旧编译产物构造零值兜底与测试夹具用。
func DefaultNotifySettings() NotifySettings {
	return NotifySettings{
		TaskAssigned:  true,
		TaskReturned:  true,
		TaskRevoked:   true,
		InstanceEnded: true,
	}
}
