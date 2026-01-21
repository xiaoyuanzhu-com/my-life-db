package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// sessionWatcher watches a session's JSONL and todo files for changes
type sessionWatcher struct {
	sessionID   string
	projectPath string
	watcher     *fsnotify.Watcher
	sessionFile string
	todoFile    string

	// Debouncing
	lastUpdate time.Time
	debounce   time.Duration

	// Channels
	updateChan chan string // "messages" or "todos"
}

// NewSessionWatcher creates a new session file watcher
func NewSessionWatcher(sessionID, projectPath string) (*sessionWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	sw := &sessionWatcher{
		sessionID:   sessionID,
		projectPath: projectPath,
		watcher:     watcher,
		debounce:    100 * time.Millisecond, // 100ms debounce
		updateChan:  make(chan string, 10),
	}

	return sw, nil
}

// Start begins watching the session files
func (sw *sessionWatcher) Start(ctx context.Context) error {
	// Find session file
	sessionFile, err := findSessionFile(sw.sessionID, sw.projectPath)
	if err != nil {
		log.Debug().
			Err(err).
			Str("sessionId", sw.sessionID).
			Msg("session file not found yet, will rely on polling")
	} else {
		sw.sessionFile = sessionFile
		if err := sw.watcher.Add(sessionFile); err != nil {
			log.Warn().Err(err).Str("file", sessionFile).Msg("failed to watch session file")
		}
	}

	// Find todo file (may not exist yet)
	homeDir, _ := getHomeDir()
	if homeDir != "" {
		todoFile := filepath.Join(homeDir, ".claude", "todos", sw.sessionID+"-agent-main.json")
		sw.todoFile = todoFile

		// Try to watch todo file (ignore if doesn't exist)
		sw.watcher.Add(todoFile)
	}

	// Event loop
	go sw.eventLoop(ctx)

	return nil
}

// eventLoop processes fsnotify events
func (sw *sessionWatcher) eventLoop(ctx context.Context) {
	debounceTimer := time.NewTimer(0)
	<-debounceTimer.C // drain initial timer

	pendingMessages := false
	pendingTodos := false

	for {
		select {
		case event, ok := <-sw.watcher.Events:
			if !ok {
				return
			}

			// Only care about Write events
			if event.Op&fsnotify.Write != fsnotify.Write {
				continue
			}

			// Determine what changed
			if strings.HasSuffix(event.Name, ".jsonl") {
				pendingMessages = true
			} else if strings.HasSuffix(event.Name, ".json") {
				pendingTodos = true
			}

			// Reset debounce timer
			debounceTimer.Reset(sw.debounce)

		case <-debounceTimer.C:
			// Debounce period elapsed, send updates
			if pendingMessages {
				select {
				case sw.updateChan <- "messages":
				default:
				}
				pendingMessages = false
			}
			if pendingTodos {
				select {
				case sw.updateChan <- "todos":
				default:
				}
				pendingTodos = false
			}

		case err, ok := <-sw.watcher.Errors:
			if !ok {
				return
			}
			log.Error().Err(err).Str("sessionId", sw.sessionID).Msg("fsnotify error")

		case <-ctx.Done():
			return
		}
	}
}

// Updates returns the update channel
func (sw *sessionWatcher) Updates() <-chan string {
	return sw.updateChan
}

// Close stops watching and cleans up
func (sw *sessionWatcher) Close() {
	if sw.watcher != nil {
		sw.watcher.Close()
	}
	close(sw.updateChan)
}

// getHomeDir returns the user's home directory
func getHomeDir() (string, error) {
	return os.UserHomeDir()
}
