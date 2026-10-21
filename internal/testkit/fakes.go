package testkit

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// FakeExpr 按发布物 id 回放条件真假 / 计算文本；未预设的发布物报 ErrExpressionInvalid。
type FakeExpr struct {
	mu         sync.Mutex
	Conditions map[string]bool
	Computed   map[string]string
	CondErr    map[string]error
	Calls      []string // publication ids，调用顺序
}

func NewFakeExpr() *FakeExpr {
	return &FakeExpr{Conditions: map[string]bool{}, Computed: map[string]string{}, CondErr: map[string]error{}}
}

func (f *FakeExpr) EvaluateCondition(_ context.Context, _ ports.RecordRef, publicationID, _ string, _ ports.Actor) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, publicationID)
	if err, ok := f.CondErr[publicationID]; ok {
		return false, err
	}
	v, ok := f.Conditions[publicationID]
	if !ok {
		return false, fmt.Errorf("%w: publication %s not preset", ports.ErrExpressionInvalid, publicationID)
	}
	return v, nil
}

func (f *FakeExpr) EvaluateComputed(_ context.Context, _ ports.RecordRef, publicationID, _ string, _ ports.Actor) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, publicationID)
	v, ok := f.Computed[publicationID]
	if !ok {
		return "", false, fmt.Errorf("%w: publication %s not preset", ports.ErrExpressionInvalid, publicationID)
	}
	return v, false, nil
}

// FakeRecord 记录头与写字段；WriteErr 非 nil 时写失败（事故用例用）。
// 还替宿主答「读字段」：MainValues / DetailRows 是预置的回放内容（子流程用），
// ReadErr 非 nil 时读失败。
type FakeRecord struct {
	Serial   string
	Exists   bool
	WriteErr error
	Writes   []ports.FieldWrite
	ReadErr  error
	// MainValues 主表字段值；DetailRows 按扩展表 id 分组的行。
	MainValues []ports.FieldValue
	DetailRows map[string][]ports.DetailRow
	// Reads 记录每次读的入参（判据用）。
	Reads []ports.ReadFieldsInput
	// WriteRefs / HeaderRefs 记录每次写字段 / 读记录头的单据定位（断言带上了 workflow_instance_id）。
	WriteRefs  []ports.RecordRef
	HeaderRefs []ports.RecordRef
}

func (f *FakeRecord) WriteFields(_ context.Context, rec ports.RecordRef, writes []ports.FieldWrite, _ string, _ ports.Actor, _ string) error {
	f.WriteRefs = append(f.WriteRefs, rec)
	if f.WriteErr != nil {
		return f.WriteErr
	}
	f.Writes = append(f.Writes, writes...)
	return nil
}

func (f *FakeRecord) Header(_ context.Context, rec ports.RecordRef, _ string) (bool, string, error) {
	f.HeaderRefs = append(f.HeaderRefs, rec)
	return f.Exists, f.Serial, nil
}

// ReadFields 回放预置的主表值与指定扩展表的行；没预置那张表就回零行（等价于扩展表没数据，
// 子流程按「零行发起零个」处理）。
func (f *FakeRecord) ReadFields(_ context.Context, in ports.ReadFieldsInput) (ports.ReadFieldsResult, error) {
	f.Reads = append(f.Reads, in)
	if f.ReadErr != nil {
		return ports.ReadFieldsResult{}, f.ReadErr
	}
	out := ports.ReadFieldsResult{Exists: f.Exists, MainValues: f.MainValues}
	if in.DetailTableID != "" {
		out.DetailRows = f.DetailRows[in.DetailTableID]
	}
	return out, nil
}

// FakeLaunch 非人工发起通道的假体：按调用顺序编号生成单据 id，并记下每次的入参（子流程判据用）。
type FakeLaunch struct {
	Err error
	// Created 每次建单的入参快照。
	Created []FakeLaunchCall
}

// FakeLaunchCall 一次建单调用。
type FakeLaunchCall struct {
	AppID      string
	TemplateID string
	Values     []ports.FieldWrite
	OnBehalfOf ports.Actor
	RequestKey string
	// ParentWorkflowInstanceID 发起这张单据的父流程实例。
	ParentWorkflowInstanceID string
}

func (f *FakeLaunch) CreateRecord(_ context.Context, appID, templateID string, values []ports.FieldWrite, onBehalfOf ports.Actor, parentWorkflowInstanceID, requestKey string) (string, error) {
	if f.Err != nil {
		return "", f.Err
	}
	f.Created = append(f.Created, FakeLaunchCall{AppID: appID, TemplateID: templateID, Values: values, OnBehalfOf: onBehalfOf, RequestKey: requestKey, ParentWorkflowInstanceID: parentWorkflowInstanceID})
	return fmt.Sprintf("rec-sub-%d", len(f.Created)), nil
}

// FakeLease 编辑租约释放的假体：记下每次调用的入参，供改派用例断言
// 「租约确实被释放了」；Err 非空时模拟释放失败（用于验证「失败只 warn 不回滚改派」）。
type FakeLease struct {
	Err      error
	Released bool
	// Calls 每次释放调用的入参快照。
	Calls []FakeLeaseCall
}

// FakeLeaseCall 一次释放调用。
type FakeLeaseCall struct {
	Record       ports.RecordRef
	HolderUserID int64
	Reason       string
}

func (f *FakeLease) ReleaseEditLease(_ context.Context, rec ports.RecordRef, holderUserID int64, reason string) (bool, error) {
	f.Calls = append(f.Calls, FakeLeaseCall{Record: rec, HolderUserID: holderUserID, Reason: reason})
	if f.Err != nil {
		return false, f.Err
	}
	return true, nil
}

// FixedClock 固定 UTC 时钟。
type FixedClock struct{ T time.Time }

func (c FixedClock) Now() time.Time { return c.T.UTC() }

// SeqIDs 顺序 id：prefix-1、prefix-2…
type SeqIDs struct {
	mu sync.Mutex
	n  map[string]int
}

func NewSeqIDs() *SeqIDs { return &SeqIDs{n: map[string]int{}} }

func (s *SeqIDs) New(prefix string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n[prefix]++
	return fmt.Sprintf("%s-%d", prefix, s.n[prefix])
}

// StaticCandidate 只认节点上直接指定的用户（测试替身；生产路径走宿主 CandidateService，
// 本假体只给单测用）。去重保序，display_name 留空。
type StaticCandidate struct{}

func (StaticCandidate) Resolve(_ context.Context, _ ports.RecordRef, staticUserIDs []int64, _ string, _ []int64) ([]ports.Person, error) {
	seen := map[int64]bool{}
	var out []ports.Person
	for _, id := range staticUserIDs {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, ports.Person{UserID: id})
	}
	return out, nil
}

// CandidateCall 记录一次 Resolve 调用的完整入参（关系过滤器测试用：断言
// 「先按来源算候选、过滤器非空再单独调一次」这套编排——尤其是第二次调用的入参形状：
// 来源清单只含 relation、staticUserIDs 传空、prev 与第一次相同，见 RecordingCandidate.CallLog）。
type CandidateCall struct {
	StaticUserIDs []int64
	SourcesJSON   string
	Prev          []int64
}

// RecordingCandidate 记录调用并委托给内层解析器（C1 判据）。
type RecordingCandidate struct {
	Inner ports.Candidate
	Calls int
	Err   error
	// Force 为真时无视 Inner 直接返回 Forced（模拟「同一节点前后两次到达候选不同」，C4 / G6 用）。
	Force  bool
	Forced []ports.Person
	// LastPrev 最近一次收到的前手清单（C1 判据）。
	LastPrev []int64
	// CallLog 按调用顺序记录每次入参（关系过滤器：一次到达可能触发两次 Resolve，靠这份日志
	// 分辨「先算候选」与「再筛一道」两次各收到了什么）。
	CallLog []CandidateCall
}

func (r *RecordingCandidate) Resolve(ctx context.Context, rec ports.RecordRef, ids []int64, sources string, prev []int64) ([]ports.Person, error) {
	r.Calls++
	r.LastPrev = prev
	r.CallLog = append(r.CallLog, CandidateCall{StaticUserIDs: ids, SourcesJSON: sources, Prev: prev})
	if r.Err != nil {
		return nil, r.Err
	}
	if r.Force {
		return r.Forced, nil
	}
	return r.Inner.Resolve(ctx, rec, ids, sources, prev)
}

// SourceCandidate 是能解析 sourcesJSON 的候选假体（关系过滤器测试用）：
// user 按 id 直接放行；role/department/relation 按调用方预置的映射表查人。它不模拟真实组织
// 语义（同部门 / 部门主管等口径判定在宿主，见 hostclient.Candidate），只用
// 来验证引擎侧「先算候选、按过滤器筛一道再取交集」的编排逻辑本身是否正确接线。
type SourceCandidate struct {
	// RoleMembers / DeptMembers 按来源里的 id（角色 id / 部门 id）查人。
	RoleMembers map[string][]int64
	DeptMembers map[string][]int64
	// RelationMembers 按关系档（model.AssigneeRelation 的字符串取值）查「这一档筛出的人」——
	// 测试场景里不需要真的按 prev 逐人展开，直接给定这一档对应的结果集即可。
	RelationMembers map[string][]int64
}

func (s SourceCandidate) Resolve(_ context.Context, _ ports.RecordRef, staticUserIDs []int64, sourcesJSON string, _ []int64) ([]ports.Person, error) {
	seen := map[int64]bool{}
	var out []ports.Person
	add := func(id int64) {
		if id == 0 || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, ports.Person{UserID: id})
	}
	for _, id := range staticUserIDs {
		add(id)
	}
	var sources []struct {
		Kind          string   `json:"kind"`
		UserIDs       []string `json:"user_ids,omitempty"`
		RoleIDs       []string `json:"role_ids,omitempty"`
		DepartmentIDs []string `json:"department_ids,omitempty"`
		Relation      string   `json:"relation,omitempty"`
	}
	if sourcesJSON != "" {
		if err := json.Unmarshal([]byte(sourcesJSON), &sources); err != nil {
			return nil, err
		}
	}
	for _, src := range sources {
		switch src.Kind {
		case "user":
			for _, idStr := range src.UserIDs {
				var id int64
				if _, err := fmt.Sscanf(idStr, "%d", &id); err == nil {
					add(id)
				}
			}
		case "role":
			for _, roleID := range src.RoleIDs {
				for _, id := range s.RoleMembers[roleID] {
					add(id)
				}
			}
		case "department":
			for _, deptID := range src.DepartmentIDs {
				for _, id := range s.DeptMembers[deptID] {
					add(id)
				}
			}
		case "relation":
			for _, id := range s.RelationMembers[src.Relation] {
				add(id)
			}
		}
	}
	return out, nil
}

// FakeFieldCatalog 是 ports.FieldCatalog 的测试替身：ListFields 忽略 appID/
// templateID，只回放 Fields 里预置的条目——单测场景一次编译只涉及一张模板，不用按模板分组。
type FakeFieldCatalog struct {
	// Fields 按 field_id 登记的字段（一个 field_id 只应出现一次；重复登记后一条覆盖前一条）。
	Fields map[string]ports.CatalogField
	// Err 非 nil 时 ListFields 直接返回该错误（模拟目录调用失败场景，Compile 应整体报错）。
	Err error
	// Calls 记录调用次数（判据用：K4 无待检字段引用时不应该发起目录调用）。
	Calls int
}

// NewFakeFieldCatalog 构造一个空目录；用 Fields 字段或 AllTextMain 追加登记。
func NewFakeFieldCatalog() *FakeFieldCatalog {
	return &FakeFieldCatalog{Fields: map[string]ports.CatalogField{}}
}

// AllTextMain 是常用夹具：把给定的字段 id 全部登记为「主表文本字段」，供只关心其余诊断、
// 不关心 K4 判类型细节的既有用例（如 compile_test.go 大量 f1Lite 变体）复用，免得逐条构造。
func AllTextMain(fieldIDs ...string) *FakeFieldCatalog {
	c := NewFakeFieldCatalog()
	for _, id := range fieldIDs {
		c.Fields[id] = ports.CatalogField{FieldID: id, FieldName: id, TableRole: "main", DataType: "text"}
	}
	return c
}

func (c *FakeFieldCatalog) ListFields(_ context.Context, _, _ string) ([]ports.CatalogField, error) {
	c.Calls++
	if c.Err != nil {
		return nil, c.Err
	}
	out := make([]ports.CatalogField, 0, len(c.Fields))
	for _, f := range c.Fields {
		out = append(out, f)
	}
	return out, nil
}

// FakeDefinitionCatalog 是 ports.DefinitionCatalog 的测试替身：按
// definition_id 预置定义行；未登记的 id 报 ports.ErrNotFound，呼应生产 hostclient.Ledger 把
// 宿主 NOT_FOUND 还原成同一个哨兵错误的口径。
type FakeDefinitionCatalog struct {
	// Definitions 按 definition_id 登记的定义头。
	Definitions map[string]*pb.DefinitionRow
	// Err 非 nil 时任意调用直接返回该错误（模拟账本调用失败，Compile 应整体报错）。
	Err error
	// Calls 记录每次被查询的 definition_id（判据：多个子流程节点指向同一目标时应只查一次）。
	Calls []string
}

// NewFakeDefinitionCatalog 构造一个空目录；用 Definitions 字段登记。
func NewFakeDefinitionCatalog() *FakeDefinitionCatalog {
	return &FakeDefinitionCatalog{Definitions: map[string]*pb.DefinitionRow{}}
}

func (c *FakeDefinitionCatalog) GetDefinition(_ context.Context, _, definitionID string) (*pb.DefinitionRow, error) {
	c.Calls = append(c.Calls, definitionID)
	if c.Err != nil {
		return nil, c.Err
	}
	d, ok := c.Definitions[definitionID]
	if !ok {
		return nil, ports.ErrNotFound
	}
	return d, nil
}
