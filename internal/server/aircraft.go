package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/aircraft"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
	"golang.org/x/sync/singleflight"
)

type aircraftCache struct {
	mu          sync.Mutex
	last        aircraft.Snapshot
	lastSuccess time.Time
	group       singleflight.Group
	client      *http.Client
	endpoints   aircraft.Endpoints
}

func newAircraftCache(cfg Config) *aircraftCache {
	endpoints := aircraft.DefaultEndpoints()
	if cfg.OpenSkyURL != "" {
		endpoints.OpenSky = cfg.OpenSkyURL
	}
	if cfg.AdsbLolURL != "" {
		endpoints.AdsbLol = cfg.AdsbLolURL
	}
	return &aircraftCache{
		client:    aircraft.NewClient(),
		endpoints: endpoints,
	}
}

func (s *Server) handleAircraft(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !s.cfg.AircraftEnabled {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	snapshot, ok := s.aircraftSnapshot(r.Context())
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) aircraftSnapshot(ctx context.Context) (aircraft.Snapshot, bool) {
	now := s.cfg.AircraftNow()
	if snapshot, ok := s.ac.cached(now, s.cfg.AircraftCacheTTL); ok {
		return snapshot, true
	}

	value, err, _ := s.ac.group.Do("aircraft", func() (any, error) {
		now := s.cfg.AircraftNow()
		if snapshot, ok := s.ac.cached(now, s.cfg.AircraftCacheTTL); ok {
			return snapshot, nil
		}
		fetchCtx := context.WithoutCancel(ctx)
		snapshot, err := aircraft.Fetch(fetchCtx, s.ac.client, s.ac.endpoints, tiles.AOI, now)
		if err != nil {
			return aircraft.Snapshot{}, err
		}
		s.ac.store(snapshot, now)
		return snapshot, nil
	})
	if err == nil {
		return value.(aircraft.Snapshot), true
	}
	return s.ac.cached(s.cfg.AircraftNow(), s.cfg.AircraftStaleFor)
}

func (c *aircraftCache) cached(now time.Time, maxAge time.Duration) (aircraft.Snapshot, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSuccess.IsZero() || now.Sub(c.lastSuccess) >= maxAge {
		return aircraft.Snapshot{}, false
	}
	return c.last, true
}

func (c *aircraftCache) store(snapshot aircraft.Snapshot, at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = snapshot
	c.lastSuccess = at
}
