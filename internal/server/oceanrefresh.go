package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"math/rand"
	"path/filepath"
	"sync"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/ocean"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// firstRefreshDelay keeps startup off the upstream, and stops a crash-loop
// from hammering NCSS.
const firstRefreshDelay = 15 * time.Second

// oceanCache holds the currently served currents stack. Refresh happens on a
// ticker, never on the request path: a 90s NCSS stall must never become
// request latency.
type oceanCache struct {
	mu   sync.RWMutex
	body []byte // marshalled currents.json
	etag string
}

func newOceanCache() *oceanCache { return &oceanCache{} }

func (c *oceanCache) get() ([]byte, string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.body) == 0 {
		return nil, "", false
	}
	return c.body, c.etag, true
}

func (c *oceanCache) set(body []byte) {
	sum := sha256.Sum256(body)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.body = body
	c.etag = `"` + hex.EncodeToString(sum[:]) + `"`
}

// startOceanRefresh runs until ctx is done. It always primes the in-memory
// cache from whatever snapshot is already on disk (pure local decode, no
// egress) so a disabled or still-failing refresher serves the normalized
// Steps shape instead of leaving the cache empty and falling back to the
// legacy raw-file bytes. The ticker goroutine itself is a no-op when refresh
// is disabled, which is what makes the air-gap claim literal.
func (s *Server) startOceanRefresh(ctx context.Context) {
	s.primeOceanCache()
	if !s.cfg.OceanRefreshEnabled {
		return
	}
	go func() {
		timer := time.NewTimer(s.cfg.OceanFirstRefreshDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			s.refreshOcean(ctx)
			timer.Reset(jitter(s.cfg.OceanRefreshEvery))
		}
	}()
}

// primeOceanCache loads the existing on-disk currents snapshot, if any, into
// memory. It never touches the network: a missing or unreadable snapshot
// just leaves the cache empty, and the disk-serving fallback in ocean.go
// takes over as it always has.
func (s *Server) primeOceanCache() {
	c, err := ocean.DecodeCurrentsFile(filepath.Join(s.cfg.OceanDir, "currents.json"))
	if err != nil {
		return
	}
	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return
	}
	s.oc.set(body)
}

// jitter spreads refreshes by +/-10% so restarts do not synchronize.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return time.Hour
	}
	spread := float64(d) * 0.1
	return d + time.Duration(rand.Float64()*2*spread-spread)
}

func (s *Server) refreshOcean(ctx context.Context) {
	now := s.cfg.OceanNow()
	aoi := ocean.BBox{West: tiles.AOI.West, South: tiles.AOI.South, East: tiles.AOI.East, North: tiles.AOI.North}
	c, err := ocean.FetchCurrents(ctx, s.cfg.OceanClient, s.cfg.HYCOMURL, aoi, now)
	if err != nil {
		// Serve stale. The previous stack stands.
		slog.Warn("ocean refresh", "err", err)
		return
	}
	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		slog.Warn("ocean refresh", "err", err)
		return
	}

	// Write through before publishing to the cache: a reader that observes
	// the new stack in memory must also find it on disk, or a restart right
	// after this refresh would regress to the old snapshot. An unwritable
	// dir is not fatal to serving: the freshly fetched stack still reaches
	// the in-memory cache below.
	if b, err := ocean.DecodeBuoysFile(filepath.Join(s.cfg.OceanDir, "buoys.json")); err != nil {
		slog.Warn("ocean refresh: write-through skipped", "err", err)
	} else if err := ocean.WriteSnapshot(s.cfg.OceanDir, c, b, now); err != nil {
		slog.Warn("ocean refresh: write-through", "err", err)
	}

	s.oc.set(body)
}
