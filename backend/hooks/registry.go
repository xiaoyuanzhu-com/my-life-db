package hooks

import (
	"context"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

type Registry struct {
	mu          sync.RWMutex
	subscribers map[EventType][]Subscriber
	hooks       []Hook
	ctx         context.Context
	cancel      context.CancelFunc
}

func NewRegistry() *Registry {
	return &Registry{
		subscribers: make(map[EventType][]Subscriber),
	}
}

func (r *Registry) Register(hook Hook) {
	r.mu.Lock()
	r.hooks = append(r.hooks, hook)
	r.mu.Unlock()
}

func (r *Registry) Subscribe(eventType EventType, sub Subscriber) {
	r.mu.Lock()
	r.subscribers[eventType] = append(r.subscribers[eventType], sub)
	r.mu.Unlock()
}

func (r *Registry) Emit(payload Payload) {
	r.mu.RLock()
	subs := r.subscribers[payload.EventType]
	r.mu.RUnlock()

	ctx := context.Background()
	if r.ctx != nil {
		ctx = r.ctx
	}

	for _, sub := range subs {
		sub := sub
		go sub(ctx, payload)
	}
}

func (r *Registry) Start(ctx context.Context) error {
	r.ctx, r.cancel = context.WithCancel(ctx)
	for _, h := range r.hooks {
		if err := h.Start(r.ctx); err != nil {
			log.Error().Err(err).Str("hook", string(h.Type())).Msg("failed to start hook")
			return err
		}
		log.Info().Str("hook", string(h.Type())).Msg("hook started")
	}
	return nil
}

func (r *Registry) Stop() error {
	if r.cancel != nil {
		r.cancel()
	}
	for _, h := range r.hooks {
		if err := h.Stop(); err != nil {
			log.Error().Err(err).Str("hook", string(h.Type())).Msg("failed to stop hook")
		}
	}
	return nil
}
