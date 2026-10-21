# 常用目标：
#   make build   只编译 plugin.bin（本机平台）
#   make test    运行后端单元测试（前端单测：cd frontend && npm test）
#   make kpp     完整构建并打包 .kpp（等同 bash build.sh）
export GOWORK := off

.PHONY: build test kpp clean sync-manifest
# cmd/plugin/manifest.json 是 go:embed 用的副本，构建前从根 manifest.json 同步
sync-manifest:
	cp manifest.json cmd/plugin/manifest.json

build: sync-manifest
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o plugin.bin ./cmd/plugin

test: sync-manifest
	go test ./...

kpp:
	bash build.sh

clean:
	rm -rf plugin.bin release
