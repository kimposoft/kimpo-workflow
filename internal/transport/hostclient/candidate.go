package hostclient

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// Candidate 实现 ports.Candidate：把节点上的人员来源清单（设计器文档格式 []model.AssigneeSource）
// 翻译成宿主 CandidateService 的 PersonSource 并转发（各来源由宿主按组织目录计算）。
// 枚举以 proto 为准（USER | ROLE | ORG | FIELD | RELATION），设计器文档格式不改，映射只在本层。
type Candidate struct {
	testClient pb.CandidateServiceClient // 仅测试注入（同 Ledger.testClient 的理由）
}

// NewCandidate 构造候选适配器。
func NewCandidate() *Candidate { return &Candidate{} }

// NewCandidateForTest 仅测试用：注入假的 CandidateServiceClient。
func NewCandidateForTest(c pb.CandidateServiceClient) *Candidate { return &Candidate{testClient: c} }

func (c *Candidate) client(ctx context.Context) (pb.CandidateServiceClient, error) {
	if c.testClient != nil {
		return c.testClient, nil
	}
	host := plugin.WorkflowHostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("workflow host services")
	}
	cl := host.WorkflowCandidate()
	if cl == nil {
		return nil, errUnavailable("candidate client")
	}
	return cl, nil
}

// Resolve 见 ports.Candidate。sourcesJSON 为空时退回 staticUserIDs（USER 一种来源，兼容只带静态
// 用户的旧编译产物）。宿主报错一律折成 ports.ErrSystem（core 映 CANDIDATE_FAILED）；空集原样返回
// （C4 由 core 判定）。
func (c *Candidate) Resolve(ctx context.Context, rec ports.RecordRef, staticUserIDs []int64, sourcesJSON string, previousHandlers []int64) ([]ports.Person, error) {
	sources, err := SourcesToPB(staticUserIDs, sourcesJSON)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ports.ErrSystem, err)
	}
	if len(sources) == 0 {
		return nil, nil
	}
	cl, err := c.client(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := cl.Resolve(ctx, &pb.ResolveCandidatesRequest{
		AppId: rec.AppID, Record: recordRefPB(rec), Sources: sources, PreviousHandlerUserIds: previousHandlers,
	})
	if err != nil {
		return nil, fromStatus(err)
	}
	out := make([]ports.Person, 0, len(reply.GetCandidates()))
	for _, p := range reply.GetCandidates() {
		out = append(out, ports.Person{UserID: p.GetUserId(), DisplayName: p.GetDisplayName(), Notes: p.GetSourceNotes()})
	}
	return out, nil
}

// SourcesToPB 设计器来源清单 → 宿主 PersonSource（导出供单测表驱动）。
//   - user → USER(values = 用户 id 十进制)；role → ROLE(role_ids)；department → ORG(department_ids)；
//   - main_field → FIELD(values = [main_field_id], match_by display_name→username / login_name→login)；
//   - relation → RELATION(same_department→same_dept, parent_department→parent_dept, child_department→child_dept,
//     department_manager→dept_manager, parent_department_manager→parent_dept_manager)；
//   - initiator → 宿主协议没有这一档，跳过不翻译；调用方（engine/core 的
//     node_human.go / cc.go）到达节点时已经把实例发起人 id 并入 staticUserIDs 一并传进来，
//     这里把它当成一条补充的 USER 来源译出（见下方 hasInitiator 收尾），与其余来源取并集。
//
// 未知来源 / 匹配方式 / 关系档报错（发布期已拒，运行期遇到说明编译产物损坏）。
func SourcesToPB(staticUserIDs []int64, sourcesJSON string) ([]*pb.PersonSource, error) {
	var sources []model.AssigneeSource
	if sourcesJSON != "" {
		if err := json.Unmarshal([]byte(sourcesJSON), &sources); err != nil {
			return nil, fmt.Errorf("sources_json invalid: %v", err)
		}
	}
	if len(sources) == 0 && len(staticUserIDs) > 0 {
		sources = []model.AssigneeSource{{Kind: model.AssigneeSourceUser, UserIDs: staticUserIDs}}
	}
	out := make([]*pb.PersonSource, 0, len(sources))
	// hasInitiator：来源清单里是否含 initiator 档；knownUserIDs：已经由某个 Kind=user 来源译出过
	// 的用户 id，用来给下面的「发起人补一条 USER 来源」去重——staticUserIDs 里既可能是调用方
	// 并入的发起人 id，也可能恰好与某条 Kind=user 来源重复（发起人自己也被直接选中），不能
	// 无条件整段照搬，否则同一个人会被拆成两条 USER 来源，重复派发任务。
	hasInitiator := false
	knownUserIDs := map[int64]bool{}
	for _, s := range sources {
		switch s.Kind {
		case model.AssigneeSourceUser:
			ps := &pb.PersonSource{SourceKind: "USER"}
			for _, id := range s.UserIDs {
				if id != 0 {
					ps.Values = append(ps.Values, strconv.FormatInt(id, 10))
					knownUserIDs[id] = true
				}
			}
			if len(ps.Values) > 0 {
				out = append(out, ps)
			}
		case model.AssigneeSourceInitiator:
			hasInitiator = true
		case model.AssigneeSourceRole:
			if len(s.RoleIDs) > 0 {
				out = append(out, &pb.PersonSource{SourceKind: "ROLE", Values: s.RoleIDs})
			}
		case model.AssigneeSourceDepartment:
			if len(s.DepartmentIDs) > 0 {
				out = append(out, &pb.PersonSource{SourceKind: "ORG", Values: s.DepartmentIDs})
			}
		case model.AssigneeSourceMainField:
			matchBy := ""
			switch s.MatchBy {
			case model.AssigneeMatchByDisplayName:
				matchBy = "username"
			case model.AssigneeMatchByLoginName:
				matchBy = "login"
			default:
				return nil, fmt.Errorf("main_field match_by %q unsupported", s.MatchBy)
			}
			if s.MainFieldID == "" {
				return nil, fmt.Errorf("main_field source without field id")
			}
			out = append(out, &pb.PersonSource{SourceKind: "FIELD", Values: []string{s.MainFieldID}, MatchBy: matchBy})
		case model.AssigneeSourceRelation:
			rel := ""
			switch s.Relation {
			case model.AssigneeRelationSameDept:
				rel = "same_dept"
			case model.AssigneeRelationParentDept:
				rel = "parent_dept"
			case model.AssigneeRelationChildDept:
				rel = "child_dept"
			case model.AssigneeRelationDeptManager:
				rel = "dept_manager"
			case model.AssigneeRelationParentDeptMgr:
				rel = "parent_dept_manager"
			default:
				return nil, fmt.Errorf("relation %q unsupported", s.Relation)
			}
			out = append(out, &pb.PersonSource{SourceKind: "RELATION", Relation: rel})
		default:
			return nil, fmt.Errorf("assignee source kind %q unsupported", s.Kind)
		}
	}
	if hasInitiator {
		// 把 staticUserIDs 里还没被上面任何 Kind=user 来源覆盖到的 id（即调用方并入的发起人）
		// 另起一条 USER 来源补上；「只有 initiator 一条」时 knownUserIDs 是空的，效果等同用
		// 整份 staticUserIDs 兜底（与旧行为一致，见上面 len(sources)==0 的分支）。
		var extra []string
		for _, id := range staticUserIDs {
			if id != 0 && !knownUserIDs[id] {
				extra = append(extra, strconv.FormatInt(id, 10))
				knownUserIDs[id] = true
			}
		}
		if len(extra) > 0 {
			out = append(out, &pb.PersonSource{SourceKind: "USER", Values: extra})
		}
	}
	return out, nil
}

var _ ports.Candidate = (*Candidate)(nil)
