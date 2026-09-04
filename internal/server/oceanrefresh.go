package server

import (
	"context"
	"crypto/sha256"
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

// firstBuoyRefreshDelay is deliberately offset from firstRefreshDelay so a
// restart does not open connections to NCSS and NDBC in the same instant.
const firstBuoyRefreshDelay = 20 * time.Second

// buoysCache holds the currently served NDBC stations. It keeps the decoded
// Buoys alongside the marshalled bytes because the currents refresher needs
// the struct for its snapshot write-through, and re-reading buoys.json off
// disk there would lose a fresh poll that could not be written through.
type buoysCache struct {
	mu        sync.RWMutex
	body      []byte // marshalled buoys.json
	etag      string
	buoys     ocean.Buoys
	retrieved *time.Time // when NDBC was actually polled; nil when unknown
	ok        bool
}

func newBuoysCache() *buoysCache { return &buoysCache{} }

func (c *buoysCache) get() ([]byte, string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.ok || len(c.body) == 0 {
		return nil, "", false
	}
	return c.body, c.etag, true
}

// snapshot returns the decoded stations for a snapshot write-through.
func (c *buoysCache) snapshot() (ocean.Buoys, *time.Time, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.buoys, c.retrieved, c.ok
}

func (c *buoysCache) set(b ocean.Buoys, body []byte, retrieved *time.Time) {
	sum := sha256.Sum256(body)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.body = body
	c.etag = etagFor(sum)
	c.buoys = b
	c.retrieved = retrieved
	c.ok = true
}

// startOceanRefresh runs until ctx is done. It always primes the in-memory
// caches from whatever snapshot is already on disk (pure local decode, no
// egress) so a disabled or still-failing refresher serves the normalized
// shapes instead of leaving a cache empty and falling back to the legacy raw
// file bytes. The ticker goroutines themselves are no-ops when refresh is
// disabled, which is what makes the air-gap claim literal — with
// GULF_OCEAN_REFRESH=0 neither NCSS nor NDBC is ever contacted.
//
// Currents and buoys refresh on separate tickers because their upstreams
// update on very different cadences: HYCOM publishes a new stack hourly,
// while NDBC rewrites realtime2 stdmet files about every ten minutes.
func (s *Server) startOceanRefresh(ctx context.Context) {
	s.primeOceanCache()
	s.primeBuoysCache()
	if !s.cfg.OceanRefreshEnabled {
		return
	}
	go refreshLoop(ctx, s.cfg.OceanFirstRefreshDelay, s.cfg.OceanRefreshEvery, s.refreshOcean)
	go refreshLoop(ctx, s.cfg.BuoyFirstRefreshDelay, s.cfg.BuoyRefreshEvery, s.refreshBuoys)
}

// refreshLoop calls do after first, then every jitter(every), until ctx ends.
func refreshLoop(ctx context.Context, first, every time.Duration, do func(context.Context)) {
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		do(ctx)
		timer.Reset(jitter(every))
	}
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

// primeBuoysCache is the buoys counterpart of primeOceanCache. The retrieval
// time comes from the manifest rather than from now: priming is a local
// decode of bytes NDBC handed over at some earlier moment, and stamping it
// "now" would claim a poll that did not happen.
func (s *Server) primeBuoysCache() {
	b, err := ocean.DecodeBuoysFile(filepath.Join(s.cfg.OceanDir, "buoys.json"))
	if err != nil {
		return
	}
	body, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return
	}
	var retrieved *time.Time
	if m, err := ocean.DecodeManifestFile(filepath.Join(s.cfg.OceanDir, "manifest.json")); err == nil {
		retrieved = m.Buoys.RetrievedAt
	}
	s.bc.set(b, body, retrieved)
}

// jitter spreads refreshes by +/-10% so restarts do not synchronize.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return time.Hour
	}
	spread := float64(d) * 0.1
	return d + time.Duration(rand.Float64()*2*spread-spread)
}

func oceanAOI() ocean.BBox {
	return ocean.BBox{West: tiles.AOI.West, South: tiles.AOI.South, East: tiles.AOI.East, North: tiles.AOI.North}
}

func (s *Server) refreshOcean(ctx context.Context) {
	now := s.cfg.OceanNow()
	c, err := ocean.FetchCurrents(ctx, s.cfg.OceanClient, s.cfg.HYCOMURL, oceanAOI(), now)
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
	//
	// A missing or undecodable buoys.json (a fresh deploy where `make ocean`
	// never ran, per config.go) must NOT skip this write-through: doing so
	// left currents.json and manifest.json stuck on the seed snapshot
	// forever, even though the in-memory cache had gone fresh. Fall back to
	// an empty, honestly-labelled Buoys stand-in instead.
	b, buoysPresent, buoysRetrieved := s.buoysForSnapshot(now)
	// This refresh only ever re-fetches currents, so the buoys retrieval
	// time carried forward must be whatever the buoy layer already recorded
	// — never "now", or the manifest would falsely claim NDBC was just
	// re-polled. An unknown prior time stays nil rather than being guessed.
	s.writeSnapshot(c, b, buoysPresent, now, buoysRetrieved)

	s.oc.set(body)
}

// refreshBuoys re-polls NDBC. It is the mirror of refreshOcean: a failed
// poll serves stale, and the manifest never claims a currents fetch that
// this call did not make.
func (s *Server) refreshBuoys(ctx context.Context) {
	now := s.cfg.OceanNow()
	ep := ocean.NDBCEndpoints(s.cfg.NDBCBase)
	b, err := ocean.FetchBuoys(ctx, s.cfg.OceanClient, ep, oceanAOI(), now)
	if err != nil {
		// Serve stale. The previous stations stand.
		slog.Warn("buoy refresh", "err", err)
		return
	}
	body, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		slog.Warn("buoy refresh", "err", err)
		return
	}

	// Write-through needs the currents stack, because WriteSnapshot replaces
	// data/ocean wholesale. Without a decodable currents.json there is
	// nothing to write it beside, so this poll lives in memory only and the
	// next successful currents refresh will carry it to disk. That is the
	// same trade the currents path makes in the opposite direction.
	if c, err := ocean.DecodeCurrentsFile(filepath.Join(s.cfg.OceanDir, "currents.json")); err == nil {
		s.writeSnapshot(c, b, true, s.currentsRetrieved(now), &now)
	}

	s.bc.set(b, body, &now)
}

// writeSnapshot serializes the two refreshers' write-throughs. WriteSnapshot
// atomically replaces the whole data/ocean directory by renaming it aside,
// so two concurrent calls — one per ticker — could interleave their renames
// and lose a layer. Holding this lock makes each refresher's
// read-currents/read-buoys/replace-dir sequence indivisible.
func (s *Server) writeSnapshot(c ocean.Currents, b ocean.Buoys, buoysPresent bool, currentsRetrieved time.Time, buoysRetrieved *time.Time) {
	s.snapMu.Lock()
	defer s.snapMu.Unlock()
	if err := ocean.WriteSnapshot(s.cfg.OceanDir, c, b, buoysPresent, currentsRetrieved, buoysRetrieved); err != nil {
		slog.Warn("ocean refresh: write-through", "err", err)
	}
}

// currentsRetrieved reports when the currents layer was last actually
// fetched, for a buoys-only refresh that must carry that time forward rather
// than restamp it. Falling back to now is the honest answer only when no
// prior manifest recorded one at all.
func (s *Server) currentsRetrieved(now time.Time) time.Time {
	m, err := ocean.DecodeManifestFile(filepath.Join(s.cfg.OceanDir, "manifest.json"))
	if err != nil {
		return now
	}
	if m.Currents.RetrievedAt != nil {
		return *m.Currents.RetrievedAt
	}
	if !m.RetrievedAt.IsZero() {
		return m.RetrievedAt
	}
	return now
}

// buoysForSnapshot supplies the buoys layer for a currents write-through,
// preferring the in-memory cache so a poll that could not be written through
// is not lost, and falling back to disk when the cache was never primed.
func (s *Server) buoysForSnapshot(now time.Time) (ocean.Buoys, bool, *time.Time) {
	if b, retrieved, ok := s.bc.snapshot(); ok {
		return b, true, retrieved
	}
	if b, err := ocean.DecodeBuoysFile(filepath.Join(s.cfg.OceanDir, "buoys.json")); err == nil {
		var retrieved *time.Time
		if m, err := ocean.DecodeManifestFile(filepath.Join(s.cfg.OceanDir, "manifest.json")); err == nil {
			retrieved = m.Buoys.RetrievedAt
		}
		return b, true, retrieved
	}
	return ocean.Buoys{ValidTime: now, Source: ocean.Source{Name: "NDBC"}}, false, nil
}
