package hostclient

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// fakeCandidateServiceClient 仅测试用：记录请求、回放预设回复。
type fakeCandidateServiceClient struct {
	req   *pb.ResolveCandidatesRequest
	reply *pb.ResolveCandidatesReply
	err   error
}

func (f *fakeCandidateServiceClient) Resolve(_ context.Context, req *pb.ResolveCandidatesRequest, _ ...grpc.CallOption) (*pb.ResolveCandidatesReply, error) {
	f.req = req
	return f.reply, f.err
}

// TestSourcesToPB_Mapping：设计器五种来源 → proto 枚举的映射表驱动（枚举以 proto 为准，文档格式不改）。
func TestSourcesToPB_Mapping(t *testing.T) {
	cases := []struct {
		name    string
		static  []int64
		sources string
		want    []string // "KIND|values|match_by|relation"
		wantErr string
	}{
		{"user", nil, `[{"kind":"user","user_ids":[11,0,22]}]`, []string{"USER|11,22||"}, ""},
		{"role", nil, `[{"kind":"role","role_ids":["r1","r2"]}]`, []string{"ROLE|r1,r2||"}, ""},
		{"department", nil, `[{"kind":"department","department_ids":["d1"]}]`, []string{"ORG|d1||"}, ""},
		{"field display", nil, `[{"kind":"main_field","main_field_id":"f-rev","match_by":"display_name"}]`, []string{"FIELD|f-rev|username|"}, ""},
		{"field login", nil, `[{"kind":"main_field","main_field_id":"f-rev","match_by":"login_name"}]`, []string{"FIELD|f-rev|login|"}, ""},
		{"relation same", nil, `[{"kind":"relation","relation":"same_department"}]`, []string{"RELATION|||same_dept"}, ""},
		{"relation parent", nil, `[{"kind":"relation","relation":"parent_department"}]`, []string{"RELATION|||parent_dept"}, ""},
		{"relation child", nil, `[{"kind":"relation","relation":"child_department"}]`, []string{"RELATION|||child_dept"}, ""},
		{"relation manager", nil, `[{"kind":"relation","relation":"department_manager"}]`, []string{"RELATION|||dept_manager"}, ""},
		{"relation parent manager", nil, `[{"kind":"relation","relation":"parent_department_manager"}]`, []string{"RELATION|||parent_dept_manager"}, ""},
		{"static fallback", []int64{5, 6}, "", []string{"USER|5,6||"}, ""},
		{"order kept", nil, `[{"kind":"department","department_ids":["d1"]},{"kind":"user","user_ids":[1]}]`, []string{"ORG|d1||", "USER|1||"}, ""},
		// 宿主协议没有 initiator 这一档，跳过不翻译；只有
		// initiator 一条时，落到与「sourcesJSON 为空」同样的 USER 兜底，把调用方
		// （engine/core node_human.go / cc.go）已经并入 staticUserIDs 的发起人 id 译出。
		{"initiator alone", []int64{9}, `[{"kind":"initiator"}]`, []string{"USER|9||"}, ""},
		// initiator + 其他来源：两者并集——角色单独一条 ROLE 来源，发起人另起一条 USER 来源。
		{"initiator plus role", []int64{9}, `[{"kind":"initiator"},{"kind":"role","role_ids":["r1"]}]`, []string{"ROLE|r1||", "USER|9||"}, ""},
		// initiator + 同一个人也被直接选中：发起人 id 已经在 Kind=user 来源里译出过，不重复补一条。
		{"initiator dedup with user", []int64{9}, `[{"kind":"initiator"},{"kind":"user","user_ids":[9]}]`, []string{"USER|9||"}, ""},
		// initiator 且 staticUserIDs 为空（发起人 id 为 0 的防御场景，调用方不会并入）：跳过后
		// 没有任何来源可译，PB 来源为空。
		{"initiator without static ids", nil, `[{"kind":"initiator"}]`, nil, ""},
		{"unknown kind", nil, `[{"kind":"magic"}]`, nil, "unsupported"},
		{"unknown match_by", nil, `[{"kind":"main_field","main_field_id":"f","match_by":"email"}]`, nil, "unsupported"},
		{"unknown relation", nil, `[{"kind":"relation","relation":"cousin"}]`, nil, "unsupported"},
		{"bad json", nil, `{`, nil, "invalid"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := SourcesToPB(c.static, c.sources)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var lines []string
			for _, s := range got {
				lines = append(lines, s.GetSourceKind()+"|"+strings.Join(s.GetValues(), ",")+"|"+s.GetMatchBy()+"|"+s.GetRelation())
			}
			if strings.Join(lines, ";") != strings.Join(c.want, ";") {
				t.Fatalf("got %v want %v", lines, c.want)
			}
		})
	}
}

// TestCandidate_ResolveForwardsAndMapsErrors：请求带单据 / 来源 / 前手；回复映成 ports.Person；
// 宿主 CANDIDATE_FAILED → ports.ErrSystem（core 映 CANDIDATE_FAILED）；空集原样返回。
func TestCandidate_ResolveForwardsAndMapsErrors(t *testing.T) {
	fc := &fakeCandidateServiceClient{reply: &pb.ResolveCandidatesReply{Candidates: []*pb.Person{
		{UserId: 22, DisplayName: "王芳", SourceNotes: []string{`{"code":"candidate.note.department","params":{"department_name":"采购部"}}`}},
	}}}
	c := NewCandidateForTest(fc)
	rec := ports.RecordRef{AppID: "app", TemplateID: "tpl", RecordID: "rec"}
	people, err := c.Resolve(context.Background(), rec, nil, `[{"kind":"department","department_ids":["d1"]}]`, []int64{1})
	if err != nil || len(people) != 1 || people[0].UserID != 22 || people[0].DisplayName != "王芳" || len(people[0].Notes) != 1 {
		t.Fatalf("people = %+v err %v", people, err)
	}
	if fc.req.GetAppId() != "app" || fc.req.GetRecord().GetRecordId() != "rec" || len(fc.req.GetSources()) != 1 || fc.req.GetSources()[0].GetSourceKind() != "ORG" || fc.req.GetPreviousHandlerUserIds()[0] != 1 {
		t.Fatalf("request = %+v", fc.req)
	}
	// 空集不是错误。
	fc.reply = &pb.ResolveCandidatesReply{}
	people, err = c.Resolve(context.Background(), rec, nil, `[{"kind":"relation","relation":"same_department"}]`, nil)
	if err != nil || len(people) != 0 {
		t.Fatalf("empty: %+v err %v", people, err)
	}
	// 宿主失败 → ErrSystem。
	fc.err = status.Error(codes.Internal, "CANDIDATE_FAILED: directory unavailable")
	if _, err = c.Resolve(context.Background(), rec, nil, `[{"kind":"user","user_ids":[1]}]`, nil); !errors.Is(err, ports.ErrSystem) {
		t.Fatalf("err = %v", err)
	}
	// 没有任何来源：不调宿主，直接空集。
	fc.req = nil
	if people, err = c.Resolve(context.Background(), rec, nil, "", nil); err != nil || len(people) != 0 || fc.req != nil {
		t.Fatalf("no sources: %+v err %v req %v", people, err, fc.req)
	}
	// 编译产物损坏 → ErrSystem。
	if _, err = c.Resolve(context.Background(), rec, nil, `[{"kind":"magic"}]`, nil); !errors.Is(err, ports.ErrSystem) {
		t.Fatalf("err = %v", err)
	}
}
