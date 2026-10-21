package compile_test

// golden_conformance_test.go —— 官方编译器接入 SDK 一致性套件。
//
// 链路：设计层，DefinitionService.Publish → compile.Compiler → compiled_json 写版本行 → 宿主 Commit 按 SDK 同口径
// 校验宿主依赖键（COMPILED_HOST_KEYS_INVALID）。本文件锁两件事：
//  1. RunCompilerSuite：SDK 黄金文档逐份经官方编译器编译，产物过宿主依赖键校验（error 级即失败）；
//  2. 逐字节黄金：官方编译器对同名黄金文档的产物与 SDK 黄金 compiled 逐字节一致——宿主依赖键改走 SDK 类型化
//     编码（workflowengine.Encode*）前后输出不变，以后谁改了编码口径（键序、空值省略、id 编码）这里立刻打红。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
	"testing"

	"github.com/kimposoft/kimpo-plugin-sdk/plugin/plugintest/workflowconformance"
	workflowschema "github.com/kimposoft/kimpo-plugin-sdk/schema/workflow"

	"github.com/kimposoft/kimpo-workflow/internal/compile"
	"github.com/kimposoft/kimpo-workflow/internal/model"
)

// goldenSerialFieldID 是生成 SDK 黄金 compiled 时传入的主表自动编号字段（H2，由宿主网关查模板后传入）。
const goldenSerialFieldID = "f_serial"

// goldenFreezer 是生成 SDK 黄金 compiled 时用的表达式冻结替身：发布物 id = "pub_" + 表达式 id（冒号换下划线），
// 不登记引用字段。真实冻结由宿主 ExpressionService 完成，不在一致性范围内。
type goldenFreezer struct{}

func (goldenFreezer) Freeze(_ context.Context, in compile.FreezeInput) (compile.FreezeOutput, error) {
	var out compile.FreezeOutput
	for _, spec := range in.Specs {
		out.Frozen = append(out.Frozen, compile.FrozenExpression{ExpressionID: spec.ExpressionID, PublicationID: "pub_" + strings.ReplaceAll(spec.ExpressionID, ":", "_")})
	}
	return out, nil
}

// compileGolden 以发布期口径编译一份黄金文档：模板已发布、目标模板取发起节点配置、表达式经 goldenFreezer 冻结。
func compileGolden(raw []byte) (*compile.Result, error) {
	var doc model.Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("decode document: %w", err)
	}
	templateID := ""
	for i := range doc.Nodes {
		if doc.Nodes[i].Kind == model.NodeKindStart {
			if cfg, err := model.StartConfigOf(&doc.Nodes[i]); err == nil {
				templateID = cfg.TargetTemplateID
			}
		}
	}
	c := compile.New(nil, goldenFreezer{}, nil, nil)
	res, err := c.Compile(context.Background(), compile.Input{
		Document: &doc, AppID: "app-golden", TemplateID: templateID, DefinitionID: "def-golden", VersionNo: 1,
		TemplatePublished: true, SerialFieldID: goldenSerialFieldID,
	})
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// TestCompilerConformanceSuite：SDK 黄金文档全集（官方声明支持全部六类节点）经官方编译器编出的产物都过宿主依赖键校验，
// 且全部可发布（官方编译器拒绝任何一份黄金文档都算回归）。
func TestCompilerConformanceSuite(t *testing.T) {
	workflowconformance.RunCompilerSuite(t, func(document []byte) ([]byte, []string, error) {
		res, err := compileGolden(document)
		if err != nil {
			return nil, nil, err
		}
		var diags []string
		for _, d := range res.Diagnostics {
			diags = append(diags, d.Code+"@"+d.NodeID+d.LinkID)
		}
		if len(diags) > 0 {
			return nil, diags, nil
		}
		raw, err := res.Compiled.Encode()
		return raw, nil, err
	}, workflowconformance.SuiteOptions{ExpectPublishable: true})
}

// TestCompiledGoldenByteIdentical：官方编译器对每份黄金文档的产物与 SDK 黄金 compiled 逐字节一致
// （黄金文件是两空格缩进的 JSON，按同一缩进重排后比对；嵌入的 *_json 字符串原样参与比对）。
func TestCompiledGoldenByteIdentical(t *testing.T) {
	names, err := workflowschema.GoldenFiles("documents")
	if err != nil {
		t.Fatalf("golden documents: %v", err)
	}
	if len(names) < 5 {
		t.Fatalf("golden documents = %v, want at least 5", names)
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			doc, err := fs.ReadFile(workflowschema.Golden(), "documents/"+name)
			if err != nil {
				t.Fatal(err)
			}
			want, err := fs.ReadFile(workflowschema.Golden(), "compiled/"+name)
			if err != nil {
				t.Fatal(err)
			}
			res, err := compileGolden(doc)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if len(res.Diagnostics) > 0 {
				t.Fatalf("publish rejected: %+v", res.Diagnostics)
			}
			raw, err := res.Compiled.Encode()
			if err != nil {
				t.Fatal(err)
			}
			var got bytes.Buffer
			if err := json.Indent(&got, raw, "", "  "); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(bytes.TrimSpace(got.Bytes()), bytes.TrimSpace(want)) {
				t.Fatalf("compiled_json drifted from SDK golden %s\n--- got ---\n%s\n--- want ---\n%s", name, got.String(), want)
			}
		})
	}
}
