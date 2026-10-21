package hostclient

import (
	"context"

	pb "github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// Lease 实现 ports.Lease：转发宿主 LeaseServiceClient（M4 改派 / 终止时释放原办理人的
// 单据编辑租约）。租约本身是宿主 editor 会话层的东西，插件不持有也不感知它的资源 key，
// 只管「告诉宿主这个人这张单据的租约该收回了」。
type Lease struct{}

// NewLease 构造租约释放适配器。
func NewLease() *Lease { return &Lease{} }

func (l *Lease) client(ctx context.Context) (pb.LeaseServiceClient, error) {
	host := plugin.WorkflowHostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("workflow host services")
	}
	c := host.WorkflowLease()
	if c == nil {
		return nil, errUnavailable("lease client")
	}
	return c, nil
}

// ReleaseEditLease 释放 rec 上 holderUserID 持有的编辑租约。
func (l *Lease) ReleaseEditLease(ctx context.Context, rec ports.RecordRef, holderUserID int64, reason string) (bool, error) {
	c, err := l.client(ctx)
	if err != nil {
		return false, err
	}
	// 带上所属流程实例，宿主据此核对归属。
	reply, err := c.ReleaseEditLease(ctx, &pb.ReleaseEditLeaseRequest{Record: recordRefPB(rec), HolderUserId: holderUserID, Reason: reason, WorkflowInstanceId: rec.WorkflowInstanceID})
	if err != nil {
		return false, fromStatus(err)
	}
	return reply.GetReleased(), nil
}

var _ ports.Lease = (*Lease)(nil)
