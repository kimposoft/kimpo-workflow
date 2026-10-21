package hostclient

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// Record 实现 ports.Record：转发宿主 RecordServiceClient（经宿主表单数据层写单据字段并保存 / 读记录头）。
type Record struct{}

// NewRecord 构造单据适配器。
func NewRecord() *Record { return &Record{} }

func (r *Record) client(ctx context.Context) (pb.RecordServiceClient, error) {
	host := plugin.WorkflowHostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("workflow host services")
	}
	c := host.WorkflowRecord()
	if c == nil {
		return nil, errUnavailable("record client")
	}
	return c, nil
}

// WriteFields 写字段（结束标识，以及审批结果 / 理由 / 回退清空）。写入越过字段权限
// （引擎动作是系统行为），actor 只记操作人。
func (r *Record) WriteFields(ctx context.Context, rec ports.RecordRef, writes []ports.FieldWrite, reason string, actor ports.Actor, requestKey string) error {
	c, err := r.client(ctx)
	if err != nil {
		return err
	}
	// 带上所属流程实例，宿主据此核对归属。
	req := &pb.WriteFieldsRequest{Record: recordRefPB(rec), Reason: reason, Actor: actorRefPB(actor), RequestKey: requestKey, WorkflowInstanceId: rec.WorkflowInstanceID}
	for _, w := range writes {
		req.Writes = append(req.Writes, &pb.FieldWrite{FieldId: w.FieldID, TextValue: w.TextValue, Clear: w.Clear})
	}
	if _, err := c.WriteFields(ctx, req); err != nil {
		return fromStatus(err)
	}
	return nil
}

// Header 读记录头（H2 默认摘要末尾的自动编号值）。
func (r *Record) Header(ctx context.Context, rec ports.RecordRef, serialFieldID string) (bool, string, error) {
	c, err := r.client(ctx)
	if err != nil {
		return false, "", err
	}
	reply, err := c.GetRecordHeader(ctx, &pb.GetRecordHeaderRequest{Record: recordRefPB(rec), SerialFieldId: serialFieldID, WorkflowInstanceId: rec.WorkflowInstanceID})
	if err != nil {
		return false, "", fromStatus(err)
	}
	return reply.GetExists(), reply.GetSerialValue(), nil
}

// ReadFields 读主表字段与一张扩展表的全部行（子流程 N6.1）。
func (r *Record) ReadFields(ctx context.Context, in ports.ReadFieldsInput) (ports.ReadFieldsResult, error) {
	c, err := r.client(ctx)
	if err != nil {
		return ports.ReadFieldsResult{}, err
	}
	reply, err := c.ReadFields(ctx, &pb.ReadFieldsRequest{
		Record: recordRefPB(in.Record), MainFieldIds: in.MainFieldIDs,
		DetailTableId: in.DetailTableID, DetailFieldIds: in.DetailFieldIDs,
		WorkflowInstanceId: in.Record.WorkflowInstanceID,
	})
	if err != nil {
		return ports.ReadFieldsResult{}, fromStatus(err)
	}
	out := ports.ReadFieldsResult{Exists: reply.GetExists()}
	for _, v := range reply.GetMainValues() {
		out.MainValues = append(out.MainValues, fieldValueOf(v))
	}
	for _, row := range reply.GetDetailRows() {
		r := ports.DetailRow{RecordID: row.GetRecordId()}
		for _, v := range row.GetValues() {
			r.Values = append(r.Values, fieldValueOf(v))
		}
		out.DetailRows = append(out.DetailRows, r)
	}
	return out, nil
}

func fieldValueOf(v *pb.FieldValue) ports.FieldValue {
	return ports.FieldValue{FieldID: v.GetFieldId(), TextValue: v.GetTextValue(), IsNull: v.GetIsNull()}
}

var _ ports.Record = (*Record)(nil)
