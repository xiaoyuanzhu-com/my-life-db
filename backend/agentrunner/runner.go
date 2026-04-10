package agentrunner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Config holds the configuration for the agent runner.
type Config struct {
	AgentsDir   string           // path to agents/ folder
	Registry    *hooks.Registry  // hooks registry
	CronHook    *hooks.CronHook  // for registering cron schedules
	AgentClient *agentsdk.Client // for spawning ACP sessions (nil in tests)
	WorkingDir  string           // working directory for sessions

	// Called when a session is created. Server uses this to persist to DB
	// and wire frame broadcasting.
	OnSessionCreated func(sess agentsdk.Session, def *AgentDef, payload hooks.Payload)
}

// Runner loads agent definitions from markdown files, subscribes to hooks,
// and spawns ACP sessions when triggers fire.
type Runner struct {
	cfg  Config
	mu   sync.RWMutex
	defs []*AgentDef
}

// New creates a new Runner with the given configuration.
func New(cfg Config) *Runner {
	return &Runner{cfg: cfg}
}

// LoadDefs scans AgentsDir for *.md files, parses each, and returns all
// agent definitions (including disabled ones). Hidden files and non-.md
// files are skipped.
func (r *Runner) LoadDefs() ([]*AgentDef, error) {
	entries, err := os.ReadDir(r.cfg.AgentsDir)
	if err != nil {
		return nil, fmt.Errorf("reading agents dir %s: %w", r.cfg.AgentsDir, err)
	}

	var defs []*AgentDef
	for _, entry := range entries {
		name := entry.Name()

		// Skip directories
		if entry.IsDir() {
			continue
		}
		// Skip hidden files
		if strings.HasPrefix(name, ".") {
			continue
		}
		// Skip non-markdown files
		if filepath.Ext(name) != ".md" {
			continue
		}

		data, err := os.ReadFile(filepath.Join(r.cfg.AgentsDir, name))
		if err != nil {
			log.Error().Err(err).Str("file", name).Msg("failed to read agent file")
			continue
		}

		def, err := ParseAgentDef(data, name)
		if err != nil {
			log.Error().Err(err).Str("file", name).Msg("failed to parse agent definition")
			continue
		}

		defs = append(defs, def)
	}

	r.mu.Lock()
	r.defs = defs
	r.mu.Unlock()

	return defs, nil
}

// Start loads agent definitions and registers triggers for enabled agents.
func (r *Runner) Start(ctx context.Context) error {
	defs, err := r.LoadDefs()
	if err != nil {
		return fmt.Errorf("loading agent definitions: %w", err)
	}

	for _, def := range defs {
		if def.Enabled != nil && !*def.Enabled {
			log.Info().Str("agent", def.Name).Msg("skipping disabled agent")
			continue
		}
		if err := r.registerTrigger(def); err != nil {
			log.Error().Err(err).Str("agent", def.Name).Msg("failed to register trigger")
			continue
		}
		log.Info().Str("agent", def.Name).Str("trigger", def.Trigger).Msg("agent trigger registered")
	}

	log.Info().Int("total", len(defs)).Msg("agent runner started")
	return nil
}

// Stop is a no-op. Cleanup is done by hooks/agentClient shutdown.
func (r *Runner) Stop() error {
	return nil
}

// SetOnSessionCreated sets the callback invoked when an auto-run agent session
// is created. This allows main.go to wire DB persistence and frame broadcasting
// without circular imports between server and api packages.
func (r *Runner) SetOnSessionCreated(fn func(sess agentsdk.Session, def *AgentDef, payload hooks.Payload)) {
	r.cfg.OnSessionCreated = fn
}

// registerTrigger sets up the hook subscription for an agent definition.
// For cron triggers, it registers a cron schedule and subscribes to cron.tick
// events matching the agent name. For file event triggers, it subscribes
// directly to the event type.
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
		// Subscribe to cron.tick and filter by name
		agentDef := def // capture for closure
		r.cfg.Registry.Subscribe(hooks.EventCronTick, func(ctx context.Context, payload hooks.Payload) {
			name, _ := payload.Data["name"].(string)
			if name == agentDef.Name {
				r.execute(ctx, agentDef, payload)
			}
		})

	case string(hooks.EventFileCreated),
		string(hooks.EventFileMoved),
		string(hooks.EventFileDeleted),
		string(hooks.EventFileChanged):
		agentDef := def
		r.cfg.Registry.Subscribe(hooks.EventType(def.Trigger), func(ctx context.Context, payload hooks.Payload) {
			r.execute(ctx, agentDef, payload)
		})

	default:
		return fmt.Errorf("unknown trigger type: %s", def.Trigger)
	}

	return nil
}

// execute builds a prompt, creates an ACP session, calls OnSessionCreated,
// sends the prompt, and drains frames.
func (r *Runner) execute(ctx context.Context, def *AgentDef, payload hooks.Payload) {
	if r.cfg.AgentClient == nil {
		log.Warn().Str("agent", def.Name).Msg("no agent client configured, skipping execution")
		return
	}

	prompt := r.buildPrompt(def, payload)

	session, err := r.cfg.AgentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:      agentsdk.AgentType(def.Agent),
		WorkingDir: r.cfg.WorkingDir,
		Mode:       "bypassPermissions",
	})
	if err != nil {
		log.Error().Err(err).Str("agent", def.Name).Msg("failed to create ACP session")
		return
	}

	if r.cfg.OnSessionCreated != nil {
		r.cfg.OnSessionCreated(session, def, payload)
	}

	// Send prompt and drain frames in a goroutine
	go func() {
		defer session.Close()

		frames, err := session.Send(ctx, prompt)
		if err != nil {
			log.Error().Err(err).Str("agent", def.Name).Str("session", session.ID()).Msg("failed to send prompt")
			return
		}

		// Drain all frames
		for range frames {
		}

		log.Info().Str("agent", def.Name).Str("session", session.ID()).Msg("agent session completed")
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
