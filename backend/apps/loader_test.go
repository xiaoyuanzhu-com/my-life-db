package apps

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestLoadAll_ReadsAllYamlFiles(t *testing.T) {
	fs := fstest.MapFS{
		"content/foo.yaml": {Data: []byte("id: foo\nname: Foo\ncategory: social\n")},
		"content/bar.yaml": {Data: []byte("id: bar\nname: Bar\ncategory: chat\n")},
	}
	got, err := LoadAll(fs, "content")
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 apps, got %d", len(got))
	}
	if got[0].Name != "Bar" || got[1].Name != "Foo" {
		t.Fatalf("want sorted [Bar, Foo], got [%s, %s]", got[0].Name, got[1].Name)
	}
}

func TestLoadAll_MalformedYAMLError(t *testing.T) {
	fsys := fstest.MapFS{
		"content/bad.yaml": {Data: []byte("id: foo\n\tname: broken")}, // tab indent = yaml error
	}
	_, err := LoadAll(fsys, "content")
	if err == nil {
		t.Fatalf("want error, got nil")
	}
	if !strings.Contains(err.Error(), "bad.yaml") {
		t.Fatalf("error should name the file; got: %v", err)
	}
}

func TestLoadOne_WithDoc(t *testing.T) {
	fs := fstest.MapFS{
		"content/foo.yaml": {Data: []byte("id: foo\nname: Foo\ncategory: social\n")},
		"content/foo.md":   {Data: []byte("# Foo\n\nHello.")},
	}
	got, err := LoadOne(fs, "content", "foo")
	if err != nil {
		t.Fatalf("LoadOne: %v", err)
	}
	if got.ID != "foo" {
		t.Fatalf("id: want foo, got %q", got.ID)
	}
	if got.Doc == "" {
		t.Fatalf("doc should be populated")
	}
}

func TestLoadOne_NoDoc(t *testing.T) {
	fs := fstest.MapFS{
		"content/foo.yaml": {Data: []byte("id: foo\nname: Foo\ncategory: social\n")},
	}
	got, err := LoadOne(fs, "content", "foo")
	if err != nil {
		t.Fatalf("LoadOne: %v", err)
	}
	if got.Doc != "" {
		t.Fatalf("doc should be empty, got %q", got.Doc)
	}
}

func TestLoadOne_NotFound(t *testing.T) {
	fs := fstest.MapFS{}
	_, err := LoadOne(fs, "content", "missing")
	if err == nil {
		t.Fatalf("want error, got nil")
	}
}

func TestContentFS_LoadsSeededApps(t *testing.T) {
	got, err := LoadAll(contentFS, ContentDir)
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(got) < 7 {
		t.Fatalf("want >= 7 seeded apps, got %d", len(got))
	}
}
