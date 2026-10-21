// Package compile 是流程引擎的发布期编译器：
// 把设计器文档（model.Document）编译成运行期唯一消费的 CompiledDefinition（落库为
// workflow_definition_version.compiled_json），过程中做发布期检查（图结构、目标模板、节点校验、
// 支持面）、经宿主 ExpressionService 冻结表达式、抽出字段引用并登记。
//
// 运行期（engine/core）只读 CompiledDefinition，绝不重新解析设计器文档。
package compile

import (
	"encoding/json"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// CompiledDefinition 与 proto kimpo.workflow.host.v1.CompiledDefinition 同形（JSON 字段名一致），
// 以 JSON 存进版本行。
type CompiledDefinition struct {
	StartNodeID   string         `json:"start_node_id"`
	Nodes         []NodeCompiled `json:"nodes"`
	Links         []LinkCompiled `json:"links"`
	SerialFieldID string         `json:"serial_field_id,omitempty"`
	// Notify 流程定义级通知开关。engine/core 不读它——通知开关在节点级（NodeCompiled.NotifyJSON）。
	// 这里继续原样冻结写出，只为兼容可能还在解析它的旧客户端读路径。
	Notify model.NotifySettings `json:"notify"`
}

// NodeCompiled 节点运行期所需的全部配置（已冻结的表达式只留发布物 id 与文档）。
type NodeCompiled struct {
	NodeID               string  `json:"node_id"`
	NodeKind             string  `json:"node_kind"` // START | HANDLE | APPROVE | CC | SUBFLOW | END
	NodeName             string  `json:"node_name"`
	SummaryPublicationID string  `json:"summary_publication_id,omitempty"`
	SummaryDocumentJSON  string  `json:"summary_document_json,omitempty"`
	EndLabel             string  `json:"end_label,omitempty"`
	EndLabelFieldID      string  `json:"end_label_field_id,omitempty"`
	NoRouteHint          string  `json:"no_route_hint,omitempty"`
	PassRule             string  `json:"pass_rule,omitempty"` // ANY | RATIO
	PassRatio            int32   `json:"pass_ratio,omitempty"`
	StaticUserIDs        []int64 `json:"static_user_ids,omitempty"`
	AutoConditionPubID   string  `json:"auto_condition_publication_id,omitempty"`
	AutoConditionDocJSON string  `json:"auto_condition_document_json,omitempty"`
	FieldPermissionsJSON string  `json:"field_permissions_json,omitempty"` // 原样保留，宿主会话打开时合成档位
	ClearOnWithdrawJSON  string  `json:"clear_on_withdraw_json,omitempty"`
	AllowedWithdrawsJSON string  `json:"allowed_withdraws_json,omitempty"`
	ApproveButtonsJSON   string  `json:"approve_buttons_json,omitempty"`
	ResultFieldID        string  `json:"result_field_id,omitempty"`
	ReasonFieldID        string  `json:"reason_field_id,omitempty"`
	AllowManualStart     bool    `json:"allow_manual_start,omitempty"`
	TargetTemplateID     string  `json:"target_template_id,omitempty"`
	StartPermissionJSON  string  `json:"start_permission_json,omitempty"`
	SourcesJSON          string  `json:"sources_json,omitempty"` // 原始人员来源清单（宿主 CandidateService 用）
	IsTerminalAuxiliary  bool    `json:"is_terminal_auxiliary,omitempty"`

	// RelationFilters 『过滤器：与上步处理人的关系』，
	// 办理 / 审批 / 抄送三类节点共用；来自设计期 HandleConfig/ApproveConfig/CCConfig.RelationFilters，
	// 经 model.HandleConfigOf 等解码入口归一化后原样带出，新编译产物里 SourcesJSON 不再
	// 出现 relation 条目（见 compile/kinds.go staticUserIDsAndSources 的调用方）。空 = 不限
	// （旧编译产物走这条：关系仍在 SourcesJSON 里，运行期按旧语义并集加人，见
	// engine/core/relation_filter.go）。
	RelationFilters []model.AssigneeRelation `json:"relation_filters,omitempty"`

	// —— 发起条件 ——
	// StartConditionPubID / StartConditionDocJSON 发起条件表达式的冻结发布物 id 与原始文档 JSON，
	// 运行期（engine/core/start.go）经 Expr.EvaluateCondition 求值；两者都空 = 没配条件，直接放行。
	StartConditionPubID   string `json:"start_condition_publication_id,omitempty"`
	StartConditionDocJSON string `json:"start_condition_document_json,omitempty"`
	// StartConditionHint 不满足发起条件时的提示，配了 StartCondition 即必填（node/start.go
	// Validate 的 N1_START_CONDITION_HINT_REQUIRED）；运行期求值为假时原样回传，不含表达式原文。
	StartConditionHint string `json:"start_condition_hint,omitempty"`

	// —— 节点通知 ——
	// NotifyJSON 节点级通知配置（model.NodeNotify）原样冻结的 JSON，只有发起/办理/审批/结束
	// 四类节点会有（抄送/子流程节点没有 notify 概念）。空串等价于 model.NodeNotify{}：所有
	// 事件开关按「键缺席」处理即默认全开，渠道按 ChannelsOrDefault 默认仅 system——旧编译
	// 产物没有这个字段时解码出来正是空串，天然落到这条默认路径，不需要额外兼容分支。运行期
	// 一律经 Notify() 取值，不要直接读这个字段。
	NotifyJSON string `json:"notify_json,omitempty"`

	// —— 抄送 ——
	// CCChannelsJSON 通知渠道清单（[]model.NotifyChannel）。
	CCChannelsJSON string `json:"cc_channels_json,omitempty"`
	// 标题与正文各是一条宿主 V4 取值表达式：发布期冻结成发布物，运行期到达时求一次。
	TitlePublicationID   string `json:"title_publication_id,omitempty"`
	TitleDocumentJSON    string `json:"title_document_json,omitempty"`
	ContentPublicationID string `json:"content_publication_id,omitempty"`
	ContentDocumentJSON  string `json:"content_document_json,omitempty"`

	// —— 子流程 ——
	// SubflowTargetDefinitionID 目标流程（只支持同一应用内）。
	SubflowTargetDefinitionID string `json:"subflow_target_definition_id,omitempty"`
	// SubflowMappingsJSON 传递字段清单（[]model.SubflowFieldMapping）。
	SubflowMappingsJSON string `json:"subflow_mappings_json,omitempty"`
	// SubflowWait 等待档：true = 全部子流程结束后父流程才向后走。
	SubflowWait bool `json:"subflow_wait,omitempty"`
	// SubflowDisposition 父流程先结束时对未结束子流程的处置（仅「不等待」时有意义）。
	SubflowDisposition string `json:"subflow_disposition,omitempty"`
}

// LinkCompiled 引导线：is_main 由图结构算出，条件冻结为发布物。
type LinkCompiled struct {
	LinkID                 string `json:"link_id"`
	FromNodeID             string `json:"from_node_id"`
	ToNodeID               string `json:"to_node_id"`
	IsMain                 bool   `json:"is_main"`
	ConditionPublicationID string `json:"condition_publication_id,omitempty"`
	ConditionDocumentJSON  string `json:"condition_document_json,omitempty"`
	// LinkName 设计者填的连线名称，原样透传自设计期文档；只供展示，不参与选路。
	LinkName string `json:"link_name,omitempty"`
}

// Node 按 id 查节点。
func (c *CompiledDefinition) Node(id string) *NodeCompiled {
	for i := range c.Nodes {
		if c.Nodes[i].NodeID == id {
			return &c.Nodes[i]
		}
	}
	return nil
}

// Link 按 id 查引导线。
func (c *CompiledDefinition) Link(id string) *LinkCompiled {
	for i := range c.Links {
		if c.Links[i].LinkID == id {
			return &c.Links[i]
		}
	}
	return nil
}

// OutLinks 某节点的全部出线（按文档顺序）。
func (c *CompiledDefinition) OutLinks(nodeID string) []LinkCompiled {
	var out []LinkCompiled
	for _, l := range c.Links {
		if l.FromNodeID == nodeID {
			out = append(out, l)
		}
	}
	return out
}

// MainOutLinks 某节点的主线出线（L2：只有这些参与选路）。
func (c *CompiledDefinition) MainOutLinks(nodeID string) []LinkCompiled {
	var out []LinkCompiled
	for _, l := range c.Links {
		if l.FromNodeID == nodeID && l.IsMain {
			out = append(out, l)
		}
	}
	return out
}

// Decode 从 compiled_json 解码。
func Decode(raw []byte) (*CompiledDefinition, error) {
	var c CompiledDefinition
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// Encode 编码为 compiled_json。
func (c *CompiledDefinition) Encode() ([]byte, error) {
	return json.Marshal(c)
}

// KindOf 取节点类型常量（model.NodeKind）；NodeKindOfStep 是 model/status.go 里
// StepNodeKind 的反函数，两处不必各写一份映射。
func (n *NodeCompiled) KindOf() model.NodeKind {
	return model.NodeKindOfStep(n.NodeKind)
}

// Notify 反序列化 NotifyJSON，供 engine/core 判开关与渠道。n 为 nil、
// NotifyJSON 为空（该类节点没配 notify，或旧编译产物压根没有这个字段）、或反序列化失败时
// 一律返回 nil——model.NodeNotify 的 Enabled / ChannelsOrDefault 两个 helper 对 nil 接收者
// 已经是「全开 + 仅 system」，调用方不需要另外判 nil。
func (n *NodeCompiled) Notify() *model.NodeNotify {
	if n == nil || n.NotifyJSON == "" {
		return nil
	}
	var out model.NodeNotify
	if err := json.Unmarshal([]byte(n.NotifyJSON), &out); err != nil {
		return nil
	}
	return &out
}
