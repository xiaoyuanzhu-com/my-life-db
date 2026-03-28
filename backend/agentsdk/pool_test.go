package agentsdk

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWarmConn creates a warmConn with a done channel for testing.
func fakeWarmConn() (*warmConn, chan struct{}) {
	done := make(chan struct{})
	return &warmConn{done: done}, done
}

func TestPool_Acquire(t *testing.T) {
	spawned := atomic.Int32{}
	pool := newProcessPool(PoolConfig{
		Size: 2,
		Spawn: func(ctx context.Context) (*warmConn, error) {
			spawned.Add(1)
			w, _ := fakeWarmConn()
			return w, nil
		},
	})

	ctx := context.Background()
	pool.Start(ctx)
	defer pool.Shutdown()

	// Wait for pool to fill
	time.Sleep(100 * time.Millisecond)

	w, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if w == nil {
		t.Fatal("Acquire returned nil")
	}

	// Pool should have spawned at least 2 (initial fill) + 1 (replenish)
	time.Sleep(100 * time.Millisecond)
	if s := spawned.Load(); s < 2 {
		t.Errorf("spawned = %d, want >= 2", s)
	}
}

func TestPool_AcquireFallback(t *testing.T) {
	spawned := atomic.Int32{}
	pool := newProcessPool(PoolConfig{
		Size: 1,
		Spawn: func(ctx context.Context) (*warmConn, error) {
			spawned.Add(1)
			w, _ := fakeWarmConn()
			return w, nil
		},
	})

	ctx := context.Background()
	pool.Start(ctx)
	defer pool.Shutdown()

	time.Sleep(100 * time.Millisecond)

	// Drain the pool
	pool.Acquire(ctx)

	// Next acquire should fall back to synchronous spawn
	before := spawned.Load()
	w, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire fallback: %v", err)
	}
	if w == nil {
		t.Fatal("Acquire fallback returned nil")
	}
	if spawned.Load() <= before {
		t.Error("expected synchronous spawn on empty pool")
	}
}

func TestPool_DiscardsDeadConn(t *testing.T) {
	callCount := atomic.Int32{}
	pool := newProcessPool(PoolConfig{
		Size: 2,
		Spawn: func(ctx context.Context) (*warmConn, error) {
			n := callCount.Add(1)
			w, done := fakeWarmConn()
			// First spawn: immediately kill it (simulate dead process)
			if n == 1 {
				close(done)
			}
			return w, nil
		},
	})

	ctx := context.Background()
	pool.Start(ctx)
	defer pool.Shutdown()

	time.Sleep(200 * time.Millisecond)

	w, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if w == nil {
		t.Fatal("Acquire returned nil")
	}
	if isWarmDead(w) {
		t.Error("Acquire returned a dead connection")
	}
}

func TestPool_Shutdown(t *testing.T) {
	var conns []*warmConn
	var mu sync.Mutex

	pool := newProcessPool(PoolConfig{
		Size: 3,
		Spawn: func(ctx context.Context) (*warmConn, error) {
			w, _ := fakeWarmConn()
			mu.Lock()
			conns = append(conns, w)
			mu.Unlock()
			return w, nil
		},
	})

	ctx := context.Background()
	pool.Start(ctx)

	time.Sleep(200 * time.Millisecond)

	pool.Shutdown()

	// Verify channel is drained
	select {
	case <-pool.warm:
		t.Error("pool channel should be drained after Shutdown")
	default:
		// OK
	}
}
