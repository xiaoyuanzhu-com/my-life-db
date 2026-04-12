package hooks

import (
	"context"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// CronHook manages named cron schedules and emits cron.tick events.
type CronHook struct {
	registry  *Registry
	scheduler *cron.Cron
	mu        sync.Mutex
	entries   map[string]cron.EntryID // name → entry ID
}

// NewCronHook creates a CronHook with standard 5-field cron scheduling.
func NewCronHook(registry *Registry) *CronHook {
	return &CronHook{
		registry:  registry,
		scheduler: cron.New(),
		entries:   make(map[string]cron.EntryID),
	}
}

// Type returns EventCronTick.
func (h *CronHook) Type() EventType {
	return EventCronTick
}

// Start starts the cron scheduler.
func (h *CronHook) Start(ctx context.Context) error {
	h.scheduler.Start()
	return nil
}

// Stop stops the scheduler and waits for running jobs to complete.
func (h *CronHook) Stop() error {
	ctx := h.scheduler.Stop()
	<-ctx.Done()
	return nil
}

// AddSchedule adds or replaces a named cron schedule. When the schedule fires,
// it emits a cron.tick event with the schedule name and expression in the payload.
func (h *CronHook) AddSchedule(name string, expr string) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Remove existing entry with same name if present.
	if id, exists := h.entries[name]; exists {
		h.scheduler.Remove(id)
		delete(h.entries, name)
	}

	id, err := h.scheduler.AddFunc(expr, func() {
		h.registry.Emit(Payload{
			EventType: EventCronTick,
			Timestamp: time.Now(),
			Data: map[string]any{
				"name":     name,
				"schedule": expr,
			},
		})
	})
	if err != nil {
		log.Error().Err(err).Str("name", name).Str("expr", expr).Msg("failed to add cron schedule")
		return err
	}

	h.entries[name] = id
	log.Info().Str("name", name).Str("expr", expr).Msg("cron schedule added")
	return nil
}

// RemoveSchedule removes a named cron schedule.
func (h *CronHook) RemoveSchedule(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if id, exists := h.entries[name]; exists {
		h.scheduler.Remove(id)
		delete(h.entries, name)
		log.Info().Str("name", name).Msg("cron schedule removed")
	}
}
