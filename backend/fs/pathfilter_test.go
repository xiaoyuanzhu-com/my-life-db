package fs

import "testing"

func TestIsIndexSkipped(t *testing.T) {
	tests := []struct {
		path string
		want bool
		desc string
	}{
		// All markers as direct paths
		{"node_modules", true, "node_modules at root"},
		{".git", true, ".git at root"},
		{".pnpm-store", true, ".pnpm-store at root"},
		{"__pycache__", true, "__pycache__ at root"},
		{".worktrees", true, ".worktrees at root"},
		{".venv", true, ".venv at root"},
		{"venv", true, "venv at root"},

		// Markers nested at any depth
		{"projects/foo/node_modules", true, "node_modules nested"},
		{"projects/foo/node_modules/bar/index.js", true, "file under node_modules"},
		{"a/b/.git/objects/pack", true, ".git nested"},
		{"py/pkg/__pycache__/mod.cpython-311.pyc", true, "__pycache__ nested"},
		{"deep/path/.pnpm-store/v3/files/abc", true, ".pnpm-store nested"},
		{"my-life-db/.worktrees/feature-x/backend/main.go", true, ".worktrees nested"},
		{"projects/foo/.venv/lib/python3.12/site-packages/x.py", true, ".venv nested"},
		{"projects/foo/venv/bin/python", true, "venv nested"},

		// Non-marker paths
		{"", false, "empty path"},
		{"notes/2024/january.md", false, "regular note path"},
		{"inbox/document.pdf", false, "inbox file"},
		{".claude/settings.json", false, ".claude is not a skip marker"},
		{".obsidian/workspace", false, ".obsidian is not a skip marker"},
		{".DS_Store", false, ".DS_Store is not a skip marker"},
		{"library/.git-keep", false, "name containing .git is not a marker"},
		{"node_modules_backup", false, "name containing node_modules is not a marker"},
		{"notes/venv-tutorial.md", false, "name containing venv is not a marker"},
		{"docs/.worktrees-explained.md", false, "name containing .worktrees is not a marker"},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			if got := IsIndexSkipped(tt.path); got != tt.want {
				t.Errorf("IsIndexSkipped(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsIndexSkippedName(t *testing.T) {
	skipped := []string{"node_modules", ".git", ".pnpm-store", "__pycache__", ".worktrees", ".venv", "venv"}
	for _, name := range skipped {
		if !IsIndexSkippedName(name) {
			t.Errorf("IsIndexSkippedName(%q) should be true", name)
		}
	}

	notSkipped := []string{"", "notes", ".claude", ".obsidian", ".DS_Store", "build", "dist", "out", "target"}
	for _, name := range notSkipped {
		if IsIndexSkippedName(name) {
			t.Errorf("IsIndexSkippedName(%q) should be false", name)
		}
	}
}
