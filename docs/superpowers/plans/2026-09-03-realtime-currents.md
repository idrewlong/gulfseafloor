# Real-time currents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the currents overlay from an 8-day-stale hand-run snapshot drawn in flat cyan into a self-refreshing HYCOM forecast stack interpolated to wall-clock time and drawn as speed-ramped tapered streaklines.

**Architecture:** `ocean.Currents` gains a `Steps []Step` time axis (legacy flat `u`/`v` still decodes as a one-step stack). A background goroutine in the Go server refreshes the stack from HYCOM NCSS on a ~1 h ticker, never on the request path, writing through to `data/ocean/`. The browser polls with `If-None-Match`, interpolates the stack to now every 30 s on the CPU, and re-uploads one velocity texture in place. The GPU ping-pong particle sim is kept; only its geometry, shaders, and colour change.

**Tech Stack:** Go 1.x (`net/http`, `log/slog`, `httptest`), TypeScript + three.js r185, WebGL2 GLSL, `node --experimental-strip-types --test`.

**Spec:** `docs/superpowers/specs/2026-09-03-realtime-currents-design.md`

## Global Constraints

- Forecast window is **−3 h to +24 h at 3-hourly cadence = 10 steps**.
- `u`/`v` are **quantized to 3 decimal places** (1 mm/s) everywhere they are serialized.
- The refresher requests **`accept=netcdf`, once per forecast step (10 single-time requests), and merges the results.** `accept=csv` was tried against the live service and rejected — NCSS's grid endpoint answers HTTP 400 "Format csv is not supported for Grid data request"; CSV is only valid there for point requests. `parseHYCOMNetCDF` reads `times[0]` only and stays single-step, so the multi-time stack comes from merging N single-time NetCDF responses, not from teaching the parser to index a time dimension.
- **Nothing fetches on the HTTP request path.** `/api/ocean/currents` answers from memory or disk, always.
- `GULF_OCEAN_REFRESH` is **on unless `0`**, matching the existing `GULF_AIRCRAFT` convention in `cmd/server/main.go:43`.
- Legacy single-step `currents.json` must keep decoding. `data/ocean/currents.json` on disk today is that shape.
- Null cells stay null. A null in either bracketing step yields null — no-data never interpolates into a fabricated velocity.
- Browser CSP stays `connect-src 'self'`. The browser never calls HYCOM.
- New TS test files **must be added to the explicit file list** in `web/package.json` `scripts.test` or they will not run.
- Go verification is `go test ./...`; web verification is `cd web && npm test && npm run build`.

---

### Task 1: `Currents` gains a time axis

**Files:**
- Modify: `internal/ocean/types.go:22-32`
- Modify: `internal/ocean/decode.go:11-43`
- Test: `internal/ocean/decode_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `ocean.Step{ValidTime time.Time; U, V []*float64}`; `ocean.Currents.Steps []Step`; `DecodeCurrents(io.Reader) (Currents, error)` unchanged in signature, now populating `Steps` from either shape.

- [ ] **Step 1: Write the failing tests**

Append to `internal/ocean/decode_test.go`:

```go
const twoStepCurrentsJSON = `{
  "validTime": "2026-09-03T12:00:00Z",
  "source": {"name": "HYCOM", "dataset": "GLBy0.08/latest", "url": "https://example.invalid/ncss"},
  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
  "nx": 2, "ny": 1, "grid": "centers",
  "steps": [
    {"validTime": "2026-09-03T12:00:00Z", "u": [0.12, null], "v": [-0.04, null]},
    {"validTime": "2026-09-03T15:00:00Z", "u": [0.20, null], "v": [-0.08, null]}
  ]
}`

func TestDecodeCurrentsMultiStep(t *testing.T) {
	c, err := DecodeCurrents(strings.NewReader(twoStepCurrentsJSON))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(c.Steps) != 2 {
		t.Fatalf("steps = %d, want 2", len(c.Steps))
	}
	if !c.Steps[1].ValidTime.Equal(time.Date(2026, 9, 3, 15, 0, 0, 0, time.UTC)) {
		t.Errorf("step 1 validTime = %v", c.Steps[1].ValidTime)
	}
	if c.Steps[0].U[1] != nil {
		t.Error("null cell must stay nil")
	}
	if !c.ValidTime.Equal(c.Steps[0].ValidTime) {
		t.Error("validTime must equal the first step")
	}
}

// The snapshot already on disk is the flat shape. It must keep working.
func TestDecodeCurrentsLegacyLiftsToOneStep(t *testing.T) {
	c, err := DecodeCurrents(strings.NewReader(validCurrentsJSON))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(c.Steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(c.Steps))
	}
	if !c.Steps[0].ValidTime.Equal(c.ValidTime) {
		t.Error("lifted step must carry the top-level validTime")
	}
	if got := *c.Steps[0].U[0]; got != 0.12 {
		t.Errorf("u[0] = %v, want 0.12", got)
	}
}

func TestDecodeCurrentsRejectsBadSteps(t *testing.T) {
	cases := map[string]string{
		"step length mismatch":  `"steps": [{"validTime": "2026-09-03T12:00:00Z", "u": [0.1], "v": [0.1, 0.1]}]`,
		"non-monotonic times":   `"steps": [{"validTime": "2026-09-03T15:00:00Z", "u": [0.1, 0.1], "v": [0.1, 0.1]}, {"validTime": "2026-09-03T12:00:00Z", "u": [0.1, 0.1], "v": [0.1, 0.1]}]`,
		"empty steps":           `"steps": []`,
		"step missing validTime": `"steps": [{"u": [0.1, 0.1], "v": [0.1, 0.1]}]`,
	}
	for name, steps := range cases {
		t.Run(name, func(t *testing.T) {
			body := `{
  "validTime": "2026-09-03T12:00:00Z",
  "source": {"name": "HYCOM"},
  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
  "nx": 2, "ny": 1, "grid": "centers",` + steps + `}`
			if _, err := DecodeCurrents(strings.NewReader(body)); err == nil {
				t.Fatal("want error, got nil")
			}
		})
	}
}
```

Ensure `strings` and `time` are imported in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/ocean/ -run TestDecodeCurrents -v`
Expected: FAIL — `c.Steps` undefined.

- [ ] **Step 3: Add the types**

In `internal/ocean/types.go`, replace the `Currents` struct:

```go
// Step is one forecast time of the surface velocity grid. U and V are
// row-major, west-to-east, south-to-north; nil cells are missing.
type Step struct {
	ValidTime time.Time  `json:"validTime"`
	U         []*float64 `json:"u"`
	V         []*float64 `json:"v"`
}

// Currents is a stack of surface velocity grids (u eastward, v northward,
// m/s) sharing one bbox and shape. ValidTime is the first step.
type Currents struct {
	ValidTime time.Time `json:"validTime"`
	Source    Source    `json:"source"`
	BBox      BBox      `json:"bbox"`
	NX        int       `json:"nx"`
	NY        int       `json:"ny"`
	Grid      string    `json:"grid"`
	Steps     []Step    `json:"steps"`

	// U and V are the legacy single-step fields. They are decode-only:
	// DecodeCurrents lifts them into Steps and they are never marshalled.
	U []*float64 `json:"u,omitempty"`
	V []*float64 `json:"v,omitempty"`
}
```

- [ ] **Step 4: Implement the decode rules**

In `internal/ocean/decode.go`, replace the `len(c.U) != need` block in `DecodeCurrents` with:

```go
	need := c.NX * c.NY
	if len(c.Steps) == 0 {
		// Legacy flat shape: lift u/v into a one-step stack.
		if len(c.U) != need || len(c.V) != need {
			return Currents{}, fmt.Errorf("ocean: currents: u/v length must equal nx*ny (%d)", need)
		}
		c.Steps = []Step{{ValidTime: c.ValidTime, U: c.U, V: c.V}}
	}
	var prev time.Time
	for i := range c.Steps {
		st := &c.Steps[i]
		valid, err := requireUTC(st.ValidTime)
		if err != nil {
			return Currents{}, fmt.Errorf("ocean: currents: step %d validTime %w", i, err)
		}
		if valid.IsZero() {
			return Currents{}, fmt.Errorf("ocean: currents: step %d missing validTime", i)
		}
		st.ValidTime = valid
		if i > 0 && !valid.After(prev) {
			return Currents{}, fmt.Errorf("ocean: currents: step %d validTime must increase", i)
		}
		prev = valid
		if len(st.U) != need || len(st.V) != need {
			return Currents{}, fmt.Errorf("ocean: currents: step %d u/v length must equal nx*ny (%d)", i, need)
		}
	}
	c.U, c.V = nil, nil
	c.ValidTime = c.Steps[0].ValidTime
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/ocean/ -v`
Expected: PASS, including the pre-existing decode and snapshot tests.

- [ ] **Step 6: Commit**

```bash
git add internal/ocean/types.go internal/ocean/decode.go internal/ocean/decode_test.go
git commit -m "Give currents a time axis, keeping the flat shape readable."
```

---

### Task 2: Parse a multi-time HYCOM CSV, quantized

**Files:**
- Modify: `internal/ocean/hycom.go:29-174`
- Modify: `internal/ocean/snapshot.go:37-55`
- Test: `internal/ocean/hycom_test.go`

**Interfaces:**
- Consumes: `ocean.Step`, `ocean.Currents.Steps` from Task 1.
- Produces: `ParseHYCOMCSV(io.Reader, Source) (Currents, error)` now returns one step per distinct time, sorted ascending, quantized to 3 decimals. `ParseHYCOM` dispatch is unchanged; `parseHYCOMNetCDF` still returns one step.

- [ ] **Step 1: Write the failing test**

Append to `internal/ocean/hycom_test.go`:

```go
func TestParseHYCOMCSVGroupsByTime(t *testing.T) {
	csv := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T12:00:00Z,30.0,-89.0,0.1234567,-0.05\n" +
		"2026-09-03T12:00:00Z,30.0,-88.0,0.2,-0.06\n" +
		"2026-09-03T15:00:00Z,30.0,-89.0,0.3,-0.07\n" +
		"2026-09-03T15:00:00Z,30.0,-88.0,0.4,-0.08\n"
	c, err := ParseHYCOMCSV(strings.NewReader(csv), Source{Name: "HYCOM"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(c.Steps) != 2 {
		t.Fatalf("steps = %d, want 2", len(c.Steps))
	}
	if c.NX != 2 || c.NY != 1 {
		t.Fatalf("shape = %dx%d, want 2x1", c.NX, c.NY)
	}
	if !c.Steps[0].ValidTime.Before(c.Steps[1].ValidTime) {
		t.Error("steps must be sorted ascending")
	}
	if got := *c.Steps[0].U[0]; got != 0.123 {
		t.Errorf("u = %v, want 0.123 (quantized to 1 mm/s)", got)
	}
	if got := *c.Steps[1].U[1]; got != 0.4 {
		t.Errorf("second step u = %v, want 0.4", got)
	}
}

func TestParseHYCOMCSVRejectsRaggedTimes(t *testing.T) {
	csv := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T12:00:00Z,30.0,-89.0,0.1,-0.05\n" +
		"2026-09-03T12:00:00Z,30.0,-88.0,0.2,-0.06\n" +
		"2026-09-03T15:00:00Z,30.0,-89.0,0.3,-0.07\n"
	if _, err := ParseHYCOMCSV(strings.NewReader(csv), Source{Name: "HYCOM"}); err == nil {
		t.Fatal("a time with fewer cells than the grid must be an error")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/ocean/ -run TestParseHYCOMCSV -v`
Expected: FAIL — the current parser errors with "time differs from first row".

- [ ] **Step 3: Delete the test that asserts the old behaviour**

`internal/ocean/hycom_test.go:138` is `TestParseHYCOMCSVRejectsMixedTimes`. It
asserts that a CSV with two times is an error — exactly the behaviour this task
removes. Delete that test function. Leaving it in place will fail the build.

- [ ] **Step 4: Make `gridFromCells` produce a step**

`gridFromCells` currently sets the `U`/`V` fields, which Task 1 turned into
decode-only legacy fields. Split the cell-to-array work out so both callers
share it, and have `gridFromCells` return a one-step stack. This also gives
`parseHYCOMNetCDF` a valid stack for free, with no change to that file.

In `internal/ocean/hycom.go`, replace `gridFromCells` with:

```go
// stepFromCells lays cells out row-major, west-to-east, south-to-north.
// lons and lats must already be sorted ascending.
func stepFromCells(cells []hycomCell, lons, lats []float64) ([]*float64, []*float64) {
	nx, ny := len(lons), len(lats)
	lonIdx := make(map[float64]int, nx)
	latIdx := make(map[float64]int, ny)
	for i, lon := range lons {
		lonIdx[lon] = i
	}
	for j, lat := range lats {
		latIdx[lat] = j
	}
	u := make([]*float64, nx*ny)
	v := make([]*float64, nx*ny)
	for _, c := range cells {
		idx := latIdx[c.lat]*nx + lonIdx[c.lon]
		u[idx] = quantizePtr(c.u)
		v[idx] = quantizePtr(c.v)
	}
	return u, v
}

// quantizePtr rounds to 1 mm/s. Sub-millimetre precision on a 1/12-degree
// model is noise, and it roughly halves the serialized payload.
func quantizePtr(v *float64) *float64 {
	if v == nil {
		return nil
	}
	q := math.Round(*v*1000) / 1000
	return &q
}

func gridFromCells(cells []hycomCell, lons, lats []float64, validTime time.Time, src Source) (Currents, error) {
	sort.Float64s(lons)
	sort.Float64s(lats)
	nx, ny := len(lons), len(lats)
	u, v := stepFromCells(cells, lons, lats)
	return Currents{
		ValidTime: validTime,
		Source:    src,
		BBox: BBox{
			West:  lons[0],
			South: lats[0],
			East:  lons[nx-1],
			North: lats[ny-1],
		},
		NX:    nx,
		NY:    ny,
		Grid:  "centers",
		Steps: []Step{{ValidTime: validTime, U: u, V: v}},
	}, nil
}
```

Add `math` to the imports.

- [ ] **Step 5: Group CSV rows by time**

In `ParseHYCOMCSV`, delete the `time differs from first row` rejection. Replace
the declarations above the row loop:

```go
	byTime := map[time.Time][]hycomCell{}
	var lons, lats []float64
	lonSeen := map[float64]struct{}{}
	latSeen := map[float64]struct{}{}
	var firstTime time.Time
```

Inside the row loop, keep the existing `parseHYCOMTime`, lon, lat, `u`, and `v`
parsing exactly as it is, then replace the axis-discovery and append block —
that is, everything from `if _, ok := lonSeen[lon]; !ok {` through the closing
of `cells = append(...)` — with:

```go
		if firstTime.IsZero() {
			firstTime = t
		}
		// Axis discovery runs on the first time only, so the grid shape is
		// one time's worth of cells rather than the whole file's.
		if t.Equal(firstTime) {
			if _, ok := lonSeen[lon]; !ok {
				lonSeen[lon] = struct{}{}
				lons = append(lons, lon)
			}
			if _, ok := latSeen[lat]; !ok {
				latSeen[lat] = struct{}{}
				lats = append(lats, lat)
			}
		}
		byTime[t] = append(byTime[t], hycomCell{lon: lon, lat: lat, u: u, v: v})
```

Then replace the tail of the function (`if len(lons) == 0 ...` and the
`gridFromCells` call) with:

```go
	if len(lons) == 0 || len(lats) == 0 {
		return Currents{}, fmt.Errorf("ocean: hycom: empty grid")
	}
	sort.Float64s(lons)
	sort.Float64s(lats)
	nx, ny := len(lons), len(lats)

	times := make([]time.Time, 0, len(byTime))
	for t := range byTime {
		times = append(times, t)
	}
	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })

	want := len(byTime[times[0]])
	steps := make([]Step, 0, len(times))
	for _, t := range times {
		cells := byTime[t]
		if len(cells) != want {
			return Currents{}, fmt.Errorf("ocean: hycom: time %s has %d cells, want %d", t.Format(time.RFC3339), len(cells), want)
		}
		u, v := stepFromCells(cells, lons, lats)
		steps = append(steps, Step{ValidTime: t, U: u, V: v})
	}

	return Currents{
		ValidTime: times[0],
		Source:    src,
		BBox:      BBox{West: lons[0], South: lats[0], East: lons[nx-1], North: lats[ny-1]},
		NX:        nx,
		NY:        ny,
		Grid:      "centers",
		Steps:     steps,
	}, nil
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./internal/ocean/ -v`
Expected: PASS. Pre-existing single-time CSV tests still pass because a one-time file yields a one-step stack.

- [ ] **Step 7: Commit**

```bash
git add internal/ocean/hycom.go internal/ocean/hycom_test.go
git commit -m "Group HYCOM CSV rows into forecast steps and quantize to 1 mm/s."
```

---

### Task 3: Fetch a currents-only forecast window

**Files:**
- Create: `internal/ocean/currents_fetch.go`
- Modify: `internal/ocean/fetch.go:38-52` (reuse the new helper)
- Test: `internal/ocean/currents_fetch_test.go`

**Interfaces:**
- Consumes: `ParseHYCOM` from Task 2, `getCapped` from `fetch.go`.
- Produces:
  - `ocean.CurrentsQuery(base string, aoi BBox, now time.Time) (string, error)` — builds the NCSS URL.
  - `ocean.FetchCurrents(ctx context.Context, client *http.Client, base string, aoi BBox, now time.Time) (Currents, error)`.
  - `ocean.DefaultHYCOMBase = "https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest"`.
  - `ocean.ForecastBack = 3 * time.Hour`, `ocean.ForecastAhead = 24 * time.Hour`.

- [ ] **Step 1: Write the failing tests**

Create `internal/ocean/currents_fetch_test.go`:

```go
package ocean

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

var testAOI = BBox{West: -90.2, South: 29.5, East: -87.45, North: 30.78}

func TestCurrentsQueryAsksForACSVWindow(t *testing.T) {
	now := time.Date(2026, 9, 3, 14, 0, 0, 0, time.UTC)
	raw, err := CurrentsQuery(DefaultHYCOMBase, testAOI, now)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	// CSV, not netcdf: parseHYCOMNetCDF reads times[0] only.
	if q.Get("accept") != "csv" {
		t.Errorf("accept = %q, want csv", q.Get("accept"))
	}
	if q.Get("vertCoord") != "0" {
		t.Errorf("vertCoord = %q, want 0", q.Get("vertCoord"))
	}
	if got := q["var"]; len(got) != 2 {
		t.Errorf("var = %v, want water_u and water_v", got)
	}
	if q.Get("time_start") != "2026-09-03T11:00:00Z" {
		t.Errorf("time_start = %q, want now-3h", q.Get("time_start"))
	}
	if q.Get("time_end") != "2026-09-04T14:00:00Z" {
		t.Errorf("time_end = %q, want now+24h", q.Get("time_end"))
	}
}

func TestCurrentsQueryRejectsAnEmptyBase(t *testing.T) {
	if _, err := CurrentsQuery("  ", testAOI, time.Now().UTC()); err == nil {
		t.Fatal("want error for empty base")
	}
}

func TestFetchCurrentsParsesAndChecksAOI(t *testing.T) {
	body := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T12:00:00Z,30.0,-89.0,0.1,-0.05\n" +
		"2026-09-03T12:00:00Z,30.0,-88.0,0.2,-0.06\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, time.Now().UTC())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(c.Steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(c.Steps))
	}
	if c.Source.Name != "HYCOM" {
		t.Errorf("source.name = %q", c.Source.Name)
	}
}

func TestFetchCurrentsRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer srv.Close()
	_, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("want a 502 error, got %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/ocean/ -run 'CurrentsQuery|FetchCurrents' -v`
Expected: FAIL — undefined `CurrentsQuery`, `FetchCurrents`, `DefaultHYCOMBase`.

- [ ] **Step 3: Implement**

Create `internal/ocean/currents_fetch.go`:

```go
package ocean

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultHYCOMBase is the NCSS endpoint the shipped snapshot was taken from.
const DefaultHYCOMBase = "https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest"

// The forecast window carried in one stack. GLBy0.08 posts 3-hourly, so this
// is 10 steps: enough to always bracket now, and to survive a failed refresh.
const (
	ForecastBack  = 3 * time.Hour
	ForecastAhead = 24 * time.Hour
)

// CurrentsQuery builds the NCSS URL for a surface velocity window around now.
// It requests CSV: the CSV parser carries a time column per row, while
// parseHYCOMNetCDF reads times[0] only and cannot express a stack.
func CurrentsQuery(base string, aoi BBox, now time.Time) (string, error) {
	base = strings.TrimSpace(base)
	if base == "" {
		return "", fmt.Errorf("ocean: currents: empty HYCOM base URL")
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("ocean: currents: %w", err)
	}
	q := url.Values{}
	q.Add("var", "water_u")
	q.Add("var", "water_v")
	q.Set("north", fmt.Sprintf("%g", aoi.North))
	q.Set("south", fmt.Sprintf("%g", aoi.South))
	q.Set("west", fmt.Sprintf("%g", aoi.West))
	q.Set("east", fmt.Sprintf("%g", aoi.East))
	q.Set("horizStride", "1")
	q.Set("vertCoord", "0")
	q.Set("accept", "csv")
	q.Set("time_start", now.UTC().Add(-ForecastBack).Format(time.RFC3339))
	q.Set("time_end", now.UTC().Add(ForecastAhead).Format(time.RFC3339))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// FetchCurrents downloads one forecast stack. It does not touch disk.
func FetchCurrents(ctx context.Context, client *http.Client, base string, aoi BBox, now time.Time) (Currents, error) {
	if client == nil {
		client = http.DefaultClient
	}
	raw, err := CurrentsQuery(base, aoi, now)
	if err != nil {
		return Currents{}, err
	}
	body, status, err := getCapped(ctx, client, raw, hycomCSVLimit, false)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: fetch hycom: %w", err)
	}
	if status != http.StatusOK {
		return Currents{}, fmt.Errorf("ocean: fetch hycom: HTTP %d", status)
	}
	c, err := ParseHYCOM(bytes.NewReader(body), Source{Name: "HYCOM", URL: raw})
	if err != nil {
		return Currents{}, err
	}
	if c.Source.Dataset == "" {
		c.Source.Dataset = hycomDatasetFromURL(raw)
	}
	if !c.BBox.Intersects(aoi) {
		return Currents{}, fmt.Errorf("ocean: fetch hycom: bbox does not intersect AOI")
	}
	return c, nil
}
```

Note the CSV limit is already 8 MiB (`hycomCSVLimit`); 10 steps of 1188 cells is roughly 1 MB.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/ocean/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/ocean/currents_fetch.go internal/ocean/currents_fetch_test.go
git commit -m "Fetch a HYCOM forecast window as CSV, independent of the snapshot writer."
```

---

### Task 4: Background refresher in the server

**Files:**
- Create: `internal/server/oceanrefresh.go`
- Modify: `internal/server/config.go`, `internal/server/handler.go:11-40`, `internal/server/ocean.go:26-80`, `cmd/server/main.go:36-46`
- Test: `internal/server/oceanrefresh_test.go`

**Interfaces:**
- Consumes: `ocean.FetchCurrents`, `ocean.DefaultHYCOMBase` (Task 3); `ocean.WriteSnapshot`, `ocean.DecodeCurrentsFile`, `ocean.EncodeManifest`.
- Produces:
  - `Config.OceanRefreshEnabled bool`, `Config.OceanRefreshEvery time.Duration`, `Config.HYCOMURL string`, `Config.OceanNow func() time.Time`, `Config.OceanClient *http.Client`.
  - `server.NewWithContext(ctx context.Context, cfg Config) http.Handler` — starts the refresher, stops it when ctx is done. `New(cfg)` stays and delegates with `context.Background()` **without** starting a refresher, so existing tests keep their current behaviour.

- [ ] **Step 1: Write the failing tests**

Create `internal/server/oceanrefresh_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const csvTwoSteps = "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
	"2026-09-03T12:00:00Z,30.0,-89.0,0.11,-0.05\n" +
	"2026-09-03T12:00:00Z,30.0,-88.0,0.22,-0.06\n" +
	"2026-09-03T15:00:00Z,30.0,-89.0,0.33,-0.07\n" +
	"2026-09-03T15:00:00Z,30.0,-88.0,0.44,-0.08\n"

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

func TestRefreshReplacesTheServedStack(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(csvTwoSteps))
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

	waitForSteps(t, h, 2)

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
	if len(got.Steps) != 2 {
		t.Errorf("on-disk steps = %d, want 2", len(got.Steps))
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
		TileDir:             filepath.Join("testdata", "tiles"),
		WebDir:              t.TempDir(),
		OceanDir:            dir,
		OceanRefreshEnabled: true,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/server/ -run TestRefresh -v`
Expected: FAIL — undefined `NewWithContext` and the new `Config` fields.

- [ ] **Step 3: Add config fields**

In `internal/server/config.go`, add to `Config`:

```go
	// OceanRefreshEnabled re-fetches HYCOM currents in the background.
	// Off means zero egress: the disk snapshot is served unchanged.
	OceanRefreshEnabled bool
	// OceanRefreshEvery is the refresh period. Default: 1h.
	OceanRefreshEvery time.Duration
	// HYCOMURL is the NCSS base. Default: ocean.DefaultHYCOMBase.
	HYCOMURL string
	// OceanNow supplies the refresher clock. Default: time.Now().UTC.
	OceanNow func() time.Time
	// OceanClient is the refresher's HTTP client. Default: 90s timeout.
	OceanClient *http.Client
	// OceanFirstRefreshDelay delays the first refresh after boot so startup
	// never waits on NCSS. Default: 15s. Tests set it small.
	OceanFirstRefreshDelay time.Duration
```

and in `withDefaults()`:

```go
	if c.OceanRefreshEvery == 0 {
		c.OceanRefreshEvery = time.Hour
	}
	if c.HYCOMURL == "" {
		c.HYCOMURL = ocean.DefaultHYCOMBase
	}
	if c.OceanNow == nil {
		c.OceanNow = func() time.Time { return time.Now().UTC() }
	}
	if c.OceanClient == nil {
		c.OceanClient = &http.Client{Timeout: 90 * time.Second}
	}
	if c.OceanFirstRefreshDelay == 0 {
		c.OceanFirstRefreshDelay = firstRefreshDelay
	}
```

Add `net/http` and the `ocean` import.

- [ ] **Step 4: Implement the refresher**

Create `internal/server/oceanrefresh.go`:

```go
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

// startOceanRefresh runs until ctx is done. It is a no-op when refresh is
// disabled, which is what makes the air-gap claim literal.
func (s *Server) startOceanRefresh(ctx context.Context) {
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
	s.oc.set(body)

	// Write through so a restart keeps the freshness. An unwritable dir is
	// not fatal: the in-memory stack is already serving.
	b, err := ocean.DecodeBuoysFile(filepath.Join(s.cfg.OceanDir, "buoys.json"))
	if err != nil {
		slog.Warn("ocean refresh: write-through skipped", "err", err)
		return
	}
	if err := ocean.WriteSnapshot(s.cfg.OceanDir, c, b, now); err != nil {
		slog.Warn("ocean refresh: write-through", "err", err)
	}
}
```

Add `ocean.DecodeBuoysFile(path string) (Buoys, error)` to `internal/ocean/snapshot.go`, mirroring the existing `DecodeCurrentsFile`:

```go
// DecodeBuoysFile opens path and runs DecodeBuoys.
func DecodeBuoysFile(path string) (Buoys, error) {
	f, err := os.Open(path)
	if err != nil {
		return Buoys{}, err
	}
	defer f.Close()
	return DecodeBuoys(f)
}
```

- [ ] **Step 5: Wire it into the handler and serve from cache**

In `internal/server/handler.go`, add `oc *oceanCache` to `Server`, and:

```go
// New returns a handler with security headers applied to every response.
// It does not start background refresh; use NewWithContext for that.
func New(cfg Config) http.Handler {
	return newServer(context.Background(), cfg, false)
}

// NewWithContext returns a handler and starts background ocean refresh,
// which stops when ctx is done.
func NewWithContext(ctx context.Context, cfg Config) http.Handler {
	return newServer(ctx, cfg, true)
}

func newServer(ctx context.Context, cfg Config, refresh bool) http.Handler {
	cfg = cfg.withDefaults()
	s := &Server{
		cfg:   cfg,
		tiles: newTileStore(cfg.TileDir, cfg.TileWorkers),
		web:   handleSPA(resolveWeb(cfg)),
		ac:    newAircraftCache(cfg),
		oc:    newOceanCache(),
	}
	// ... existing mux setup, unchanged ...
	if refresh {
		s.startOceanRefresh(ctx)
	}
	return securityHeaders(withAccessLog(mux), cfg.CORSOrigin)
}
```

In `internal/server/ocean.go`, at the top of `handleOcean` after the name switch, serve `currents` from cache when present:

```go
	if name == "currents" {
		if body, etag, ok := s.oc.get(); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", oceanCacheControl)
			w.Header().Set("ETag", etag)
			if match := r.Header.Get("If-None-Match"); match == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusOK)
				return
			}
			_, _ = w.Write(body)
			return
		}
	}
```

Add the same `If-None-Match` check to the existing disk path so polling is cheap before the first refresh lands.

In `cmd/server/main.go`, replace `Handler: server.New(cfg)` with `NewWithContext`, moving the `signal.NotifyContext` block above the `http.Server` construction, and add to `cfg`:

```go
		OceanRefreshEnabled: os.Getenv("GULF_OCEAN_REFRESH") != "0",
		HYCOMURL:            os.Getenv("GULF_HYCOM_URL"),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./... `
Expected: PASS, including every pre-existing `internal/server` test.

- [ ] **Step 7: Commit**

```bash
git add internal/server/ internal/ocean/snapshot.go cmd/server/main.go
git commit -m "Refresh currents on a ticker, never on the request path."
```

---

### Task 5: Parse the stack in the browser

**Files:**
- Modify: `web/src/overlay/currentsField.ts:44-95`
- Test: `web/src/overlay/currentsField.test.ts`

**Interfaces:**
- Consumes: the JSON shape from Task 1.
- Produces: `type VelocityStack = { nx: number; ny: number; bbox: BBox; times: number[]; u: (number | null)[][]; v: (number | null)[][] }` and `velocityStackFromJson(raw: unknown): VelocityStack | null`. `VelocityGrid` and every other export in this file are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/overlay/currentsField.test.ts`:

```ts
import { velocityStackFromJson } from './currentsField.ts';

const bbox = { west: -89.7, south: 29.95, east: -87.85, north: 30.52 };

describe('velocityStackFromJson', () => {
  it('reads a multi-step stack', () => {
    const stack = velocityStackFromJson({
      grid: 'centers', nx: 2, ny: 1, bbox,
      steps: [
        { validTime: '2026-09-03T12:00:00Z', u: [0.1, null], v: [-0.05, null] },
        { validTime: '2026-09-03T15:00:00Z', u: [0.3, null], v: [-0.07, null] },
      ],
    });
    assert.ok(stack);
    assert.equal(stack.times.length, 2);
    assert.equal(stack.times[0], Date.parse('2026-09-03T12:00:00Z'));
    assert.equal(stack.u[1]![0], 0.3);
    assert.equal(stack.u[0]![1], null);
  });

  it('lifts the legacy flat shape to one step', () => {
    const stack = velocityStackFromJson({
      grid: 'centers', nx: 2, ny: 1, bbox,
      validTime: '2026-08-26T00:00:00Z',
      u: [0.1, 0.2], v: [-0.05, -0.06],
    });
    assert.ok(stack);
    assert.equal(stack.times.length, 1);
    assert.equal(stack.times[0], Date.parse('2026-08-26T00:00:00Z'));
  });

  it('rejects malformed input', () => {
    const bad: unknown[] = [
      { grid: 'corners', nx: 2, ny: 1, bbox, steps: [] },
      { grid: 'centers', nx: 2, ny: 1, bbox, steps: [] },
      { grid: 'centers', nx: 2, ny: 1, bbox, steps: [{ validTime: '2026-09-03T12:00:00Z', u: [0.1], v: [0.1, 0.2] }] },
      { grid: 'centers', nx: 2, ny: 1, bbox, steps: [
        { validTime: '2026-09-03T15:00:00Z', u: [0.1, 0.1], v: [0.1, 0.1] },
        { validTime: '2026-09-03T12:00:00Z', u: [0.1, 0.1], v: [0.1, 0.1] },
      ] },
      { grid: 'centers', nx: 2, ny: 1, bbox, steps: [{ validTime: 'not-a-time', u: [0.1, 0.1], v: [0.1, 0.1] }] },
      null,
    ];
    for (const raw of bad) {
      assert.equal(velocityStackFromJson(raw), null);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && node --experimental-strip-types --test src/overlay/currentsField.test.ts`
Expected: FAIL — `velocityStackFromJson` is not exported.

- [ ] **Step 3: Implement**

In `web/src/overlay/currentsField.ts`, add alongside the existing `velocityGridFromJson` (keep that function — Task 6 returns its type):

```ts
export type VelocityStack = {
  nx: number;
  ny: number;
  bbox: BBox;
  /** Epoch ms, strictly increasing. */
  times: number[];
  u: (number | null)[][];
  v: (number | null)[][];
};

/**
 * Map `/api/ocean/currents` onto a forecast stack. The legacy flat `u`/`v`
 * shape becomes a one-step stack so an old snapshot still renders.
 */
export function velocityStackFromJson(raw: unknown): VelocityStack | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (o.grid !== 'centers') {
    return null;
  }
  const nx = o.nx;
  const ny = o.ny;
  if (
    typeof nx !== 'number' || typeof ny !== 'number' ||
    !Number.isInteger(nx) || !Number.isInteger(ny) || nx <= 0 || ny <= 0
  ) {
    return null;
  }
  const b = o.bbox as Record<string, unknown> | undefined;
  if (
    !b || typeof b.west !== 'number' || typeof b.south !== 'number' ||
    typeof b.east !== 'number' || typeof b.north !== 'number' ||
    b.west >= b.east || b.south >= b.north
  ) {
    return null;
  }
  const need = nx * ny;

  type RawStep = { validTime?: unknown; u?: unknown; v?: unknown };
  let rawSteps: RawStep[];
  if (Array.isArray(o.steps)) {
    rawSteps = o.steps as RawStep[];
  } else {
    rawSteps = [{ validTime: o.validTime, u: o.u, v: o.v }];
  }
  if (rawSteps.length === 0) {
    return null;
  }

  const times: number[] = [];
  const u: (number | null)[][] = [];
  const v: (number | null)[][] = [];
  for (const step of rawSteps) {
    if (typeof step.validTime !== 'string') {
      return null;
    }
    const t = Date.parse(step.validTime);
    if (!Number.isFinite(t)) {
      return null;
    }
    if (times.length > 0 && t <= times[times.length - 1]!) {
      return null;
    }
    if (!Array.isArray(step.u) || !Array.isArray(step.v) || step.u.length !== need || step.v.length !== need) {
      return null;
    }
    times.push(t);
    u.push(step.u.map(finiteOrNull));
    v.push(step.v.map(finiteOrNull));
  }
  return { nx, ny, bbox: { west: b.west, south: b.south, east: b.east, north: b.north }, times, u, v };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/currentsField.ts web/src/overlay/currentsField.test.ts
git commit -m "Read the currents forecast stack, old snapshots included."
```

---

### Task 6: Interpolate the stack to wall-clock time

**Files:**
- Create: `web/src/overlay/currentsTime.ts`
- Create: `web/src/overlay/currentsTime.test.ts`
- Modify: `web/package.json` (add the test file to `scripts.test`)

**Interfaces:**
- Consumes: `VelocityStack` (Task 5), `VelocityGrid` (`currentsField.ts`).
- Produces:
  - `interpolateGrid(stack: VelocityStack, tMs: number): VelocityGrid`
  - `bracket(times: number[], tMs: number): { i0: number; i1: number; t: number }`
  - `isStale(stack: VelocityStack, tMs: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `web/src/overlay/currentsTime.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bracket, interpolateGrid, isStale } from './currentsTime.ts';
import type { VelocityStack } from './currentsField.ts';

const T0 = Date.parse('2026-09-03T12:00:00Z');
const T1 = Date.parse('2026-09-03T15:00:00Z');

const stack: VelocityStack = {
  nx: 2, ny: 1,
  bbox: { west: -89.7, south: 29.95, east: -87.85, north: 30.52 },
  times: [T0, T1],
  u: [[0.0, null], [1.0, 0.5]],
  v: [[0.0, 0.2], [-1.0, null]],
};

describe('bracket', () => {
  it('finds the surrounding steps and the fraction between them', () => {
    const b = bracket(stack.times, T0 + 90 * 60 * 1000);
    assert.deepEqual([b.i0, b.i1], [0, 1]);
    assert.equal(b.t, 0.5);
  });

  it('clamps before the first step and after the last', () => {
    assert.deepEqual(bracket(stack.times, T0 - 1e7), { i0: 0, i1: 0, t: 0 });
    assert.deepEqual(bracket(stack.times, T1 + 1e7), { i0: 1, i1: 1, t: 0 });
  });

  it('handles a one-step stack', () => {
    assert.deepEqual(bracket([T0], T1), { i0: 0, i1: 0, t: 0 });
  });
});

describe('interpolateGrid', () => {
  it('blends linearly between steps', () => {
    const g = interpolateGrid(stack, T0 + 90 * 60 * 1000);
    assert.equal(g.u[0], 0.5);
    assert.equal(g.v[0], -0.5);
    assert.equal(g.nx, 2);
    assert.equal(g.ny, 1);
  });

  // A null in either bracketing step must not become a fabricated velocity.
  it('propagates null from either side', () => {
    const g = interpolateGrid(stack, T0 + 90 * 60 * 1000);
    assert.equal(g.u[1], null);
    assert.equal(g.v[1], null);
  });

  it('returns a step exactly at its own time', () => {
    const g = interpolateGrid(stack, T1);
    assert.equal(g.u[0], 1.0);
    assert.equal(g.v[0], -1.0);
  });
});

describe('isStale', () => {
  it('is false inside the window and true outside it', () => {
    assert.equal(isStale(stack, T0 + 1000), false);
    assert.equal(isStale(stack, T0 - 1000), true);
    assert.equal(isStale(stack, T1 + 1000), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && node --experimental-strip-types --test src/overlay/currentsTime.test.ts`
Expected: FAIL — cannot find module `./currentsTime.ts`.

- [ ] **Step 3: Implement**

Create `web/src/overlay/currentsTime.ts`:

```ts
import type { VelocityGrid, VelocityStack } from './currentsField.ts';

/**
 * Bracketing step indices and the fraction between them. Times outside the
 * window clamp to an end step, so the field is never extrapolated.
 */
export function bracket(times: number[], tMs: number): { i0: number; i1: number; t: number } {
  const last = times.length - 1;
  if (times.length === 0) {
    return { i0: 0, i1: 0, t: 0 };
  }
  if (tMs <= times[0]!) {
    return { i0: 0, i1: 0, t: 0 };
  }
  if (tMs >= times[last]!) {
    return { i0: last, i1: last, t: 0 };
  }
  let i1 = 1;
  while (i1 < last && times[i1]! < tMs) {
    i1++;
  }
  const i0 = i1 - 1;
  const span = times[i1]! - times[i0]!;
  return { i0, i1, t: span <= 0 ? 0 : (tMs - times[i0]!) / span };
}

function blend(a: number | null, b: number | null, t: number): number | null {
  // Null is no-data. Blending it toward a real value would invent current.
  if (a == null || b == null) {
    return null;
  }
  return a * (1 - t) + b * t;
}

/** The velocity field at `tMs`, linearly interpolated between forecast steps. */
export function interpolateGrid(stack: VelocityStack, tMs: number): VelocityGrid {
  const { i0, i1, t } = bracket(stack.times, tMs);
  const u0 = stack.u[i0]!;
  const u1 = stack.u[i1]!;
  const v0 = stack.v[i0]!;
  const v1 = stack.v[i1]!;
  const n = stack.nx * stack.ny;
  const u = new Array<number | null>(n);
  const v = new Array<number | null>(n);
  for (let i = 0; i < n; i++) {
    u[i] = blend(u0[i]!, u1[i]!, t);
    v[i] = blend(v0[i]!, v1[i]!, t);
  }
  return { nx: stack.nx, ny: stack.ny, bbox: stack.bbox, u, v };
}

/** True when now falls outside the covered forecast window. */
export function isStale(stack: VelocityStack, tMs: number): boolean {
  if (stack.times.length === 0) {
    return true;
  }
  return tMs < stack.times[0]! || tMs > stack.times[stack.times.length - 1]!;
}
```

- [ ] **Step 4: Register the test file**

In `web/package.json`, append ` src/overlay/currentsTime.test.ts` to the `scripts.test` file list. Without this the file never runs.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS, and the new file appears in the run.

- [ ] **Step 6: Commit**

```bash
git add web/src/overlay/currentsTime.ts web/src/overlay/currentsTime.test.ts web/package.json
git commit -m "Interpolate the currents stack to wall-clock time."
```

---

### Task 7: Speed ramp and honest caption

**Files:**
- Create: `web/src/overlay/speedRamp.ts`
- Create: `web/src/overlay/speedRamp.test.ts`
- Modify: `web/src/overlay/oceanUi.ts:36-42`, `web/src/overlay/oceanUi.test.ts`, `web/package.json`

**Interfaces:**
- Consumes: `VelocityStack` (Task 5), `bracket`/`isStale` (Task 6), `msToKnots` (`windBarb.ts`).
- Produces:
  - `SPEED_MAX_MS = 1.5`
  - `speedColor(speedMs: number): [number, number, number]` — linear-space RGB in 0..1
  - `speedRampCss(): string` — a `linear-gradient(...)` for the legend
  - `speedLegendTicks(): Array<{ frac: number; label: string }>` — knots labels
  - `currentsCaption(stack: VelocityStack | null, nowMs: number): string` replacing the currents half of `oceanCaption`

- [ ] **Step 1: Write the failing tests**

Create `web/src/overlay/speedRamp.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SPEED_MAX_MS, speedColor, speedLegendTicks, speedRampCss } from './speedRamp.ts';

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('speedColor', () => {
  it('stays in gamut and clamps outside the range', () => {
    for (const s of [-1, 0, 0.3, 0.8, SPEED_MAX_MS, 99]) {
      const c = speedColor(s);
      assert.equal(c.length, 3);
      for (const ch of c) {
        assert.ok(ch >= 0 && ch <= 1, `channel ${ch} out of gamut at ${s} m/s`);
      }
    }
    assert.deepEqual(speedColor(99), speedColor(SPEED_MAX_MS));
    assert.deepEqual(speedColor(-1), speedColor(0));
  });

  // Faster must read brighter, or the ramp carries no information at a glance.
  it('increases in luminance with speed', () => {
    let prev = -1;
    for (let s = 0; s <= SPEED_MAX_MS; s += SPEED_MAX_MS / 16) {
      const lum = luminance(speedColor(s));
      assert.ok(lum > prev, `luminance must rise at ${s} m/s`);
      prev = lum;
    }
  });
});

describe('speedRampCss', () => {
  it('is a gradient with several stops', () => {
    const css = speedRampCss();
    assert.ok(css.startsWith('linear-gradient('));
    assert.ok(css.split('rgb(').length > 4);
  });
});

describe('speedLegendTicks', () => {
  it('labels in knots across the full ramp', () => {
    const ticks = speedLegendTicks();
    assert.ok(ticks.length >= 3);
    assert.equal(ticks[0]!.frac, 0);
    assert.equal(ticks[ticks.length - 1]!.frac, 1);
    for (const tick of ticks) {
      assert.match(tick.label, /kt$/);
    }
  });
});
```

Append to `web/src/overlay/oceanUi.test.ts`:

```ts
import { currentsCaption } from './oceanUi.ts';
import type { VelocityStack } from './currentsField.ts';

const capT0 = Date.parse('2026-09-03T12:00:00Z');
const capT1 = Date.parse('2026-09-03T15:00:00Z');
const capStack: VelocityStack = {
  nx: 1, ny: 1,
  bbox: { west: -90, south: 29, east: -87, north: 31 },
  times: [capT0, capT1],
  u: [[0], [0]], v: [[0], [0]],
};

describe('currentsCaption', () => {
  // Model output must never read as observation.
  it('names the bracketing forecast hours', () => {
    const caption = currentsCaption(capStack, capT0 + 80 * 60 * 1000);
    assert.equal(caption, 'Currents HYCOM 13:20Z · interpolated 12Z→15Z');
  });

  it('marks a field outside its window as stale', () => {
    const caption = currentsCaption(capStack, capT1 + 3600_000);
    assert.match(caption, /· stale$/);
  });

  it('is empty without a stack', () => {
    assert.equal(currentsCaption(null, capT0), '');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && node --experimental-strip-types --test src/overlay/speedRamp.test.ts src/overlay/oceanUi.test.ts`
Expected: FAIL — module not found, and `currentsCaption` not exported.

- [ ] **Step 3: Implement the ramp**

Create `web/src/overlay/speedRamp.ts`:

```ts
import { msToKnots } from './windBarb.ts';

/** Ramp ceiling. Loop Current filaments run near 1.5 m/s (~3 kt). */
export const SPEED_MAX_MS = 1.5;

/**
 * Deep indigo → cyan → mint → pale yellow. Anchored in cyan to keep the
 * established currents identity, and ending high-luminance and saturated so
 * it cannot be confused with the muted teal-and-sand hypsometric ramp in
 * `lut.ts`. Luminance rises monotonically so speed reads at a glance.
 */
const STOPS: Array<[number, number, number]> = [
  [0.09, 0.13, 0.36],
  [0.13, 0.42, 0.63],
  [0.25, 0.72, 0.78],
  [0.55, 0.90, 0.75],
  [0.97, 0.95, 0.70],
];

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Linear-space RGB in 0..1 for a speed in m/s. Out-of-range clamps. */
export function speedColor(speedMs: number): [number, number, number] {
  const f = clamp01((Number.isFinite(speedMs) ? speedMs : 0) / SPEED_MAX_MS);
  const last = STOPS.length - 1;
  const scaled = f * last;
  const i = Math.min(Math.floor(scaled), last - 1);
  const t = scaled - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ];
}

function css(color: [number, number, number]): string {
  const [r, g, b] = color.map((c) => Math.round(c * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Horizontal CSS gradient: 0 m/s at the left, SPEED_MAX_MS at the right. */
export function speedRampCss(): string {
  const steps = 12;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    stops.push(`${css(speedColor(f * SPEED_MAX_MS))} ${(f * 100).toFixed(0)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Legend ticks at quarter points, labelled in knots. */
export function speedLegendTicks(): Array<{ frac: number; label: string }> {
  return [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    frac,
    label: `${msToKnots(frac * SPEED_MAX_MS).toFixed(1)} kt`,
  }));
}
```

- [ ] **Step 4: Implement the caption**

In `web/src/overlay/oceanUi.ts`, add (keep `oceanCaption` for the buoys half):

```ts
import type { VelocityStack } from './currentsField.ts';
import { bracket, isStale } from './currentsTime.ts';

/**
 * Names the bracketing forecast hours, because the displayed field is model
 * output interpolated to now — not an observation. Shortening this to a bare
 * timestamp would misrepresent the data.
 */
export function currentsCaption(stack: VelocityStack | null, nowMs: number): string {
  if (stack == null || stack.times.length === 0) {
    return '';
  }
  const { i0, i1 } = bracket(stack.times, nowMs);
  const at = formatValidZ(new Date(nowMs).toISOString());
  let caption = `Currents HYCOM ${at}`;
  if (i0 !== i1) {
    const from = formatValidZ(new Date(stack.times[i0]!).toISOString());
    const to = formatValidZ(new Date(stack.times[i1]!).toISOString());
    caption += ` · interpolated ${from}→${to}`;
  }
  if (isStale(stack, nowMs)) {
    caption += ' · stale';
  }
  return caption;
}
```

- [ ] **Step 5: Register the test file and run**

Append ` src/overlay/speedRamp.test.ts` to `scripts.test` in `web/package.json`.

Run: `cd web && npm test && npm run build`
Expected: PASS, clean type-check.

- [ ] **Step 6: Commit**

```bash
git add web/src/overlay/speedRamp.ts web/src/overlay/speedRamp.test.ts web/src/overlay/oceanUi.ts web/src/overlay/oceanUi.test.ts web/package.json
git commit -m "Add a speed ramp and a caption that admits the field is interpolated."
```

---

### Task 8: Tapered, speed-coloured streaklines

**Files:**
- Modify: `web/src/overlay/currentsGpu.ts:16-43`, `web/src/overlay/currents.ts:19-23,142-175,183-210`
- Modify: `web/src/overlay/shaders/trail.vert.glsl`, `trail.frag.glsl`, `particle.vert.glsl`, `particle.frag.glsl`
- Test: `web/src/overlay/currents.test.ts`

**Interfaces:**
- Consumes: `speedColor`, `SPEED_MAX_MS` (Task 7); `FLOW_SCALE`, `TRAIL_LAG_SEC` (`currentsField.ts`).
- Produces: `TRAIL_SEGMENTS = 8`; `makeTrailGeometry()` returns `PARTICLE_COUNT * TRAIL_SEGMENTS * 2` vertices with an `aT` attribute in 0..1; `makeStaticArrows(grid)` returns a `THREE.Group` with per-vertex colour.

- [ ] **Step 1: Write the failing tests**

Replace the `makeTrailGeometry` block in `web/src/overlay/currents.test.ts`:

```ts
import { TRAIL_SEGMENTS } from './currentsGpu.ts';

describe('makeTrailGeometry', () => {
  it('builds one line segment per trail segment per particle', () => {
    const geo = makeTrailGeometry();
    const verts = PARTICLE_COUNT * TRAIL_SEGMENTS * 2;
    assert.equal(geo.drawRange.count, verts);
    assert.equal(geo.getAttribute('position').count, verts);
    assert.equal(geo.getAttribute('aId').count, verts);
    assert.equal(geo.getAttribute('aT').count, verts);
  });

  // aT drives the head-to-tail alpha taper, so it must span the full range.
  it('spans aT from head to tail within one particle', () => {
    const geo = makeTrailGeometry();
    const at = geo.getAttribute('aT').array as Float32Array;
    const id = geo.getAttribute('aId').array as Float32Array;
    assert.equal(at[0], 0);
    assert.equal(id[0], 0);
    const lastVert = TRAIL_SEGMENTS * 2 - 1;
    assert.equal(at[lastVert], 1);
    assert.equal(id[lastVert], 0);
    assert.equal(id[lastVert + 1], 1, 'the next particle starts a new trail');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && node --experimental-strip-types --test src/overlay/currents.test.ts`
Expected: FAIL — `TRAIL_SEGMENTS` not exported.

- [ ] **Step 3: Rebuild the trail geometry**

In `web/src/overlay/currentsGpu.ts`, replace `makeTrailGeometry`:

```ts
/** Vertices per trail. More segments buy curvature, at 2 vertices each. */
export const TRAIL_SEGMENTS = 8;

export function makeTrailGeometry(): THREE.BufferGeometry {
  const verts = PARTICLE_COUNT * TRAIL_SEGMENTS * 2;
  const ids = new Float32Array(verts);
  const ts = new Float32Array(verts);
  let o = 0;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    for (let s = 0; s < TRAIL_SEGMENTS; s++) {
      ids[o] = i;
      ts[o] = s / TRAIL_SEGMENTS;
      o++;
      ids[o] = i;
      ts[o] = (s + 1) / TRAIL_SEGMENTS;
      o++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  geo.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
  geo.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
  geo.setDrawRange(0, verts);
  return geo;
}
```

- [ ] **Step 4: Back-integrate the trail in the vertex shader**

Replace the body of `web/src/overlay/shaders/trail.vert.glsl` `main()` and add a ramp. Keep the existing uniforms and helpers; add `uniform float uSpeedMax;`, `attribute float aT;` (replacing `aEnd`), and varyings:

```glsl
varying float vT;
varying float vSpeed;

// Ramp must match speedRamp.ts. Faster reads brighter.
vec3 speedColor(float speedMs) {
  float f = clamp(speedMs / uSpeedMax, 0.0, 1.0);
  vec3 c0 = vec3(0.09, 0.13, 0.36);
  vec3 c1 = vec3(0.13, 0.42, 0.63);
  vec3 c2 = vec3(0.25, 0.72, 0.78);
  vec3 c3 = vec3(0.55, 0.90, 0.75);
  vec3 c4 = vec3(0.97, 0.95, 0.70);
  float s = f * 4.0;
  vec3 c = mix(c0, c1, clamp(s, 0.0, 1.0));
  c = mix(c, c2, clamp(s - 1.0, 0.0, 1.0));
  c = mix(c, c3, clamp(s - 2.0, 0.0, 1.0));
  c = mix(c, c4, clamp(s - 3.0, 0.0, 1.0));
  return c;
}

void main() {
  float x = mod(aId, uStateSize.x);
  float y = floor(aId / uStateSize.x);
  vec2 uv = (vec2(x, y) + 0.5) / uStateSize;
  vec4 st = texture2D(uStatePos, uv);

  vec2 pos = st.xy;
  vec4 headVel = sampleVel(toLonLat(pos).x, toLonLat(pos).y);
  vSpeed = length(headVel.rg);
  vT = aT;

  // Back-integrate the field from the head. This traces a streamline, not a
  // pathline: over a ~4 s visual lag on a quasi-steady field the two
  // coincide, and it costs no history buffer.
  float steps = floor(aT * float(TRAIL_STEPS) + 0.5);
  float dt = uTrailLag / float(TRAIL_STEPS);
  for (int i = 0; i < TRAIL_STEPS; i++) {
    if (float(i) >= steps) {
      break;
    }
    vec2 ll = toLonLat(pos);
    vec4 vel = sampleVel(ll.x, ll.y);
    if (vel.b < 0.999) {
      break;
    }
    pos -= vec2(vel.r, vel.g) * dt * uFlowScale;
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 18.0, 1.0);
}
```

Prepend `#define TRAIL_STEPS 8` to the shader source in `currents.ts` (it must match `TRAIL_SEGMENTS`) by building the material with:

```ts
    vertexShader: `#define TRAIL_STEPS ${TRAIL_SEGMENTS}\n${trailVert}`,
```

- [ ] **Step 5: Taper and colour in the fragment shaders**

`trail.frag.glsl`. Note `vColor` must be declared in **both** stages — the
vertex shader assigns it, the fragment shader reads it:

```glsl
varying float vT;
varying float vSpeed;
varying vec3 vColor;

void main() {
  // Alpha taper, not width: WebGL ignores lineWidth. Genuine width taper
  // would need quad-expanded ribbons.
  float taper = pow(1.0 - vT, 1.5);
  // Slack water fades out rather than sitting as a field of static marks.
  float alive = smoothstep(0.0, 0.05, vSpeed);
  gl_FragColor = vec4(vColor, 0.85 * taper * alive);
}
```

In `trail.vert.glsl`, declare `varying vec3 vColor;` alongside `vT`/`vSpeed`
and assign `vColor = speedColor(vSpeed);` right after `vSpeed` is computed.
The unused `uSpeedMax` uniform in the fragment stage can be dropped.

`particle.vert.glsl` gains the same `speedColor`, samples the velocity at the particle, sets `vColor` and `gl_PointSize = uPointSize * (0.6 + 0.6 * clamp(speed / uSpeedMax, 0.0, 1.0));`. `particle.frag.glsl` becomes `gl_FragColor = vec4(vColor, 0.95 * smoothstep(0.0, 0.05, vSpeed));`.

Add `uSpeedMax: { value: SPEED_MAX_MS }` to `overlayStateUniforms` in `currents.ts` and to the point material uniforms; the point material also needs `uVelTex`, `uVelSize`, the grid bounds, and the origin uniforms, so build it from `overlayStateUniforms(...)` plus `uPointSize`.

- [ ] **Step 6: Fix the static arrows**

In `currents.ts`, rewrite `makeStaticArrows` to emit per-vertex colour, an arrowhead, and a speed floor:

```ts
/** Below this the arrow is noise, not signal. */
const ARROW_MIN_MS = 0.02;
const ARROW_HEAD_FRAC = 0.3;

export function makeStaticArrows(grid: VelocityGrid): THREE.Group {
  const group = new THREE.Group();
  group.name = 'currents-arrows';
  const pts: number[] = [];
  const cols: number[] = [];
  for (const a of staticArrows(grid)) {
    const speed = Math.hypot(a.u, a.v);
    if (speed < ARROW_MIN_MS) {
      continue;
    }
    const rgb = speedColor(speed);
    const a0 = lonLatToLocal(a.lon, a.lat);
    const next = advect(a.lon, a.lat, a.u, a.v, TRAIL_LAG_SEC, FLOW_SCALE);
    const a1 = lonLatToLocal(next.lon, next.lat);
    const dx = a1.x - a0.x;
    const dy = a1.y - a0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = len * ARROW_HEAD_FRAC;
    const push = (x0: number, y0: number, x1: number, y1: number): void => {
      pts.push(x0, y0, LIFT_Z, x1, y1, LIFT_Z);
      cols.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    };
    push(a0.x, a0.y, a1.x, a1.y);
    // Two barbs at +/-150 degrees from the shaft make it read as an arrow.
    for (const sign of [1, -1]) {
      const ang = Math.atan2(uy, ux) + sign * (Math.PI * 5) / 6;
      push(a1.x, a1.y, a1.x + Math.cos(ang) * head, a1.y + Math.sin(ang) * head);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 4;
  group.add(lines);
  return group;
}
```

- [ ] **Step 7: Run the tests and build**

Run: `cd web && npm test && npm run build`
Expected: PASS, clean type-check.

- [ ] **Step 8: Commit**

```bash
git add web/src/overlay/currentsGpu.ts web/src/overlay/currents.ts web/src/overlay/shaders/ web/src/overlay/currents.test.ts
git commit -m "Draw currents as tapered, speed-coloured streaklines."
```

---

### Task 9: Wire the live cursor, polling, and legend

**Files:**
- Modify: `web/src/overlay/currents.ts:245-389` (add `setGrid` to `CurrentsHandle`)
- Modify: `web/src/main.ts:404-408,595-655,743`
- Modify: `web/index.html:61` (add the currents legend element), `web/src/style.css` if present

**Interfaces:**
- Consumes: everything from Tasks 5–8.
- Produces: `CurrentsHandle.setGrid(grid: VelocityGrid): void`.

- [ ] **Step 1: Add `setGrid` to the handle**

In `currents.ts`, add to `CurrentsHandle` and its implementation. Rebuild the velocity texture data in place so particle state survives the swap:

```ts
    setGrid(grid: VelocityGrid): void {
      if (gpu) {
        const data = gpu.velTex.image.data as Float32Array;
        const n = grid.nx * grid.ny;
        for (let i = 0; i < n; i++) {
          const u = grid.u[i];
          const v = grid.v[i];
          const o = i * 4;
          const ok = u != null && v != null;
          data[o] = ok ? u : 0;
          data[o + 1] = ok ? v : 0;
          data[o + 2] = ok ? 1 : 0;
          data[o + 3] = ok ? 1 : 0;
        }
        gpu.velTex.needsUpdate = true;
      }
      // Arrows are baked geometry, so they are rebuilt rather than updated.
      group.remove(arrows);
      disposeObject3D(arrows);
      arrows = makeStaticArrows(grid);
      group.add(arrows);
      syncVisibility();
    },
```

Change `const arrows` to `let arrows` and make `mountCurrents` take the interpolated grid as it does today.

- [ ] **Step 2: Poll, interpolate, and caption in `main.ts`**

Replace the currents half of the ocean bootstrap:

```ts
  const CURRENTS_POLL_MS = 15 * 60 * 1000;
  const CURSOR_MS = 30 * 1000;
  let currentsStack: VelocityStack | null = null;
  let currentsEtag: string | null = null;
  let lastCursor = 0;
```

`web/tsconfig.json` sets `noUnusedLocals: true`, so the now-unused import must
go: change main.ts:30 from `import { velocityGridFromJson } from './overlay/currentsField';`
to `import { velocityStackFromJson, type VelocityStack } from './overlay/currentsField';`
and add `import { interpolateGrid } from './overlay/currentsTime';`. Leaving the old
import in place fails `npm run build`.

In the bootstrap, replace `velocityGridFromJson(currentsRaw)` with:

```ts
    currentsStack = velocityStackFromJson(currentsRaw);
    currentsEtag = currentsRes.headers.get('ETag');
    const grid = currentsStack ? interpolateGrid(currentsStack, Date.now()) : null;
```

Add a poll that respects the ETag, so the steady state is a 304 with no body:

```ts
  const pollCurrents = async (): Promise<void> => {
    try {
      const headers: HeadersInit = currentsEtag ? { 'If-None-Match': currentsEtag } : {};
      const res = await fetch('/api/ocean/currents', { headers });
      if (res.status === 304 || !res.ok) {
        return;
      }
      const next = velocityStackFromJson(await res.json());
      if (next) {
        currentsStack = next;
        currentsEtag = res.headers.get('ETag');
        lastCursor = 0;
      }
    } catch {
      // A failed poll keeps the stack already loaded.
    }
  };
  window.setInterval(() => void pollCurrents(), CURRENTS_POLL_MS);
```

In `tick()`, beside the existing `currentsHandle?.tick(...)`:

```ts
    const nowMs = Date.now();
    if (currentsStack && currentsHandle && nowMs - lastCursor >= CURSOR_MS) {
      lastCursor = nowMs;
      currentsHandle.setGrid(interpolateGrid(currentsStack, nowMs));
      setCaption(exaggeration);
    }
```

In `setCaption`, replace the currents half with `currentsCaption(oceanOn.currents ? currentsStack : null, Date.now())`.

- [ ] **Step 3: Add the legend**

In `web/index.html`, after line 61:

```html
      <aside id="currents-legend" class="legend legend-currents" aria-label="Current speed scale" hidden></aside>
```

In `main.ts`, fill it from `speedRampCss()` and `speedLegendTicks()` when the layer mounts, and set `hidden = !oceanOn.currents` wherever the currents radio is handled.

- [ ] **Step 4: Verify in the running app**

Run: `make run`, open the viewer, enable Currents.
Expected: streaks curve and taper, fast water is pale, slack water fades, the caption names two forecast hours, and the legend shows knots.

- [ ] **Step 5: Run the full suite**

Run: `go test ./... && cd web && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/overlay/currents.ts web/src/main.ts web/index.html
git commit -m "Track wall-clock time in the viewer and legend the speed ramp."
```

---

### Task 10: Correct the documentation

**Files:**
- Modify: `README.md:42,102,141-148,335`
- Modify: `docs/data-sources.md`, `docs/threat-model.md`, `Makefile`

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–9.
- Produces: no code.

This task runs **last, and only once the code above is merged.** The tree's own build-status section warns against claims that outrun the code; writing these edits earlier would create exactly that.

- [ ] **Step 1: Fix the architecture diagram**

`README.md:101-103` currently reads `snapshot, air-gap safe`. Replace with wording that says currents refresh on a ~1 h ticker by default and fall back to the on-disk snapshot, and that `GULF_OCEAN_REFRESH=0` restores pure snapshot behaviour.

- [ ] **Step 2: Rewrite the air-gap paragraph**

`README.md:141-148` claims "Terrain tiles and the ocean overlay have no outbound calls at serve time" and calls `/api/aircraft` "the live exception". Both are now false by default. Rewrite so the air-gap property is stated as the opt-out it has become, naming `GULF_OCEAN_REFRESH=0`, and note that buoys remain snapshot-only.

- [ ] **Step 3: Extend the env table**

`README.md:335`, add two rows:

```markdown
| `GULF_OCEAN_REFRESH` | enabled unless `0` | `0` stops background HYCOM refresh; `/api/ocean/currents` then serves only the on-disk snapshot, with no outbound calls |
| `GULF_HYCOM_URL` | `https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest` | NCSS base for the currents refresher |
```

- [ ] **Step 4: Correct the pre-existing provenance claim**

`README.md:42` says "No NOAA, USGS, HYCOM, NDBC, or Argo bytes have been fetched." A real HYCOM snapshot dated 2026-08-26 sits in `data/ocean/`. It is gitignored, so the claim is true of the repository and false of a running tree. Reword to say no such bytes are *vendored in the repository*, and that `make ocean` and the refresher both write untracked data to `data/ocean/`.

- [ ] **Step 5: Update data sources and threat model**

In `docs/data-sources.md`, change HYCOM's row from a one-shot ingest to a recurring serve-time fetch, and note that the snapshot's retrieval date is continuously replaced rather than fixed.

In `docs/threat-model.md`, add the new scheduled outbound dependency in the serving binary: a periodic egress to `ncss.hycom.org` on the default configuration, its failure mode (serve stale), and the opt-out.

- [ ] **Step 6: Note the Makefile relationship**

`make ocean` still exists and still writes a snapshot; it is now the seeding path and the air-gap path rather than the only path. Add one comment line above the `ocean:` target saying so.

- [ ] **Step 7: Verify and commit**

Run: `go test ./... && cd web && npm test && npm run build`

```bash
git add README.md docs/data-sources.md docs/threat-model.md Makefile
git commit -m "Correct the docs now that currents refresh at serve time."
```
