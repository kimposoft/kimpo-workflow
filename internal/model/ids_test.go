package model

import (
	"encoding/json"
	"reflect"
	"testing"
)

// 19 位宿主用户 id 经字符串往返不丢精度，数字与字符串混写都能解码。
func TestIDList_RoundTripKeepsPrecision(t *testing.T) {
	var l IDList
	if err := json.Unmarshal([]byte(`[1970000000000000001, "1970000000000000002", " 3 "]`), &l); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := IDList{1970000000000000001, 1970000000000000002, 3}
	if !reflect.DeepEqual(l, want) {
		t.Fatalf("got %v want %v", l, want)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != `["1970000000000000001","1970000000000000002","3"]` {
		t.Fatalf("marshal got %s", raw)
	}
}

func TestIDList_RejectsNonDecimal(t *testing.T) {
	for _, bad := range []string{`["abc"]`, `[""]`, `[1.5]`, `{"a":1}`} {
		var l IDList
		if err := json.Unmarshal([]byte(bad), &l); err == nil {
			t.Fatalf("%s should fail", bad)
		}
	}
}

// 新形状四组全取（含 N1.8 主表字段来源）；旧形状按 kind 只取对应一组，main_field 现在也
// 正确读入（此前落进 default 分支被当留空丢弃）；全空视为留空。
func TestStartGrant_NewAndLegacyShapes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want StartGrant
	}{
		{"new", `{"user_ids":["11"],"role_ids":["r1"],"department_ids":["d1"]}`, StartGrant{UserIDs: IDList{11}, RoleIDs: []string{"r1"}, DepartmentIDs: []string{"d1"}}},
		{"new-with-main-field", `{"user_ids":["11"],"main_field_id":"f-owner","match_by":"login_name"}`, StartGrant{UserIDs: IDList{11}, MainFieldID: "f-owner", MatchBy: AssigneeMatchByLoginName}},
		{"legacy-user", `{"kind":"user","user_ids":[22],"role_ids":["ignored"]}`, StartGrant{UserIDs: IDList{22}}},
		{"legacy-role", `{"kind":"role","role_ids":["r2"]}`, StartGrant{RoleIDs: []string{"r2"}}},
		{"legacy-dept", `{"kind":"department","department_ids":["d2"]}`, StartGrant{DepartmentIDs: []string{"d2"}}},
		// 旧形状 kind=main_field 现在正确读入 main_field_id/match_by。
		{"legacy-main-field", `{"kind":"main_field","main_field_id":"f-owner","match_by":"display_name"}`, StartGrant{MainFieldID: "f-owner", MatchBy: AssigneeMatchByDisplayName}},
		{"legacy-other", `{"kind":"relation","relation":"same_department"}`, StartGrant{}},
		{"empty", `{}`, StartGrant{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var g StartGrant
			if err := json.Unmarshal([]byte(c.raw), &g); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if !reflect.DeepEqual(g, c.want) {
				t.Fatalf("got %+v want %+v", g, c.want)
			}
			if g.IsEmpty() != c.want.IsEmpty() {
				t.Fatalf("IsEmpty mismatch")
			}
		})
	}
	// 只配了主表字段来源（不配用户/角色/部门）不算空——发起权限的第四种来源单独就能
	// 判定「有人能发起」，不需要另外配别的来源垫底。
	if (StartGrant{MainFieldID: "f-owner"}).IsEmpty() {
		t.Fatal("只配主表字段来源不该算空")
	}
	raw, _ := json.Marshal(StartGrant{UserIDs: IDList{1970000000000000001}, RoleIDs: []string{"r"}})
	if string(raw) != `{"user_ids":["1970000000000000001"],"role_ids":["r"]}` {
		t.Fatalf("marshal got %s", raw)
	}
}
