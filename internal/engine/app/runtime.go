package engineapp

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// UTCClock 生产时钟（DV6：一律 UTC）。
type UTCClock struct{}

// Now 见 ports.Clock。
func (UTCClock) Now() time.Time { return time.Now().UTC() }

// RandomIDs 生产 id：<prefix>_<32 位十六进制随机>（≤ 37 字符，账本 id 列 VARCHAR(64)）。
type RandomIDs struct{}

// New 见 ports.IDGen。
func (RandomIDs) New(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败只在系统熵源坏掉时发生，退回时间戳避免空 id。
		return prefix + "_" + time.Now().UTC().Format("20060102150405.000000000")
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
