package grpc

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"google.golang.org/grpc/codes"

	"github.com/kimposoft/kimpo-plugin-sdk/gen/workflowhostv1"
)

// toStatus 只认 WorkflowErrorCode 枚举里的码（外加自己特判的 NOT_FOUND / INVALID_ARGUMENT），
// 不认的一律落进 codes.Internal + "SYSTEM_ERROR:"，宿主再翻成「服务器内部错误」。
//
// 典型后果：引擎明明回了 APPROVE_REASON_REQUIRED（「请填写审批理由」），若这个码没进 proto
// 枚举，审批人看到的是「服务器内部错误」——业务错误被当成系统故障，而单测、编译全绿，
// 只有实际运行才看得出来。
//
// 所以这条判据直接扫状态机源码里所有 errf("CODE", …) 的字面量，要求每一个都能被 toStatus
// 认出来。新加一个错误码却忘了同步 proto 枚举，这里立刻打红。
func TestAllEngineErrorCodesAreTransportable(t *testing.T) {
	codesInSource := collectEngineErrorCodes(t)
	if len(codesInSource) < 10 {
		t.Fatalf("只扫出 %d 个错误码，判据八成没扫到源码：%v", len(codesInSource), codesInSource)
	}
	// toStatus 在枚举之外另行特判的两个码。
	special := map[string]bool{"NOT_FOUND": true, "INVALID_ARGUMENT": true}
	var orphans []string
	for _, c := range codesInSource {
		if special[c] {
			continue
		}
		if _, ok := workflowhostv1.WorkflowErrorCode_value[c]; !ok {
			orphans = append(orphans, c)
		}
	}
	if len(orphans) > 0 {
		t.Fatalf("这些错误码不在 WorkflowErrorCode 枚举里，传到宿主会变成「服务器内部错误」：%v\n"+
			"（补进 proto/workflow/host/v1/common.proto 的枚举 + WorkflowErrorCodeToGRPC 的分支 + 宿主四语文案）", orphans)
	}
}

// 枚举里的每个码都要在 WorkflowErrorCodeToGRPC 里有明确分支——落到 default 的 Unknown 会让
// 宿主按未知错误处理，同样是「业务拒绝被当成故障」。
func TestEveryEnumCodeHasGRPCMapping(t *testing.T) {
	var unmapped []string
	for name, v := range workflowhostv1.WorkflowErrorCode_value {
		if name == "WORKFLOW_ERROR_CODE_UNSPECIFIED" {
			continue
		}
		if WorkflowErrorCodeToGRPC(workflowhostv1.WorkflowErrorCode(v)) == codes.Unknown {
			unmapped = append(unmapped, name)
		}
	}
	sort.Strings(unmapped)
	if len(unmapped) > 0 {
		t.Fatalf("这些枚举值没有 gRPC 状态映射，会回落 codes.Unknown：%v", unmapped)
	}
}

var errfCodeRe = regexp.MustCompile(`errf\("([A-Z_]+)"`)

// collectEngineErrorCodes 扫 internal/engine/core 下所有非测试 .go 文件里的 errf("CODE", …)。
func collectEngineErrorCodes(t *testing.T) []string {
	t.Helper()
	dir := filepath.Join("..", "..", "engine", "core")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读 %s：%v", dir, err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("读 %s：%v", e.Name(), err)
		}
		for _, m := range errfCodeRe.FindAllStringSubmatch(string(raw), -1) {
			seen[m[1]] = true
		}
	}
	out := make([]string, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}
