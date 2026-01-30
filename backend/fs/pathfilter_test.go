package fs

import "testing"

func TestPathFilter_IsExcluded(t *testing.T) {
	tests := []struct {
		name       string
		exclusions Category
		path       string
		want       bool
	}{
		// Hidden files
		{"hidden dir", CategoryHidden, ".git", true},
		{"hidden file", CategoryHidden, ".hidden", true},
		{"hidden nested", CategoryHidden, "foo/.hidden/bar", true},
		{"not hidden", CategoryHidden, "regular", false},
		{"dot only", CategoryHidden, ".", false},

		// VCS
		{"git", CategoryVCS, ".git", true},
		{"svn", CategoryVCS, ".svn", true},
		{"hg nested", CategoryVCS, "project/.hg", true},
		{"not vcs", CategoryVCS, "gitrepo", false},

		// IDE
		{"idea", CategoryIDE, ".idea", true},
		{"vscode", CategoryIDE, ".vscode", true},
		{"suo file", CategoryIDE, "project.suo", true},
		{"not ide", CategoryIDE, "ideas", false},

		// Backup
		{"tilde prefix", CategoryBackup, "~file", true},
		{"tilde suffix", CategoryBackup, "file~", true},
		{"bak file", CategoryBackup, "file.bak", true},
		{"swp file", CategoryBackup, ".file.swp", true}, // Also hidden
		{"not backup", CategoryBackup, "backup", false},

		// Dependencies
		{"node_modules", CategoryDependencies, "node_modules", true},
		{"vendor", CategoryDependencies, "vendor", true},
		{"nested node_modules", CategoryDependencies, "project/node_modules/pkg", true},
		{"not deps", CategoryDependencies, "modules", false},

		// Cache
		{"pycache", CategoryCache, "__pycache__", true},
		{"pytest", CategoryCache, ".pytest_cache", true},
		{"pyc file", CategoryCache, "module.pyc", true},
		{"next", CategoryCache, ".next", true},
		{"not cache", CategoryCache, "cache", false},

		// Build
		{"dist", CategoryBuild, "dist", true},
		{"build", CategoryBuild, "build", true},
		{"target", CategoryBuild, "target", true},
		{"nested target", CategoryBuild, "rust-project/target/debug", true},
		{"so file", CategoryBuild, "lib.so", true},
		{"not build", CategoryBuild, "builder", false},

		// Virtual env
		{"venv", CategoryVirtualEnv, "venv", true},
		{".venv", CategoryVirtualEnv, ".venv", true},
		{"not venv", CategoryVirtualEnv, "environment", false},

		// OS files
		{"ds_store", CategoryOS, ".DS_Store", true},
		{"thumbs", CategoryOS, "Thumbs.db", true},
		{"resource fork", CategoryOS, "._hidden", true},
		{"not os", CategoryOS, "dsstore", false},

		// Logs
		{"log dir", CategoryLogs, "logs", true},
		{"log file", CategoryLogs, "app.log", true},
		{"not log", CategoryLogs, "logger", false},

		// App reserved (only at root)
		{"inbox at root", CategoryAppReserved, "inbox", true},
		{"app at root", CategoryAppReserved, "app", true},
		{"inbox nested", CategoryAppReserved, "foo/inbox", false}, // Not at root
		{"not reserved", CategoryAppReserved, "library", false},

		// Combined categories
		{"git with default", ExcludeDefault, ".git", true},
		{"node_modules with default", ExcludeDefault, "node_modules", true},
		{"regular with default", ExcludeDefault, "documents", false},

		// Complex paths
		{"deep hidden", CategoryHidden, "a/b/c/.hidden/d", true},
		{"deep vcs", CategoryVCS, "projects/myapp/.git/objects", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := NewPathFilter(tt.exclusions)
			if got := f.IsExcluded(tt.path); got != tt.want {
				t.Errorf("IsExcluded(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestPathFilter_IsExcludedEntry(t *testing.T) {
	tests := []struct {
		name       string
		exclusions Category
		entry      string
		atRoot     bool
		want       bool
	}{
		// App reserved - root vs nested
		{"inbox at root", CategoryAppReserved, "inbox", true, true},
		{"inbox not at root", CategoryAppReserved, "inbox", false, false},
		{"app at root", CategoryAppReserved, "app", true, true},
		{"app not at root", CategoryAppReserved, "app", false, false},

		// Case insensitivity for OS files
		{"DS_Store upper", CategoryOS, ".DS_Store", false, true},
		{"ds_store lower", CategoryOS, ".ds_store", false, true},
		{"Thumbs.db", CategoryOS, "Thumbs.db", false, true},
		{"thumbs.db lower", CategoryOS, "thumbs.db", false, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := NewPathFilter(tt.exclusions)
			if got := f.IsExcludedEntry(tt.entry, tt.atRoot); got != tt.want {
				t.Errorf("IsExcludedEntry(%q, %v) = %v, want %v", tt.entry, tt.atRoot, got, tt.want)
			}
		})
	}
}

func TestPathFilter_Presets(t *testing.T) {
	// Test that presets combine categories correctly
	tests := []struct {
		name   string
		preset Category
		check  Category
		want   bool
	}{
		{"default has hidden", ExcludeDefault, CategoryHidden, true},
		{"default has vcs", ExcludeDefault, CategoryVCS, true},
		{"default has deps", ExcludeDefault, CategoryDependencies, true},
		{"default no app reserved", ExcludeDefault, CategoryAppReserved, false},

		{"tree has hidden", ExcludeForTree, CategoryHidden, true},
		{"tree has deps", ExcludeForTree, CategoryDependencies, true},
		{"tree has app reserved", ExcludeForTree, CategoryAppReserved, true},
		{"tree no build", ExcludeForTree, CategoryBuild, false},

		{"indexing has all common", ExcludeForIndexing, CategoryHidden | CategoryVCS | CategoryDependencies, true},
		{"indexing has build", ExcludeForIndexing, CategoryBuild, true},

		{"all has everything", ExcludeAll, CategoryHidden | CategoryBackup | CategoryVCS | CategoryIDE |
			CategoryDependencies | CategoryCache | CategoryBuild | CategoryVirtualEnv |
			CategoryOS | CategoryLogs | CategoryAppReserved, true},

		{"none has nothing", ExcludeNone, CategoryHidden, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hasCategory := tt.preset&tt.check == tt.check
			if hasCategory != tt.want {
				t.Errorf("preset %v has category %v = %v, want %v", tt.preset, tt.check, hasCategory, tt.want)
			}
		})
	}
}

func TestDefaultPathFilter(t *testing.T) {
	f := DefaultPathFilter()
	if f == nil {
		t.Fatal("DefaultPathFilter returned nil")
	}
	if f.exclusions != ExcludeDefault {
		t.Errorf("DefaultPathFilter exclusions = %v, want %v", f.exclusions, ExcludeDefault)
	}
}
