package hostclient

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// Launch 实现 ports.Launch：转发宿主 LaunchServiceClient（子流程 N6.1 / N6.3 的建单那一半）。
//
// 为什么建单在宿主、发起在引擎：单据是宿主的东西（模板、字段、默认值、自动编号、校验全在那边），
// 引擎只知道「把这几个值写进目标模板」；而发起一个实例是引擎自己的状态机动作，跟人工发起走的
// 是同一条 Engine.Start，不需要宿主再造一条。
type Launch struct{}

// NewLaunch 构造发起通道适配器。
func NewLaunch() *Launch { return &Launch{} }

func (l *Launch) client(ctx context.Context) (pb.LaunchServiceClient, error) {
	host := plugin.WorkflowHostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("workflow host services")
	}
	c := host.WorkflowLaunch()
	if c == nil {
		return nil, errUnavailable("launch client")
	}
	return c, nil
}

// CreateRecord 按传递字段新建目标流程的单据；parentWorkflowInstanceID 是发起它的父流程实例
// （宿主按它核对父实例属于本引擎）。
func (l *Launch) CreateRecord(ctx context.Context, appID, templateID string, values []ports.FieldWrite, onBehalfOf ports.Actor, parentWorkflowInstanceID, requestKey string) (string, error) {
	c, err := l.client(ctx)
	if err != nil {
		return "", err
	}
	req := &pb.CreateRecordRequest{AppId: appID, TemplateId: templateID, OnBehalfOf: actorRefPB(onBehalfOf), RequestKey: requestKey, ParentWorkflowInstanceId: parentWorkflowInstanceID}
	for _, v := range values {
		req.Values = append(req.Values, &pb.FieldWrite{FieldId: v.FieldID, TextValue: v.TextValue, Clear: v.Clear})
	}
	reply, err := c.CreateRecord(ctx, req)
	if err != nil {
		return "", fromStatus(err)
	}
	return reply.GetRecordId(), nil
}

var _ ports.Launch = (*Launch)(nil)
