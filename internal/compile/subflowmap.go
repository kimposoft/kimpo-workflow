package compile

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// subflowmap.go 是「目标流程存在 / 同应用 / 已发布」与「传递字段的来源与目标类型须相同，
// 或目标为文本」两道发布期后端闸。节点校验（node/subflow.go）只能做不依赖外部数据的检查
// （同一张扩展表、不等待必填处置、末级只能不等待）；这两道闸要用到字段目录
// （ports.FieldCatalog，同 fieldtype.go）与账本定义目录（ports.DefinitionCatalog），所以放在编译器里。
//
// 与绑定字段类型闸同款判据结构：目录 / 账本调用失败即 Compile 整体返回 error（发布失败，不静默放行）；
// definitions 或 catalog 任一为 nil 时整段跳过（仅允许单测这么用，见 Compiler.definitions /
// Compiler.catalog 字段注释）。DryRun（Validate）与正式发布同一条代码路径，天然同闸。
const (
	targetNotPublishedCode   = "K3_TARGET_NOT_PUBLISHED"
	mappingSourceInvalidCode = "N6_MAPPING_SOURCE_INVALID"
	mappingTargetInvalidCode = "N6_MAPPING_TARGET_INVALID"
	mappingTypeMismatchCode  = "N6_MAPPING_TYPE_MISMATCH"
)

// retiredMappingTargetTypes 已退役的字段 data_type：目标字段是这两档时一律拒绝，即便来源字段
// 恰好是同一个已退役类型（发布期不能放行任何新链路把退役类型纳入可换算 / 可引用范围）——
// 退役判据以宿主为准，插件是独立 module 拿不到宿主的判定函数，本表与 fieldtype.go 同一份口径，
// 以免两处判据分叉。
var retiredMappingTargetTypes = map[string]bool{"boolean": true, "date": true}

// catalogFieldIndex 把字段目录列表按 field_id 建索引，供 subflowMappingChecks 反复查找。
func catalogFieldIndex(fields []ports.CatalogField) map[string]ports.CatalogField {
	out := make(map[string]ports.CatalogField, len(fields))
	for _, f := range fields {
		out[f.FieldID] = f
	}
	return out
}

// subflowMappingChecks 遍历文档里的全部子流程节点，逐条校验目标流程状态与传递字段类型。definitions 或
// catalog 为 nil 时整段跳过；文档里没有子流程节点时不发起任何账本 / 目录调用。
//
// 两级缓存：defCache 按 target_workflow_id 缓存账本 GetDefinition 结果（多个子流程节点指向
// 同一个已失效目标时，只报一次账本错误、不重复调用）；fieldsCache 按 template_id 缓存字段
// 目录（本模板只查一次；多个子流程节点指向同一目标模板时，目标模板字段目录也只查一次）。
func (c *Compiler) subflowMappingChecks(ctx context.Context, appID, templateID string, doc *model.Document) ([]model.Diagnostic, error) {
	if c.definitions == nil || c.catalog == nil {
		return nil, nil
	}

	var diags []model.Diagnostic
	defCache := map[string]*subflowTargetDef{}
	fieldsCache := map[string]map[string]ports.CatalogField{}
	var ownFields map[string]ports.CatalogField
	ownFieldsLoaded := false

	loadFields := func(cacheKey string) (map[string]ports.CatalogField, error) {
		if f, ok := fieldsCache[cacheKey]; ok {
			return f, nil
		}
		list, err := c.catalog.ListFields(ctx, appID, cacheKey)
		if err != nil {
			return nil, fmt.Errorf("compile: subflow mapping list fields of template %s: %w", cacheKey, err)
		}
		idx := catalogFieldIndex(list)
		fieldsCache[cacheKey] = idx
		return idx, nil
	}
	loadOwnFields := func() (map[string]ports.CatalogField, error) {
		if ownFieldsLoaded {
			return ownFields, nil
		}
		idx, err := loadFields(templateID)
		if err != nil {
			return nil, err
		}
		ownFields, ownFieldsLoaded = idx, true
		return ownFields, nil
	}

	for i := range doc.Nodes {
		n := &doc.Nodes[i]
		if n.Kind != model.NodeKindSubflow {
			continue
		}
		cfg, err := model.SubflowConfigOf(n)
		if err != nil {
			// 配置本身解不开，node/subflow.go 的 Handler.Validate 已经报 NODE_CONFIG_INVALID，
			// 这里没有可校验的字段，直接跳过这个节点。
			continue
		}
		if cfg.TargetWorkflowID == "" {
			// node/subflow.go 已报 N6_TARGET_REQUIRED，没有目标流程无从校验起。
			continue
		}

		def, err := c.subflowTargetDefinition(ctx, appID, cfg.TargetWorkflowID, defCache)
		if err != nil {
			return nil, err
		}
		if reason := def.rejectReason(); reason != "" {
			diags = append(diags, model.NewDiagnostic(targetNotPublishedCode, n.ID, "", map[string]string{
				"target_workflow_id": cfg.TargetWorkflowID, "reason": reason,
			}))
			continue
		}
		if len(cfg.FieldMappings) == 0 {
			continue
		}

		own, err := loadOwnFields()
		if err != nil {
			return nil, err
		}
		targetFields, err := loadFields(def.templateID)
		if err != nil {
			return nil, err
		}
		diags = append(diags, subflowMappingFieldChecks(n.ID, cfg.FieldMappings, own, targetFields)...)
	}
	return diags, nil
}

// subflowTargetDef 是 GetDefinition 结果的最小摘要：K3 判定 + 目标模板 id，缓存值用指针存
// 「查无此定义」这个负结果本身也要缓存（missing 时 templateID 留空，rejectReason 恒非空）。
type subflowTargetDef struct {
	found      bool
	published  bool
	enabled    bool
	templateID string
}

func (d *subflowTargetDef) rejectReason() string {
	switch {
	case !d.found:
		return "missing"
	case !d.published:
		return "unpublished"
	case !d.enabled:
		return "disabled"
	default:
		return ""
	}
}

// subflowTargetDefinition 查一个目标流程的定义头，按 defCache 去重（同一目标只查一次账本）。
func (c *Compiler) subflowTargetDefinition(ctx context.Context, appID, definitionID string, defCache map[string]*subflowTargetDef) (*subflowTargetDef, error) {
	if cached, ok := defCache[definitionID]; ok {
		return cached, nil
	}
	row, err := c.definitions.GetDefinition(ctx, appID, definitionID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			d := &subflowTargetDef{found: false}
			defCache[definitionID] = d
			return d, nil
		}
		return nil, fmt.Errorf("compile: K3 get target definition %s: %w", definitionID, err)
	}
	d := &subflowTargetDef{
		found:      true,
		published:  row.GetLatestVersionNo() > 0,
		enabled:    row.GetStatusCode() == string(model.DefinitionStatusEnabled),
		templateID: row.GetTemplateId(),
	}
	defCache[definitionID] = d
	return d, nil
}

// subflowMappingFieldChecks 校验一个子流程节点的传递字段清单：来源字段所属表须与
// SourceTableID 一致、目标字段须是目标模板主表字段、两者类型须相同或目标为文本。
func subflowMappingFieldChecks(nodeID string, mappings []model.SubflowFieldMapping, own, target map[string]ports.CatalogField) []model.Diagnostic {
	var diags []model.Diagnostic
	for _, m := range mappings {
		if m.TargetFieldID == "" {
			// node/subflow.go 已报 N6_MAPPING_TARGET_REQUIRED，没有目标字段无从比类型。
			continue
		}
		srcField, srcOK := checkSourceMapping(nodeID, m, own, &diags)
		tgtField, tgtOK := checkTargetMapping(nodeID, m, target, &diags)
		if !srcOK || !tgtOK {
			continue
		}
		if mappingTypeMismatch(srcField.DataType, tgtField.DataType) {
			diags = append(diags, model.NewDiagnostic(mappingTypeMismatchCode, nodeID, "", map[string]string{
				"source_field_id": m.SourceFieldID, "target_field_id": m.TargetFieldID,
				"source_type": srcField.DataType, "target_type": tgtField.DataType,
			}))
		}
	}
	return diags
}

// checkSourceMapping 校验一条映射的来源字段：SourceFieldID 必须在本模板目录里存在，且所属表
// 与 SourceTableID 一致——SourceTableID=="" 时该字段必须是主表字段；非空时必须是扩展表字段
// 且 DataTableID 与 SourceTableID 相同。刻意把「主表 id 被当成扩展表 id 写进 SourceTableID」
// 单独标一个 reason（main_table_id_as_detail）：这是背景里点出的真实画法，运行期
// engine/core/subflow.go 的 subflowParams 会把它当扩展表查、查出零行，编译期在这里先拦住。
func checkSourceMapping(nodeID string, m model.SubflowFieldMapping, own map[string]ports.CatalogField, diags *[]model.Diagnostic) (ports.CatalogField, bool) {
	if m.SourceFieldID == "" {
		return ports.CatalogField{}, false
	}
	f, ok := own[m.SourceFieldID]
	if !ok {
		*diags = append(*diags, model.NewDiagnostic(mappingSourceInvalidCode, nodeID, "", map[string]string{
			"source_field_id": m.SourceFieldID, "reason": "missing",
		}))
		return ports.CatalogField{}, false
	}
	isMain := strings.EqualFold(f.TableRole, "main")
	switch {
	case m.SourceTableID == "" && !isMain:
		*diags = append(*diags, model.NewDiagnostic(mappingSourceInvalidCode, nodeID, "", map[string]string{
			"source_field_id": m.SourceFieldID, "reason": "not_main",
		}))
		return f, false
	case m.SourceTableID != "" && isMain:
		*diags = append(*diags, model.NewDiagnostic(mappingSourceInvalidCode, nodeID, "", map[string]string{
			"source_field_id": m.SourceFieldID, "source_table_id": m.SourceTableID, "reason": "main_table_id_as_detail",
		}))
		return f, false
	case m.SourceTableID != "" && f.DataTableID != m.SourceTableID:
		*diags = append(*diags, model.NewDiagnostic(mappingSourceInvalidCode, nodeID, "", map[string]string{
			"source_field_id": m.SourceFieldID, "source_table_id": m.SourceTableID, "reason": "table_mismatch",
		}))
		return f, false
	}
	return f, true
}

// checkTargetMapping 校验一条映射的目标字段：TargetFieldID 必须在目标模板目录里存在，且是
// 目标模板的主表字段（子流程只能写目标单据主表，同结果绑定 / 结束标识写入字段的口径）。
func checkTargetMapping(nodeID string, m model.SubflowFieldMapping, target map[string]ports.CatalogField, diags *[]model.Diagnostic) (ports.CatalogField, bool) {
	f, ok := target[m.TargetFieldID]
	if !ok {
		*diags = append(*diags, model.NewDiagnostic(mappingTargetInvalidCode, nodeID, "", map[string]string{
			"target_field_id": m.TargetFieldID, "reason": "missing",
		}))
		return ports.CatalogField{}, false
	}
	if !strings.EqualFold(f.TableRole, "main") {
		*diags = append(*diags, model.NewDiagnostic(mappingTargetInvalidCode, nodeID, "", map[string]string{
			"target_field_id": m.TargetFieldID, "reason": "not_main",
		}))
		return f, false
	}
	return f, true
}

// mappingTypeMismatch 类型闸：目标为已退役类型一律拒绝；否则来源类型与目标类型相同放行，
// 目标为 text 放行（任意类型都能转文本），其余情况拒绝。
func mappingTypeMismatch(sourceType, targetType string) bool {
	if retiredMappingTargetTypes[targetType] {
		return true
	}
	if strings.EqualFold(targetType, "text") {
		return false
	}
	return sourceType != targetType
}
