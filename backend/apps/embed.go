package apps

import "embed"

//go:embed content
var contentFS embed.FS

// ContentFS exposes the embedded registry + docs for handler wiring.
func ContentFS() embed.FS { return contentFS }

// ContentDir is the subpath inside ContentFS where app yamls live.
const ContentDir = "content"
