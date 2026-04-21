package apps

import (
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// LoadAll parses every *.yaml file under dir into a sorted slice of App.
func LoadAll(fsys fs.FS, dir string) ([]App, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read dir %q: %w", dir, err)
	}
	var apps []App
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		data, err := fs.ReadFile(fsys, path.Join(dir, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		var a App
		if err := yaml.Unmarshal(data, &a); err != nil {
			return nil, fmt.Errorf("parse %s: %w", e.Name(), err)
		}
		apps = append(apps, a)
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].Name < apps[j].Name })
	return apps, nil
}

// LoadOne returns the AppDetail for id: the registry entry plus co-located doc
// markdown when present. Returns an error if the yaml file does not exist.
func LoadOne(fsys fs.FS, dir, id string) (*AppDetail, error) {
	yamlPath := path.Join(dir, id+".yaml")
	data, err := fs.ReadFile(fsys, yamlPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", yamlPath, err)
	}
	var a App
	if err := yaml.Unmarshal(data, &a); err != nil {
		return nil, fmt.Errorf("parse %s: %w", yamlPath, err)
	}
	detail := &AppDetail{App: a}
	if doc, err := fs.ReadFile(fsys, path.Join(dir, id+".md")); err == nil {
		detail.Doc = string(doc)
	}
	return detail, nil
}
