package hostclient

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// Expression 实现 ports.Expression（运行期求值）与 compile.Freezer（发布期冻结），
// 都转发宿主 ExpressionServiceClient（宿主 V4 表达式发布物）。
type Expression struct{}

// NewExpression 构造表达式适配器。
func NewExpression() *Expression { return &Expression{} }

func (e *Expression) client(ctx context.Context) (pb.ExpressionServiceClient, error) {
	host := plugin.WorkflowHostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("workflow host services")
	}
	c := host.WorkflowExpression()
	if c == nil {
		return nil, errUnavailable("expression client")
	}
	return c, nil
}

// EvaluateCondition 判断类求值（引导线条件 L12 / 自动办理 F7）。
func (e *Expression) EvaluateCondition(ctx context.Context, rec ports.RecordRef, publicationID, documentJSON string, actor ports.Actor) (bool, error) {
	c, err := e.client(ctx)
	if err != nil {
		return false, err
	}
	reply, err := c.EvaluateCondition(ctx, &pb.EvaluateRequest{
		PublicationId: publicationID,
		Record:        recordRefPB(rec),
		Actor:         actorRefPB(actor),
		DocumentJson:  documentJSON,
	})
	if err != nil {
		return false, fromStatus(err)
	}
	return reply.GetResult(), nil
}

// EvaluateComputed 计算类求值（步骤摘要 H1 / 抄送标题正文）。空值约定：回复的 Diagnostic 里
// 出现一条 code=="NULL" 即结果为空（null=true），文本按空串处理。
func (e *Expression) EvaluateComputed(ctx context.Context, rec ports.RecordRef, publicationID, documentJSON string, actor ports.Actor) (string, bool, error) {
	c, err := e.client(ctx)
	if err != nil {
		return "", false, err
	}
	reply, err := c.EvaluateComputed(ctx, &pb.EvaluateRequest{
		PublicationId: publicationID,
		Record:        recordRefPB(rec),
		Actor:         actorRefPB(actor),
		DocumentJson:  documentJSON,
	})
	if err != nil {
		return "", false, fromStatus(err)
	}
	for _, d := range reply.GetDiagnostics() {
		if d.GetCode() == "NULL" {
			return "", true, nil
		}
	}
	return reply.GetText(), false, nil
}

// Freeze 发布期冻结（compile.Freezer）：一批表达式一次性交给宿主，逐条回填发布物 id 与
// 引用到的字段（供 X3 字段引用登记）；宿主回报的 issues 原样搬成 model.Diagnostic。
func (e *Expression) Freeze(ctx context.Context, in compile.FreezeInput) (compile.FreezeOutput, error) {
	c, err := e.client(ctx)
	if err != nil {
		return compile.FreezeOutput{}, err
	}
	req := &pb.FreezeRequest{AppId: in.AppID, TemplateId: in.TemplateID, DefinitionId: in.DefinitionID, VersionNo: in.VersionNo}
	for _, sp := range in.Specs {
		req.Specs = append(req.Specs, &pb.ExpressionSpec{ExpressionId: sp.ExpressionID, Purpose: purposePB(sp.Purpose), DocumentJson: sp.DocumentJSON})
	}
	reply, err := c.Freeze(ctx, req)
	if err != nil {
		return compile.FreezeOutput{}, fromStatus(err)
	}
	var out compile.FreezeOutput
	for _, d := range reply.GetDiagnostics() {
		out.Issues = append(out.Issues, diagnosticFromPB(d))
	}
	for _, f := range reply.GetFrozen() {
		fe := compile.FrozenExpression{ExpressionID: f.GetExpressionId(), PublicationID: f.GetPublicationId()}
		for _, r := range f.GetReferencedFields() {
			// FrozenExpression.referenced_fields 按 proto 注释只填 data_table_id / field_id。
			fe.ReferencedFields = append(fe.ReferencedFields, compile.FieldRef{DataTableID: r.GetDataTableId(), FieldID: r.GetFieldId()})
		}
		out.Frozen = append(out.Frozen, fe)
	}
	return out, nil
}

// purposePB 把 compile.ExpressionPurpose 转成宿主枚举；未识别一律 UNSPECIFIED（不 panic）。
func purposePB(p compile.ExpressionPurpose) pb.ExpressionPurpose {
	switch p {
	case compile.PurposeJudge:
		return pb.ExpressionPurpose_JUDGE
	case compile.PurposeValue:
		return pb.ExpressionPurpose_VALUE
	case compile.PurposeCompute:
		return pb.ExpressionPurpose_COMPUTE
	default:
		return pb.ExpressionPurpose_EXPRESSION_PURPOSE_UNSPECIFIED
	}
}

func recordRefPB(rec ports.RecordRef) *pb.RecordRef {
	return &pb.RecordRef{AppId: rec.AppID, TemplateId: rec.TemplateID, RecordId: rec.RecordID}
}

func actorRefPB(actor ports.Actor) *pb.ActorRef {
	return &pb.ActorRef{UserId: actor.UserID, DisplayName: actor.DisplayName, IsSuperAdmin: actor.SuperAdmin}
}

func diagnosticFromPB(d *pb.Diagnostic) model.Diagnostic {
	return model.Diagnostic{Code: d.GetCode(), MessageKey: d.GetMessageKey(), NodeID: d.GetNodeId(), LinkID: d.GetLinkId(), Arguments: d.GetArguments()}
}

var (
	_ ports.Expression = (*Expression)(nil)
	_ compile.Freezer  = (*Expression)(nil)
)
