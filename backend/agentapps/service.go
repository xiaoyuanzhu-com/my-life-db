// Package agentapps manages agent-published web applications.
// Agents can publish static files (HTML, images, PDFs, etc.) organized
// by app name, and the backend serves them at /apps/<app>/<path>.
package agentapps

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Service manages agent app files under APP_DATA_DIR/agent-apps/.
type Service struct {
	baseDir string // e.g. /path/to/app-data/agent-apps
}

// NewService creates a new agent apps service.
func NewService(appDataDir string) *Service {
	dir := filepath.Join(appDataDir, "agent-apps")
	return &Service{baseDir: dir}
}

// BaseDir returns the base directory for agent apps.
func (s *Service) BaseDir() string {
	return s.baseDir
}

// AppInfo describes a published agent app.
type AppInfo struct {
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updatedAt"`
	Files     []string  `json:"files,omitempty"`
}

// FileInfo describes a single file in an agent app.
type FileInfo struct {
	App       string    `json:"app"`
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// PutFile writes a base64-encoded file to <app>/<path>.
// Creates directories as needed.
func (s *Service) PutFile(app, path, contentBase64 string) error {
	if err := validateAppName(app); err != nil {
		return err
	}
	if err := validatePath(path); err != nil {
		return err
	}

	data, err := base64.StdEncoding.DecodeString(contentBase64)
	if err != nil {
		return fmt.Errorf("invalid base64 content: %w", err)
	}

	fullPath := filepath.Join(s.baseDir, app, path)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

// GetFile reads a file and returns its base64-encoded content.
func (s *Service) GetFile(app, path string) (string, error) {
	if err := validateAppName(app); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}

	fullPath := filepath.Join(s.baseDir, app, path)

	data, err := os.ReadFile(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("file not found: %s/%s", app, path)
		}
		return "", fmt.Errorf("failed to read file: %w", err)
	}

	return base64.StdEncoding.EncodeToString(data), nil
}

// ListApps returns all published apps with their metadata.
func (s *Service) ListApps() ([]AppInfo, error) {
	entries, err := os.ReadDir(s.baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []AppInfo{}, nil
		}
		return nil, fmt.Errorf("failed to read apps directory: %w", err)
	}

	var apps []AppInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		// Find latest modification time across all files in the app
		latestMod := info.ModTime()
		var files []string
		appDir := filepath.Join(s.baseDir, entry.Name())
		filepath.Walk(appDir, func(path string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(appDir, path)
			files = append(files, rel)
			if fi.ModTime().After(latestMod) {
				latestMod = fi.ModTime()
			}
			return nil
		})

		apps = append(apps, AppInfo{
			Name:      entry.Name(),
			UpdatedAt: latestMod,
			Files:     files,
		})
	}

	sort.Slice(apps, func(i, j int) bool {
		return apps[i].UpdatedAt.After(apps[j].UpdatedAt)
	})

	return apps, nil
}

// ListFiles returns all files in a specific app.
func (s *Service) ListFiles(app string) ([]FileInfo, error) {
	if err := validateAppName(app); err != nil {
		return nil, err
	}

	appDir := filepath.Join(s.baseDir, app)
	if _, err := os.Stat(appDir); os.IsNotExist(err) {
		return []FileInfo{}, nil
	}

	var files []FileInfo
	filepath.Walk(appDir, func(path string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(appDir, path)
		files = append(files, FileInfo{
			App:       app,
			Path:      rel,
			Size:      fi.Size(),
			UpdatedAt: fi.ModTime(),
		})
		return nil
	})

	return files, nil
}

// DeleteFile removes a single file from an app.
func (s *Service) DeleteFile(app, path string) error {
	if err := validateAppName(app); err != nil {
		return err
	}
	if err := validatePath(path); err != nil {
		return err
	}

	fullPath := filepath.Join(s.baseDir, app, path)
	if err := os.Remove(fullPath); err != nil {
		if os.IsNotExist(err) {
			return nil // already gone
		}
		return fmt.Errorf("failed to delete file: %w", err)
	}

	// Clean up empty parent directories (up to app dir)
	s.cleanEmptyDirs(filepath.Dir(fullPath), filepath.Join(s.baseDir, app))
	return nil
}

// DeleteApp removes an entire app and all its files.
func (s *Service) DeleteApp(app string) error {
	if err := validateAppName(app); err != nil {
		return err
	}

	appDir := filepath.Join(s.baseDir, app)
	if err := os.RemoveAll(appDir); err != nil {
		return fmt.Errorf("failed to delete app: %w", err)
	}
	return nil
}

// cleanEmptyDirs removes empty directories from path up to stopAt.
func (s *Service) cleanEmptyDirs(path, stopAt string) {
	for path != stopAt && path != s.baseDir {
		entries, err := os.ReadDir(path)
		if err != nil || len(entries) > 0 {
			break
		}
		os.Remove(path)
		path = filepath.Dir(path)
	}
}

func validateAppName(app string) error {
	if app == "" {
		return fmt.Errorf("app name is required")
	}
	if strings.Contains(app, "..") || strings.Contains(app, "/") || strings.Contains(app, "\\") {
		return fmt.Errorf("invalid app name: %q", app)
	}
	return nil
}

func validatePath(path string) error {
	if path == "" {
		return fmt.Errorf("path is required")
	}
	if strings.Contains(path, "..") {
		return fmt.Errorf("invalid path: %q", path)
	}
	return nil
}
