package agentrunner

import (
	"context"
	"encoding/json"
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
	DefaultModel   string // optional — empty means "let AgentManager pick the per-agent default"
	TriggerKind    string // event type that fired this run, e.g. "cron.tick", "file.created"
	TriggerData    string // JSON-encoded trigger payload data (path, schedule, etc.)
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

	case string(hooks.EventFileCreated),
		string(hooks.EventFileMoved),
		string(hooks.EventFileDeleted),
		string(hooks.EventFileChanged):
		// subscription handled below

	default:
		return fmt.Errorf("unknown trigger type: %s", def.Trigger)
	}

	r.ensureSubscription(def.Trigger)
	return nil
}

// ensureSubscription subscribes the runner to the hook event backing the
// given trigger, at most once per event type. Callbacks use dynamic lookup
// against r.defs, so a single subscription per event type serves every
// agent of that kind — including ones added after startup via reload().
func (r *Runner) ensureSubscription(trigger string) {
	if r.cfg.Registry == nil {
		return
	}
	switch trigger {
	case "cron":
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
		eventType := hooks.EventType(trigger)
		r.subscribeOnce(eventType, func(ctx context.Context, payload hooks.Payload) {
			r.executeMatchingAgents(ctx, trigger, payload)
		})
	}
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
// It watches the root AgentsDir and each existing subdirectory; when a new
// subdirectory appears it is added to the watch set automatically. Any change
// inside a watched path triggers a debounced reload.
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

	// Track watched paths so we can add/remove as subdirectories appear/disappear.
	watched := map[string]struct{}{}
	addWatch := func(p string) {
		if _, ok := watched[p]; ok {
			return
		}
		if err := watcher.Add(p); err != nil {
			log.Warn().Err(err).Str("path", p).Msg("agentrunner: failed to add watch")
			return
		}
		watched[p] = struct{}{}
	}

	// Watch root
	addWatch(r.cfg.AgentsDir)

	// Watch existing subdirectories
	if entries, err := os.ReadDir(r.cfg.AgentsDir); err == nil {
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				addWatch(filepath.Join(r.cfg.AgentsDir, e.Name()))
			}
		}
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

			// If a new subdirectory was created under the root, start watching it.
			if event.Op&fsnotify.Create != 0 {
				if fi, err := os.Stat(event.Name); err == nil && fi.IsDir() {
					if filepath.Dir(event.Name) == r.cfg.AgentsDir && !strings.HasPrefix(filepath.Base(event.Name), ".") {
						addWatch(event.Name)
					}
				}
			}
			// If a watched path was removed or renamed, drop the watch.
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				if _, ok := watched[event.Name]; ok {
					_ = watcher.Remove(event.Name)
					delete(watched, event.Name)
				}
			}

			log.Info().
				Str("file", filepath.Base(event.Name)).
				Str("op", event.Op.String()).
				Msg("agent directory change detected, scheduling reload")

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
		r.ensureSubscription(def.Trigger)
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

// AgentsDir returns the root folder holding agent definitions.
func (r *Runner) AgentsDir() string {
	return r.cfg.AgentsDir
}

// GetDef returns the in-memory def for an agent name, along with the raw
// markdown source read from disk. Returns nil, nil if the agent folder or
// file does not exist.
func (r *Runner) GetDef(name string) (*AgentDef, []byte, error) {
	if err := validateAgentName(name); err != nil {
		return nil, nil, err
	}
	r.mu.RLock()
	var def *AgentDef
	for _, d := range r.defs {
		if d.Name == name {
			def = d
			break
		}
	}
	r.mu.RUnlock()
	path := filepath.Join(r.cfg.AgentsDir, name, name+".md")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return def, nil, nil
		}
		return def, nil, err
	}
	return def, data, nil
}

// ValidateDef parses and validates an agent definition without writing to disk.
// Used by the MCP validateAgent tool to surface frontmatter errors before the
// skill writes the file. Returns the parsed def on success.
func (r *Runner) ValidateDef(name string, markdown []byte) (*AgentDef, error) {
	if err := validateAgentName(name); err != nil {
		return nil, err
	}
	return ParseAgentDef(markdown, name, name+".md")
}

// SaveDef writes markdown for the given agent name, validating the frontmatter
// before touching disk, then triggers a reload so triggers are re-registered.
// Creates the <AgentsDir>/<name>/ folder if it does not exist.
func (r *Runner) SaveDef(name string, markdown []byte) (*AgentDef, error) {
	if err := validateAgentName(name); err != nil {
		return nil, err
	}
	def, err := ParseAgentDef(markdown, name, name+".md")
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(r.cfg.AgentsDir, name)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("creating agent dir: %w", err)
	}
	path := filepath.Join(dir, name+".md")
	if err := os.WriteFile(path, markdown, 0644); err != nil {
		return nil, fmt.Errorf("writing agent file: %w", err)
	}
	// Force an immediate reload — the fs watcher will also fire, but the
	// HTTP response should reflect the new state.
	r.reload()
	return def, nil
}

// DeleteDef removes the agent folder from disk and triggers a reload.
func (r *Runner) DeleteDef(name string) error {
	if err := validateAgentName(name); err != nil {
		return err
	}
	dir := filepath.Join(r.cfg.AgentsDir, name)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("removing agent dir: %w", err)
	}
	r.reload()
	return nil
}

// RunNow manually executes an agent by name, bypassing its trigger.
// Runs async — returns immediately after kicking off the goroutine.
func (r *Runner) RunNow(ctx context.Context, name string) error {
	if err := validateAgentName(name); err != nil {
		return err
	}
	r.mu.RLock()
	var def *AgentDef
	for _, d := range r.defs {
		if d.Name == name {
			def = d
			break
		}
	}
	r.mu.RUnlock()
	if def == nil {
		return fmt.Errorf("agent %q not found", name)
	}
	payload := hooks.Payload{
		EventType: hooks.EventType("manual"),
		Timestamp: time.Now(),
		Data:      map[string]any{"source": "run-now"},
	}
	go r.execute(context.Background(), def, payload)
	return nil
}

// validateAgentName rejects names that could escape the agents dir or
// otherwise clash with filesystem rules. Keep this strict — we treat the
// name as both a folder and a file stem.
func validateAgentName(name string) error {
	if name == "" {
		return fmt.Errorf("agent name is required")
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("agent name must not start with '.'")
	}
	if strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return fmt.Errorf("agent name contains invalid characters")
	}
	return nil
}

// execute builds a prompt, creates a session via the shared path, and
// closes the ACP session after completion (fire-and-forget).
func (r *Runner) execute(ctx context.Context, def *AgentDef, payload hooks.Payload) {
	if r.cfg.CreateSession == nil {
		log.Warn().Str("agent", def.Name).Msg("no CreateSession configured, skipping execution")
		return
	}

	prompt := r.buildPrompt(def, payload)

	// Serialize the trigger payload data so we can persist structured
	// per-run context (schedule, file path, etc.) and render a descriptive
	// label for each session row. Falls back to empty string on encode
	// failure — the session is still created, just without trigger data.
	var triggerData string
	if len(payload.Data) > 0 {
		if b, err := json.Marshal(payload.Data); err == nil {
			triggerData = string(b)
		}
	}

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
		DefaultModel:   def.Model,
		TriggerKind:    string(payload.EventType),
		TriggerData:    triggerData,
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
