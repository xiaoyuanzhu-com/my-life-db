package fs

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

type lightweightMetadataDB struct {
	Database
	paths   []string
	deleted []string
}

func (m *lightweightMetadataDB) GetFileByPath(string) (*db.FileRecord, error) { return nil, nil }
func (m *lightweightMetadataDB) ListAllFilePaths() ([]string, error)          { return m.paths, nil }
func (m *lightweightMetadataDB) BatchDeleteFilesWithCascade(paths []string) error {
	m.deleted = append(m.deleted, paths...)
	return nil
}

func TestSkippedArtifactsRemainBrowsableAndKeepPins(t *testing.T) {
	root := t.TempDir()
	path := "projects/demo/target/output.txt"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, path), []byte("artifact"), 0600); err != nil {
		t.Fatal(err)
	}
	m := &lightweightMetadataDB{paths: []string{path, "projects/demo/target/deleted.txt"}}
	s := NewService(Config{DataRoot: root, DB: m})
	info, err := s.GetFileInfo(context.Background(), path)
	if err != nil || info == nil || info.Path != path || info.Size == nil || *info.Size != 8 {
		t.Fatalf("artifact not browsable: %#v %v", info, err)
	}
	removed := s.scanner.reconcileOrphans(map[string]bool{})
	if removed != 1 || len(m.deleted) != 1 || m.deleted[0] != "projects/demo/target/deleted.txt" {
		t.Fatalf("removed existing skipped artifact and pins: %v", m.deleted)
	}
}
