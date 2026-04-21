package apps

import (
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
