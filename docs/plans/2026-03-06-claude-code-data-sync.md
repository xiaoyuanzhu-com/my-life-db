# Claude Code Session Data Sync — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sync Claude Code session files from `~/.claude/projects/` into `imports/claude-code/` as raw data, via two independent collectors (Go backend + macOS app).

**Architecture:** Standalone plugin collectors that read from `~/.claude/projects/` and write to `imports/claude-code/`, mirroring the source directory structure byte-for-byte. Go collector writes directly to the filesystem. macOS collector uploads via `PUT /raw/`. Both use local dedup (filesystem compare or watermark hash).

**Tech Stack:** Go 1.25 (backend collector), Swift/SwiftUI (macOS collector), existing `DataCollector` protocol and `SyncManager`.

**Design doc:** `docs/plans/2026-03-06-claude-code-data-sync-design.md`

---

## Task 1: Go Collector — Core Sync Logic

**Repo:** `my-life-db`

**Files:**
- Create: `backend/collectors/claudecode/collector.go`
- Create: `backend/collectors/claudecode/collector_test.go`

**Step 1: Write the failing test**

Create `backend/collectors/claudecode/collector_test.go`:

```go
package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSync_CopiesNewFiles(t *testing.T) {
	// Setup: create temp source and dest dirs
	sourceDir := t.TempDir()
	destDir := t.TempDir()

	// Create a fake project dir with a session JSONL and sessions-index.json
	projectDir := filepath.Join(sourceDir, "-Users-test")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}

	sessionContent := []byte(`{"type":"user","message":"hello"}` + "\n")
	indexContent := []byte(`{"version":1,"entries":[]}`)

	os.WriteFile(filepath.Join(projectDir, "abc123.jsonl"), sessionContent, 0o644)
	os.WriteFile(filepath.Join(projectDir, "sessions-index.json"), indexContent, 0o644)

	// Run sync
	c := New(sourceDir, destDir)
	result, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync() error: %v", err)
	}

	if result.Copied != 2 {
		t.Errorf("Copied = %d, want 2", result.Copied)
	}

	// Verify files exist at destination
	destSession := filepath.Join(destDir, "-Users-test", "abc123.jsonl")
	if data, err := os.ReadFile(destSession); err != nil {
		t.Errorf("dest session file missing: %v", err)
	} else if string(data) != string(sessionContent) {
		t.Errorf("dest content = %q, want %q", data, sessionContent)
	}

	destIndex := filepath.Join(destDir, "-Users-test", "sessions-index.json")
	if _, err := os.Stat(destIndex); err != nil {
		t.Errorf("dest index file missing: %v", err)
	}
}

func TestSync_SkipsIdenticalFiles(t *testing.T) {
	sourceDir := t.TempDir()
	destDir := t.TempDir()

	projectDir := filepath.Join(sourceDir, "-Users-test")
	os.MkdirAll(projectDir, 0o755)

	content := []byte(`{"type":"user","message":"hello"}` + "\n")
	os.WriteFile(filepath.Join(projectDir, "abc123.jsonl"), content, 0o644)

	c := New(sourceDir, destDir)

	// First sync: should copy
	r1, _ := c.Sync(context.Background())
	if r1.Copied != 1 {
		t.Fatalf("first sync: Copied = %d, want 1", r1.Copied)
	}

	// Second sync: same content, should skip
	r2, _ := c.Sync(context.Background())
	if r2.Skipped != 1 {
		t.Errorf("second sync: Skipped = %d, want 1", r2.Skipped)
	}
	if r2.Copied != 0 {
		t.Errorf("second sync: Copied = %d, want 0", r2.Copied)
	}
}

func TestSync_CopiesUpdatedFiles(t *testing.T) {
	sourceDir := t.TempDir()
	destDir := t.TempDir()

	projectDir := filepath.Join(sourceDir, "-Users-test")
	os.MkdirAll(projectDir, 0o755)

	os.WriteFile(filepath.Join(projectDir, "abc123.jsonl"), []byte("line1\n"), 0o644)

	c := New(sourceDir, destDir)
	c.Sync(context.Background())

	// Update source file (appended content, like a real session)
	os.WriteFile(filepath.Join(projectDir, "abc123.jsonl"), []byte("line1\nline2\n"), 0o644)

	r, _ := c.Sync(context.Background())
	if r.Copied != 1 {
		t.Errorf("Copied = %d, want 1", r.Copied)
	}

	// Verify updated content at destination
	data, _ := os.ReadFile(filepath.Join(destDir, "-Users-test", "abc123.jsonl"))
	if string(data) != "line1\nline2\n" {
		t.Errorf("dest content = %q, want %q", data, "line1\nline2\n")
	}
}

func TestSync_CopiesSubagentFiles(t *testing.T) {
	sourceDir := t.TempDir()
	destDir := t.TempDir()

	// Create project dir with session + subagent
	projectDir := filepath.Join(sourceDir, "-Users-test")
	subagentDir := filepath.Join(projectDir, "abc123", "subagents")
	os.MkdirAll(subagentDir, 0o755)

	os.WriteFile(filepath.Join(projectDir, "abc123.jsonl"), []byte("main\n"), 0o644)
	os.WriteFile(filepath.Join(subagentDir, "agent-xyz.jsonl"), []byte("sub\n"), 0o644)

	c := New(sourceDir, destDir)
	r, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync() error: %v", err)
	}

	if r.Copied != 2 {
		t.Errorf("Copied = %d, want 2", r.Copied)
	}

	// Verify subagent file at destination
	destSub := filepath.Join(destDir, "-Users-test", "abc123", "subagents", "agent-xyz.jsonl")
	if data, err := os.ReadFile(destSub); err != nil {
		t.Errorf("subagent file missing: %v", err)
	} else if string(data) != "sub\n" {
		t.Errorf("subagent content = %q, want %q", data, "sub\n")
	}
}

func TestSync_SkipsUnexpectedFiles(t *testing.T) {
	sourceDir := t.TempDir()
	destDir := t.TempDir()

	projectDir := filepath.Join(sourceDir, "-Users-test")
	os.MkdirAll(projectDir, 0o755)

	os.WriteFile(filepath.Join(projectDir, "abc123.jsonl"), []byte("ok\n"), 0o644)
	os.WriteFile(filepath.Join(projectDir, "random.txt"), []byte("skip me"), 0o644)
	os.WriteFile(filepath.Join(projectDir, ".DS_Store"), []byte("skip me"), 0o644)

	c := New(sourceDir, destDir)
	r, _ := c.Sync(context.Background())

	if r.Copied != 1 {
		t.Errorf("Copied = %d, want 1 (only the .jsonl)", r.Copied)
	}
}

func TestSync_SourceDirMissing(t *testing.T) {
	c := New("/nonexistent/path", t.TempDir())
	r, err := c.Sync(context.Background())

	// Should not error — just return empty result (source may not exist yet)
	if err != nil {
		t.Errorf("expected no error for missing source, got: %v", err)
	}
	if r.Copied != 0 {
		t.Errorf("Copied = %d, want 0", r.Copied)
	}
}
```

**Step 2: Run test to verify it fails**

```bash
cd backend && go test -v ./collectors/claudecode/...
```

Expected: compilation error — `New` and `Sync` don't exist yet.

**Step 3: Write minimal implementation**

Create `backend/collectors/claudecode/collector.go`:

```go
package claudecode

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SyncResult holds the outcome of a sync operation.
type SyncResult struct {
	Copied  int
	Skipped int
	Errors  int
}

// Collector syncs Claude Code session files from a source directory
// into the MyLifeDB imports tree.
type Collector struct {
	sourceDir string // ~/.claude/projects/
	destDir   string // USER_DATA_DIR/imports/claude-code/
}

// New creates a new Claude Code collector.
func New(sourceDir, destDir string) *Collector {
	return &Collector{
		sourceDir: sourceDir,
		destDir:   destDir,
	}
}

// Sync walks the source tree and copies new or changed files to the
// destination. Files are copied byte-for-byte. Identical files (by
// content hash) are skipped.
func (c *Collector) Sync(ctx context.Context) (SyncResult, error) {
	var result SyncResult

	// If source doesn't exist, return empty result (not an error)
	if _, err := os.Stat(c.sourceDir); os.IsNotExist(err) {
		return result, nil
	}

	err := filepath.WalkDir(c.sourceDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}

		// Check context cancellation
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Skip directories (we create them on demand)
		if d.IsDir() {
			return nil
		}

		// Filter: only .jsonl files and sessions-index.json
		if !shouldSync(d.Name()) {
			return nil
		}

		// Compute relative path and destination
		relPath, err := filepath.Rel(c.sourceDir, path)
		if err != nil {
			result.Errors++
			return nil
		}
		destPath := filepath.Join(c.destDir, relPath)

		// Compare source and destination
		if filesIdentical(path, destPath) {
			result.Skipped++
			return nil
		}

		// Copy file
		if err := copyFile(path, destPath); err != nil {
			log.Error().Err(err).Str("src", path).Str("dest", destPath).Msg("failed to copy claude session file")
			result.Errors++
			return nil
		}

		result.Copied++
		return nil
	})

	if err != nil && err != context.Canceled {
		return result, err
	}

	if result.Copied > 0 || result.Errors > 0 {
		log.Info().
			Int("copied", result.Copied).
			Int("skipped", result.Skipped).
			Int("errors", result.Errors).
			Msg("claude code session sync complete")
	}

	return result, nil
}

// shouldSync returns true if the file should be synced.
func shouldSync(name string) bool {
	if name == "sessions-index.json" {
		return true
	}
	return strings.HasSuffix(name, ".jsonl")
}

// filesIdentical returns true if src and dest exist and have the same content.
// Uses size comparison first (cheap), then SHA-256 if sizes match.
func filesIdentical(src, dest string) bool {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return false
	}
	destInfo, err := os.Stat(dest)
	if err != nil {
		return false // dest doesn't exist
	}

	// Quick check: different sizes means different content
	if srcInfo.Size() != destInfo.Size() {
		return false
	}

	// Same size: compare hashes
	srcHash, err := fileHash(src)
	if err != nil {
		return false
	}
	destHash, err := fileHash(dest)
	if err != nil {
		return false
	}

	return srcHash == destHash
}

// fileHash returns the hex-encoded SHA-256 hash of a file.
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}

	return string(h.Sum(nil)), nil
}

// copyFile copies src to dest, creating parent directories as needed.
func copyFile(src, dest string) error {
	// Create parent directories
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}

	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	destFile, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, srcFile); err != nil {
		return err
	}

	return destFile.Close()
}
```

**Step 4: Run tests to verify they pass**

```bash
cd backend && go test -v ./collectors/claudecode/...
```

Expected: all 6 tests PASS.

**Step 5: Commit**

```bash
git add backend/collectors/claudecode/
git commit -m "feat: add Claude Code session data collector (Go)

Standalone collector that syncs ~/.claude/projects/ JSONL files
into imports/claude-code/, preserving the original directory layout.
Copies session files, subagent files, and session indexes byte-for-byte.
Uses size + SHA-256 dedup to skip identical files.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Go Server Integration — Wire Collector Into Server

**Repo:** `my-life-db`

**Files:**
- Modify: `backend/server/server.go` (add collector field, init in `New()`, start/stop periodic sync)
- Modify: `backend/server/config.go` (no changes needed — uses existing `UserDataDir`)

**Step 1: Add collector field and initialization to server.go**

In `server.go`, add to imports:

```go
claudecodecollector "github.com/xiaoyuanzhu-com/my-life-db/collectors/claudecode"
```

Add field to `Server` struct:

```go
claudeCodeCollector *claudecodecollector.Collector
```

Add initialization in `New()`, after FS service creation (step 4) and before `connectServices()`:

```go
// 6.5. Create Claude Code data collector
{
	homeDir, err := os.UserHomeDir()
	if err == nil {
		sourceDir := filepath.Join(homeDir, ".claude", "projects")
		destDir := filepath.Join(cfg.UserDataDir, "imports", "claude-code")
		s.claudeCodeCollector = claudecodecollector.New(sourceDir, destDir)
		log.Info().Str("source", sourceDir).Str("dest", destDir).Msg("initialized Claude Code data collector")
	} else {
		log.Warn().Err(err).Msg("failed to get home dir, Claude Code collector disabled")
	}
}
```

**Step 2: Add periodic sync goroutine in Start()**

In `Start()`, before the HTTP server creation, add:

```go
// Start Claude Code data collector (periodic sync)
if s.claudeCodeCollector != nil {
	go s.runClaudeCodeSync()
}
```

Add the method:

```go
// runClaudeCodeSync runs the Claude Code collector on startup and periodically.
func (s *Server) runClaudeCodeSync() {
	// Initial sync on startup
	if _, err := s.claudeCodeCollector.Sync(s.shutdownCtx); err != nil {
		log.Error().Err(err).Msg("Claude Code initial sync failed")
	}

	// Periodic sync every 10 minutes
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-s.shutdownCtx.Done():
			return
		case <-ticker.C:
			if _, err := s.claudeCodeCollector.Sync(s.shutdownCtx); err != nil {
				log.Error().Err(err).Msg("Claude Code periodic sync failed")
			}
		}
	}
}
```

**Step 3: Add required imports to server.go**

Add `"os"` and `"path/filepath"` to the import block (if not already present).

**Step 4: Build to verify compilation**

```bash
cd backend && go build .
```

Expected: compiles successfully.

**Step 5: Run existing tests to verify no regressions**

```bash
cd backend && go test ./...
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add backend/server/server.go
git commit -m "feat: wire Claude Code collector into server lifecycle

Initializes the collector with ~/.claude/projects/ as source and
USER_DATA_DIR/imports/claude-code/ as destination. Runs initial sync
on startup, then every 10 minutes. Respects shutdown context.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Swift Collector — ClaudeCodeCollector

**Repo:** `my-life-db-apple`

**Files:**
- Create: `MyLifeDB/DataCollect/Collectors/ClaudeCodeCollector.swift`

**Step 1: Write the collector**

Create `MyLifeDB/DataCollect/Collectors/ClaudeCodeCollector.swift`:

```swift
//
//  ClaudeCodeCollector.swift
//  MyLifeDB
//
//  Collects Claude Code session files from ~/.claude/projects/ and
//  uploads them to the backend as raw imported data. macOS only.
//
//  Source: ~/.claude/projects/{project-dir}/{session-id}.jsonl
//  Dest:   imports/claude-code/{project-dir}/{session-id}.jsonl
//
//  Files are copied byte-for-byte — no transformation.
//

#if os(macOS)
import Foundation

final class ClaudeCodeCollector: DataCollector {

    let id = "claude-code"
    let displayName = "Claude Code"

    let sourceIDs: [String] = ["claude_sessions"]

    // MARK: - Source Directory

    private var sourceDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects")
    }

    // MARK: - Authorization

    func requestAuthorization() async -> Bool {
        // No special authorization needed — just filesystem access
        return FileManager.default.isReadableFile(atPath: sourceDir.path)
    }

    func authorizationStatus() -> CollectorAuthStatus {
        if !FileManager.default.fileExists(atPath: sourceDir.path) {
            return .unavailable
        }
        if FileManager.default.isReadableFile(atPath: sourceDir.path) {
            return .authorized
        }
        return .denied
    }

    // MARK: - Collection

    func collectNewSamples(fullSync: Bool) async throws -> CollectionResult {
        let fm = FileManager.default

        guard fm.fileExists(atPath: sourceDir.path) else {
            return CollectionResult(batches: [], stats: CollectionStats(
                typesQueried: 1, typesWithData: 0, samplesCollected: 0
            ))
        }

        var batches: [DaySamples] = []
        var filesFound = 0

        // Walk the source directory
        guard let projectDirs = try? fm.contentsOfDirectory(
            at: sourceDir, includingPropertiesForKeys: [.isDirectoryKey]
        ) else {
            return CollectionResult(batches: [], stats: CollectionStats(
                typesQueried: 1, typesWithData: 0, samplesCollected: 0
            ))
        }

        for projectURL in projectDirs {
            guard isDirectory(projectURL) else { continue }
            let projectName = projectURL.lastPathComponent

            // Collect files in this project directory
            let projectBatches = try collectProject(
                projectURL: projectURL,
                projectName: projectName
            )
            batches.append(contentsOf: projectBatches)
            filesFound += projectBatches.count
        }

        return CollectionResult(
            batches: batches,
            stats: CollectionStats(
                typesQueried: 1,
                typesWithData: filesFound > 0 ? 1 : 0,
                samplesCollected: filesFound
            )
        )
    }

    func commitAnchor(for batch: DaySamples) async {
        // No anchor needed — we use watermark-based dedup in SyncManager
    }

    // MARK: - Private Helpers

    private func collectProject(
        projectURL: URL,
        projectName: String
    ) throws -> [DaySamples] {
        let fm = FileManager.default
        var batches: [DaySamples] = []

        // Enumerate all files recursively in this project directory
        guard let enumerator = fm.enumerator(
            at: projectURL,
            includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        for case let fileURL as URL in enumerator {
            guard isRegularFile(fileURL) else { continue }
            guard shouldSync(fileURL.lastPathComponent) else { continue }

            // Read file data
            guard let data = try? Data(contentsOf: fileURL) else { continue }

            // Compute upload path: imports/claude-code/{projectName}/{relative-path}
            let relativePath = fileURL.path.replacingOccurrences(
                of: projectURL.path + "/", with: ""
            )
            let uploadPath = "imports/claude-code/\(projectName)/\(relativePath)"

            // Use file modification date for the batch date
            let modDate = (try? fileURL.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()

            batches.append(DaySamples(
                date: modDate,
                collectorID: id,
                uploadPath: uploadPath,
                data: data
            ))
        }

        return batches
    }

    private func shouldSync(_ filename: String) -> Bool {
        if filename == "sessions-index.json" { return true }
        return filename.hasSuffix(".jsonl")
    }

    private func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
    }

    private func isRegularFile(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
    }
}
#endif // os(macOS)
```

**Step 2: Build for macOS to verify compilation**

```bash
xcodebuild -scheme MyLifeDB -destination 'platform=macOS' build
```

Expected: compiles successfully.

**Step 3: Commit**

```bash
git add MyLifeDB/DataCollect/Collectors/ClaudeCodeCollector.swift
git commit -m "feat: add Claude Code session data collector (macOS)

Implements DataCollector protocol for macOS. Walks ~/.claude/projects/,
reads session JSONL files, subagent files, and session indexes,
and packages them as DaySamples for upload to imports/claude-code/.
Files are uploaded byte-for-byte with no transformation.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Swift SyncManager Registration

**Repo:** `my-life-db-apple`

**Files:**
- Modify: `MyLifeDB/DataCollect/SyncManager.swift:83-89` (add ClaudeCodeCollector to the collectors array)

**Step 1: Add ClaudeCodeCollector to the collectors array**

In `SyncManager.swift`, update the `init()` method:

```swift
private init() {
    // Register all collectors
    collectors = [
        HealthKitCollector(),
        #if os(macOS)
        ClaudeCodeCollector(),
        #endif
    ]

    // Initialize per-collector states
    for collector in collectors {
        collectorStates[collector.id] = .idle
    }

    // Load last sync date
    lastSyncDate = UserDefaults.standard.object(forKey: "sync.lastSyncDate") as? Date
}
```

**Step 2: Build for macOS and iOS to verify both compile**

```bash
xcodebuild -scheme MyLifeDB -destination 'platform=macOS' build
xcodebuild -scheme MyLifeDB -destination 'platform=iOS Simulator,name=iPhone 15' build
```

Expected: both compile successfully. iOS build excludes `ClaudeCodeCollector` via `#if os(macOS)`.

**Step 3: Run tests**

```bash
xcodebuild test -scheme MyLifeDB -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:MyLifeDBTests
```

Expected: all tests pass.

**Step 4: Commit**

```bash
git add MyLifeDB/DataCollect/SyncManager.swift
git commit -m "feat: register ClaudeCodeCollector in SyncManager (macOS only)

Adds ClaudeCodeCollector to the collectors array behind #if os(macOS).
iOS builds are unaffected. The collector is triggered by SyncManager
on the same schedule as HealthKitCollector — foreground sync + background.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
