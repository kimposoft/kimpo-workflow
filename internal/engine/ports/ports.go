// Package ports 是流程引擎状态机（internal/engine/core）向外的五个口：账本、表达式、候选、
// 单据、时钟 / id。核心只依赖这些接口做纯计算；生产实现在 internal/transport（gRPC 客户端适配），
// 单测用 internal/testkit 的假体。
//
// 领域行直接复用 SDK 生成的行消息（kimpo.workflow.host.v1.*Row）——它们就是账本表的一行，
// 再抄一套 Go 结构体只会多一层无意义的转换（宿主账本已经做过一次）。
package ports

import (
	"context"
	"errors"
	"time"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
)

// 哨兵错误：适配器把宿主 gRPC status 的前缀（VERSION_CONFLICT: … 等）还原成这些。
var (
	ErrNotFound          = errors.New("workflow: not found")
	ErrVersionConflict   = errors.New("workflow: version conflict")
	ErrRecordHasInstance = errors.New("workflow: record already has instance")
	ErrExpressionInvalid = errors.New("workflow: expression invalid")
	ErrSystem            = errors.New("workflow: system error")
	// ErrRequestKeyReused 同一 request_key 配了不同摘要 / 不同操作人：
	// 宿主 Commit 事务规约⓪命中请求日志但摘要或操作人不同时返回此错，engineapp 折成 INVALID_ARGUMENT。
	ErrRequestKeyReused = errors.New("workflow: request key reused with different content")
	// ErrRecordWriteRejected 宿主按**业务校验**拒绝了这次建单 / 写字段（宿主 status message 前缀
	// RECORD_WRITE_REJECTED：必填缺失、字段不在主表、模板禁用 / 查询模式 / 未发布、「唯一」字段重复）。
	// 与 ErrSystem 分开：这类失败重试无益，要管理员改配置或数据；停驻事件据此记
	// RECORD_WRITE_REJECTED 而不是笼统的 SYSTEM_ERROR。
	ErrRecordWriteRejected = errors.New("workflow: record write rejected")
)

// RecordWriteRejection 带宿主子码的业务校验类拒绝。宿主在 gRPC 状态详情里附了 Diagnostic 子码
// （REQUIRED_FIELD_MISSING / FIELD_UNIQUE_CONFLICT / TEMPLATE_DISABLED ……）时，适配器用这个类型
// 把子码一路带进引擎，停驻事故据此记更细的原因码，流程管理页才能给管理员显示「哪一类拒绝」的
// 业务话，而不是笼统的「被拒绝」。errors.Is(err, ErrRecordWriteRejected) 照常成立，Error() 文本
// 与不带子码时的 "%w: %s" 写法逐字一致——既有按哨兵判定、按原文记日志的调用方都不受影响。
type RecordWriteRejection struct {
	// SubCode 宿主给的拒绝子码；宿主没给时为空串。
	SubCode string
	// Message 宿主 status message 原文（含 RECORD_WRITE_REJECTED: 前缀）。
	Message string
}

func (e *RecordWriteRejection) Error() string {
	return ErrRecordWriteRejected.Error() + ": " + e.Message
}

// Unwrap 让 errors.Is(err, ErrRecordWriteRejected) 成立。
func (e *RecordWriteRejection) Unwrap() error { return ErrRecordWriteRejected }

// HostRejection 宿主按具名业务码拒绝了这次调用：status message 前缀是
// WorkflowErrorCode 枚举内、但不在上面几个哨兵里的码——典型是 Commit 校验的 WORKFLOW_SUBFLOW_CROSS_ENGINE
// （子流程目标绑定了别的引擎）、COMPILED_HOST_KEYS_INVALID、OUTBOX_PAYLOAD_INVALID（只认 SDK 枚举内的码）。引擎 app 层据此把**宿主给的码原样**回给网关（发布页能显示「子流程目标
// 绑定了别的引擎」而不是笼统的系统错误）；Unwrap 仍是 ErrSystem，既有按 ErrSystem 判定（停驻 / 重试）的
// 调用方行为不变。
type HostRejection struct {
	// Code 宿主业务码（WorkflowErrorCode 枚举名）。
	Code string
	// Message 宿主 status message 原文（含前缀）。
	Message string
}

func (e *HostRejection) Error() string { return ErrSystem.Error() + ": " + e.Message }

// Unwrap 让 errors.Is(err, ErrSystem) 照常成立。
func (e *HostRejection) Unwrap() error { return ErrSystem }

// Actor 操作人（宿主从会话填入，含姓名供 H2）。
type Actor struct {
	UserID      int64
	DisplayName string
	SuperAdmin  bool
}

// RecordRef 单据定位。
type RecordRef struct {
	AppID      string
	TemplateID string
	RecordID   string
	// WorkflowInstanceID 这次读写所属的流程实例：宿主
	// RecordService / LeaseService 按它核对「实例属于本引擎、单据 = 实例单据」。已知实例的路径一律带上；
	// 发起时实例 ID 由 app 层预分配后同样带上（实例尚未落库时宿主按单据反查放行）。只有表达式求值等
	// 不经 Record / Lease 的读取不使用本字段。
	WorkflowInstanceID string
}

// Person 候选人。
type Person struct {
	UserID      int64
	DisplayName string
	Notes       []string
}

// CommitInput 一次 Commit 的入参（带意图摘要 / 操作人 / 结果快照，供宿主按
// (app_id, request_key) 的请求日志判定重放 vs 请求键复用）。
type CommitInput struct {
	RequestKey string
	// RequestDigest 动作意图摘要（sha256 hex）：动作类型 + 目标 id + 选择项 + 操作人 + 请求体要点，
	// 不含时钟与随机 id；同请求键重放时用它区分「真重试」与「同键配了不同内容」。
	RequestDigest string
	ActorUserID   int64
	// OutcomeJSON 本次动作结果快照（引擎自定义 JSON，宿主只存不解析），重放时原样回带。
	OutcomeJSON string
	Changeset   *pb.Changeset
}

// CommitResult 一次 Commit 的回包。
type CommitResult struct {
	// Applied false = 命中请求日志重放，什么都没写；OutcomeJSON / InstanceVersion 是首次提交时的值。
	Applied         bool
	InstanceVersion int64
	OutcomeJSON     string
}

// CommittedRequest FindCommit 命中时的已提交记录（对齐 FindCommitReply）。
type CommittedRequest struct {
	RequestDigest      string
	ActorUserID        int64
	WorkflowInstanceID string
	DefinitionID       string
	InstanceVersion    int64
	OutcomeJSON        string
}

// Ledger 六本账：读聚合、提交变更集（宿主 CAS + request_key 幂等）。
type Ledger interface {
	GetDefinition(ctx context.Context, appID, definitionID string) (*pb.DefinitionRow, []*pb.DefinitionVersionRow, error)
	ListDefinitions(ctx context.Context, appID, templateID string, includeDisabled bool) ([]*pb.DefinitionRow, error)
	// GetVersion versionNo = 0 取最新已发布。
	GetVersion(ctx context.Context, appID, definitionID string, versionNo int64) (*pb.DefinitionVersionRow, error)
	LoadInstanceByID(ctx context.Context, appID, workflowInstanceID string) (*pb.InstanceAggregate, error)
	LoadInstanceByRecord(ctx context.Context, appID, recordID string) (*pb.InstanceAggregate, error)
	LoadInstanceByTask(ctx context.Context, appID, taskID string) (*pb.InstanceAggregate, error)
	LoadInstanceByIncident(ctx context.Context, appID, incidentID string) (*pb.InstanceAggregate, error)
	// LoadParentOfChild 按子实例反查它的父实例聚合（等待档：子实例结束时要回去推父流程）。
	// 该子实例没有父链接时返回 ErrNotFound。
	LoadParentOfChild(ctx context.Context, appID, childInstanceID string) (*pb.InstanceAggregate, error)
	Commit(ctx context.Context, appID string, in CommitInput) (CommitResult, error)
	// FindCommit 按请求键查已提交的动作；未找到返回 (nil, nil)（决策之前调用，
	// 命中即直接回放，不再重新装载 / 决策）。
	FindCommit(ctx context.Context, appID, requestKey string) (*CommittedRequest, error)
}

// Expression 运行期求值（发布期冻结走 compile.Freezer）。
type Expression interface {
	EvaluateCondition(ctx context.Context, rec RecordRef, publicationID, documentJSON string, actor Actor) (bool, error)
	EvaluateComputed(ctx context.Context, rec RecordRef, publicationID, documentJSON string, actor Actor) (text string, null bool, err error)
}

// Candidate 候选计算：生产走宿主 CandidateService（hostclient.Candidate），单测用 testkit.StaticCandidate。
type Candidate interface {
	Resolve(ctx context.Context, rec RecordRef, staticUserIDs []int64, sourcesJSON string, previousHandlers []int64) ([]Person, error)
}

// FieldWrite 写字段。
type FieldWrite struct {
	FieldID   string
	TextValue string
	Clear     bool
}

// FieldValue 一个字段的文本值。IsNull 把「没有值」与「值是空串」分开：前者不写进目标字段，
// 后者写空串（子流程传递字段要区分这两种）。
type FieldValue struct {
	FieldID   string
	TextValue string
	IsNull    bool
}

// DetailRow 扩展表的一行（RecordID 是行自己的记录 id，供行身份与判重用）。
type DetailRow struct {
	RecordID string
	Values   []FieldValue
}

// ReadFieldsInput 读字段入参。DetailTableID 为空表示只读主表字段；一次只读一张扩展表——
// 传递字段本来就只能来自同一张扩展表。
type ReadFieldsInput struct {
	Record         RecordRef
	MainFieldIDs   []string
	DetailTableID  string
	DetailFieldIDs []string
}

// ReadFieldsResult 读字段出参。
type ReadFieldsResult struct {
	Exists     bool
	MainValues []FieldValue
	DetailRows []DetailRow
}

// Record 单据字段读写（经宿主表单数据层）。
type Record interface {
	WriteFields(ctx context.Context, rec RecordRef, writes []FieldWrite, reason string, actor Actor, requestKey string) error
	Header(ctx context.Context, rec RecordRef, serialFieldID string) (exists bool, serialValue string, err error)
	// ReadFields 读主表字段与一张扩展表的全部行（子流程用）。
	ReadFields(ctx context.Context, in ReadFieldsInput) (ReadFieldsResult, error)
}

// Launch 非人工发起通道的宿主侧：按传递字段新建目标流程的单据。
// 发起实例本身仍由引擎自己完成（Engine.Start），这里只负责「先有一张单据」。
type Launch interface {
	// CreateRecord 在目标模板下新建一张单据并写入初值；onBehalfOf 记为发起人
	// （子流程 = 触发过关的提交人）。parentWorkflowInstanceID 是发起这张单据的父流程实例
	// （宿主 LaunchService 按它核对父实例属于本引擎）。
	CreateRecord(ctx context.Context, appID, templateID string, values []FieldWrite, onBehalfOf Actor, parentWorkflowInstanceID, requestKey string) (recordID string, err error)
}

// Lease 编辑租约释放：改派 / 终止时原办理人若持有单据编辑租约，即刻释放，
// 原办理人页面收到阻断提示。释放失败由调用方只 warn、不回滚已经生效的管理动作。
type Lease interface {
	// ReleaseEditLease 释放 rec 上 holderUserID 持有的编辑租约；reason 是 REASSIGNED 或
	// TERMINATED（与 TaskWithdrawReason 同名同义，供宿主日志与前端阻断提示据此措辞）。
	// released=false 且 err=nil 表示这一刻他本来就没有持有租约（幂等，不算失败）。
	ReleaseEditLease(ctx context.Context, rec RecordRef, holderUserID int64, reason string) (released bool, err error)
}

// CatalogField 字段目录里的一条字段（绑定字段与传递字段判类型用）。DataType / TableRole 原值透传
// 宿主（不做人员/组织字段类型映射），退役档 boolean / date 也原样带回——是否放行由调用方
// （compile.bindingFieldTypeChecks）按正向白名单判定，本层不做特判。
type CatalogField struct {
	FieldID     string
	FieldName   string
	DataType    string
	DataTableID string
	TableRole   string
}

// FieldCatalog 发布期字段目录（绑定字段与传递字段类型闸用）：按模板列出全部字段与所属表角色，供发布期编译器
// 校验绑定字段类型。生产实现经 SDK 通用面 plugin.HostFrom(ctx).TemplateCatalog()（与 workflow
// 专用四客户端不同源，但同一条宿主 gRPC 连接），单测用 testkit.FakeFieldCatalog。
type FieldCatalog interface {
	ListFields(ctx context.Context, appID, templateID string) ([]CatalogField, error)
}

// DefinitionCatalog 发布期查「目标流程」状态用的账本薄封装：子流程
// 节点发布前要确认目标流程存在、已发布、未停用，还要拿它绑定的模板 id 去查目标字段目录——
// 这三件事都只需要 GetDefinition 的定义头（不需要版本清单），单独开一个窄接口而不是直接复用
// ports.Ledger，好让 compile 包不必知道账本的其余五本账。生产实现是 internal/app/app.go 里对
// hostclient.Ledger.GetDefinition 的一层薄封装（丢弃版本清单那个返回值），单测用
// testkit.FakeDefinitionCatalog。definitionID 查无此定义时返回 ErrNotFound（与 ports.Ledger
// 同一哨兵错误，hostclient 适配器原样透传）。
type DefinitionCatalog interface {
	GetDefinition(ctx context.Context, appID, definitionID string) (*pb.DefinitionRow, error)
}

// Clock 必须返回 UTC。
type Clock interface{ Now() time.Time }

// IDGen 生成账本主键（prefix：inst / step / task / inc / def / ver）。
type IDGen interface{ New(prefix string) string }
