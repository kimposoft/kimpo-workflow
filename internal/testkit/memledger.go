// Package testkit 是引擎单测 / 端到端假宿主：内存账本（实现 ports.Ledger，含 CAS 与 request_key 幂等，
// 语义对齐宿主账本）、假表达式 / 候选 / 单据 / 时钟 / id 生成器。
// 引擎单测不起宿主；真库只测宿主账本与投影。
package testkit

import (
	"context"
	"fmt"
	"sync"

	"google.golang.org/protobuf/proto"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// requestLogEntry 请求日志一行（与宿主 workflow_request_log 同语义）——
// 按 (app_id, request_key) 记首次提交的摘要 / 操作人 / 结果快照，供 Commit 幂等判定与 FindCommit 读出。
type requestLogEntry struct {
	Digest             string
	ActorUserID        int64
	WorkflowInstanceID string
	DefinitionID       string
	InstanceVersion    int64
	OutcomeJSON        string
}

// MemLedger 内存账本。
type MemLedger struct {
	mu          sync.Mutex
	Definitions map[string]*pb.DefinitionRow
	Versions    map[string][]*pb.DefinitionVersionRow // definition_id → 按 version_no
	Instances   map[string]*pb.InstanceRow
	Steps       map[string]*pb.StepRow
	Tasks       map[string]*pb.TaskRow
	Incidents   map[string]*pb.IncidentRow
	// Ccs 抄送行；Links 父子链接行。
	Ccs       map[string]*pb.CcRow
	Links     map[string]*pb.LinkRow
	Outbox    []*pb.OutboxRow
	FieldRefs map[string][]*pb.FieldRefRow
	Commits   int
	// RequestLog 按 "app_id\x00request_key" 存请求日志。
	RequestLog map[string]requestLogEntry
}

// NewMemLedger 构造空账本。
func NewMemLedger() *MemLedger {
	return &MemLedger{Definitions: map[string]*pb.DefinitionRow{}, Versions: map[string][]*pb.DefinitionVersionRow{}, Instances: map[string]*pb.InstanceRow{},
		Steps: map[string]*pb.StepRow{}, Tasks: map[string]*pb.TaskRow{}, Incidents: map[string]*pb.IncidentRow{},
		Ccs: map[string]*pb.CcRow{}, Links: map[string]*pb.LinkRow{}, FieldRefs: map[string][]*pb.FieldRefRow{},
		RequestLog: map[string]requestLogEntry{}}
}

func requestLogKey(appID, requestKey string) string { return appID + "\x00" + requestKey }

func (m *MemLedger) GetDefinition(_ context.Context, _ string, definitionID string) (*pb.DefinitionRow, []*pb.DefinitionVersionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.Definitions[definitionID]
	if !ok {
		return nil, nil, ports.ErrNotFound
	}
	var vs []*pb.DefinitionVersionRow
	for _, v := range m.Versions[definitionID] {
		vs = append(vs, proto.Clone(v).(*pb.DefinitionVersionRow))
	}
	return proto.Clone(d).(*pb.DefinitionRow), vs, nil
}

func (m *MemLedger) ListDefinitions(_ context.Context, _ string, templateID string, includeDisabled bool) ([]*pb.DefinitionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*pb.DefinitionRow
	for _, d := range m.Definitions {
		if templateID != "" && d.GetTemplateId() != templateID {
			continue
		}
		if !includeDisabled && d.GetStatusCode() != "enabled" {
			continue
		}
		out = append(out, proto.Clone(d).(*pb.DefinitionRow))
	}
	return out, nil
}

func (m *MemLedger) GetVersion(_ context.Context, _ string, definitionID string, versionNo int64) (*pb.DefinitionVersionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *pb.DefinitionVersionRow
	for _, v := range m.Versions[definitionID] {
		if versionNo > 0 && v.GetVersionNo() == versionNo {
			return proto.Clone(v).(*pb.DefinitionVersionRow), nil
		}
		if versionNo == 0 && (best == nil || v.GetVersionNo() > best.GetVersionNo()) {
			best = v
		}
	}
	if best == nil {
		return nil, ports.ErrNotFound
	}
	return proto.Clone(best).(*pb.DefinitionVersionRow), nil
}

func (m *MemLedger) aggregate(inst *pb.InstanceRow) *pb.InstanceAggregate {
	agg := &pb.InstanceAggregate{Instance: proto.Clone(inst).(*pb.InstanceRow)}
	for _, s := range m.Steps {
		if s.GetWorkflowInstanceId() == inst.GetWorkflowInstanceId() {
			agg.Steps = append(agg.Steps, proto.Clone(s).(*pb.StepRow))
		}
	}
	for i := 0; i < len(agg.Steps); i++ { // 按 seq 升序
		for j := i + 1; j < len(agg.Steps); j++ {
			if agg.Steps[j].GetSeqNo() < agg.Steps[i].GetSeqNo() {
				agg.Steps[i], agg.Steps[j] = agg.Steps[j], agg.Steps[i]
			}
		}
	}
	for _, t := range m.Tasks {
		if t.GetWorkflowInstanceId() == inst.GetWorkflowInstanceId() {
			agg.Tasks = append(agg.Tasks, proto.Clone(t).(*pb.TaskRow))
		}
	}
	for _, i := range m.Incidents {
		if i.GetWorkflowInstanceId() == inst.GetWorkflowInstanceId() {
			agg.Incidents = append(agg.Incidents, proto.Clone(i).(*pb.IncidentRow))
		}
	}
	for _, c := range m.Ccs {
		if c.GetWorkflowInstanceId() == inst.GetWorkflowInstanceId() {
			agg.Ccs = append(agg.Ccs, proto.Clone(c).(*pb.CcRow))
		}
	}
	for _, l := range m.Links {
		if l.GetParentWorkflowInstanceId() == inst.GetWorkflowInstanceId() {
			agg.Links = append(agg.Links, proto.Clone(l).(*pb.LinkRow))
		}
	}
	for _, v := range m.Versions[inst.GetDefinitionId()] {
		if v.GetVersionNo() == inst.GetVersionNo() {
			agg.Version = proto.Clone(v).(*pb.DefinitionVersionRow)
		}
	}
	return agg
}

func (m *MemLedger) LoadInstanceByID(_ context.Context, _ string, id string) (*pb.InstanceAggregate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst, ok := m.Instances[id]
	if !ok {
		return nil, ports.ErrNotFound
	}
	return m.aggregate(inst), nil
}

func (m *MemLedger) LoadInstanceByRecord(_ context.Context, _ string, recordID string) (*pb.InstanceAggregate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, inst := range m.Instances {
		if inst.GetRecordId() == recordID {
			return m.aggregate(inst), nil
		}
	}
	return nil, ports.ErrNotFound
}

func (m *MemLedger) LoadInstanceByTask(_ context.Context, _ string, taskID string) (*pb.InstanceAggregate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.Tasks[taskID]
	if !ok {
		return nil, ports.ErrNotFound
	}
	inst, ok := m.Instances[t.GetWorkflowInstanceId()]
	if !ok {
		return nil, ports.ErrNotFound
	}
	return m.aggregate(inst), nil
}

// LoadParentOfChild 按子实例反查父实例。
func (m *MemLedger) LoadParentOfChild(_ context.Context, _ string, childInstanceID string) (*pb.InstanceAggregate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.Links {
		if l.GetChildWorkflowInstanceId() != childInstanceID {
			continue
		}
		if inst, ok := m.Instances[l.GetParentWorkflowInstanceId()]; ok {
			return m.aggregate(inst), nil
		}
	}
	return nil, ports.ErrNotFound
}

func (m *MemLedger) LoadInstanceByIncident(_ context.Context, _ string, incidentID string) (*pb.InstanceAggregate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	inc, ok := m.Incidents[incidentID]
	if !ok {
		return nil, ports.ErrNotFound
	}
	inst, ok := m.Instances[inc.GetWorkflowInstanceId()]
	if !ok {
		return nil, ports.ErrNotFound
	}
	return m.aggregate(inst), nil
}

// Commit 与宿主 Commit 事务规约同一语义：
//
//	⓪ 先按 (app_id, request_key) 查请求日志：命中且摘要 / 操作人都相同 → applied=false，回带首次的
//	   outcome_json / instance_version，什么都不写；命中但摘要或操作人不同 → ErrRequestKeyReused。
//	① 定义行乐观锁：version_no 必须恰为 当前+1，否则一律 VERSION_CONFLICT（不再把「相等」当重放，
//	   重放只按请求键判）；新建（无当前行）时 version_no 缺省 1。
//	② 实例行 CAS：expected_version==0 新建，撞 record_id 唯一键 → ErrRecordHasInstance；
//	   否则必须等于当前 version，否则 VERSION_CONFLICT（重放同样只按请求键判，不看 version 是否相等）。
//	提交成功后同事务写一行请求日志（除了「只返回选路 / 选人对话框、没有变更集」的调用——那种调用
//	engineapp 根本不会来 Commit，本方法自然也不会记）。
func (m *MemLedger) Commit(_ context.Context, appID string, in ports.CommitInput) (ports.CommitResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Commits++
	cs := in.Changeset
	if cs == nil {
		return ports.CommitResult{}, fmt.Errorf("nil changeset")
	}
	logKey := requestLogKey(appID, in.RequestKey)
	if entry, ok := m.RequestLog[logKey]; ok {
		if entry.Digest == in.RequestDigest && entry.ActorUserID == in.ActorUserID {
			return ports.CommitResult{Applied: false, InstanceVersion: entry.InstanceVersion, OutcomeJSON: entry.OutcomeJSON}, nil
		}
		return ports.CommitResult{}, fmt.Errorf("%w: app %s request_key %s", ports.ErrRequestKeyReused, appID, in.RequestKey)
	}
	if d := cs.GetDefinitionUpsert(); d != nil {
		row := proto.Clone(d).(*pb.DefinitionRow)
		if cur, ok := m.Definitions[row.GetDefinitionId()]; ok {
			if row.GetVersionNo() != cur.GetVersionNo()+1 {
				return ports.CommitResult{}, fmt.Errorf("%w: definition %s version_no %d, current %d", ports.ErrVersionConflict, row.GetDefinitionId(), row.GetVersionNo(), cur.GetVersionNo())
			}
		} else if row.GetVersionNo() <= 0 {
			row.VersionNo = 1
		}
		m.Definitions[row.GetDefinitionId()] = row
	}
	for _, v := range cs.GetVersionUpserts() {
		dup := false
		for _, old := range m.Versions[v.GetDefinitionId()] {
			if old.GetVersionNo() == v.GetVersionNo() {
				dup = true
			}
		}
		if dup && cs.GetInstance() == nil {
			return ports.CommitResult{}, nil
		}
		if !dup {
			m.Versions[v.GetDefinitionId()] = append(m.Versions[v.GetDefinitionId()], proto.Clone(v).(*pb.DefinitionVersionRow))
		}
	}
	if fr := cs.GetFieldRefReplace(); fr != nil {
		m.FieldRefs[fr.GetDefinitionId()] = fr.GetRefs()
	}
	var newVersion int64
	var instanceID, definitionID string
	if iw := cs.GetInstance(); iw != nil && iw.GetRow() != nil {
		row := proto.Clone(iw.GetRow()).(*pb.InstanceRow)
		instanceID = row.GetWorkflowInstanceId()
		if iw.GetExpectedVersion() == 0 {
			for _, inst := range m.Instances {
				if inst.GetRecordId() == row.GetRecordId() {
					return ports.CommitResult{}, ports.ErrRecordHasInstance
				}
			}
			newVersion = 1
		} else {
			cur, ok := m.Instances[row.GetWorkflowInstanceId()]
			if !ok {
				return ports.CommitResult{}, ports.ErrNotFound
			}
			if cur.GetVersion() != iw.GetExpectedVersion() {
				return ports.CommitResult{}, fmt.Errorf("%w: expected %d current %d", ports.ErrVersionConflict, iw.GetExpectedVersion(), cur.GetVersion())
			}
			newVersion = cur.GetVersion() + 1
		}
		row.Version, row.LastRequestKey = newVersion, in.RequestKey
		m.Instances[row.GetWorkflowInstanceId()] = row
		for _, s := range cs.GetStepUpserts() {
			m.Steps[s.GetStepId()] = proto.Clone(s).(*pb.StepRow)
		}
		for _, t := range cs.GetTaskUpserts() {
			m.Tasks[t.GetTaskId()] = proto.Clone(t).(*pb.TaskRow)
		}
		for _, i := range cs.GetIncidentUpserts() {
			m.Incidents[i.GetIncidentId()] = proto.Clone(i).(*pb.IncidentRow)
		}
		for _, c := range cs.GetCcUpserts() {
			m.Ccs[c.GetCcId()] = proto.Clone(c).(*pb.CcRow)
		}
		for _, l := range cs.GetLinkUpserts() {
			m.Links[l.GetLinkId()] = proto.Clone(l).(*pb.LinkRow)
		}
		for _, id := range cs.GetLinkDeleteIds() {
			delete(m.Links, id)
		}
		for i, o := range cs.GetOutboxAppends() {
			row := proto.Clone(o).(*pb.OutboxRow)
			row.Seq, row.Ordinal, row.RequestKey, row.WorkflowInstanceId = newVersion, int32(i), in.RequestKey, iw.GetRow().GetWorkflowInstanceId()
			m.Outbox = append(m.Outbox, row)
		}
	}
	if d := cs.GetDefinitionUpsert(); d != nil {
		definitionID = d.GetDefinitionId()
	}
	if in.RequestKey != "" {
		m.RequestLog[logKey] = requestLogEntry{Digest: in.RequestDigest, ActorUserID: in.ActorUserID, WorkflowInstanceID: instanceID, DefinitionID: definitionID, InstanceVersion: newVersion, OutcomeJSON: in.OutcomeJSON}
	}
	return ports.CommitResult{Applied: true, InstanceVersion: newVersion, OutcomeJSON: in.OutcomeJSON}, nil
}

// FindCommit 按 (app_id, request_key) 查请求日志；未命中返回 (nil, nil)。
func (m *MemLedger) FindCommit(_ context.Context, appID, requestKey string) (*ports.CommittedRequest, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.RequestLog[requestLogKey(appID, requestKey)]
	if !ok {
		return nil, nil
	}
	return &ports.CommittedRequest{RequestDigest: entry.Digest, ActorUserID: entry.ActorUserID, WorkflowInstanceID: entry.WorkflowInstanceID,
		DefinitionID: entry.DefinitionID, InstanceVersion: entry.InstanceVersion, OutcomeJSON: entry.OutcomeJSON}, nil
}

// OutboxKinds 某实例发件箱 kind 序列（测试断言用）。
func (m *MemLedger) OutboxKinds(instanceID string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, o := range m.Outbox {
		if o.GetWorkflowInstanceId() == instanceID {
			out = append(out, fmt.Sprintf("%d/%s", o.GetSeq(), o.GetKind()))
		}
	}
	return out
}
