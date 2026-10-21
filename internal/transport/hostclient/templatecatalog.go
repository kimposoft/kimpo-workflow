package hostclient

import (
	"context"

	"github.com/kimposoft/kimpo-plugin-sdk/plugin"

	"github.com/kimposoft/kimpo-workflow/internal/engine/ports"
)

// TemplateCatalog 实现 ports.FieldCatalog：转发宿主 SDK 通用出站面 TemplateCatalogService.
// ListFields（K4 / N6.10 发布期字段类型校验用）。与本包其余四个适配器（Ledger/Record/
// Expression/Candidate）不同源——那四个挂在 workflow 专用面（plugin.WorkflowHostFrom），
// 本适配器挂在插件通用面（plugin.HostFrom），两者共享同一条宿主 gRPC 连接
// （kimpo-plugin-sdk/plugin/hostconn.go newHostClient 一次性拨号，两套客户端都从其上取）。
type TemplateCatalog struct {
	// testClient 仅测试注入：绕开 plugin.HostFrom(ctx)（生产路径依赖宿主真实注入的连接，
	// 单测里没有这个连接），手法同 Record.testClient。
	testClient plugin.TemplateCatalogClient
}

// NewTemplateCatalog 构造字段目录适配器。
func NewTemplateCatalog() *TemplateCatalog { return &TemplateCatalog{} }

// NewTemplateCatalogForTest 仅测试用：注入假的 TemplateCatalogClient，跳过 plugin.HostFrom(ctx)。
func NewTemplateCatalogForTest(c plugin.TemplateCatalogClient) *TemplateCatalog {
	return &TemplateCatalog{testClient: c}
}

func (t *TemplateCatalog) client(ctx context.Context) (plugin.TemplateCatalogClient, error) {
	if t.testClient != nil {
		return t.testClient, nil
	}
	host := plugin.HostFrom(ctx)
	if host == nil {
		return nil, errUnavailable("host services")
	}
	c := host.TemplateCatalog()
	if c == nil {
		return nil, errUnavailable("template catalog client")
	}
	return c, nil
}

// ListFields 见 ports.FieldCatalog：一次拉整张模板（主表 + 全部明细表）的字段，逐字段透传
// 宿主 TemplateFieldBrief（DataType/TableRole 原值不做映射）。
func (t *TemplateCatalog) ListFields(ctx context.Context, appID, templateID string) ([]ports.CatalogField, error) {
	c, err := t.client(ctx)
	if err != nil {
		return nil, err
	}
	items, err := c.ListFields(ctx, appID, templateID)
	if err != nil {
		return nil, fromStatus(err)
	}
	out := make([]ports.CatalogField, 0, len(items))
	for _, it := range items {
		out = append(out, ports.CatalogField{
			FieldID: it.FieldID, FieldName: it.FieldName,
			DataType: it.DataType, DataTableID: it.DataTableID, TableRole: it.TableRole,
		})
	}
	return out, nil
}

var _ ports.FieldCatalog = (*TemplateCatalog)(nil)
