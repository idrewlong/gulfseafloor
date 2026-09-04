package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/ocean"
)

// failingTransport fails the test if anything dials out.
type failingTransport struct{ t *testing.T }

func (f failingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	f.t.Fatalf("unexpected outbound request to %s", r.URL)
	return nil, nil
}

func seedOceanDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"currents.json": validCurrentsJSON,
		"buoys.json":    validBuoysJSON,
		"manifest.json": validManifestJSON,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// hycomFixture returns the vendored single-time HYCOM NetCDF response used
// by internal/ocean's own tests. Production requests accept=netcdf per step
// (ocean.CurrentsQuery: NCSS rejects accept=csv for a grid subset), so a
// fake upstream answering with CSV — as this test used to — never exercises
// parseHYCOMNetCDF, ncTimeVar's standard_name resolution, or the per-step
// merge against the actual bytes the refresher receives in production.
func hycomFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "ocean", "testdata", "hycom.nc"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRefreshReplacesTheServedStack(t *testing.T) {
	fixture := hycomFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(fixture)
	}))
	defer upstream.Close()

	dir := seedOceanDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:             filepath.Join("testdata", "tiles"),
		WebDir:              t.TempDir(),
		OceanDir:            dir,
		OceanRefreshEnabled: true,
		OceanRefreshEvery:   time.Hour,
		HYCOMURL:            upstream.URL,
		OceanClient:         upstream.Client(),
		// Without this the first refresh is 15s out and the 2s deadline below
		// can never be met.
		OceanFirstRefreshDelay: time.Millisecond,
	})

	// The fixture carries one fixed validTime, so every one of the 10
	// per-step requests resolves to that same step; NCSS's snap-to-nearest
	// behaviour means real distinct requests can also collide like this,
	// and FetchCurrents's dedupe (asserted directly against
	// TestFetchCurrentsMergesAndDedupesIdenticalValidTimes in the ocean
	// package) collapses them to 1. Here that collapse is exercised
	// end-to-end through the refresher and the on-disk write-through.
	waitForRefreshedStack(t, h)

	// Write-through means a restart keeps the freshness.
	onDisk, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Steps []struct{} `json:"steps"`
	}
	if err := json.Unmarshal(onDisk, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Steps) != 1 {
		t.Errorf("on-disk steps = %d, want 1", len(got.Steps))
	}
}

// TestRefreshWriteThroughWithoutBuoysFile guards F1: a fresh deploy where
// `make ocean` never ran has no buoys.json at all (a supported state, see
// config.go's OceanDir doc comment). The currents write-through must not
// skip itself just because buoys.json is missing, or currents.json and
// manifest.json would stay on the seed snapshot forever even though the
// in-memory cache had gone fresh.
func TestRefreshWriteThroughWithoutBuoysFile(t *testing.T) {
	fixture := hycomFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(fixture)
	}))
	defer upstream.Close()

	dir := t.TempDir()
	for name, body := range map[string]string{
		"currents.json": validCurrentsJSON,
		"manifest.json": validManifestJSON,
		// buoys.json deliberately absent.
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:                filepath.Join("testdata", "tiles"),
		WebDir:                 t.TempDir(),
		OceanDir:               dir,
		OceanRefreshEnabled:    true,
		OceanRefreshEvery:      time.Hour,
		HYCOMURL:               upstream.URL,
		OceanClient:            upstream.Client(),
		OceanFirstRefreshDelay: time.Millisecond,
	})
	waitForRefreshedStack(t, h)

	if _, err := os.ReadFile(filepath.Join(dir, "currents.json")); err != nil {
		t.Fatalf("currents.json must be written through even without buoys.json: %v", err)
	}
	m, err := ocean.DecodeManifestFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("manifest.json must still decode: %v", err)
	}
	if m.Buoys.Present {
		t.Error("manifest must not claim buoys are present when buoys.json never existed")
	}
	if m.Buoys.ValidTime != nil || m.Buoys.Count != 0 {
		t.Errorf("absent buoys layer must not carry a validTime or count: %+v", m.Buoys)
	}
}

// TestRefreshPreservesBuoysRetrievedAtAcrossCurrentsOnlyRefresh guards F2:
// this refresher never re-fetches NDBC (docs/data-sources.md), so a
// currents-only refresh must not stamp the buoys layer's retrievedAt with
// "now" — that would falsely claim a fresh NDBC poll. The prior manifest's
// buoys.retrievedAt must carry forward unchanged.
func TestRefreshPreservesBuoysRetrievedAtAcrossCurrentsOnlyRefresh(t *testing.T) {
	fixture := hycomFixture(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(fixture)
	}))
	defer upstream.Close()

	const priorBuoysRetrievedAt = "2026-08-20T00:00:00Z"
	manifestWithBuoysRetrieved := `{
	  "retrievedAt": "2026-08-24T20:01:00Z",
	  "currents": {"present": false},
	  "buoys": {"present": true, "validTime": "2026-08-24T19:50:00Z", "count": 1, "retrievedAt": "` + priorBuoysRetrievedAt + `"}
	}`

	dir := t.TempDir()
	for name, body := range map[string]string{
		"currents.json": validCurrentsJSON,
		"buoys.json":    validBuoysJSON,
		"manifest.json": manifestWithBuoysRetrieved,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:                filepath.Join("testdata", "tiles"),
		WebDir:                 t.TempDir(),
		OceanDir:               dir,
		OceanRefreshEnabled:    true,
		OceanRefreshEvery:      time.Hour,
		HYCOMURL:               upstream.URL,
		OceanClient:            upstream.Client(),
		OceanFirstRefreshDelay: time.Millisecond,
	})
	waitForRefreshedStack(t, h)

	m, err := ocean.DecodeManifestFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("manifest.json must decode: %v", err)
	}
	want, err := time.Parse(time.RFC3339, priorBuoysRetrievedAt)
	if err != nil {
		t.Fatal(err)
	}
	if m.Buoys.RetrievedAt == nil || !m.Buoys.RetrievedAt.Equal(want) {
		t.Errorf("buoys.retrievedAt = %v, want preserved %v (a currents-only refresh must not claim NDBC was just re-polled)", m.Buoys.RetrievedAt, want)
	}
}

func TestRefreshServesStaleWhenUpstreamFails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer upstream.Close()

	dir := seedOceanDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:                filepath.Join("testdata", "tiles"),
		WebDir:                 t.TempDir(),
		OceanDir:               dir,
		OceanRefreshEnabled:    true,
		OceanRefreshEvery:      time.Hour,
		HYCOMURL:               upstream.URL,
		OceanClient:            upstream.Client(),
		OceanFirstRefreshDelay: time.Millisecond,
	})

	// The refresh must actually be attempted and fail before this proves
	// anything, so give the goroutine a moment.
	time.Sleep(50 * time.Millisecond)
	// The seeded snapshot must still be served, as a lifted one-step stack.
	waitForSteps(t, h, 1)
}

// This is the air-gap claim, so it gets a test rather than a comment.
func TestRefreshDisabledMakesNoOutboundRequest(t *testing.T) {
	dir := seedOceanDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:             filepath.Join("testdata", "tiles"),
		WebDir:              t.TempDir(),
		OceanDir:            dir,
		OceanRefreshEnabled: false,
		OceanRefreshEvery:   time.Millisecond,
		HYCOMURL:            "https://example.invalid/ncss",
		OceanClient:         &http.Client{Transport: failingTransport{t: t}},
		// The refresher would fire immediately if the disabled flag were
		// ignored. With the default 15s delay this test could not fail.
		OceanFirstRefreshDelay: time.Millisecond,
	})
	time.Sleep(50 * time.Millisecond)
	waitForSteps(t, h, 1)
}

// waitForRefreshedStack polls /api/ocean/currents until the served grid's
// shape matches the hycom.nc fixture (24x15) rather than any of this file's
// seeded stacks (all nx=2, ny=1). Every seed used here already primes the
// cache with 1 step before any refresh runs, so a bare step-count check
// (waitForSteps with want=1) would pass immediately off the primed seed and
// never actually wait for the background refresh — matching on the
// fixture's distinct shape is what proves the refresh landed.
func waitForRefreshedStack(t *testing.T, h http.Handler) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var lastNX int
	for time.Now().Before(deadline) {
		req := httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			var got struct {
				NX int `json:"nx"`
				NY int `json:"ny"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err == nil {
				lastNX = got.NX
				if got.NX == 24 && got.NY == 15 {
					return
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("refreshed (24x15) stack never appeared before deadline, last nx = %d", lastNX)
}

func waitForSteps(t *testing.T, h http.Handler, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var last int
	for time.Now().Before(deadline) {
		req := httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			var got struct {
				Steps []struct{} `json:"steps"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err == nil {
				last = len(got.Steps)
				if last == want {
					return
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("steps = %d, want %d before deadline", last, want)
}

// ndbcFixtureServer answers the station table and one realtime2 file, and
// counts station-table hits so a test can tell a poll happened.
func ndbcFixtureServer(t *testing.T, hits *int32) *httptest.Server {
	t.Helper()
	// Mirrors the live file: lower-case ids and free-text TTYPE.
	table := "# STATION_ID | OWNER | TTYPE | HULL | NAME | PAYLOAD | LOCATION | TIMEZONE | FORECAST | NOTE\n" +
		"wycm6|NOS|Water Level Observation Network||Gulfport Harbor||30.360 N 89.081 W|C| |\n" +
		"42040|N|3-meter discus buoy|3D|Luke Offshore||30.100 N 89.100 W|C| |\n"
	mux := http.NewServeMux()
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		_, _ = w.Write([]byte(table))
	})
	mux.HandleFunc("/data/realtime2/WYCM6.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join("..", "ocean", "testdata", "realtime2_wycm6.txt"))
	})
	mux.HandleFunc("/data/realtime2/42040.txt", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// The bug this covers: before buoys had their own ticker, NDBC was fetched
// only by the one-shot `make ocean`, so a long-running server served
// week-old observations while its currents stayed fresh.
func TestBuoyRefreshReplacesTheServedStations(t *testing.T) {
	var hits int32
	ndbc := ndbcFixtureServer(t, &hits)
	dir := seedOceanDir(t)
	now := time.Date(2026, 9, 3, 21, 0, 0, 0, time.UTC)

	h := NewWithContext(t.Context(), Config{
		TileDir:               t.TempDir(),
		OceanDir:              dir,
		OceanRefreshEnabled:   true,
		NDBCBase:              ndbc.URL,
		OceanClient:           ndbc.Client(),
		OceanNow:              func() time.Time { return now },
		BuoyFirstRefreshDelay: time.Millisecond,
		BuoyRefreshEvery:      time.Hour,
		// Park the currents ticker so only the buoy poll is under test.
		OceanFirstRefreshDelay: time.Hour,
		OceanRefreshEvery:      time.Hour,
		HYCOMURL:               "http://127.0.0.1:0/unused",
	})

	waitFor(t, func() bool { return atomic.LoadInt32(&hits) > 0 })

	var got ocean.Buoys
	waitFor(t, func() bool {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/buoys", nil))
		if rec.Code != http.StatusOK {
			return false
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			return false
		}
		// The seed fixture's single station carries no obsTime; the freshly
		// polled one does.
		return len(got.Stations) == 1 && got.Stations[0].ObsTime != nil
	})

	if got.Stations[0].ID != "WYCM6" {
		t.Fatalf("station %q, want WYCM6", got.Stations[0].ID)
	}
	// The platform class must survive the fetch → serve round trip, or the
	// viewer has nothing to pick a glyph from.
	if got.Stations[0].Kind != ocean.KindFixed {
		t.Fatalf("kind %q, want %q", got.Stations[0].Kind, ocean.KindFixed)
	}
}

// A buoys-only poll must not restamp the currents layer as freshly
// retrieved. This is the mirror of the invariant refreshOcean already keeps
// for buoys, and it is the whole reason the manifest carries per-layer times.
func TestBuoyRefreshDoesNotClaimACurrentsFetch(t *testing.T) {
	var hits int32
	ndbc := ndbcFixtureServer(t, &hits)
	dir := seedOceanDir(t)

	currentsRetrieved := time.Date(2026, 9, 3, 18, 30, 0, 0, time.UTC)
	seedManifest := ocean.Manifest{
		RetrievedAt: currentsRetrieved,
		Currents:    ocean.LayerInfo{Present: true, RetrievedAt: &currentsRetrieved},
		Buoys:       ocean.LayerInfo{Present: true},
	}
	mJSON, err := json.MarshalIndent(seedManifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), mJSON, 0o644); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 3, 21, 0, 0, 0, time.UTC)
	NewWithContext(t.Context(), Config{
		TileDir:                t.TempDir(),
		OceanDir:               dir,
		OceanRefreshEnabled:    true,
		NDBCBase:               ndbc.URL,
		OceanClient:            ndbc.Client(),
		OceanNow:               func() time.Time { return now },
		BuoyFirstRefreshDelay:  time.Millisecond,
		BuoyRefreshEvery:       time.Hour,
		OceanFirstRefreshDelay: time.Hour,
		OceanRefreshEvery:      time.Hour,
		HYCOMURL:               "http://127.0.0.1:0/unused",
	})

	var m ocean.Manifest
	waitFor(t, func() bool {
		got, err := ocean.DecodeManifestFile(filepath.Join(dir, "manifest.json"))
		if err != nil || got.Buoys.RetrievedAt == nil {
			return false
		}
		m = got
		return got.Buoys.RetrievedAt.Equal(now)
	})

	if m.Currents.RetrievedAt == nil || !m.Currents.RetrievedAt.Equal(currentsRetrieved) {
		t.Fatalf("currents retrievedAt %v, want it carried forward as %v", m.Currents.RetrievedAt, currentsRetrieved)
	}
}

// GULF_OCEAN_REFRESH=0 must mean zero egress, NDBC included. The air-gap
// claim in the README is only literal if the new ticker respects it too.
func TestBuoyRefreshDisabledMakesNoRequests(t *testing.T) {
	dir := seedOceanDir(t)
	h := NewWithContext(t.Context(), Config{
		TileDir:               t.TempDir(),
		OceanDir:              dir,
		OceanRefreshEnabled:   false,
		NDBCBase:              "http://ndbc.invalid",
		OceanClient:           &http.Client{Transport: failingTransport{t}},
		BuoyFirstRefreshDelay: time.Millisecond,
		BuoyRefreshEvery:      time.Millisecond,
	})
	time.Sleep(50 * time.Millisecond)

	// Priming is a pure local decode, so the seeded stations still serve.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/buoys", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var b ocean.Buoys
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if len(b.Stations) != 1 || b.Stations[0].ID != "WYCM6" {
		t.Fatalf("stations %+v", b.Stations)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 3s")
}
