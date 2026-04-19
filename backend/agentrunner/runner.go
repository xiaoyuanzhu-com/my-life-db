package agentrunner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SessionParams describes how to create an agent session.
// Passed to Config.CreateSession by the runner.
type SessionParams struct {
	AgentType      string // "claude_code" or "codex"
	WorkingDir     string
	Title          string
	Message        string // initial prompt
	PermissionMode string
	Source         string // "auto"
	AgentName      string // agent folder name
}

// Config holds the configuration for the agent runner.
type Config struct {
	AgentsDir   string          // path to agents/ folder
	Registry    *hooks.Registry // hooks registry
	CronHook    *hooks.CronHook // for registering cron schedules
	WorkingDir  string          // working directory for sessions

	// CreateSession creates an agent session through the shared api path.
	// Returns the ACP session for lifecycle management and a channel that
	// closes when the initial prompt completes.
	// When nil, session creation is skipped (tests).
	CreateSession func(ctx context.Context, params SessionParams) (acpSession agentsdk.Session, promptDone <-chan struct{}, err error)
}

// Runner loads agent definitions from markdown files, subscribes to hooks,
// and spawns ACP sessions when triggers fire.
type Runner struct {
	cfg    Config
	mu     sync.RWMutex
	defs   []*AgentDef
	cancel context.CancelFunc // for stopping the watcher

	// Track which event types we've already subscribed to (subscribe once).
	subscribedEvents map[hooks.EventType]bool
	// Track active cron schedule names so we can diff on reload.
	activeCrons map[string]string // name -> schedule expression
}

// New creates a new Runner with the given configuration.
func New(cfg Config) *Runner {
	return &Runner{
		cfg:              cfg,
		subscribedEvents: make(map[hooks.EventType]bool),
		activeCrons:      make(map[string]string),
	}
}

// LoadDefs walks AgentsDir, treating each subdirectory as an agent. It reads
// <name>/<name>.md for each agent folder. Flat .md files at the root are
// ignored with a debug log. Subdirs missing their inner .md are skipped with
// a warning. Hidden dirs (starting with ".") are skipped silently.
func (r *Runner) LoadDefs() error {
	entries, err := os.ReadDir(r.cfg.AgentsDir)
	if err != nil {
		if os.IsNotExist(err) {
			r.mu.Lock()
			r.defs = nil
			r.mu.Unlock()
			return nil
		}
		return fmt.Errorf("reading agents dir %s: %w", r.cfg.AgentsDir, err)
	}

	var defs []*AgentDef
	for _, entry := range entries {
		if !entry.IsDir() {
			if strings.HasSuffix(entry.Name(), ".md") {
				log.Debug().Str("file", entry.Name()).Msg("agentrunner: ignoring flat .md file at agents root")
			}
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		filename := name + ".md"
		path := filepath.Join(r.cfg.AgentsDir, name, filename)
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				log.Warn().Str("agent", name).Str("expected", path).Msg("agentrunner: agent folder missing its .md file, skipping")
				continue
			}
			return err
		}
		def, err := ParseAgentDef(data, name, filename)
		if err != nil {
			log.Warn().Err(err).Str("agent", name).Msg("agentrunner: failed to parse agent definition")
			continue
		}
		defs = append(defs, def)
	}

	r.mu.Lock()
	r.defs = defs
	r.mu.Unlock()

	return nil
}

// Start loads agent definitions, registers triggers, and starts watching
// the agents directory for changes.
func (r *Runner) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	// Load initial defs and register triggers
	if err := r.loadAndRegister(); err != nil {
		// Log but don't fail — agents dir might not exist yet
		log.Warn().Err(err).Msg("initial agent load failed, will retry on file changes")
	}

	// Start watching agents dir for changes
	go r.watchAgentsDir(ctx)

	return nil
}

// Stop cancels the file watcher goroutine.
func (r *Runner) Stop() error {
	if r.cancel != nil {
		r.cancel()
	}
	return nil
}

// SetCreateSession sets the callback used to create agent sessions.
// This allows main.go to wire session creation through the shared api path
// without circular imports between server and api packages.
func (r *Runner) SetCreateSession(fn func(ctx context.Context, params SessionParams) (agentsdk.Session, <-chan struct{}, error)) {
	r.cfg.CreateSession = fn
}

// loadAndRegister loads defs from disk, subscribes to event types (once),
// and registers cron schedules.
func (r *Runner) loadAndRegister() error {
	if err := r.LoadDefs(); err != nil {
		return fmt.Errorf("loading agent definitions: %w", err)
	}

	defs := r.Defs()
	enabledCount := 0
	for _, def := range defs {
		if def.Enabled != nil && !*def.Enabled {
			log.Info().Str("agent", def.Name).Msg("skipping disabled agent")
			continue
		}
		enabledCount++

		if err := r.registerTrigger(def); err != nil {
			log.Error().Err(err).Str("agent", def.Name).Msg("failed to register trigger")
			continue
		}
		log.Info().Str("agent", def.Name).Str("trigger", def.Trigger).Msg("agent trigger registered")
	}

	log.Info().Int("total", len(defs)).Int("enabled", enabledCount).Msg("agent runner started")
	return nil
}

// registerTrigger sets up the hook subscription for an agent definition.
// For event-based triggers, it subscribes ONCE per event type using dynamic
// lookup so that reloading defs automatically picks up changes.
// For cron triggers, it registers the cron schedule and subscribes once to
// cron.tick with dynamic lookup.
func (r *Runner) registerTrigger(def *AgentDef) error {
	if r.cfg.Registry == nil {
		return fmt.Errorf("no registry configured")
	}

	switch def.Trigger {
	case "cron":
		if r.cfg.CronHook == nil {
			return fmt.Errorf("no cron hook configured")
		}
		if err := r.cfg.CronHook.AddSchedule(def.Name, def.Schedule); err != nil {
			return fmt.Errorf("adding cron schedule: %w", err)
		}
		r.activeCrons[def.Name] = def.Schedule

		// Subscribe to cron.tick ONCE — callback does dynamic lookup
		r.subscribeOnce(hooks.EventCronTick, func(ctx context.Context, payload hooks.Payload) {
			name, _ := payload.Data["name"].(string)
			r.mu.RLock()
			var match *AgentDef
			for _, d := range r.defs {
				if d.Trigger == "cron" && d.Name == name && d.Enabled != nil && *d.Enabled {
					match = d
					break
				}
			}
			r.mu.RUnlock()
			if match != nil {
				r.execute(ctx, match, payload)
			}
		})

	case string(hooks.EventFileCreated),
		string(hooks.EventFileMoved),
		string(hooks.EventFileDeleted),
		string(hooks.EventFileChanged):
		eventType := hooks.EventType(def.Trigger)
		r.subscribeOnce(eventType, func(ctx context.Context, payload hooks.Payload) {
			r.executeMatchingAgents(ctx, def.Trigger, payload)
		})

	default:
		return fmt.Errorf("unknown trigger type: %s", def.Trigger)
	}

	return nil
}

// subscribeOnce subscribes to an event type at most once. Subsequent calls
// for the same event type are no-ops, since the callback uses dynamic lookup.
func (r *Runner) subscribeOnce(eventType hooks.EventType, fn func(context.Context, hooks.Payload)) {
	if r.subscribedEvents[eventType] {
		return
	}
	r.subscribedEvents[eventType] = true
	r.cfg.Registry.Subscribe(eventType, fn)
}

// executeMatchingAgents finds all enabled agents matching the given trigger
// and executes them.
func (r *Runner) executeMatchingAgents(ctx context.Context, trigger string, p hooks.Payload) {
	eventPath, _ := p.Data["path"].(string)

	r.mu.RLock()
	var matching []*AgentDef
	for _, def := range r.defs {
		if def.Trigger == trigger && def.Enabled != nil && *def.Enabled {
			if def.Path != "" {
				if eventPath == "" {
					continue
				}
				matched, err := doublestar.Match(def.Path, eventPath)
				if err != nil {
					log.Error().Err(err).Str("agent", def.Name).Str("pattern", def.Path).Msg("bad path glob pattern")
					continue
				}
				if !matched {
					continue
				}
			}
			matching = append(matching, def)
		}
	}
	r.mu.RUnlock()

	for _, def := range matching {
		r.execute(ctx, def, p)
	}
}

// watchAgentsDir uses fsnotify to watch the agents directory for changes.
// On any .md file change, it debounces and reloads definitions.
func (r *Runner) watchAgentsDir(ctx context.Context) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Error().Err(err).Msg("failed to create agents dir watcher")
		return
	}
	defer watcher.Close()

	// Create agents dir if it doesn't exist
	if err := os.MkdirAll(r.cfg.AgentsDir, 0755); err != nil {
		log.Error().Err(err).Str("dir", r.cfg.AgentsDir).Msg("failed to create agents dir")
		return
	}

	if err := watcher.Add(r.cfg.AgentsDir); err != nil {
		log.Error().Err(err).Str("dir", r.cfg.AgentsDir).Msg("failed to watch agents dir")
		return
	}

	log.Info().Str("dir", r.cfg.AgentsDir).Msg("watching agents directory for changes")

	// Debounce: wait 500ms after last event before reloading
	var timer *time.Timer
	for {
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			// Only react to .md file changes
			if filepath.Ext(event.Name) != ".md" {
				continue
			}

			log.Info().
				Str("file", filepath.Base(event.Name)).
				Str("op", event.Op.String()).
				Msg("agent file change detected, scheduling reload")

			if timer != nil {
				timer.Stop()
			}
			timer = time.AfterFunc(500*time.Millisecond, func() {
				r.reload()
			})
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Error().Err(err).Msg("agents dir watcher error")
		}
	}
}

// reload re-reads all agent definitions from disk, syncs cron schedules,
// and ensures event subscriptions exist for any new trigger types.
// Event-based subscriptions use dynamic lookup, so updating r.defs is
// sufficient for them — only cron schedules need explicit syncing.
func (r *Runner) reload() {
	if err := r.LoadDefs(); err != nil {
		log.Error().Err(err).Msg("failed to reload agent definitions")
		return
	}

	defs := r.Defs()
	r.syncCronSchedules(defs)

	enabledCount := 0
	for _, def := range defs {
		if def.Enabled == nil || !*def.Enabled {
			continue
		}
		enabledCount++

		// Ensure event subscriptions exist for any new trigger types.
		// subscribeOnce is a no-op if already subscribed.
		if def.Trigger != "cron" && r.cfg.Registry != nil {
			eventType := hooks.EventType(def.Trigger)
			trigger := def.Trigger // capture for closure
			r.subscribeOnce(eventType, func(ctx context.Context, payload hooks.Payload) {
				r.executeMatchingAgents(ctx, trigger, payload)
			})
		}
	}

	log.Info().Int("total", len(defs)).Int("enabled", enabledCount).Msg("agent definitions reloaded")
}

// syncCronSchedules compares the previously active cron schedules with the
// new defs and updates CronHook accordingly: removes schedules for agents
// that were deleted or disabled, and adds/updates schedules for new or
// changed agents.
func (r *Runner) syncCronSchedules(newDefs []*AgentDef) {
	if r.cfg.CronHook == nil {
		return
	}

	// Build map of desired cron agents from new defs
	desired := make(map[string]string)
	for _, def := range newDefs {
		if def.Trigger == "cron" && def.Enabled != nil && *def.Enabled {
			desired[def.Name] = def.Schedule
		}
	}

	// Remove schedules that are no longer desired
	for name := range r.activeCrons {
		if _, ok := desired[name]; !ok {
			r.cfg.CronHook.RemoveSchedule(name)
			log.Info().Str("agent", name).Msg("removed cron schedule")
		}
	}

	// Add or update schedules
	for name, schedule := range desired {
		oldSchedule, exists := r.activeCrons[name]
		if !exists || oldSchedule != schedule {
			if err := r.cfg.CronHook.AddSchedule(name, schedule); err != nil {
				log.Error().Err(err).Str("agent", name).Str("schedule", schedule).Msg("failed to update cron schedule")
				continue
			}
			if exists {
				log.Info().Str("agent", name).Str("schedule", schedule).Msg("updated cron schedule")
			} else {
				log.Info().Str("agent", name).Str("schedule", schedule).Msg("added cron schedule")
			}
		}
	}

	// Replace active crons with the desired set
	r.activeCrons = desired
}

// Defs returns the current agent definitions (thread-safe).
func (r *Runner) Defs() []*AgentDef {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*AgentDef, len(r.defs))
	copy(out, r.defs)
	return out
}

// execute builds a prompt, creates a session via the shared path, and
// closes the ACP session after completion (fire-and-forget).
func (r *Runner) execute(ctx context.Context, def *AgentDef, payload hooks.Payload) {
	if r.cfg.CreateSession == nil {
		log.Warn().Str("agent", def.Name).Msg("no CreateSession configured, skipping execution")
		return
	}

	prompt := r.buildPrompt(def, payload)

	// Create session through the shared api path. The shared function
	// handles DB persistence, frame broadcasting, synth user message,
	// and sending the prompt in a background goroutine.
	session, promptDone, err := r.cfg.CreateSession(ctx, SessionParams{
		AgentType:      def.Agent,
		WorkingDir:     r.cfg.WorkingDir,
		Title:          def.Name,
		Message:        prompt,
		PermissionMode: "bypassPermissions",
		Source:         "auto",
		AgentName:      def.Name,
	})
	if err != nil {
		log.Error().Err(err).Str("agent", def.Name).Msg("failed to create agent session")
		return
	}

	// Wait for the prompt to complete, then close the session (fire-and-forget).
	go func() {
		if promptDone != nil {
			<-promptDone
		}
		session.Close()
		log.Info().Str("agent", def.Name).Str("session", session.ID()).Msg("auto-run agent session completed")
	}()
}

// buildPrompt prepends trigger context to the agent's prompt.
func (r *Runner) buildPrompt(def *AgentDef, payload hooks.Payload) string {
	var b strings.Builder

	b.WriteString("[Trigger Context]\n")
	b.WriteString(fmt.Sprintf("Event: %s\n", payload.EventType))
	b.WriteString(fmt.Sprintf("Time: %s\n", payload.Timestamp.UTC().Format("2006-01-02T15:04:05Z")))

	switch def.Trigger {
	case "cron":
		if schedule, ok := payload.Data["schedule"].(string); ok {
			b.WriteString(fmt.Sprintf("Schedule: %s\n", schedule))
		}

	default:
		// File events: include path, name, folder
		if path, ok := payload.Data["path"].(string); ok {
			b.WriteString(fmt.Sprintf("Path: %s\n", path))
		}
		if name, ok := payload.Data["name"].(string); ok {
			b.WriteString(fmt.Sprintf("Name: %s\n", name))
		}
		if folder, ok := payload.Data["folder"].(string); ok {
			b.WriteString(fmt.Sprintf("Folder: %s\n", folder))
		}
	}

	b.WriteString("\n---\n\n")
	b.WriteString(def.Prompt)

	return b.String()
}
