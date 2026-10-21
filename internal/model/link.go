package model

import "encoding/json"

// Link 是画布上的一条引导线：连接两个节点，可选一条宿主 V4 判断表达式作为
// 流转条件；不填即无条件、恒可走。
type Link struct {
	// ID 引导线在本文档内唯一。
	ID string `json:"id"`
	// From/To 是起止节点 ID。
	From string `json:"from"`
	To   string `json:"to"`
	// Name 设计者自己填的一段文本，至多 20 字（按字符数），可空。只用于设计器画布上
	// 标识这条线，不参与选路——提交人的选路界面仍按指向的节点列出，求值也只看
	// ConditionDoc。
	Name string `json:"name,omitempty"`
	// ConditionDoc 是条件表达式的设计期文档（宿主 V4 判断表达式，发布时冻结为发布物；
	// 这里只透传原始 JSON，不解析、不求值——求值在填报层由宿主 ExpressionService 做）。
	ConditionDoc json.RawMessage `json:"condition_doc,omitempty"`
	// Vertices 画布上的折线控制点，引擎不关心，仅设计器读写、随文档整体保存。
	Vertices []Point `json:"vertices,omitempty"`
}

// Point 是画布坐标点，供 Link.Vertices 使用。
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
