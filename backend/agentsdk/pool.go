package agentsdk

import (
	"context"
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// PoolConfig configures a ProcessPool.
type PoolConfig struct {
	Size      int                                           // number of warm connections to maintain
	AgentType AgentType                                     // which agent this pool is for
	Spawn     func(ctx context.Context) (*warmConn, error) // factory for warm connections
}

// ProcessPool maintains pre-warmed ACP connections ready for immediate use.
// Each Acquire() returns a dedicated warm connection (1:1 with session, no reuse).
// The pool replenishes in the background after each take.
type ProcessPool struct {
	cfg  PoolConfig
	warm chan *warmConn

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// newProcessPool creates a pool but does not start warming. Call Start().
func newProcessPool(cfg PoolConfig) *ProcessPool {
	if cfg.Size <= 0 {
		cfg.Size = 3
	}
	return &ProcessPool{
		cfg:  cfg,
		warm: make(chan *warmConn, cfg.Size),
	}
}

// Start begins background warming to fill the pool.
func (p *ProcessPool) Start(ctx context.Context) {
	p.ctx, p.cancel = context.WithCancel(ctx)
	p.fill(p.cfg.Size)
}

// fill spawns n warm connections in background goroutines.
func (p *ProcessPool) fill(n int) {
	for range n {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			p.spawnOne()
		}()
	}
}

// spawnOne creates one warm connection and adds it to the pool.
func (p *ProcessPool) spawnOne() {
	if p.ctx.Err() != nil {
		return
	}

	w, err := p.cfg.Spawn(p.ctx)
	if err != nil {
		if p.ctx.Err() == nil {
			log.Warn().Err(err).Msg("pool: failed to spawn warm connection")
		}
		return
	}

	select {
	case p.warm <- w:
		log.Info().Msg("pool: warm connection added")
	case <-p.ctx.Done():
		killWarm(w)
	}
}

// Acquire returns a pre-warmed connection from the pool.
// If the pool is empty, spawns one synchronously (fallback).
// Triggers background replenishment after each successful acquire.
func (p *ProcessPool) Acquire(ctx context.Context) (*warmConn, error) {
	start := time.Now()
	for {
		select {
		case w := <-p.warm:
			if isWarmDead(w) {
				log.Warn().Msg("pool: discarding dead warm connection")
				killWarm(w)
				continue
			}
			log.Info().
				Dur("acquire_ms", time.Since(start)).
				Msg("pool: acquired warm connection from pool")
			p.replenish()
			return w, nil
		default:
			log.Warn().Msg("pool: empty, spawning synchronously")
			w, err := p.cfg.Spawn(ctx)
			if err != nil {
				return nil, err
			}
			log.Info().
				Dur("acquire_ms", time.Since(start)).
				Msg("pool: synchronous spawn complete")
			return w, nil
		}
	}
}

// replenish spawns one replacement in the background.
func (p *ProcessPool) replenish() {
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.spawnOne()
	}()
}

// Shutdown kills all warm connections and waits for background goroutines.
func (p *ProcessPool) Shutdown() {
	p.cancel()

	// Drain and kill all warm connections in the channel
	for {
		select {
		case w := <-p.warm:
			killWarm(w)
		default:
			p.wg.Wait()
			return
		}
	}
}

// isWarmDead checks if the warm connection's process has exited.
func isWarmDead(w *warmConn) bool {
	if w.done != nil {
		select {
		case <-w.done:
			return true
		default:
		}
	}
	return false
}

// killWarm terminates a warm connection's process.
func killWarm(w *warmConn) {
	if w.cmd != nil && w.cmd.Process != nil {
		w.cmd.Process.Kill()
		w.cmd.Wait()
	}
}
