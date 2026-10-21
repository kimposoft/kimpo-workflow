package core

import (
	"encoding/json"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// initiator_source.go 是『人员来源』档位「发起人」在
// 引擎侧的落地：这一档在宿主 CandidateService 协议里没有对应枚举（谁是发起人只有引擎自己
// 知道，编译产物里存不下），所以不走 compile 期摊平（K3 的 staticUserIDsAndSources 不认它，
// 见 compile/kinds.go），只能在运行期就地取值。
//
// 到达办理 / 审批（node_human.go）与抄送（cc.go）两处都要在调 e.Candidate.Resolve 之前做同一件
// 事——把实例发起人 id 并入 staticUserIDs，交给 hostclient.Candidate.SourcesToPB 走既有的
// USER 来源那条路兜底翻译——抽成这个小 helper 两处共用，不重复实现。

// withInitiatorSource 若 sourcesJSON（NodeCompiled.SourcesJSON）里含一条 kind=="initiator"
// 的来源，把实例发起人 starterUserID 并入 staticUserIDs 后返回（去重）；否则原样返回该切片，
// 不分配新的底层数组。starterUserID 为 0（拿不到发起人，理论上不会发生，防御性判断）时不并入。
func withInitiatorSource(staticUserIDs []int64, sourcesJSON string, starterUserID int64) []int64 {
	if sourcesJSON == "" || starterUserID == 0 {
		return staticUserIDs
	}
	var sources []model.AssigneeSource
	if err := json.Unmarshal([]byte(sourcesJSON), &sources); err != nil {
		// 编译产物损坏交给下游 Resolve → SourcesToPB 报错，这里不重复处理。
		return staticUserIDs
	}
	hasInitiator := false
	for _, s := range sources {
		if s.Kind == model.AssigneeSourceInitiator {
			hasInitiator = true
			break
		}
	}
	if !hasInitiator {
		return staticUserIDs
	}
	for _, id := range staticUserIDs {
		if id == starterUserID {
			return staticUserIDs // 已经在里面，不重复并入
		}
	}
	out := make([]int64, 0, len(staticUserIDs)+1)
	out = append(out, staticUserIDs...)
	out = append(out, starterUserID)
	return out
}
