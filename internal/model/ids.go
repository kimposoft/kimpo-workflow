package model

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// IDList 是宿主用户 id 列表。
//
// 宿主用户 id 是 19 位整数，浏览器把它当 JSON 数字序列化必丢精度，SDK 选人结果本就用
// 十进制字符串（PickedUser.user_id）。因此：
//   - 解码同时接受数字与十进制字符串（早期经 API 灌入的定义是数字，继续可读）；
//   - 编码一律输出字符串数组，设计器读回不丢精度。
//
// 底层仍是 []int64，引擎内部（StaticUserIDs、候选映射）直接当 []int64 用，无需转换。
type IDList []int64

// MarshalJSON 输出十进制字符串数组；nil 输出 null（配合 omitempty 省略）。
func (l IDList) MarshalJSON() ([]byte, error) {
	if l == nil {
		return []byte("null"), nil
	}
	out := make([]string, len(l))
	for i, id := range l {
		out[i] = strconv.FormatInt(id, 10)
	}
	return json.Marshal(out)
}

// UnmarshalJSON 接受 [1, "2", …] 混写；空串元素与非数字字符串报错（不静默丢人）。
func (l *IDList) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		*l = nil
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return fmt.Errorf("user id list must be an array: %w", err)
	}
	out := make(IDList, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(string(item))
		if strings.HasPrefix(text, `"`) {
			var s string
			if err := json.Unmarshal(item, &s); err != nil {
				return fmt.Errorf("user id %s invalid: %w", text, err)
			}
			text = strings.TrimSpace(s)
		}
		id, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return fmt.Errorf("user id %q is not a decimal integer", text)
		}
		out = append(out, id)
	}
	*l = out
	return nil
}

// StartGrant 是发起节点的发起权限（用户、角色、部门、主表字段四种来源，取并集）。
//
// 四组取并集；全空 = 留空，除超级管理员外无人可发起。宿主发起目录
// 按同一口径解析编译产物 start_permission_json；
// 主表字段这一档要读单据才能判定，真判逻辑在宿主侧（填报层）实现，本插件只登记
// 结构（MainFieldID/MatchBy）与字段引用（见 compile/kind_start.go）。
type StartGrant struct {
	UserIDs       IDList   `json:"user_ids,omitempty"`
	RoleIDs       []string `json:"role_ids,omitempty"`
	DepartmentIDs []string `json:"department_ids,omitempty"`
	// MainFieldID / MatchBy 第四种来源：目标模板主表的一个字段。字段内容按英文逗号拆成多个值，
	// 每个值按「用户名」或「登录名」匹配一个人；匹配依据二选一，取值口径与『人员来源』人员来源的
	// 主表字段档（AssigneeSource.MainFieldID/MatchBy）完全相同。
	MainFieldID string          `json:"main_field_id,omitempty"`
	MatchBy     AssigneeMatchBy `json:"match_by,omitempty"`
}

// IsEmpty 四组都没配（主表字段来源也算一种来源，配了就不算空）。
func (g StartGrant) IsEmpty() bool {
	return len(g.UserIDs) == 0 && len(g.RoleIDs) == 0 && len(g.DepartmentIDs) == 0 && g.MainFieldID == ""
}

// UnmarshalJSON 兼容早期的旧形状 {kind, user_ids|role_ids|department_ids|main_field_id|match_by}：
// 旧形状只有一个 kind，按 kind 只取对应那一组（与旧判定口径一致，多写的组忽略）；
// 新形状（无 kind）四组全取。
func (g *StartGrant) UnmarshalJSON(raw []byte) error {
	var wire struct {
		Kind          string          `json:"kind"`
		UserIDs       IDList          `json:"user_ids"`
		RoleIDs       []string        `json:"role_ids"`
		DepartmentIDs []string        `json:"department_ids"`
		MainFieldID   string          `json:"main_field_id"`
		MatchBy       AssigneeMatchBy `json:"match_by"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return err
	}
	*g = StartGrant{}
	switch strings.TrimSpace(wire.Kind) {
	case "":
		g.UserIDs, g.RoleIDs, g.DepartmentIDs = wire.UserIDs, wire.RoleIDs, wire.DepartmentIDs
		g.MainFieldID, g.MatchBy = wire.MainFieldID, wire.MatchBy
	case string(AssigneeSourceUser):
		g.UserIDs = wire.UserIDs
	case string(AssigneeSourceRole):
		g.RoleIDs = wire.RoleIDs
	case string(AssigneeSourceDepartment):
		g.DepartmentIDs = wire.DepartmentIDs
	case string(AssigneeSourceMainField):
		// 主表字段来源现在对发起权限有意义，正确读入
		// main_field_id/match_by——此前落进 default 分支，被当「留空」丢弃。
		g.MainFieldID, g.MatchBy = wire.MainFieldID, wire.MatchBy
	default:
		// 旧形状里其它 kind（关系）对发起权限无意义，按留空处理。
	}
	return nil
}
