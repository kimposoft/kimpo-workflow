package compile

import (
	"context"
	"fmt"
	"strings"

	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// fieldtype.go 是绑定字段类型的发布期后端闸：结果绑定字段、
// 理由绑定字段（审批节点，RefKindApproveBind）与结束标识写入字段（结束节点，
// RefKindEndLabelTarget）只允许主表文本字段。字段类型在发布期之前没有别处把关——设计器面板
// （frontend/src/designer/panels/shared/MainFieldSelect.vue）只是把选择范围提前收窄到主表，
// 不能替代后端闸（前端可绕过）；
// node/approve.go 与 node/end.go 的 Validate 不做这项检查，因为节点校验拿不到字段目录。
//
// 判据是**正向白名单**：data_type == "text" 且 table_role 为 main（大小写不敏感，跟宿主
// 一样宽松）。逐字对齐设计器 MainFieldSelect.vue 的 `f.data_type === props.dataType`
// （=== 'text'）过滤口径，两处必须一致，否则会出现「设计器选得出、发布拒」或反过来的落差。已退役的
// boolean / date 字段类型不在白名单内，自然落在拒绝侧——退役判据以宿主为准，插件是独立
// module，拿不到宿主的判定函数，这里按同一口径自行列出。
const fieldTypeUnsupportedCode = "FIELD_TYPE_UNSUPPORTED"

// isFieldTypeCheckedRef 判定一条字段引用是否受绑定字段类型闸约束：只看「值会被引擎写回单据」的绑定
// 字段，其余引用种类（字段权限、回退清空、抄送文本等）不受约束。
func isFieldTypeCheckedRef(kind string) bool {
	return kind == RefKindApproveBind || kind == RefKindEndLabelTarget
}

// bindingFieldTypeChecks 是 K4 后端闸：从 refs 里挑出待检的绑定字段引用，查一次字段目录，
// 逐条判类型。catalog 为 nil 时直接跳过（仅允许单测这么用，见 Compiler.catalog 字段注释）；
// 目录调用失败时返回 error（发布失败，不静默放行——宁可拒绝发布也不能带着未知类型的绑定
// 字段上线）。
func (c *Compiler) bindingFieldTypeChecks(ctx context.Context, appID, templateID string, refs []FieldRef) ([]model.Diagnostic, error) {
	if c.catalog == nil {
		return nil, nil
	}
	var checked []FieldRef
	for _, r := range refs {
		if isFieldTypeCheckedRef(r.RefKind) {
			checked = append(checked, r)
		}
	}
	if len(checked) == 0 {
		return nil, nil
	}
	fields, err := c.catalog.ListFields(ctx, appID, templateID)
	if err != nil {
		return nil, fmt.Errorf("compile: K4 list fields: %w", err)
	}
	byID := make(map[string]struct{ dataType, tableRole string }, len(fields))
	for _, f := range fields {
		byID[f.FieldID] = struct{ dataType, tableRole string }{f.DataType, f.TableRole}
	}
	var out []model.Diagnostic
	for _, r := range checked {
		got, ok := byID[r.FieldID]
		if !ok {
			out = append(out, model.NewDiagnostic(fieldTypeUnsupportedCode, r.NodeID, "", map[string]string{
				"field_id": r.FieldID, "reason": "missing",
			}))
			continue
		}
		if !strings.EqualFold(got.tableRole, "main") || got.dataType != "text" {
			out = append(out, model.NewDiagnostic(fieldTypeUnsupportedCode, r.NodeID, "", map[string]string{
				"field_id": r.FieldID, "data_type": got.dataType, "table_role": got.tableRole,
			}))
		}
	}
	return out, nil
}
