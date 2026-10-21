package node

import "github.com/kimposoft/kimpo-workflow/internal/model"

// assignee_rules.go 是办理与审批共用的发布期校验：两类节点的「人员来源」与
// 「办理方式」本就是同一套通用件（审批只是叫法不同），实现必须只有一份——两处各写一份迟早会
// 漂移，同一件事两处各判一次，口径不一致就等于规则不存在。

// validateAssigneeSources 校验『人员来源』+『过滤器：与上步处理人的关系』：来源至少配一种；每种来源自己的必填项不空；来源档位、匹配方式两处枚举必须在闭集内；
// 过滤器取值也要落在五档闭集内（复用 A_SOURCE_UNSUPPORTED，不新开码——过滤器与来源共用同一份
// 『人员来源』通用件取值表，只是引用的位置不同）。filters 由调用方传 cfg.RelationFilters，经
// model.HandleConfigOf 等解码入口归一化后，正常情况下 sources 里已经不会再出现 relation 条目
// ；下面 case model.AssigneeSourceRelation 分支仍然保留——防御旧编译产物直连或归一化
// 逻辑本身出 bug 的极端情况，不因为「理论上见不到」就删掉这道闸。
func validateAssigneeSources(nodeID string, sources []model.AssigneeSource, filters []model.AssigneeRelation) []model.Diagnostic {
	var out []model.Diagnostic
	if len(sources) == 0 {
		if len(filters) > 0 {
			// 只配了过滤器没配来源，发布拒绝；用新码代替
			// A1_SOURCE_REQUIRED，两者不同时报——过滤器不是「未配来源」，是「配错了顺序」。
			return append(out, model.NewDiagnostic("A1_FILTER_WITHOUT_SOURCE", nodeID, "", nil))
		}
		return append(out, model.NewDiagnostic("A1_SOURCE_REQUIRED", nodeID, "", nil))
	}
	for _, src := range sources {
		switch src.Kind {
		case model.AssigneeSourceUser:
			if len(src.UserIDs) == 0 {
				out = append(out, model.NewDiagnostic("A1_SOURCE_EMPTY", nodeID, "", nil))
			}
		case model.AssigneeSourceRole:
			if len(src.RoleIDs) == 0 {
				out = append(out, model.NewDiagnostic("A1_SOURCE_EMPTY", nodeID, "", nil))
			}
		case model.AssigneeSourceDepartment:
			if len(src.DepartmentIDs) == 0 {
				out = append(out, model.NewDiagnostic("A1_SOURCE_EMPTY", nodeID, "", nil))
			}
		case model.AssigneeSourceMainField:
			if src.MainFieldID == "" {
				out = append(out, model.NewDiagnostic("A1_SOURCE_EMPTY", nodeID, "", nil))
			}
			if src.MatchBy != model.AssigneeMatchByDisplayName && src.MatchBy != model.AssigneeMatchByLoginName {
				out = append(out, model.NewDiagnostic("A_SOURCE_UNSUPPORTED", nodeID, "", map[string]string{"kind": string(src.Kind), "match_by": string(src.MatchBy)}))
			}
		case model.AssigneeSourceRelation:
			switch src.Relation {
			case model.AssigneeRelationSameDept, model.AssigneeRelationParentDept, model.AssigneeRelationChildDept,
				model.AssigneeRelationDeptManager, model.AssigneeRelationParentDeptMgr:
			default:
				out = append(out, model.NewDiagnostic("A_SOURCE_UNSUPPORTED", nodeID, "", map[string]string{"kind": string(src.Kind), "relation": string(src.Relation)}))
			}
		case model.AssigneeSourceInitiator:
			// 不用配任何参数：没有必填项要查，也不产 A1_SOURCE_EMPTY。
		default:
			out = append(out, model.NewDiagnostic("A_SOURCE_UNSUPPORTED", nodeID, "", map[string]string{"kind": string(src.Kind)}))
		}
	}
	// 过滤器取值闭集校验（A3 五档），与上面 relation 来源那一分支共用同一张取值表、同一个码。
	for _, f := range filters {
		switch f {
		case model.AssigneeRelationSameDept, model.AssigneeRelationParentDept, model.AssigneeRelationChildDept,
			model.AssigneeRelationDeptManager, model.AssigneeRelationParentDeptMgr:
		default:
			out = append(out, model.NewDiagnostic("A_SOURCE_UNSUPPORTED", nodeID, "", map[string]string{"kind": "relation_filter", "relation": string(f)}))
		}
	}
	return out
}

// validateCompleteMode 校验『办理方式』：三档都支持（任一、按比例、「全部/会签」，后者不看
// 百分比）；按比例的百分比必须落在 1~100（存的是万分比，1%~100% 即 100~10000），越界按
// 配置错拒绝——0% 意味着无人办理即过关，100% 以上永远过不了关，两种都是把流程配死。
func validateCompleteMode(nodeID string, mode model.CompleteMode) []model.Diagnostic {
	switch mode.Kind {
	case "", model.CompleteModeAny:
		return nil
	case model.CompleteModeAll:
		// 「全部完成 / 会签」档语义等同比例 100%，但不看 PercentageBP，不对它做范围校验——
		// 以后改比例定义时这一档不会跟着漂。
		return nil
	case model.CompleteModePercentage:
		bp := mode.PercentageBP
		if bp == 0 {
			// 不填按 100%（全部同意）处理，与「百分比默认 100%」的规则一致。
			return nil
		}
		if bp < 100 || bp > 10000 {
			return []model.Diagnostic{model.NewDiagnostic("D_RATIO_OUT_OF_RANGE", nodeID, "", map[string]string{"percentage_bp": itoa(bp)})}
		}
		return nil
	default:
		return []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", nodeID, "", map[string]string{"message": "complete_mode.kind 未知"})}
	}
}

// itoa 是给诊断参数用的极小整数转字符串（避免为一行诊断引入 strconv 之外的依赖层次）。
func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [12]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
