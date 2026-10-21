package engineapp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/core"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
	"github.com/kimposoft/kimpo-workflow/internal/observability"
)

// 定义面（DefinitionService）：草稿并入定义行，发布一次一版，定义行 version_no 乐观锁。
// 删除不在引擎：宿主网关自查运行中实例数（DEFINITION_IN_USE）后直接删表行，引擎无需知情。

// DefinitionView 定义 + 版本清单。
type DefinitionView struct {
	Definition *pb.DefinitionRow
	Versions   []*pb.DefinitionVersionRow
}

// PublishResult 发布结果：Diagnostics 非空即被拒绝（PUBLISH_REJECTED），VersionNo 为 0。
type PublishResult struct {
	VersionNo   int64
	VersionID   string
	Diagnostics []model.Diagnostic
	Replayed    bool
}

func (s *Service) now() *timestamppb.Timestamp {
	if s.Clock == nil {
		return timestamppb.Now()
	}
	return timestamppb.New(s.Clock.Now().UTC())
}

func (s *Service) newID(prefix string) string {
	if s.IDs == nil {
		return prefix + "-" + strings.ReplaceAll(timestamppb.Now().AsTime().Format("20060102150405.000000000"), ".", "")
	}
	return s.IDs.New(prefix)
}

// defaultDraft 新建定义的初始草稿：只有一个发起节点（文档校验要求恰一个发起节点）。
func defaultDraft(templateID, name string) (string, error) {
	cfg, err := json.Marshal(model.StartConfig{TargetTemplateID: templateID, AllowManualStart: true})
	if err != nil {
		return "", err
	}
	doc := model.Document{Schema: model.SchemaVersion, Name: name, Nodes: []model.Node{{ID: "start", Kind: model.NodeKindStart, Config: cfg}}, Notify: model.DefaultNotifySettings()}
	raw, err := json.Marshal(doc)
	return string(raw), err
}

// definitionDigest 定义面动作的意图摘要：动作类型 + 定义 id（新建时用模板 id）+ 操作人 + 请求体要点。
func definitionDigest(action, target string, actorUserID int64, extra map[string]any) string {
	return requestDigest(action, target, actorUserID, extra)
}

// definitionOutcome 定义面动作的结果快照形状：只存 definition_id，重放时用它重新 GetDefinition
// 读当前状态（比另存一份 view 快照更不容易与账本实际状态失配）。
type definitionOutcome struct {
	DefinitionID string `json:"definition_id"`
}

// definitionReplayView 定义面动作命中重放：解码 outcome_json 拿 definition_id，重新读当前视图。
func (s *Service) definitionReplayView(ctx context.Context, meta Meta, found *ports.CommittedRequest, withDraft bool) (*DefinitionView, error) {
	var out definitionOutcome
	_ = json.Unmarshal([]byte(found.OutcomeJSON), &out)
	if out.DefinitionID == "" {
		out.DefinitionID = found.DefinitionID
	}
	return s.GetDefinition(ctx, meta, out.DefinitionID, withDraft)
}

// CreateDefinition 新建定义（enabled、未发布、草稿只有发起节点）。
func (s *Service) CreateDefinition(ctx context.Context, meta Meta, templateID, name string) (*DefinitionView, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	if strings.TrimSpace(templateID) == "" || strings.TrimSpace(name) == "" {
		return nil, invalidArgument("template_id and name are required")
	}
	digest := definitionDigest("CREATE_DEFINITION", templateID, meta.Actor.UserID, map[string]any{"name": strings.TrimSpace(name)})
	if found, hit, err := s.replayCheck(ctx, meta, "CREATE_DEFINITION", digest); err != nil {
		return nil, err
	} else if hit {
		return s.definitionReplayView(ctx, meta, found, true)
	}
	draft, err := defaultDraft(templateID, name)
	if err != nil {
		return nil, core.SystemErrorf("build default draft: %v", err)
	}
	now := s.now()
	row := &pb.DefinitionRow{
		DefinitionId: s.newID("def"), TemplateId: templateID, Name: strings.TrimSpace(name), StatusCode: string(model.DefinitionStatusEnabled),
		DraftJson: draft, DraftUpdatedAt: now, CreatedBy: meta.Actor.UserID, UpdatedBy: meta.Actor.UserID, CreatedAt: now, UpdatedAt: now, VersionNo: 1,
	}
	outcomeJSON, _ := json.Marshal(definitionOutcome{DefinitionID: row.GetDefinitionId()})
	result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON), Changeset: &pb.Changeset{DefinitionUpsert: row}})
	if err != nil {
		return nil, ledgerErr(err)
	}
	if !result.Applied {
		return s.definitionReplayView(ctx, meta, &ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON}, true)
	}
	return s.GetDefinition(ctx, meta, row.GetDefinitionId(), true)
}

// SaveDraft 保存草稿（不影响已发布版本）；expectedVersionNo 为定义行乐观锁，
// 必须 > 0（不允许传 0 跳过乐观锁，新建走 CreateDefinition，与本方法无关）。
func (s *Service) SaveDraft(ctx context.Context, meta Meta, definitionID, draftJSON string, expectedVersionNo int64) (*DefinitionView, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	if expectedVersionNo <= 0 {
		return nil, &core.Error{Code: "INVALID_ARGUMENT", Message: "expected_version_no must be > 0"}
	}
	doc, err := model.Decode([]byte(draftJSON))
	if err != nil {
		return nil, invalidArgument(err.Error())
	}
	digest := definitionDigest("SAVE_DRAFT", definitionID, meta.Actor.UserID, map[string]any{"draft_hash": sha256Hex(draftJSON), "expected_version_no": expectedVersionNo})
	if found, hit, err := s.replayCheck(ctx, meta, "SAVE_DRAFT", digest); err != nil {
		return nil, err
	} else if hit {
		return s.definitionReplayView(ctx, meta, found, true)
	}
	def, _, err := s.Ledger.GetDefinition(ctx, meta.AppID, definitionID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	if expectedVersionNo != def.GetVersionNo() {
		return nil, &core.Error{Code: "VERSION_CONFLICT", Message: "definition was modified by someone else"}
	}
	row := proto.Clone(def).(*pb.DefinitionRow)
	now := s.now()
	row.DraftJson, row.DraftUpdatedAt = draftJSON, now
	if strings.TrimSpace(doc.Name) != "" {
		row.Name = strings.TrimSpace(doc.Name)
	}
	row.UpdatedBy, row.UpdatedAt, row.VersionNo = meta.Actor.UserID, now, def.GetVersionNo()+1
	outcomeJSON, _ := json.Marshal(definitionOutcome{DefinitionID: definitionID})
	result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON), Changeset: &pb.Changeset{DefinitionUpsert: row}})
	if err != nil {
		return nil, ledgerErr(err)
	}
	if !result.Applied {
		return s.definitionReplayView(ctx, meta, &ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON, DefinitionID: definitionID}, true)
	}
	return s.GetDefinition(ctx, meta, definitionID, true)
}

// sha256Hex 供意图摘要纳入草稿正文（读写大 JSON 提醒：draftJSON 是设计器整份画布 JSON，这里只取其
// sha256 摘要参与请求键判重，不整份落进摘要或日志）。
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Validate 只做发布期检查（DryRun：不冻结、不落库）；draftJSON 空 = 用当前草稿。
func (s *Service) Validate(ctx context.Context, meta Meta, definitionID, draftJSON string, templatePublished bool) ([]model.Diagnostic, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	if s.Compiler == nil {
		return nil, core.SystemErrorf("compiler is not wired")
	}
	def, _, err := s.Ledger.GetDefinition(ctx, meta.AppID, definitionID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	if draftJSON == "" {
		draftJSON = def.GetDraftJson()
	}
	doc, err := model.Decode([]byte(draftJSON))
	if err != nil {
		return nil, invalidArgument(err.Error())
	}
	res, err := s.Compiler.Compile(ctx, compile.Input{Document: &doc, AppID: meta.AppID, TemplateID: def.GetTemplateId(), DefinitionID: definitionID,
		VersionNo: def.GetLatestVersionNo() + 1, TemplatePublished: templatePublished, DryRun: true})
	if err != nil {
		return nil, core.SystemErrorf("validate: %v", err)
	}
	return res.Diagnostics, nil
}

// Publish 发布：草稿编译（含冻结表达式）→ 新版本行 + 定义行 latest_version_no + 字段引用整体替换，一次 Commit。
// expectedVersionNo 必须 > 0（不允许传 0 跳过乐观锁）；重放不靠账本
// (definition_id, version_no) 唯一键兜底判定，而由请求日志（见下方 replayCheck）先行拦截，
// Commit 返回 applied=false 时也用回带的 outcome_json（而不是重新拉取「当前最新版本」，
// 在两人并发发布不同内容时会把对方的结果错当成自己的）。
func (s *Service) Publish(ctx context.Context, meta Meta, definitionID string, expectedVersionNo int64, templatePublished bool, serialFieldID string) (*PublishResult, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	if expectedVersionNo <= 0 {
		return nil, &core.Error{Code: "INVALID_ARGUMENT", Message: "expected_version_no must be > 0"}
	}
	if s.Compiler == nil {
		return nil, core.SystemErrorf("compiler is not wired")
	}
	digest := definitionDigest("PUBLISH", definitionID, meta.Actor.UserID, map[string]any{
		"expected_version_no": expectedVersionNo, "template_published": templatePublished, "serial_field_id": serialFieldID,
	})
	if found, hit, err := s.replayCheck(ctx, meta, "PUBLISH", digest); err != nil {
		return nil, err
	} else if hit {
		return decodePublishReplay(found), nil
	}
	def, _, err := s.Ledger.GetDefinition(ctx, meta.AppID, definitionID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	if expectedVersionNo != def.GetVersionNo() {
		return nil, &core.Error{Code: "VERSION_CONFLICT", Message: "definition was modified by someone else"}
	}
	doc, err := model.Decode([]byte(def.GetDraftJson()))
	if err != nil {
		return &PublishResult{Diagnostics: []model.Diagnostic{model.NewDiagnostic("NODE_CONFIG_INVALID", "", "", map[string]string{"message": err.Error()})}}, nil
	}
	versionNo := def.GetLatestVersionNo() + 1
	res, err := s.Compiler.Compile(ctx, compile.Input{Document: &doc, AppID: meta.AppID, TemplateID: def.GetTemplateId(), DefinitionID: definitionID,
		VersionNo: versionNo, TemplatePublished: templatePublished, SerialFieldID: serialFieldID})
	if err != nil {
		return nil, core.SystemErrorf("publish: %v", err)
	}
	if len(res.Diagnostics) > 0 {
		return &PublishResult{Diagnostics: res.Diagnostics}, nil
	}
	compiledJSON, err := res.Compiled.Encode()
	if err != nil {
		return nil, core.SystemErrorf("encode compiled definition: %v", err)
	}
	now := s.now()
	name := strings.TrimSpace(doc.Name)
	if name == "" {
		name = def.GetName()
	}
	version := &pb.DefinitionVersionRow{
		VersionId: s.newID("ver"), DefinitionId: definitionID, VersionNo: versionNo, TemplateId: def.GetTemplateId(), Name: name,
		AllowManualStart: allowManualStart(&doc), GraphJson: def.GetDraftJson(), CompiledJson: string(compiledJSON), PublishedBy: meta.Actor.UserID, PublishedAt: now,
	}
	row := proto.Clone(def).(*pb.DefinitionRow)
	row.Name, row.LatestVersionNo, row.UpdatedBy, row.UpdatedAt, row.VersionNo = name, versionNo, meta.Actor.UserID, now, def.GetVersionNo()+1
	refs := &pb.FieldRefReplace{DefinitionId: definitionID}
	for _, r := range res.FieldRefs {
		refs.Refs = append(refs.Refs, &pb.FieldRefRow{DefinitionId: definitionID, TemplateId: r.TemplateID, DataTableId: r.DataTableID, FieldId: r.FieldID, RefKind: r.RefKind, NodeId: r.NodeID, LinkId: r.LinkID})
	}
	outcomeJSON, _ := json.Marshal(publishOutcome{VersionNo: versionNo, VersionID: version.GetVersionId()})
	result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON),
		Changeset: &pb.Changeset{DefinitionUpsert: row, VersionUpserts: []*pb.DefinitionVersionRow{version}, FieldRefReplace: refs}})
	if err != nil {
		return nil, ledgerErr(err)
	}
	if !result.Applied {
		return decodePublishReplay(&ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON}), nil
	}
	return &PublishResult{VersionNo: versionNo, VersionID: version.GetVersionId()}, nil
}

// publishOutcome Publish 的结果快照形状（存 outcome_json，重放时原样回带，不用重新查账本）。
type publishOutcome struct {
	VersionNo int64  `json:"version_no"`
	VersionID string `json:"version_id"`
}

func decodePublishReplay(found *ports.CommittedRequest) *PublishResult {
	var out publishOutcome
	_ = json.Unmarshal([]byte(found.OutcomeJSON), &out)
	return &PublishResult{VersionNo: out.VersionNo, VersionID: out.VersionID, Replayed: true}
}

// allowManualStart 取发起节点的「允许人工发起」。
func allowManualStart(doc *model.Document) bool {
	for i := range doc.Nodes {
		if doc.Nodes[i].Kind == model.NodeKindStart {
			if cfg, err := model.StartConfigOf(&doc.Nodes[i]); err == nil {
				return cfg.AllowManualStart
			}
		}
	}
	return false
}

// SetEnabled 启用 / 停用（停用只拦新发起，运行中实例照走）。本方法不接收
// expectedVersionNo（调用方不追踪定义行版本号），基于「读到的 version_no」直接提交；命中
// VERSION_CONFLICT（别人在读写之间改了定义行）时重新读取一次并重试一次，不原样失败。
func (s *Service) SetEnabled(ctx context.Context, meta Meta, definitionID string, enabled bool) (*DefinitionView, error) {
	if err := s.check(meta); err != nil {
		return nil, err
	}
	digest := definitionDigest("SET_ENABLED", definitionID, meta.Actor.UserID, map[string]any{"enabled": enabled})
	if found, hit, err := s.replayCheck(ctx, meta, "SET_ENABLED", digest); err != nil {
		return nil, err
	} else if hit {
		return s.definitionReplayView(ctx, meta, found, false)
	}
	for attempt := 0; ; attempt++ {
		def, _, err := s.Ledger.GetDefinition(ctx, meta.AppID, definitionID)
		if err != nil {
			return nil, ledgerErr(err)
		}
		row := proto.Clone(def).(*pb.DefinitionRow)
		row.StatusCode = string(model.DefinitionStatusDisabled)
		if enabled {
			row.StatusCode = string(model.DefinitionStatusEnabled)
		}
		row.UpdatedBy, row.UpdatedAt, row.VersionNo = meta.Actor.UserID, s.now(), def.GetVersionNo()+1
		outcomeJSON, _ := json.Marshal(definitionOutcome{DefinitionID: definitionID})
		result, err := s.Ledger.Commit(ctx, meta.AppID, ports.CommitInput{RequestKey: meta.RequestKey, RequestDigest: digest, ActorUserID: meta.Actor.UserID, OutcomeJSON: string(outcomeJSON), Changeset: &pb.Changeset{DefinitionUpsert: row}})
		if err != nil {
			if errors.Is(err, ports.ErrVersionConflict) && attempt == 0 {
				observability.Logger(ctx).Info(ctx, "workflow", "engine", "workflow.engine.retry", "version conflict, retrying once", map[string]any{"request_key": meta.RequestKey})
				continue
			}
			return nil, ledgerErr(err)
		}
		if !result.Applied {
			return s.definitionReplayView(ctx, meta, &ports.CommittedRequest{OutcomeJSON: result.OutcomeJSON, DefinitionID: definitionID}, false)
		}
		return s.GetDefinition(ctx, meta, definitionID, false)
	}
}

// GetDefinition 定义 + 版本清单；withDraft=false 时不带草稿正文。
func (s *Service) GetDefinition(ctx context.Context, meta Meta, definitionID string, withDraft bool) (*DefinitionView, error) {
	if s.Ledger == nil {
		return nil, core.SystemErrorf("engine service is not wired")
	}
	def, versions, err := s.Ledger.GetDefinition(ctx, meta.AppID, definitionID)
	if err != nil {
		return nil, ledgerErr(err)
	}
	if !withDraft {
		def.DraftJson = ""
	}
	return &DefinitionView{Definition: def, Versions: versions}, nil
}

// ListDefinitions 定义清单。
func (s *Service) ListDefinitions(ctx context.Context, meta Meta, templateID string, includeDisabled bool) ([]*pb.DefinitionRow, error) {
	if s.Ledger == nil {
		return nil, core.SystemErrorf("engine service is not wired")
	}
	rows, err := s.Ledger.ListDefinitions(ctx, meta.AppID, templateID, includeDisabled)
	if err != nil {
		return nil, ledgerErr(err)
	}
	for _, r := range rows {
		r.DraftJson = ""
	}
	return rows, nil
}

// invalidArgument 入参非法：没有专属 WorkflowErrorCode，按 INVALID_CHOICE（transport 映 InvalidArgument）。
func invalidArgument(msg string) error {
	return &core.Error{Code: "INVALID_CHOICE", Message: msg}
}
