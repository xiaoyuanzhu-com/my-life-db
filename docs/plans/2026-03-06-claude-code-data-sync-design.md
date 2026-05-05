# Claude Code Session Data Sync — Design

## Goal

Sync Claude Code session files from `~/.claude/projects/` into the MyLifeDB data directory as raw imported data. Two independent collectors — one in the Go backend, one in the macOS Apple app — both write to the same destination using the standard MyLifeDB interface.

## Principles

- **Plugin architecture.** Each collector is standalone, knows nothing about MyLifeDB internals (no SessionManager, no database, no notifications). It reads from a source, writes to a destination through the standard file interface.
- **Raw data, no transformation.** JSONL files are copied byte-for-byte. Processing happens later.
- **Honor the original layout.** The source directory structure is preserved in the destination.
- **Local-first dedup.** Each collector checks locally before writing — no backend round-trips for dedup.
- **Splittable.** Collectors could be extracted to separate processes someday; the only interface they need is `PUT /raw/{path}` (HTTP) or direct filesystem write (co-located).

## Source Layout

Claude Code stores session data at `~/.claude/projects/`:

```
~/.claude/projects/
├── -Users-iloahz/                           # project dir (sanitized path)
│   ├── sessions-index.json
│   ├── {session-id}.jsonl                   # session JSONL (raw messages)
│   └── {session-id}/                        # optional session subdir
│       └── subagents/
│           └── agent-{agent-id}.jsonl
├── -private-tmp-skill-creator-run/
│   └── ...
└── ...
```

Each `.jsonl` file contains one JSON object per line: `user`, `assistant`, `result`, `system`, `progress`, `summary`, `queue-operation`, etc.

## Destination Layout

Mirror the source under `imports/claude-code/`:

```
imports/claude-code/
├── -Users-iloahz/
│   ├── sessions-index.json
│   ├── {session-id}.jsonl
│   └── {session-id}/
│       └── subagents/
│           └── agent-{agent-id}.jsonl
├── -private-tmp-skill-creator-run/
│   └── ...
└── ...
```

### What gets copied

| File type | Included | Notes |
|-----------|----------|-------|
| `*.jsonl` (session files) | Yes | Main session data |
| `*/subagents/*.jsonl` | Yes | Subagent conversations |
| `sessions-index.json` | Yes | Claude's per-project session index |
| Other files | No | Skip anything unexpected |

## Dedup Strategy

### Go backend collector (co-located)

Direct filesystem compare against the destination:

1. `stat()` destination file
2. If missing: copy
3. If exists: compare size. If same size, compare content hash (SHA-256). If identical, skip.

No local index needed — the destination file *is* the index.

### macOS app collector (remote)

Uses the existing `SyncWatermark` system in SyncManager:

1. Before uploading, check local watermark: `(path, content-hash)` map
2. If watermark matches: skip
3. If new or changed: upload via `PUT /raw/{path}`, record watermark on success

If the Go backend already wrote the same file, the macOS app may upload it once redundantly (idempotent PUT, same content). After that first upload, the watermark prevents future redundancy.

## Go Backend Collector

### Interface

```go
// collectors/claudecode/collector.go
package claudecode

type Collector struct {
    sourceDir string   // ~/.claude/projects/
    destDir   string   // USER_DATA_DIR/imports/claude-code/
}

func New(sourceDir, destDir string) *Collector

// Sync walks the source tree, copies new/changed files to destDir.
func (c *Collector) Sync(ctx context.Context) (SyncResult, error)

type SyncResult struct {
    Copied  int
    Skipped int
    Errors  int
}
```

### Lifecycle

- Created by `server.New()` with source and dest paths
- SyncManager triggers `Sync()` on startup + periodically (e.g. every 10 minutes)
- No goroutines of its own — caller controls scheduling
- No dependency on SessionManager, database, or notifications

### File walk logic

1. `filepath.WalkDir(sourceDir, ...)` to enumerate all files
2. Filter: only `.jsonl` files and `sessions-index.json`
3. Compute destination path: `destDir + relative path from sourceDir`
4. Create destination directories as needed
5. Compare source vs destination (size, then hash)
6. Copy if new or changed

## macOS App Collector

### Interface

Implements the existing `DataCollector` protocol:

```swift
// DataCollect/Collectors/ClaudeCodeCollector.swift

final class ClaudeCodeCollector: DataCollector {
    let id = "claude-code"
    let displayName = "Claude Code"
    let sourceIDs: [String] = ["claude_sessions"]

    func collectNewSamples(fullSync: Bool) async throws -> CollectionResult
    func commitAnchor(for batch: DaySamples) async
    func requestAuthorization() async -> Bool
    func authorizationStatus() -> CollectorAuthStatus
}
```

### Key details

- `#if os(macOS)` only — Claude Code sessions only exist on Mac
- No framework authorization needed (just filesystem access)
- `collectNewSamples()` walks `~/.claude/projects/`, reads file contents, packages as `DaySamples` batches
- Each `DaySamples` = one file, with `uploadPath` like `imports/claude-code/-Users-iloahz/{session-id}.jsonl`
- `date` uses the file's modification date (for display/grouping)
- Uses existing `SyncWatermark` for local dedup

### Registration

```swift
// SyncManager.swift
private init() {
    collectors = [
        HealthKitCollector(),
        #if os(macOS)
        ClaudeCodeCollector(),
        #endif
    ]
}
```

### DataCollectView

The existing entry `claude_sessions` under "Developer & Knowledge Work" (status: `.available`, platform: `.mac`) already exists. No UI changes needed — the collector wires up to that toggle.

## Commit Plan

Separate commits, one per logical piece:

1. **Go collector** — `collectors/claudecode/` package with `Sync()` logic
2. **Go server integration** — wire collector into server startup + periodic trigger
3. **Swift collector** — `ClaudeCodeCollector.swift` implementing `DataCollector`
4. **Swift SyncManager registration** — register in SyncManager, `#if os(macOS)`
