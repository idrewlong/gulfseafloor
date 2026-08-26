# Live Aircraft Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live public ADS-B positions over `internal/tiles.AOI` on the bathymetry chart, with no API key, while leaving globe / Cesium untouched.

**Architecture:** The Go viewer polls OpenSky (adsb.lol fallback) on demand, caches ~10 s, and serves stable JSON at `GET /api/aircraft`. The bathymetry client draws HTML heading chevrons, dead-reckons between polls, and hides the layer in globe mode. CSP stays `connect-src 'self'`.

**Tech Stack:** Go 1.26, `net/http` + `httptest`, `golang.org/x/sync/singleflight` (already in `go.mod`), existing Vite `node --test` runner, no new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-08-25-live-aircraft-overlay-design.md](../specs/2026-08-25-live-aircraft-overlay-design.md)

## Global Constraints

- Clip box is `internal/tiles.AOI` (code), not the older `projectspec.md` shelf window.
- No paid API, no key, no `cmd/aircraft`, no `data/aircraft/`.
- Browser never calls OpenSky or adsb.lol. CSP `connect-src 'self'` stays.
- Globe / Cesium: no marks, no polling, no Cesium edits. Fieldset and `#aircraft-marks` hidden in globe mode.
- CI must not hit live OpenSky or adsb.lol. Inject `httptest` URLs.
- `/readyz` does not depend on aircraft.
- `GULF_AIRCRAFT=0` → 404, same pattern as `GULF_IMAGERY=0`.
- Do not call it radar in UI copy. Not for navigation. No implied endorsement.
- CGO stays off. No new npm packages.
- User-Agent: `gulf-seafloor-viewer/0.2 (public-adsb-proxy)`.

---

## File structure

| Path | Responsibility |
|---|---|
| `internal/aircraft/types.go` | `Snapshot`, `Aircraft`, `Source` JSON types |
| `internal/aircraft/parse.go` | OpenSky + adsb.lol parse, clip, cap 200 |
| `internal/aircraft/fetch.go` | Pinned-host HTTP, OpenSky then adsb.lol |
| `internal/server/aircraft.go` | `/api/aircraft` cache + `singleflight` |
| `internal/server/config.go`, `handler.go` | `AircraftEnabled`, feed URLs, mux |
| `cmd/server/main.go` | `GULF_AIRCRAFT` |
| `web/src/overlay/aircraftUi.ts` | Availability, caption, readout, dead-reckon, ranks |
| `web/src/overlay/aircraft.ts` | Parse payload, HTML marks, occupancy, poll helpers |
| `web/src/ui/controls.ts`, `web/index.html`, `web/src/style.css`, `web/src/main.ts` | Fieldset, marks layer, globe hide, about |
| `web/package.json` | Add the two new test files to `npm test` |
| `docs/data-sources.md`, `README.md` | Live exception + attribution |

Occupancy uses `visibleLabelIds` inside `aircraft.ts` (same as buoys). Do not change `web/src/ui/labels.ts`.

---

### Task 1: Normalize OpenSky and adsb.lol

**Files:**
- Create: `internal/aircraft/types.go`
- Create: `internal/aircraft/parse.go`
- Test: `internal/aircraft/parse_test.go`

**Interfaces:**
- Consumes: `tiles.BBox`, `tiles.AOI`
- Produces:
  - `type Source string` with `SourceOpenSky Source = "opensky"` and `SourceAdsbLol Source = "adsb.lol"`
  - `type Aircraft struct { ICAO24, Callsign string; Lon, Lat float64; AltBaroM, TrackDeg, GsMps *float64; OnGround *bool }` JSON tags `icao24`, `callsign,omitempty`, `lon`, `lat`, `altBaroM,omitempty`, `trackDeg,omitempty`, `gsMps,omitempty`, `onGround,omitempty`
  - `type Snapshot struct { Source Source; FetchedAt time.Time; Aircraft []Aircraft }` JSON `source`, `fetchedAt` RFC3339 UTC, `aircraft`
  - `func ParseOpenSky(raw []byte, fetchedAt time.Time, clip tiles.BBox) (Snapshot, error)`
  - `func ParseAdsbLol(raw []byte, fetchedAt time.Time, clip tiles.BBox) (Snapshot, error)`
  - `func ClipAndCap(rows []Aircraft, clip tiles.BBox) []Aircraft`
  - `const MaxAircraft = 200`
  - `func KnotsToMps(kt float64) float64` (`kt * 1852 / 3600`)
  - `func FeetToMetres(ft float64) float64` (`ft * 0.3048`)

- [ ] **Step 1: Write the failing test**

```go
package aircraft

import (
	"fmt"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestParseOpenSkyKeepsInBoxDropsNullPosition(t *testing.T) {
	raw := []byte(`{
	  "time": 1,
	  "states": [
	    ["abc123","DAL123  ","United States",1,1,-89.08,30.41,3200,false,120.0,270.0,0,null,3200,null,false,0],
	    ["dead00","NONE    ","United States",1,1,null,null,null,false,null,null,null,null,null,null,false,0],
	    ["outbox","XYZ000  ","United States",1,1,-80.0,40.0,1000,false,50.0,90.0,0,null,1000,null,false,0]
	  ]
	}`)
	got, err := ParseOpenSky(raw, time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC), tiles.AOI)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceOpenSky || len(got.Aircraft) != 1 {
		t.Fatalf("source=%s n=%d", got.Source, len(got.Aircraft))
	}
	a := got.Aircraft[0]
	if a.ICAO24 != "abc123" || a.Callsign != "DAL123" || a.Lon != -89.08 || a.Lat != 30.41 {
		t.Fatalf("%+v", a)
	}
	if a.AltBaroM == nil || *a.AltBaroM != 3200 || a.GsMps == nil || *a.GsMps != 120 || a.TrackDeg == nil || *a.TrackDeg != 270 {
		t.Fatalf("kinematics %+v", a)
	}
	if a.OnGround == nil || *a.OnGround {
		t.Fatalf("onGround %+v", a.OnGround)
	}
}

func TestParseAdsbLolConvertsUnits(t *testing.T) {
	raw := []byte(`{"ac":[{"hex":"a1b2c3","flight":"SWA45 ","lat":30.41,"lon":-89.08,"alt_baro":10000,"track":90,"gs":194.384,"ground":false}]}`)
	got, err := ParseAdsbLol(raw, time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC), tiles.AOI)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceAdsbLol || len(got.Aircraft) != 1 {
		t.Fatalf("%+v", got)
	}
	a := got.Aircraft[0]
	if a.Callsign != "SWA45" {
		t.Fatalf("callsign %q", a.Callsign)
	}
	if a.AltBaroM == nil || *a.AltBaroM != 3048 {
		t.Fatalf("alt %v", a.AltBaroM)
	}
	if a.GsMps == nil || *a.GsMps < 99.9 || *a.GsMps > 100.1 {
		t.Fatalf("gs %v want ~100", a.GsMps)
	}
}

func TestParseAdsbLolGroundAltOmitsAltitude(t *testing.T) {
	raw := []byte(`{"ac":[{"hex":"abc123","lat":30.41,"lon":-89.08,"alt_baro":"ground","ground":true}]}`)
	got, err := ParseAdsbLol(raw, time.Now().UTC(), tiles.AOI)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Aircraft) != 1 || got.Aircraft[0].AltBaroM != nil {
		t.Fatalf("%+v", got.Aircraft)
	}
	if got.Aircraft[0].OnGround == nil || !*got.Aircraft[0].OnGround {
		t.Fatal("ground flag")
	}
}

func TestClipAndCapSortsAndTruncates(t *testing.T) {
	rows := make([]Aircraft, 0, 202)
	for i := 200; i >= 0; i-- {
		rows = append(rows, Aircraft{ICAO24: fmt.Sprintf("%03d", i), Lon: -89, Lat: 30.2})
	}
	rows = append(rows, Aircraft{ICAO24: "zzzzzz", Lon: 0, Lat: 0})
	got := ClipAndCap(rows, tiles.AOI)
	if len(got) != MaxAircraft {
		t.Fatalf("len %d", len(got))
	}
	if got[0].ICAO24 != "000" || got[len(got)-1].ICAO24 != "199" {
		t.Fatalf("range %s..%s", got[0].ICAO24, got[len(got)-1].ICAO24)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].ICAO24 > got[i].ICAO24 {
			t.Fatalf("unsorted %s then %s", got[i-1].ICAO24, got[i].ICAO24)
		}
	}
}

func TestParseOpenSkyRejectsGarbage(t *testing.T) {
	if _, err := ParseOpenSky([]byte(`{"states": "nope"}`), time.Now().UTC(), tiles.AOI); err == nil {
		t.Fatal("expected error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/aircraft/ -count=1`
Expected: FAIL, package not found or `ParseOpenSky` undefined.

- [ ] **Step 3: Write minimal implementation**

`types.go`: structs and `Source` constants as in Interfaces.

`parse.go`:

- OpenSky `states` is an array of arrays. Index 0 icao24, 1 callsign, 5 lon, 6 lat, 7 baro alt (m), 8 on_ground, 9 velocity (m/s), 10 true_track. Missing icao24 or non-finite lon/lat → drop row. Trim callsign; omit if empty. JSON `null` → omit pointer fields. `on_ground` present as bool → set `OnGround`.
- adsb.lol: object with `ac` array. `hex`, `flight`, `lat`, `lon`, `alt_baro` (number feet or `"ground"`), `track`, `gs` (knots), `ground`. Convert units. `"ground"` alt → omit `AltBaroM`.
- `ClipAndCap`: keep `clip.Contains(lon,lat)`, sort by `ICAO24`, truncate to `MaxAircraft`.
- Both parse funcs set `FetchedAt` from the argument (do not use OpenSky `time`). Call `ClipAndCap` before return.
- Invalid JSON or missing `states`/`ac` (wrong type) → error. Empty `states: null` or omitted `ac` → empty snapshot, not error.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/aircraft/ -count=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/aircraft/types.go internal/aircraft/parse.go internal/aircraft/parse_test.go
git commit -m "$(cat <<'EOF'
Parse OpenSky and adsb.lol into one clipped aircraft snapshot.

Keeps the UI off feed-specific arrays so the later proxy can swap
sources without changing the JSON contract.
EOF
)"
```

---

### Task 2: Fetch OpenSky then adsb.lol

**Files:**
- Create: `internal/aircraft/fetch.go`
- Test: `internal/aircraft/fetch_test.go`

**Interfaces:**
- Consumes: `ParseOpenSky`, `ParseAdsbLol`, `tiles.AOI`
- Produces:
  - `const UserAgent = "gulf-seafloor-viewer/0.2 (public-adsb-proxy)"`
  - `const MaxBodyBytes = 2 << 20`
  - `const FetchTimeout = 6 * time.Second`
  - `type Endpoints struct { OpenSky string; AdsbLol string }` // full URLs; OpenSky is the `/states/all` URL without query; AdsbLol is `https://host` origin (path is built)
  - `func DefaultEndpoints() Endpoints` → OpenSky `https://opensky-network.org/api/states/all`, AdsbLol origin `https://api.adsb.lol`
  - `func CoverRadiusNmi(b tiles.BBox) float64` — half-diagonal of the box in nautical miles plus 10 nmi, `math.Ceil`
  - `func OpenSkyURL(base string, b tiles.BBox) string` — add `lamin,lomin,lamax,lomax`
  - `func AdsbLolURL(origin string, b tiles.BBox) string` — `/v2/lat/{midLat}/lon/{midLon}/dist/{CoverRadiusNmi}`
  - `func NewClient() *http.Client` — timeout `FetchTimeout`; `CheckRedirect` refuses a different host than `via[0].URL.Host` and caps 3 hops
  - `func Fetch(ctx context.Context, client *http.Client, ep Endpoints, clip tiles.BBox, now time.Time) (Snapshot, error)` — GET OpenSky; if err, non-200, empty body, or parse fail, GET adsb.lol; if that fails too, return error. Do not return a partial OpenSky parse as success if `states` was garbage.

- [ ] **Step 1: Write the failing test**

```go
package aircraft

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestCoverRadiusCoversAOI(t *testing.T) {
	r := CoverRadiusNmi(tiles.AOI)
	if r < 80 || r > 120 {
		t.Fatalf("radius %v nmi, expected ~90", r)
	}
}

func TestFetchUsesOpenSkyWhenOK(t *testing.T) {
	var hits []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		if r.Header.Get("User-Agent") != UserAgent {
			t.Errorf("ua %q", r.Header.Get("User-Agent"))
		}
		if !strings.Contains(r.URL.RawQuery, "lamin=") {
			t.Errorf("query %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","DAL123  ",null,1,1,-89.08,30.41,1000,false,80,180,0,null,1000,null,false,0]]}`)
	}))
	t.Cleanup(up.Close)
	got, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: up.URL + "/states/all", AdsbLol: "http://127.0.0.1:1"}, tiles.AOI, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceOpenSky || len(got.Aircraft) != 1 {
		t.Fatalf("%+v", got)
	}
	if len(hits) != 1 {
		t.Fatalf("hits %v", hits)
	}
}

func TestFetchFallsBackOnOpenSky429(t *testing.T) {
	sky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(sky.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/v2/lat/") {
			t.Errorf("path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ac":[{"hex":"abc123","lat":30.41,"lon":-89.08,"gs":10,"track":0,"ground":false}]}`)
	}))
	t.Cleanup(lol.Close)
	got, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: sky.URL, AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceAdsbLol {
		t.Fatalf("source %s", got.Source)
	}
}

func TestFetchBothFail(t *testing.T) {
	sky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(sky.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(lol.Close)
	if _, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: sky.URL, AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC()); err == nil {
		t.Fatal("expected error")
	}
}

func TestFetchDoesNotFollowOffHostRedirect(t *testing.T) {
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("followed off-host redirect")
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(evil.Close)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/secret", http.StatusFound)
	}))
	t.Cleanup(up.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(lol.Close)
	if _, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: up.URL, AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC()); err == nil {
		t.Fatal("redirect must not parse as success")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/aircraft/ -count=1`
Expected: FAIL, `Fetch` undefined.

- [ ] **Step 3: Write minimal implementation**

`getCapped`: GET with context, set User-Agent, `io.LimitReader` `MaxBodyBytes+1`, reject oversize. Status not 200 → error including status.

`Fetch`: try OpenSky URL with bbox query; on any failure, try adsb.lol path. Body cap applies to both.

`NewClient` redirect rule matches imagery: different host than the first request → `http.ErrUseLastResponse`.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/aircraft/ -count=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/aircraft/fetch.go internal/aircraft/fetch_test.go
git commit -m "$(cat <<'EOF'
Fetch aircraft from OpenSky and fall back to adsb.lol.

Keeps one pinned HTTP client and a bbox query so anonymous OpenSky
credits stay at one per poll and the browser never leaves our origin.
EOF
)"
```

---

### Task 3: Serve `/api/aircraft` with a 10 s cache

**Files:**
- Create: `internal/server/aircraft.go`
- Modify: `internal/server/config.go` (add fields below)
- Modify: `internal/server/handler.go` (`Server` gains `ac *aircraftCache`; mux `GET /api/aircraft`; construct cache in `New`)
- Modify: `cmd/server/main.go` (`AircraftEnabled: os.Getenv("GULF_AIRCRAFT") != "0"`, pass feed URL env if set)
- Test: `internal/server/aircraft_test.go`

**Interfaces:**
- Consumes: `aircraft.Fetch`, `aircraft.NewClient`, `aircraft.DefaultEndpoints`, `aircraft.Snapshot`, `tiles.AOI`
- Produces:
  - Config fields:
    - `AircraftEnabled bool` — main.go sets true unless `GULF_AIRCRAFT=0`
    - `OpenSkyURL string` — empty → `DefaultEndpoints().OpenSky`
    - `AdsbLolURL string` — empty → `DefaultEndpoints().AdsbLol`
    - `AircraftNow func() time.Time` — nil → `time.Now().UTC`
    - `AircraftCacheTTL time.Duration` — 0 → 10s
    - `AircraftStaleFor time.Duration` — 0 → 60s
  - Route `GET`/`HEAD` `/api/aircraft`
  - `Cache-Control: no-store`
  - JSON body is `aircraft.Snapshot`
  - Disabled or both feeds down with no usable cache → **404 empty body**
  - Other methods → 405

- [ ] **Step 1: Write the failing test**

```go
package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/aircraft"
)

func aircraftHandler(t *testing.T, sky http.HandlerFunc, lol http.HandlerFunc, now func() time.Time) http.Handler {
	t.Helper()
	up := httptest.NewServer(sky)
	t.Cleanup(up.Close)
	fb := httptest.NewServer(lol)
	t.Cleanup(fb.Close)
	return New(Config{
		TileDir:         "testdata/tiles",
		WebDir:          t.TempDir(),
		TileWorkers:     1,
		AircraftEnabled: true,
		OpenSkyURL:      up.URL + "/states/all",
		AdsbLolURL:      fb.URL,
		AircraftNow:     now,
		AircraftCacheTTL: 10 * time.Second,
		AircraftStaleFor: 60 * time.Second,
	})
}

func TestAircraftDisabledIs404(t *testing.T) {
	h := New(Config{TileDir: "testdata/tiles", WebDir: t.TempDir(), TileWorkers: 1, AircraftEnabled: false})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestAircraftServesOpenSkyAndCaches(t *testing.T) {
	var n atomic.Int32
	now := time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","DAL123  ",null,1,1,-89.08,30.41,1000,false,80,180,0,null,1000,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("fallback should not run")
	}, clock)
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("cc %s", rec.Header().Get("Cache-Control"))
		}
		var snap aircraft.Snapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Source != aircraft.SourceOpenSky || len(snap.Aircraft) != 1 {
			t.Fatalf("%+v", snap)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("upstream hits %d", n.Load())
	}
}

func TestAircraftHEADOmitsBody(t *testing.T) {
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {}, time.Now)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/api/aircraft", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("status %d len %d", rec.Code, rec.Body.Len())
	}
}

func TestAircraftPOSTIs405(t *testing.T) {
	h := New(Config{TileDir: "testdata/tiles", WebDir: t.TempDir(), TileWorkers: 1, AircraftEnabled: true})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/aircraft", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestAircraftStaleCacheWhenBothDown(t *testing.T) {
	now := time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	var sky http.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) { sky(w, r) }, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}, clock)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	sky = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }
	now = now.Add(15 * time.Second) // TTL expired, stale window open
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("stale want 200 got %d", rec.Code)
	}
	now = now.Add(60 * time.Second) // beyond 60s from original fetch
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expired stale want 404 got %d", rec.Code)
	}
}

func TestReadyzOKWhenAircraftDisabled(t *testing.T) {
	h := New(Config{TileDir: "testdata/tiles", WebDir: t.TempDir(), TileWorkers: 1, AircraftEnabled: false})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}
func TestAircraftSingleflightCoalesces(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var n atomic.Int32
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		started <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("fallback should not run")
	}, time.Now)
	done := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
			done <- rec.Code
		}()
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream did not start")
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	for i := 0; i < 2; i++ {
		if code := <-done; code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("upstream hits %d", n.Load())
	}
}
```

Run: `go test ./internal/server/ -run Aircraft -count=1`
Expected: FAIL, unknown Config fields / no route.

- [ ] **Step 3: Write minimal implementation**

`aircraftCache` on `Server`: mutex, last `Snapshot`, last success `time.Time`, `singleflight.Group`, `*http.Client` from `aircraft.NewClient()`.

`handleAircraft`: 405 unless GET/HEAD; 404 if `!cfg.AircraftEnabled`; `singleflight.Do("aircraft", ...)` when cache age ≥ TTL; on fetch error, if last success age < StaleFor serve last snapshot else 404; set `Cache-Control: no-store`; HEAD omits body.

`New` must construct the cache even when disabled (handler still 404s).

`cmd/server/main.go`: `AircraftEnabled: os.Getenv("GULF_AIRCRAFT") != "0"`, `OpenSkyURL: os.Getenv("GULF_OPENSKY_URL")`, `AdsbLolURL: os.Getenv("GULF_ADSBLOL_URL")`.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/server/ -count=1` and `go test ./... -count=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/server/aircraft.go internal/server/aircraft_test.go internal/server/config.go internal/server/handler.go cmd/server/main.go
git commit -m "$(cat <<'EOF'
Serve live aircraft JSON from a shared 10s OpenSky cache.

One upstream poll per TTL keeps anonymous credits intact and lets
every tab share the same positions without leaving same-origin.
EOF
)"
```

---

### Task 4: Client parse, caption, readout, dead-reckon

**Files:**
- Create: `web/src/overlay/aircraftUi.ts`
- Test: `web/src/overlay/aircraftUi.test.ts`
- Create: `web/src/overlay/aircraft.ts` (parse + occupancy + dead-reckon helpers only in this task if they stay DOM-free; keep `mountAircraft` for Task 5)
- Test: `web/src/overlay/aircraft.test.ts`
- Modify: `web/package.json` — append `src/overlay/aircraftUi.test.ts src/overlay/aircraft.test.ts` to the `test` script

**Interfaces:**
- Consumes: `formatValidZ` from `oceanUi.ts`, `msToKnots` from `windBarb.ts`, `visibleLabelIds` / `MIN_LABEL_PX` from `labelLayout.ts`, `bboxContains` / `AOI` from `geo.ts`
- Produces:
  - `export const AIRCRAFT_RANK = 20`
  - `export const AIRCRAFT_ID_BASE = 2000`
  - `export type Aircraft = { icao24: string; callsign?: string; lon: number; lat: number; altBaroM?: number; trackDeg?: number; gsMps?: number; onGround?: boolean }`
  - `export type AircraftSnapshot = { source: 'opensky' | 'adsb.lol'; fetchedAt: string; aircraft: Aircraft[] }`
  - `export function aircraftAvailable(status: number): boolean` — true iff 200
  - `export function aircraftChromeHidden(mode: 'globe' | 'bathymetry'): boolean` — true on globe
  - `export function aircraftCaption(source: string | null, fetchedAt: string | null): string` — `Aircraft OpenSky 02:00Z` / `Aircraft adsb.lol 02:00Z` / `''`
  - `export function aircraftReadout(a: Aircraft): string` — lines: callsign or icao24, icao24 if callsign present, altitude `3200 m`, track `270°`, speed knots `1` decimal + ` kt`. Omit missing.
  - `export function deadReckon(a: Aircraft, dtSec: number): { lon: number; lat: number }` — if `onGround === true` OR `onGround` omitted OR `trackDeg`/`gsMps` missing, return `{lon, lat}` unchanged. Else east = `gs*sin(track)`, north = `gs*cos(track)`, metres to deg with `111320` and `cos(lat)`.
  - `export function parseAircraftJson(raw: unknown): AircraftSnapshot | null`
  - `export function layoutAircraftVisibility(extra: LabelCandidate[], rows: Aircraft[], project, width, height, aoi?): { visible: Set<number>; candidates: LabelCandidate[]; positions: Array<{x,y}|null> }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleLabelIds } from '../ui/labelLayout.ts';
import {
  AIRCRAFT_RANK,
  aircraftAvailable,
  aircraftCaption,
  aircraftChromeHidden,
  aircraftReadout,
  deadReckon,
} from './aircraftUi.ts';
import { AIRCRAFT_ID_BASE, layoutAircraftVisibility, parseAircraftJson } from './aircraft.ts';
import { BUOY_RANK } from './oceanUi.ts';

describe('aircraftAvailable', () => {
  it('is true only for HTTP 200', () => {
    assert.equal(aircraftAvailable(200), true);
    assert.equal(aircraftAvailable(404), false);
    assert.equal(aircraftAvailable(500), false);
  });
});

describe('aircraftChromeHidden', () => {
  it('hides on globe and shows on bathymetry', () => {
    assert.equal(aircraftChromeHidden('globe'), true);
    assert.equal(aircraftChromeHidden('bathymetry'), false);
  });
});

describe('aircraftCaption', () => {
  it('names the feed and compact Z time', () => {
    assert.equal(aircraftCaption('opensky', '2026-08-26T02:00:00Z'), 'Aircraft OpenSky 02:00Z');
    assert.equal(aircraftCaption('adsb.lol', '2026-08-26T02:10:00Z'), 'Aircraft adsb.lol 02:10Z');
    assert.equal(aircraftCaption(null, null), '');
  });
});

describe('deadReckon', () => {
  it('moves north at 111.32 m/s for 1s near the equator-ish test lat', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 0, gsMps: 111.32, onGround: false };
    const got = deadReckon(a, 1);
    assert.ok(Math.abs(got.lon + 89) < 1e-8);
    assert.ok(got.lat > 30.0009 && got.lat < 30.0011);
  });
  it('does not coast when onGround is omitted', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 90, gsMps: 100 };
    assert.deepEqual(deadReckon(a, 10), { lon: -89, lat: 30 });
  });
  it('does not coast when reduced-motion caller passes dt 0', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 90, gsMps: 100, onGround: false };
    assert.deepEqual(deadReckon(a, 0), { lon: -89, lat: 30 });
  });
});

describe('parseAircraftJson', () => {
  it('drops rows missing icao24 or lon/lat', () => {
    const parsed = parseAircraftJson({
      source: 'opensky',
      fetchedAt: '2026-08-26T02:00:00Z',
      aircraft: [
        { icao24: 'abc123', lon: -89.08, lat: 30.41, trackDeg: 270, gsMps: 80, onGround: false },
        { icao24: '', lon: -89, lat: 30 },
        { lon: -89, lat: 30 },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.aircraft.length, 1);
    assert.equal(parsed.aircraft[0]?.icao24, 'abc123');
  });
});

describe('layoutAircraftVisibility', () => {
  const project = (lon: number, lat: number) => ({ x: lon, y: lat });
  it('yields to a place or buoy at the same pixel', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const place = [{ id: 0, x: 100, y: 10, rank: 1 }];
    const { visible } = layoutAircraftVisibility(place, rows, project, 800, 400);
    assert.equal(visible.has(AIRCRAFT_ID_BASE), false);
    const buoy = [{ id: 1000, x: 100, y: 10, rank: BUOY_RANK }];
    const again = layoutAircraftVisibility(buoy, rows, project, 800, 400);
    assert.equal(again.visible.has(AIRCRAFT_ID_BASE), false);
  });
  it('uses AIRCRAFT_RANK 20', () => {
    assert.equal(AIRCRAFT_RANK, 20);
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const { candidates } = layoutAircraftVisibility([], rows, project, 800, 400);
    assert.equal(candidates[0]?.rank, 20);
  });
});
```

Add `aircraftReadout` cases: full fields, and omit altitude when missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --experimental-strip-types --test src/overlay/aircraftUi.test.ts src/overlay/aircraft.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

Caption source map: `opensky` → `OpenSky`, `adsb.lol` → `adsb.lol`. Reuse `formatValidZ`.

Dead-reckon meters/deg: `mPerDegLat = 111320`, `mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180)`. Track is true degrees clockwise from north.

`parseAircraftJson`: require `source` one of the two strings, non-empty `fetchedAt`, `aircraft` array. Re-validate each row (do not trust the server blindly).

`layoutAircraftVisibility`: skip rows outside `aoi` when provided; `id = AIRCRAFT_ID_BASE + index`; merge `extra` then aircraft candidates into `visibleLabelIds`.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `cd web && npm test`
Expected: PASS (existing tests still pass).

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/aircraftUi.ts web/src/overlay/aircraftUi.test.ts web/src/overlay/aircraft.ts web/src/overlay/aircraft.test.ts web/package.json
git commit -m "$(cat <<'EOF'
Add aircraft overlay math: parse, caption, and dead-reckon.

Keeps motion and occupancy testable without DOM so globe-hidden
chrome and buoy-rank collisions are locked before marks land.
EOF
)"
```

---

### Task 5: Marks, controls, globe hide, docs

**Files:**
- Modify: `web/src/overlay/aircraft.ts` — add `mountAircraft`
- Modify: `web/src/ui/controls.ts` — `aircraft: boolean` on `ViewerControls`; `setAircraftReadout` (mirror `setBuoyReadout` with `.readout-aircraft` / `dataset.aircraft`); read `input[name="aircraft"]`
- Modify: `web/index.html` — `#aircraft-marks` sibling of `#buoy-marks`; fieldset `#aircraft` after `#ocean`; about paragraph
- Modify: `web/src/style.css` — marks + `#app.is-globe #aircraft` / `#aircraft-marks` like buoys
- Modify: `web/src/main.ts` — fetch `/api/aircraft`, poll 10 s, pause on `document.hidden` and globe, dead-reckon in the rAF loop (dt 0 if reduced motion), caption, radios
- Modify: `docs/data-sources.md`, `README.md`

**Interfaces:**
- Consumes: Task 4 exports, `setAircraftReadout`, existing `fetchOk` / `setOceanRadios` pattern
- Produces:
  - `mountAircraft(root, aoi?): AircraftHandle` with `layout(project, w, h, extraCandidates)`, `setEnabled`, `setAircraft(rows)`, `candidates(...)`
  - Marks are `<button type="button" class="aircraft-mark">` with chevron (CSS triangle or inline SVG) rotated by `trackDeg`, label = callsign or icao24. Square class when no track or grounded without track.
  - Poll interval 10_000 ms. `visibilitychange` clears/restarts. Globe `setMode` calls `setEnabled(false)` and does not poll.

- [ ] **Step 1: Write the failing test**

Add to `web/src/overlay/aircraftUi.test.ts` and implement in `aircraftUi.ts`:

```ts
import { shouldPollAircraft } from './aircraftUi.ts';

describe('shouldPollAircraft', () => {
  const on = { layerOn: true, documentHidden: false, available: true };
  it('polls only on bathymetry while visible and enabled', () => {
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on }), true);
    assert.equal(shouldPollAircraft({ mode: 'globe', ...on }), false);
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on, documentHidden: true }), false);
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on, layerOn: false }), false);
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on, available: false }), false);
  });
});
```

```ts
export function shouldPollAircraft(opts: {
  mode: 'globe' | 'bathymetry';
  layerOn: boolean;
  documentHidden: boolean;
  available: boolean;
}): boolean {
  return opts.mode === 'bathymetry' && opts.layerOn && !opts.documentHidden && opts.available;
}
```

- [ ] **Step 2: Run test to verify it fails, then pass**

Run: `cd web && node --experimental-strip-types --test src/overlay/aircraftUi.test.ts`
Expected: first FAIL (`shouldPollAircraft` missing), then PASS after the function exists.

- [ ] **Step 3: Implement marks and UI**

HTML fieldset (after ocean):

```html
<fieldset id="aircraft" class="control-block">
  <legend>Aircraft</legend>
  <div class="radio-row">
    <label><input type="radio" name="aircraft" value="0" /> Off</label>
    <label><input type="radio" name="aircraft" value="1" checked /> On</label>
  </div>
</fieldset>
```

Marks layer:

```html
<div id="aircraft-marks" hidden></div>
```

CSS: copy `#buoy-marks` rules to `#aircraft-marks`. Chevron: 10px, chart `--land` color, `transform: translate(-50%, -50%) rotate(Ndeg)` where 0° track points up. About copy (not “radar”):

```html
<div class="aircraft-about">
  <h3>Aircraft overlay</h3>
  <p>
    On bathymetry, live public ADS-B positions over this box can appear as
    heading marks. Data from The OpenSky Network, with adsb.lol as fallback.
    Not for navigation. Not a snapshot; this layer is empty with the network
    unplugged. Do not infer endorsement by OpenSky or adsb.lol.
  </p>
</div>
```

Hide `.aircraft-about` in globe CSS like `.ocean-about`.

`main.ts` poll:

```ts
let aircraftTimer: number | undefined;
function aircraftPolling(): boolean {
  return viewMode === 'bathymetry' && aircraftOn && !document.hidden && aircraftAvailableStatus;
}
function restartAircraftPoll(): void {
  if (aircraftTimer !== undefined) window.clearInterval(aircraftTimer);
  aircraftTimer = undefined;
  if (!aircraftPolling()) return;
  void pullAircraft();
  aircraftTimer = window.setInterval(() => { void pullAircraft(); }, 10_000);
}
document.addEventListener('visibilitychange', restartAircraftPoll);
```

`pullAircraft` uses `fetchOk('/api/aircraft')`. 200 → parse, `setAircraft`, enable radios. 404 → disable, `setAircraft([])`. Never throw.

In the frame loop, if enabled and not reduced motion, for each aircraft `deadReckon` by frame dt since last snapshot `fetchedAt` (or since last apply). Spec: dead-reckon between polls, snap when a new report arrives. Store `report = { t: performance.now(), rows }` on each successful pull; each frame `dt = (now - report.t) / 1000` and dead-reckon from the report positions (not from already-coasted positions).

Globe `setMode('globe')`: `aircraftFieldset.hidden = aircraftChromeHidden('globe')`, `aircraftMarks.hidden = true`, `aircraftHandle?.setEnabled(false)`, `restartAircraftPoll()`.

Extend `setCaption` to append `aircraftCaption` with a middle dot when the layer is on.

`setOceanRadios` currently types `name: 'currents' | 'buoys'`. Either generalize to `'currents' | 'buoys' | 'aircraft'` or add `setAircraftRadios` with the same body.

`mountControls` initial state includes `aircraft: false` until fetch returns (same as ocean).

- [ ] **Step 4: Docs**

`docs/data-sources.md` source-index rows:

| OpenSky Network | `https://opensky-network.org/api/states/all` bbox, anonymous, no key. Live at view time via `/api/aircraft`. | OpenSky terms for non-commercial/research use of the REST API. | Acknowledge The OpenSky Network. No endorsement. Not for navigation. | No |
| adsb.lol | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` fallback only. | ODbL as documented by the API. | Acknowledge adsb.lol / feeders. No endorsement. | No |

Add a short “Live aircraft” subsection: not vendored, `GULF_AIRCRAFT=0` for air-gap, server polls only when a client asks, 10 s floor, 400 anonymous OpenSky credits/day.

README: list `GET /api/aircraft` next to ocean routes; note live exception vs ocean snapshot; `GULF_AIRCRAFT=0`.

- [ ] **Step 5: Run tests**

Run: `go test ./... -count=1` and `cd web && npm test`
Expected: PASS

- [ ] **Step 6: Manual check (not CI)**

`make run` on a network. Bathymetry: aircraft fieldset enabled if 200; marks over GPT/MOB or overflights. Switch to globe: fieldset gone, marks gone, Cesium unchanged. Hide the tab: polling stops (no `/api/aircraft` in network panel). Unplug: after 60 s stale window, toggle disables; terrain and ocean still work.

- [ ] **Step 7: Commit**

```bash
git add web/src/overlay/aircraft.ts web/src/ui/controls.ts web/index.html web/src/style.css web/src/main.ts docs/data-sources.md README.md
git commit -m "$(cat <<'EOF'
Draw live aircraft marks on the bathymetry chart only.

Keeps globe and air-gap terrain untouched while a same-origin poll
shows OpenSky positions as quiet heading chevrons.
EOF
)"
```

---

## Self-review (plan vs spec)

| Spec section | Task |
|---|---|
| §1–2 live, no key, bathymetry only, globe out | Global constraints + Tasks 3–5 |
| §3 architecture / CSP | Tasks 2–3 (browser only `/api/aircraft`) |
| §4.1 OpenSky bbox | Tasks 1–2 |
| §4.2 adsb.lol fallback + unit conversion | Tasks 1–2 |
| §4.3 cache 10 s, singleflight, stale 60 s, `no-store`, `GULF_AIRCRAFT=0` | Task 3 |
| §4.4 normalize, cap 200 by icao24, omit empty callsign | Task 1 |
| §5 marks, poll, dead-reckon, reduced motion, readout, ranks, caption, about | Tasks 4–5 |
| §6 error table | Tasks 2–3, 5 |
| §7 tests, no live network in CI | Tasks 1–4; Task 5 manual |
| §8 files / no `cmd/aircraft` | File structure |
| §9 attribution | Task 5 docs |

No globe Cesium path. No keyed APIs. No snapshot ingest.
