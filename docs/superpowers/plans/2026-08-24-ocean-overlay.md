# Ocean Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a snapshot HYCOM surface-current grid and NDBC buoy observations from the Go binary, and draw GPGPU particles plus station wind barbs on the three.js bathymetry chart.

**Architecture:** `cmd/ocean` fetches public HYCOM NCSS CSV and NDBC text, writes `data/ocean/{currents,buoys,manifest}.json`. `gulf-viewer` serves those files at `/api/ocean/*` with no outbound calls. The bathymetry client uploads `u,v` as a float texture, advects 8192 particles on the GPU, and overlays HTML NDBC glyphs. Globe mode is unchanged.

**Tech Stack:** Go 1.26, `net/http` + `httptest`, three.js r185 WebGL2, existing Vite `node --test` runner, no new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-08-24-ocean-overlay-design.md](../specs/2026-08-24-ocean-overlay-design.md)

## Global Constraints

- Clip box is `internal/tiles.AOI` / `web/src/geo.ts` `AOI` (Mississippi Sound), not the older `projectspec.md` shelf window.
- Server has no outbound calls. Only `make ocean` may hit the network. CI must not run `make ocean`.
- `make run` must succeed with `data/ocean/` missing. `/readyz` does not depend on ocean files.
- Magenta `#C0006E` is not used for currents or buoys.
- Slice 1 does not add `wind.json`, GFS, globe overlays, or a second particle field.
- JSON `u`/`v` are row-major, west-to-east, south-to-north, `grid` must be `"centers"`, units m/s, `u` eastward `v` northward.
- NDBC wind direction is meteorological (from). Barbs in knots. `wspd` is m/s.
- Particle count is 8192. Lift in local Z is 18 m. `prefers-reduced-motion: reduce` and missing float-texture both use static arrows.
- Attribution: HYCOM consortium + dataset id; NDBC/NOAA; not an official NOAA product.
- User-Agent for ingest: `gulf-seafloor-viewer/ocean (https://github.com/idrewlong/gulfseafloor)`.
- CGO stays off. No new npm packages.

---

## File structure

| Path | Responsibility |
|---|---|
| `internal/ocean/types.go` | `Currents`, `Buoys`, `Station`, `Manifest`, `Source`, `BBox` JSON types |
| `internal/ocean/decode.go` | `DecodeCurrents`, `DecodeBuoys`, `DecodeManifest` validation |
| `internal/ocean/ndbc.go` | Station-table + `realtime2` parsers, 0.5° margin filter |
| `internal/ocean/hycom.go` | NCSS CSV → `Currents` |
| `internal/ocean/snapshot.go` | Fail-closed write of the three JSON files |
| `internal/ocean/fetch.go` | HTTP fetch with injectable client, size caps, timeouts |
| `cmd/ocean/main.go` | CLI: `-out`, `-hycom-url`, `-ndbc-base` |
| `internal/server/ocean.go` | `GET /api/ocean/{manifest,currents,buoys}` |
| `internal/server/config.go` | `OceanDir` |
| `internal/server/handler.go` | Mux routes |
| `cmd/server/main.go` | `GULF_OCEAN_DIR` |
| `web/src/overlay/currentsField.ts` | Sample, advect, respawn, static arrows (no three.js) |
| `web/src/overlay/windBarb.ts` | Knots + barb counts + SVG path |
| `web/src/overlay/oceanUi.ts` | Toggle availability, caption string, buoy readout text |
| `web/src/overlay/currents.ts` | three.js GPGPU overlay |
| `web/src/overlay/shaders/advect.frag.glsl` | Particle sim |
| `web/src/overlay/shaders/trail.vert.glsl` | Line trail draw |
| `web/src/overlay/shaders/trail.frag.glsl` | Quiet cyan |
| `web/src/overlay/buoys.ts` | HTML stations + occupancy vs place labels |
| `web/src/ui/controls.ts`, `web/index.html`, `web/src/style.css`, `web/src/main.ts` | Toggles, caption, mount, about |
| `Makefile`, `.gitignore`, `web/package.json` | `make ocean`, `data/ocean/`, test file list |
| `docs/data-sources.md`, `README.md` | Routes, retrieval notes |

Do not create `wind.json` or a globe ocean path.

---

### Task 1: Ocean JSON contract

**Files:**
- Create: `internal/ocean/types.go`
- Create: `internal/ocean/decode.go`
- Test: `internal/ocean/decode_test.go`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type BBox struct { West, South, East, North float64 }` with JSON tags `west,south,east,north`
  - `type Source struct { Name, Dataset, URL string }` JSON `name,dataset,url`
  - `type Currents struct { ValidTime time.Time; Source Source; BBox BBox; NX, NY int; Grid string; U, V []*float64 }`
  - `type Station struct { ID, Name string; Lon, Lat float64; ObsTime *time.Time; WDir, WSpd, Gst, WVHT, WTMP *float64 }`
  - `type Buoys struct { ValidTime time.Time; Source Source; Stations []Station }`
  - `type LayerInfo struct { Present bool; ValidTime *time.Time; Count int }`
  - `type Manifest struct { RetrievedAt time.Time; Currents, Buoys LayerInfo; Attribution []string }`
  - `func DecodeCurrents(r io.Reader) (Currents, error)`
  - `func DecodeBuoys(r io.Reader) (Buoys, error)`
  - `func DecodeManifest(r io.Reader) (Manifest, error)`

- [ ] **Step 1: Write the failing test**

```go
package ocean

import (
	"strings"
	"testing"
	"time"
)

func TestDecodeCurrentsAcceptsCentersGrid(t *testing.T) {
	raw := `{
	  "validTime": "2026-08-24T18:00:00Z",
	  "source": {"name": "HYCOM", "dataset": "test", "url": "https://example.invalid/ncss"},
	  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
	  "nx": 2, "ny": 1, "grid": "centers",
	  "u": [0.12, null],
	  "v": [-0.04, null]
	}`
	c, err := DecodeCurrents(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if c.NX != 2 || c.NY != 1 || c.Grid != "centers" {
		t.Fatalf("got nx=%d ny=%d grid=%q", c.NX, c.NY, c.Grid)
	}
	if c.U[0] == nil || *c.U[0] != 0.12 || c.U[1] != nil {
		t.Fatalf("u cells: %#v", c.U)
	}
	if !c.ValidTime.Equal(time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)) {
		t.Fatalf("validTime %s", c.ValidTime)
	}
}

func TestDecodeCurrentsRejectsBadGridAndLength(t *testing.T) {
	if _, err := DecodeCurrents(strings.NewReader(`{
	  "validTime":"2026-08-24T18:00:00Z","source":{"name":"HYCOM","url":"x"},
	  "bbox":{"west":-89,"south":29,"east":-88,"north":30},
	  "nx":2,"ny":1,"grid":"edges","u":[0,0],"v":[0,0]
	}`)); err == nil {
		t.Fatal("edges must be rejected")
	}
	if _, err := DecodeCurrents(strings.NewReader(`{
	  "validTime":"2026-08-24T18:00:00Z","source":{"name":"HYCOM","url":"x"},
	  "bbox":{"west":-89,"south":29,"east":-88,"north":30},
	  "nx":2,"ny":1,"grid":"centers","u":[0],"v":[0,0]
	}`)); err == nil {
		t.Fatal("len(u) != nx*ny must be rejected")
	}
}

func TestDecodeBuoysOmitsMissingFields(t *testing.T) {
	raw := `{
	  "validTime": "2026-08-24T19:50:00Z",
	  "source": {"name": "NDBC", "url": "https://www.ndbc.noaa.gov/"},
	  "stations": [{"id": "WYCM6", "lon": -89.081, "lat": 30.36, "wdir": 180, "wspd": 6.2}]
	}`
	b, err := DecodeBuoys(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Stations) != 1 || b.Stations[0].ID != "WYCM6" {
		t.Fatalf("%+v", b.Stations)
	}
	if b.Stations[0].WVHT != nil || b.Stations[0].WSpd == nil || *b.Stations[0].WSpd != 6.2 {
		t.Fatalf("optional fields: %+v", b.Stations[0])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/ocean -run 'TestDecode' -count=1`

Expected: FAIL with `no required module provides package` or `undefined: DecodeCurrents`

- [ ] **Step 3: Write minimal implementation**

`DecodeCurrents` must `json.Decoder.DisallowUnknownFields()` **off** (Slice 2 may add keys). Validate: `Grid == "centers"`, `NX>0`, `NY>0`, `len(U)==NX*NY`, `len(V)==NX*NY`, `Source.Name != ""`, bbox west<east and south<north, `ValidTime` non-zero. Times are RFC3339 UTC.

`DecodeBuoys`: require `Source.Name`, each station `ID != ""` and finite lon/lat. Empty `stations` is allowed.

`DecodeManifest`: require `RetrievedAt`; `Currents`/`Buoys` may have `Present: false`.

Use `encoding/json` with `*float64` so JSON `null` becomes a nil pointer.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/ocean -count=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/ocean/types.go internal/ocean/decode.go internal/ocean/decode_test.go
git commit -m "$(cat <<'EOF'
Add ocean snapshot JSON types and validation.

EOF
)"
```

---

### Task 2: NDBC parsers and AOI margin

**Files:**
- Create: `internal/ocean/ndbc.go`
- Create: `internal/ocean/testdata/station_table.txt`
- Create: `internal/ocean/testdata/realtime2_wycm6.txt`
- Test: `internal/ocean/ndbc_test.go`

**Interfaces:**
- Consumes: `BBox` from Task 1; `internal/tiles.AOI` as the production clip (tests pass an explicit box)
- Produces:
  - `const StationMarginDeg = 0.5`
  - `func Expand(b BBox, deg float64) BBox`
  - `func (b BBox) Contains(lon, lat float64) bool`
  - `type TableRow struct { ID, Name string; Lon, Lat float64 }`
  - `func ParseStationTable(r io.Reader, margin BBox) ([]TableRow, error)`
  - `func ParseRealtime2(id string, r io.Reader) (Station, error)` — latest data row; `MM` → omitted field
  - `func BuoysValidTime(stations []Station, retrieved time.Time) time.Time` — max `ObsTime`, else `retrieved`

- [ ] **Step 1: Write fixtures and failing tests**

`testdata/station_table.txt` (pipe-delimited, NDBC layout; location in a column the parser searches for `N`/`W` degrees):

```
#id|owner|ttype|hull|name|payload|location|timezone|forecast|note
WYCM6|NWLON|fixed|n/a|Gulfport Harbor|stdmet|30.360 N 89.081 W|CST|n/a|n/a
42040|NDBC|buoy|3m|Luke Offshore Test Site|stdmet|29.212 N 88.207 W|CST|n/a|n/a
41009|NDBC|buoy|3m|Far Away|stdmet|28.500 N 80.180 W|EST|n/a|n/a
```

`testdata/realtime2_wycm6.txt`:

```
#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 08 24 18 50  MM   MM   MM    MM    MM    MM  MM     MM    MM    MM    MM   MM   MM    MM
2026 08 24 19 50 180  6.2  8.1   0.4   4.0   3.5 190 1014.2  28.1  29.1    MM   MM   MM    MM
```

```go
func TestExpandAndContains(t *testing.T) {
	b := Expand(BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}, 0.5)
	if b.West != -90.2 || b.North != 31.02 {
		t.Fatalf("%+v", b)
	}
	if !b.Contains(-88.207, 29.212) {
		t.Fatal("42040 is inside 0.5° margin of the Sound")
	}
}

func TestParseStationTableFiltersMargin(t *testing.T) {
	f, err := os.Open("testdata/station_table.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	margin := Expand(BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}, StationMarginDeg)
	rows, err := ParseStationTable(f, margin)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range rows {
		got[r.ID] = true
	}
	if !got["WYCM6"] || !got["42040"] || got["41009"] {
		t.Fatalf("%v", got)
	}
}

func TestParseRealtime2LatestRow(t *testing.T) {
	f, err := os.Open("testdata/realtime2_wycm6.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, err := ParseRealtime2("WYCM6", f)
	if err != nil {
		t.Fatal(err)
	}
	if st.WDir == nil || *st.WDir != 180 || st.WSpd == nil || *st.WSpd != 6.2 {
		t.Fatalf("%+v", st)
	}
	if st.WVHT == nil || *st.WVHT != 0.4 || st.WTMP == nil || *st.WTMP != 29.1 {
		t.Fatalf("waves/temp %+v", st)
	}
	want := time.Date(2026, 8, 24, 19, 50, 0, 0, time.UTC)
	if st.ObsTime == nil || !st.ObsTime.Equal(want) {
		t.Fatalf("obs %v", st.ObsTime)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/ocean -run 'TestParse|TestExpand' -count=1`

Expected: FAIL `undefined: ParseStationTable`

- [ ] **Step 3: Write minimal implementation**

Skip `#` lines. Split station table on `|`, trim spaces. Parse location with regex `([0-9.]+)\s*([NS])\s+([0-9.]+)\s*([EW])` (lat first, then lon; negate S/W). Keep rows whose lon/lat fall in `margin`.

`realtime2`: second non-comment line is units (ignore). Columns after the 5-token timestamp: `WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP ...`. `MM` and empty → nil. Use the last parseable data row. Cap reader at 256 KiB (`io.LimitReader`).

HTML payloads (`<html`) return an error; do not parse as tables.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/ocean -count=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/ocean/ndbc.go internal/ocean/ndbc_test.go internal/ocean/testdata
git commit -m "$(cat <<'EOF'
Parse NDBC station tables and realtime observations.

EOF
)"
```

---

### Task 3: HYCOM NCSS CSV → Currents

**Files:**
- Create: `internal/ocean/hycom.go`
- Create: `internal/ocean/testdata/hycom.csv`
- Test: `internal/ocean/hycom_test.go`

**Interfaces:**
- Consumes: `Currents`, `BBox`, `Source` from Task 1
- Produces: `func ParseHYCOMCSV(r io.Reader, src Source) (Currents, error)`

- [ ] **Step 1: Write fixture and failing test**

`testdata/hycom.csv`:

```
time,latitude[unit="degrees_north"],longitude[unit="degrees_east"],water_u[unit="m s-1"],water_v[unit="m s-1"]
2026-08-24T18:00:00Z,29.96,-89.68,0.10,-0.02
2026-08-24T18:00:00Z,29.96,-89.60,0.12,-0.01
2026-08-24T18:00:00Z,30.04,-89.68,0.08,0.03
2026-08-24T18:00:00Z,30.04,-89.60,NaN,NaN
```

```go
func TestParseHYCOMCSVBuildsSouthToNorthGrid(t *testing.T) {
	f, err := os.Open("testdata/hycom.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c, err := ParseHYCOMCSV(f, Source{Name: "HYCOM", Dataset: "test", URL: "https://example.invalid/ncss"})
	if err != nil {
		t.Fatal(err)
	}
	if c.NX != 2 || c.NY != 2 || c.Grid != "centers" {
		t.Fatalf("nx=%d ny=%d grid=%s", c.NX, c.NY, c.Grid)
	}
	// index 0 = southwest (29.96, -89.68)
	if c.U[0] == nil || *c.U[0] != 0.10 {
		t.Fatalf("SW u %#v", c.U[0])
	}
	// last index = northeast row-major: y=1 x=1 → NaN → nil
	if c.U[3] != nil || c.V[3] != nil {
		t.Fatal("NaN must become null cells")
	}
	if c.BBox.West != -89.68 || c.BBox.North != 30.04 {
		t.Fatalf("centers bbox %+v", c.BBox)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/ocean -run TestParseHYCOMCSV -count=1`

Expected: FAIL `undefined: ParseHYCOMCSV`

- [ ] **Step 3: Write minimal implementation**

Skip lines starting `#`. Header: find columns whose names contain `time`, `lat`, `lon`, `water_u` / `_u`, `water_v` / `_v` (case-insensitive, ignore `[unit=...]`). Parse rows. Unique sorted longitudes (west to east), unique sorted latitudes (south to north). `nx=len(lons)`, `ny=len(lats)`. Fill `U`/`V` at `i = y*nx + x`. Missing or NaN → nil. `bbox` is first/last cell centres. `ValidTime` from first row. Reject empty grid. `io.LimitReader` 8 MiB.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/ocean -count=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/ocean/hycom.go internal/ocean/hycom_test.go internal/ocean/testdata/hycom.csv
git commit -m "$(cat <<'EOF'
Parse HYCOM NCSS CSV into a cell-center velocity grid.

EOF
)"
```

---

### Task 4: Fail-closed snapshot write and cmd/ocean

**Files:**
- Create: `internal/ocean/snapshot.go`
- Create: `internal/ocean/fetch.go`
- Create: `cmd/ocean/main.go`
- Test: `internal/ocean/snapshot_test.go`
- Test: `internal/ocean/fetch_test.go`
- Modify: `Makefile` — add `ocean` target, do **not** add it as a dependency of `run`
- Modify: `.gitignore` — add `data/ocean/` and `/ocean`

**Interfaces:**
- Consumes: `Decode*`/`Parse*` from Tasks 1–3, `tiles.AOI`
- Produces:
  - `func WriteSnapshot(dir string, c Currents, b Buoys, retrieved time.Time) error` — temp dir + rename; on error leave existing `dir` intact
  - `func EncodeManifest(c Currents, b Buoys, retrieved time.Time) Manifest`
  - `type Endpoints struct { HYCOM, StationTable, Realtime2Prefix string }` — `Realtime2Prefix` is `https://www.ndbc.noaa.gov/data/realtime2/` (id + `.txt` appended)
  - `func FetchSnapshot(ctx context.Context, client *http.Client, ep Endpoints, aoi BBox, outDir string) error`
  - CLI flags: `-out` default `data/ocean`, `-hycom-url` required (full NCSS URL including query **or** base URL; if no `?` then append `var=water_u&var=water_v&north=&west=&east=&south=&time=latest&accept=csv` from `tiles.AOI`), `-ndbc-base` default `https://www.ndbc.noaa.gov`

- [ ] **Step 1: Write the failing tests**

```go
func TestWriteSnapshotDoesNotClobberOnFailure(t *testing.T) {
	dir := t.TempDir()
	u0, v0 := 0.1, 0.0
	good := Currents{ValidTime: time.Now().UTC(), Source: Source{Name: "HYCOM", URL: "x"}, BBox: BBox{West: -2, South: 1, East: -1, North: 2}, NX: 1, NY: 1, Grid: "centers", U: []*float64{&u0}, V: []*float64{&v0}}
	buoys := Buoys{ValidTime: time.Now().UTC(), Source: Source{Name: "NDBC", URL: "y"}, Stations: nil}
	if err := WriteSnapshot(dir, good, buoys, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	prev, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}
	bad := good
	bad.Grid = "edges"
	if err := WriteSnapshot(dir, bad, buoys, time.Now().UTC()); err == nil {
		t.Fatal("expected reject")
	}
	now, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(prev, now) {
		t.Fatal("failed write must not replace currents.json")
	}
}

func TestFetchSnapshotUsesFixtures(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ncss", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/hycom.csv")
	})
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/station_table.txt")
	})
	mux.HandleFunc("/data/realtime2/WYCM6.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/realtime2_wycm6.txt")
	})
	mux.HandleFunc("/data/realtime2/42040.txt", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", 404)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	out := t.TempDir()
	aoi := BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}
	err := FetchSnapshot(context.Background(), srv.Client(), Endpoints{
		HYCOM:           srv.URL + "/ncss",
		StationTable:    srv.URL + "/data/stations/station_table.txt",
		Realtime2Prefix: srv.URL + "/data/realtime2/",
	}, aoi, out)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCurrentsFile(filepath.Join(out, "currents.json")); err != nil {
		t.Fatal(err)
	}
}
```

Add `DecodeCurrentsFile` as a one-liner helper in `decode.go` (`os.Open` + `DecodeCurrents`) if that keeps the test readable — or inline `os.ReadFile` + `DecodeCurrents(bytes.NewReader)`.

`FetchSnapshot` must set User-Agent, `Timeout` on a default client of 30s when `main` constructs it, 8 MiB HYCOM cap, 2 MiB station table, 256 KiB per realtime file. Realtime 404 skips that station. If HYCOM fails, return error and do not write. If every realtime fails but HYCOM ok, still write buoys with possibly empty `stations` **only if** the station table itself succeeded; station-table failure is fatal.

Ndbc concurrency: at most 8 in-flight GETs.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/ocean -run 'TestWriteSnapshot|TestFetchSnapshot' -count=1`

Expected: FAIL undefined `WriteSnapshot`

- [ ] **Step 3: Implement write, fetch, and CLI**

`WriteSnapshot`: validate via encode→`DecodeCurrents`/`DecodeBuoys` on a buffer first. `os.MkdirTemp` next to `dir`, write `currents.json`, `buoys.json`, `manifest.json` (`json.MarshalIndent`), `os.Rename` each file into `dir` after `MkdirAll(dir)`. If validate fails, do not touch `dir`.

`EncodeManifest` attribution:

```go
[]string{
  "HYCOM consortium; dataset " + c.Source.Dataset,
  "NDBC / NOAA. Not an official NOAA product.",
}
```

`cmd/ocean/main.go`: parse flags, `http.Client{Timeout: 30 * time.Second}`, `FetchSnapshot`, print `wrote n stations to dir` on success. Exit 1 on error. Do not call this from `make run`.

Makefile:

```
.PHONY: test tiles web server run tidy ocean

ocean:
	go run ./cmd/ocean -out data/ocean
```

`-hycom-url` has no silent default that hits the network in tests. For `make ocean`, document in the target that the flag is required, **or** pass a default in the Makefile once a URL is known. Until first successful pull, Makefile should be:

```
HYCOM_NCSS ?=
ocean:
	@test -n "$(HYCOM_NCSS)" || (echo "set HYCOM_NCSS to a THREDDS NCSS URL"; exit 2)
	go run ./cmd/ocean -out data/ocean -hycom-url "$(HYCOM_NCSS)"
```

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/ocean ./cmd/ocean -count=1`

Expected: PASS (`cmd/ocean` may have no tests; package must compile)

- [ ] **Step 5: Commit**

```bash
git add internal/ocean/snapshot.go internal/ocean/fetch.go internal/ocean/snapshot_test.go internal/ocean/fetch_test.go cmd/ocean/main.go Makefile .gitignore
git commit -m "$(cat <<'EOF'
Add cmd/ocean snapshot fetch with fail-closed writes.

EOF
)"
```

---

### Task 5: Serve `/api/ocean/*`

**Files:**
- Modify: `internal/server/config.go` — add `OceanDir string`; default `data/ocean` in `withDefaults`
- Modify: `internal/server/handler.go` — register three `HandleFunc` routes
- Create: `internal/server/ocean.go`
- Modify: `cmd/server/main.go` — `OceanDir: env("GULF_OCEAN_DIR", "data/ocean")`
- Modify: `internal/server/handler_test.go` — ocean cases
- Test: `internal/server/ocean_test.go` (preferred over bloating `handler_test.go`)

**Interfaces:**
- Consumes: `ocean.DecodeCurrents`, `DecodeBuoys`, `DecodeManifest`
- Produces: HTTP GET
  - `/api/ocean/manifest`
  - `/api/ocean/currents`
  - `/api/ocean/buoys`
  - Missing file → 404 empty body
  - Invalid JSON or failed decode → 500, log path **not** in body (`slog.Error("ocean file", "name", name, "err", err)`), body `"ocean snapshot unavailable\n"`
  - `Content-Type: application/json`
  - `Cache-Control: public, max-age=300`
  - `ETag` = `"` + hex(sha256(bytes)) + `"`
  - GET and HEAD only; other methods 405
  - Allowlist names only; no user path concat

- [ ] **Step 1: Write the failing tests**

```go
func oceanHandler(t *testing.T, oceanDir string) http.Handler {
	t.Helper()
	return New(Config{
		TileDir:  filepath.Join("testdata", "tiles"),
		WebDir:   t.TempDir(),
		OceanDir: oceanDir,
	})
}

func TestOceanMissingIs404AndReadyzStillOK(t *testing.T) {
	h := oceanHandler(t, t.TempDir())
	for _, p := range []string{"/api/ocean/manifest", "/api/ocean/currents", "/api/ocean/buoys"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", p, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz %d", rec.Code)
	}
}

func TestOceanServesValidatedJSON(t *testing.T) {
	dir := t.TempDir()
	// write valid currents.json, buoys.json, manifest.json (minimal legal bodies from Task 1)
	h := oceanHandler(t, dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=300" {
		t.Fatalf("cache %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("missing ETag")
	}
}

func TestOceanMalformedJSONIs500(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "currents.json"), []byte(`{not json`), 0o644)
	h := oceanHandler(t, dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil))
	if rec.Code != 500 {
		t.Fatalf("%d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), dir) {
		t.Fatal("must not leak path")
	}
}
```

Also assert `TestOceanPathDoesNotTraverse`: `GET /api/ocean/../tiles` is 404 (ServeMux exact paths).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server -run TestOcean -count=1`

Expected: FAIL 404 on all ocean routes (unregistered)

- [ ] **Step 3: Implement handler**

```go
func (s *Server) handleOcean(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/api/ocean/")
	switch name {
	case "manifest", "currents", "buoys":
	default:
		http.NotFound(w, r)
		return
	}
	// read filepath.Join(s.cfg.OceanDir, name+".json") with Abs/Rel jail like tiles.go
}
```

Register:

```go
mux.HandleFunc("/api/ocean/manifest", s.handleOcean)
mux.HandleFunc("/api/ocean/currents", s.handleOcean)
mux.HandleFunc("/api/ocean/buoys", s.handleOcean)
```

After read: decode with the matching `ocean.Decode*`. 8 MiB `LimitReader`. HEAD: same headers, no body.

Update `testHandler` in `handler_test.go` only if `withDefaults` setting `OceanDir` to `data/ocean` would accidentally serve the developer’s disk; tests should pass `OceanDir: t.TempDir()` in `testHandler` so existing tests stay isolated. Change `testHandler` to set `OceanDir: t.TempDir()`.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `go test ./internal/server -count=1`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/server/config.go internal/server/handler.go internal/server/ocean.go internal/server/ocean_test.go internal/server/handler_test.go cmd/server/main.go
git commit -m "$(cat <<'EOF'
Serve ocean snapshot JSON from the tile server.

EOF
)"
```

---

### Task 6: Client velocity field math

**Files:**
- Create: `web/src/overlay/currentsField.ts`
- Test: `web/src/overlay/currentsField.test.ts`
- Modify: `web/package.json` — append `src/overlay/currentsField.test.ts` to the `test` script

**Interfaces:**
- Consumes: `BBox` from `web/src/geo.ts`
- Produces:
  - `export type VelocityGrid = { nx: number; ny: number; bbox: BBox; u: (number | null)[]; v: (number | null)[] }`
  - `export function sampleUV(grid: VelocityGrid, lon: number, lat: number): { u: number; v: number } | null`
  - `export function advect(lon: number, lat: number, u: number, v: number, dtSec: number, flowScale: number): { lon: number; lat: number }` — `u` east m/s, `v` north m/s; convert via `111320` m/deg lat and `111320*cos(lat)` m/deg lon (same constants as `geo.ts`)
  - `export function shouldRespawn(lon: number, lat: number, age: number, bbox: BBox, maxAge: number): boolean`
  - `export function staticArrows(grid: VelocityGrid): Array<{ lon: number; lat: number; u: number; v: number }>` — one entry per non-null cell centre
  - `export const PARTICLE_COUNT = 8192`
  - `export const FLOW_SCALE = 2500`
  - `export const PARTICLE_MAX_AGE = 8`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sampleUV, advect, shouldRespawn, staticArrows, type VelocityGrid } from './currentsField.ts';
import { AOI } from '../geo.ts';

const grid: VelocityGrid = {
  nx: 2,
  ny: 2,
  bbox: { west: -90, south: 30, east: -88, north: 32 },
  u: [1, 1, 1, 1],
  v: [0, 0, 0, 0],
};

describe('sampleUV', () => {
  it('returns the SW cell at the SW centre', () => {
    const p = sampleUV(grid, -90, 30);
    assert.ok(p);
    assert.equal(p.u, 1);
    assert.equal(p.v, 0);
  });
  it('returns null outside the bbox', () => {
    assert.equal(sampleUV(grid, 0, 0), null);
  });
  it('returns null on a null cell (no interpolation from missing)', () => {
    const g: VelocityGrid = { ...grid, u: [null, 1, 1, 1], v: [null, 0, 0, 0] };
    assert.equal(sampleUV(g, -90, 30), null);
  });
});

describe('advect', () => {
  it('moves east for positive u', () => {
    const next = advect(-89, 30, 1, 0, 1, 1);
    assert.ok(next.lon > -89);
    assert.ok(Math.abs(next.lat - 30) < 1e-9);
  });
});

describe('shouldRespawn', () => {
  it('respawns outside AOI or when aged out', () => {
    assert.equal(shouldRespawn(-89, 30.2, 1, AOI, 8), false);
    assert.equal(shouldRespawn(-89, 30.2, 9, AOI, 8), true);
    assert.equal(shouldRespawn(0, 0, 0, AOI, 8), true);
  });
});

describe('staticArrows', () => {
  it('skips null cells', () => {
    const g: VelocityGrid = { ...grid, u: [1, null, 1, 1], v: [0, null, 0, 0] };
    assert.equal(staticArrows(g).length, 3);
  });
});
```

Bilinear: map lon/lat to fractional `x` in `[0, nx-1]`, `y` in `[0, ny-1]` using bbox as **cell centres of first and last samples** (spec). If any of the 4 corners is null, return null (do not leak across nodata).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --experimental-strip-types --test src/overlay/currentsField.test.ts`

Expected: FAIL module not found

- [ ] **Step 3: Implement `currentsField.ts`**

Keep it free of three.js.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `cd web && npm test`

Expected: PASS (script list includes the new file)

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/currentsField.ts web/src/overlay/currentsField.test.ts web/package.json
git commit -m "$(cat <<'EOF'
Add HYCOM grid sampling and particle advection helpers.

EOF
)"
```

---

### Task 7: Wind barbs

**Files:**
- Create: `web/src/overlay/windBarb.ts`
- Test: `web/src/overlay/windBarb.test.ts`
- Modify: `web/package.json` test script — add `src/overlay/windBarb.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export function msToKnots(ms: number): number` — `* 1.94384`
  - `export type BarbCounts = { pennants: number; full: number; half: boolean; calm: boolean }`
  - `export function barbCounts(knots: number): BarbCounts` — round to nearest 5 kt; `< 2.5` → `{pennants:0, full:0, half:false, calm:true}`; pennant=50, full=10, half=5
  - `export function barbSvg(wdirFromDeg: number, wspdMs: number): string` — returns SVG **inner** markup (path), staff pointing **into** the wind (direction from). Northern-hemisphere barbs on the left of the staff when heading along `wdirFromDeg`. Viewbox `0 0 40 40`, stroke `currentColor`, fill none, `stroke-width="1.5"`. Calm: circle `r=4` at centre, no staff.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { msToKnots, barbCounts, barbSvg } from './windBarb.ts';

describe('barbCounts', () => {
  it('maps 0, 5, 10, 50 kt', () => {
    assert.deepEqual(barbCounts(0), { pennants: 0, full: 0, half: false, calm: true });
    assert.deepEqual(barbCounts(5), { pennants: 0, full: 0, half: true, calm: false });
    assert.deepEqual(barbCounts(10), { pennants: 0, full: 1, half: false, calm: false });
    assert.deepEqual(barbCounts(50), { pennants: 1, full: 0, half: false, calm: false });
  });
});

describe('msToKnots', () => {
  it('converts 6.2 m/s', () => {
    assert.ok(Math.abs(msToKnots(6.2) - 12.0518) < 1e-3);
  });
});

describe('barbSvg', () => {
  it('uses a circle for calm and a path for wind', () => {
    assert.match(barbSvg(0, 0), /circle/);
    assert.match(barbSvg(180, 6.2), /path/);
    assert.doesNotMatch(barbSvg(180, 6.2), /#C0006E/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --experimental-strip-types --test src/overlay/windBarb.test.ts`

Expected: FAIL module not found

- [ ] **Step 3: Implement `windBarb.ts`**

Staff from centre toward `wdirFromDeg` (meteorological from). Do not use magenta.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `cd web && npm test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/windBarb.ts web/src/overlay/windBarb.test.ts web/package.json
git commit -m "$(cat <<'EOF'
Add NDBC wind barb geometry in knots.

EOF
)"
```

---

### Task 8: Caption, toggles, occupancy, readout copy

**Files:**
- Create: `web/src/overlay/oceanUi.ts`
- Test: `web/src/overlay/oceanUi.test.ts`
- Modify: `web/src/ui/labelLayout.test.ts` — one case that a rank-10 buoy loses to a rank-1 place
- Modify: `web/package.json` test script — add `src/overlay/oceanUi.test.ts`

**Interfaces:**
- Consumes: `visibleLabelIds` / `LabelCandidate` from `web/src/ui/labelLayout.ts`
- Produces:
  - `export const BUOY_RANK = 10`
  - `export type LayerAvailability = { currents: boolean; buoys: boolean }`
  - `export function availabilityFromHttp(currentsStatus: number, buoysStatus: number): LayerAvailability` — `true` only for 200
  - `export function defaultOn(avail: LayerAvailability): { currents: boolean; buoys: boolean }` — on iff available
  - `export function formatValidZ(iso: string): string` — `18Z` if minutes=0 else `19:50Z`
  - `export function oceanCaption(currentsIso: string | null, buoysIso: string | null): string` — empty if both null; otherwise `Currents HYCOM 18Z · Buoys NDBC 19:50Z` omitting a side when null
  - `export function buoyReadout(st: { id: string; name?: string; lon: number; lat: number; wdir?: number; wspd?: number; gst?: number; wvht?: number; wtmp?: number; obsTime?: string }): string` — plain text lines omitted when missing; wind as `{wdir}° / {knots} kt` (1 decimal)

Existing `visibleLabelIds` already implements “lower rank wins”. Add a test in `labelLayout.test.ts`:

```ts
it('drops a buoy when a place label is closer than minDist', () => {
  const visible = visibleLabelIds(
    [
      { id: 0, x: 10, y: 10, rank: 1 },
      { id: 100, x: 12, y: 11, rank: 10 },
    ],
    40,
  );
  assert.equal(visible.has(0), true);
  assert.equal(visible.has(100), false);
});
```

- [ ] **Step 1: Write failing `oceanUi` tests** including 404 → both layers unavailable; 200/404 partial; caption pieces.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && node --experimental-strip-types --test src/overlay/oceanUi.test.ts src/ui/labelLayout.test.ts`

Expected: FAIL on missing `oceanUi.ts`; labelLayout test should already pass once added (existing function). If the occupancy test is added first and passes, that is acceptable — do not change `visibleLabelIds`.

- [ ] **Step 3: Implement `oceanUi.ts`**

- [ ] **Step 4: Run `cd web && npm test`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/oceanUi.ts web/src/overlay/oceanUi.test.ts web/src/ui/labelLayout.test.ts web/package.json
git commit -m "$(cat <<'EOF'
Add ocean caption, toggle, and buoy readout helpers.

EOF
)"
```

---

### Task 9: Controls chrome (HTML/CSS)

**Files:**
- Modify: `web/index.html` — fieldset `#ocean` after `#imagery`; caption already `#caption`; about section “Ocean overlay”
- Modify: `web/src/style.css` — hide `#ocean` when `#app.is-globe`; buoy overlay styles
- Modify: `web/src/ui/controls.ts` — extend `ViewerControls` with `currents: boolean; buoys: boolean`
- Test: no new runner test; TypeScript build is the check (`npm run build` later). Keep `mountControls` compiling.

**Interfaces:**
- Consumes: `defaultOn` / availability (wired in Task 11)
- Produces: radios `name="currents"` values `0`/`1`, `name="buoys"` values `0`/`1`; fieldset `hidden` or `disabled` attributes set by `main.ts`

HTML:

```html
<fieldset id="ocean" class="control-block">
  <legend>Ocean</legend>
  <div class="radio-row">
    <span class="ocean-layer">Currents</span>
    <label><input type="radio" name="currents" value="0" /> Off</label>
    <label><input type="radio" name="currents" value="1" checked /> On</label>
  </div>
  <div class="radio-row">
    <span class="ocean-layer">Buoys</span>
    <label><input type="radio" name="buoys" value="0" /> Off</label>
    <label><input type="radio" name="buoys" value="1" checked /> On</label>
  </div>
</fieldset>
```

CSS:

```css
#app.is-globe #ocean { display: none; }
#buoy-marks { position: absolute; inset: 0; pointer-events: none; z-index: 4; }
#buoy-marks button { pointer-events: auto; }
```

Add `<div id="buoy-marks" hidden></div>` as a sibling of `#geo-labels`.

About panel new `<h3>Ocean overlay</h3>` paragraph: snapshot HYCOM particles are visually exaggerated, not a time stepper; NDBC wind barbs; not an official NOAA product; HYCOM consortium acknowledgment (dataset filled from manifest in Task 11 if present, otherwise generic).

Extend `ViewerControls` and `mountControls` to read the new radios the same way as imagery.

- [ ] **Step 1: Make the HTML/CSS/controls edits**

- [ ] **Step 2: Run `cd web && npx tsc --noEmit`**

Expected: PASS (or fail until `mountControls` callers in `main.ts` pass the new fields — if `main.ts` does not compile, set `currents: false, buoys: false` temporarily in the `mountControls` initial object)

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/src/style.css web/src/ui/controls.ts web/src/main.ts
git commit -m "$(cat <<'EOF'
Add ocean layer controls to the bathymetry chrome.

EOF
)"
```

---

### Task 10: GPGPU currents overlay

**Files:**
- Create: `web/src/overlay/shaders/advect.frag.glsl`
- Create: `web/src/overlay/shaders/trail.vert.glsl`
- Create: `web/src/overlay/shaders/trail.frag.glsl`
- Create: `web/src/overlay/currents.ts`
- Consumes: `VelocityGrid`, `FLOW_SCALE`, `PARTICLE_COUNT`, `sampleUV`, `staticArrows` from Task 6; `lonLatToLocal`, `localToLonLat`, `AOI` from `geo.ts`

**Interfaces:**
- Produces:
  - `export type CurrentsHandle = { setEnabled(on: boolean): void; tick(dtSec: number): void; setReducedMotion(on: boolean): void; destroy(): void }`
  - `export function mountCurrents(scene: THREE.Scene, grid: VelocityGrid, opts: { reducedMotion: boolean; floatOk: boolean }): CurrentsHandle`

- [ ] **Step 1: Implement velocity texture + sim + trails**

Velocity: `THREE.DataTexture` `RG FloatType`, size `nx × ny`, `flipY` so `v=0` is south. Null cells: `u=0,v=0` plus a third channel or treat `(0,0)` with a separate `R` mask texture (`Luminance`/`Red` float, 0 = nodata). Prefer a 3-component `RGB` float: `u, v, mask`.

Particle state: two `WebGLRenderTarget` `FloatType`, size `128 × 64`, `NearestFilter`, no mipmaps. Sim shader: `gl_FragCoord` → particle id; read `x,y,age,seed`; convert local metres via uniforms `uOriginLon`, `uOriginLat`, `uMPerDegLon`, `uMPerDegLat` (pass from `ORIGIN` in `geo.ts`); sample velocity; if mask=0 or `shouldRespawn` logic in shader, respawn with hash(`seed`) inside AOI; write `newX,newY,age,seed` **and** pack previous xy in a second target **or** `.zw` of a second ping-pong pair. Simplest legal design matching the spec: RGBA state = `x, y, prevX, prevY` and a second texture `age, seed, 0, 0`.

Trails: `BufferGeometry` with `PARTICLE_COUNT * 2` vertices, attribute `aId` 0..8191 and `aEnd` 0|1. Vertex shader samples state texture, outputs local `vec3(x,y,18)`. Fragment: cyan `vec3(0.55, 0.78, 0.82)`, alpha `0.35`, `depthTest true`, `transparent true`, `renderOrder 4`.

`tick`: if disabled or reduced or `!floatOk`, skip sim; if reduced/`!floatOk`, draw `staticArrows` as a `THREE.Group` of short `Line` segments (CPU, using `lonLatToLocal`) and hide GPU lines. `setEnabled(false)` sets `group.visible = false` and skips sim.

Detect float RT: try creating a `WebGLRenderTarget` with `FloatType` and check `renderer.capabilities.isFloatTexture` / `WEBGL_color_buffer_float`. Pass `floatOk` from `main.ts` via `renderer.capabilities`.

`uFlowScale` uniform = `FLOW_SCALE`. Document in a code comment that it is visual exaggeration.

Do not run sim when the group is invisible.

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/overlay/currents.ts web/src/overlay/shaders
git commit -m "$(cat <<'EOF'
Draw HYCOM currents as GPU particle trails on the chart.

EOF
)"
```

---

### Task 11: Buoy overlay, main.ts wiring, docs

**Files:**
- Create: `web/src/overlay/buoys.ts`
- Modify: `web/src/ui/labels.ts` — accept optional extra `LabelCandidate[]` **or** have `buoys.ts` call `visibleLabelIds` with combined candidates (places + buoys). Prefer extending `labels.update` / `layout` with an extra argument `buoyCandidates: LabelCandidate[]` and returning `Set<number>` of visible buoy ids (ids ≥ 1000). Place ids stay `0..PLACES.length-1`. Buoy id = `1000 + index`.
- Modify: `web/src/main.ts` — fetch `/api/ocean/currents` and `/api/ocean/buoys` (and manifest for attribution/caption); mount overlays only in bathymetry; `tick` calls `currents.tick`; hide overlay when `viewMode==='globe'`
- Modify: `web/src/ui/controls.ts` `setReadout` **or** buoy overlay writes `#readout` itself on focus/hover and restores depth on blur — do not fight the depth hover. Rule: if a buoy button is `:focus` or `:hover`, buoy readout wins; else existing depth pick.
- Modify: `docs/data-sources.md` — HYCOM/NDBC rows: “retrieval via `make ocean`; date filled at first successful pull”
- Modify: `README.md` — list `/api/ocean/*`; note overlay is snapshot, air-gap safe
- Modify: spec status line optional: not required

**Interfaces:**
- Consumes: `barbSvg`, `buoyReadout`, `BUOY_RANK`, `oceanCaption`, `availabilityFromHttp`, `defaultOn`, `mountCurrents`
- Produces: `export function mountBuoys(root: HTMLElement, stations: Station[]): BuoysHandle` with `layout(project, width, height, placeCandidates: LabelCandidate[]): void` and `setEnabled(on: boolean): void`

Station type on the client:

```ts
export type BuoyStation = {
  id: string;
  name?: string;
  lon: number;
  lat: number;
  obsTime?: string;
  wdir?: number;
  wspd?: number;
  gst?: number;
  wvht?: number;
  wtmp?: number;
};
```

Each station is a `<button type="button" class="buoy-mark">` containing the SVG + `<span class="buoy-id">`. `aria-label` from `buoyReadout`. `pointer-events` on buttons only.

- [ ] **Step 1: Implement `buoys.ts` and occupancy merge**

When combining candidates, places use existing ranks; buoys use `BUOY_RANK` and ids `1000+i`. After `visibleLabelIds`, hide buttons not in the set.

- [ ] **Step 2: Wire `main.ts`**

```ts
const currentsRes = await fetch('/api/ocean/currents');
const buoysRes = await fetch('/api/ocean/buoys');
const avail = availabilityFromHttp(currentsRes.status, buoysRes.status);
```

Disable radios when `!avail.currents` / `!avail.buoys`. Parse JSON only on 200. `mountCurrents` if currents ok. `mountBuoys` if buoys ok. Caption: `setCaption` includes `oceanCaption`. Manifest fetch optional for about dataset id (`/api/ocean/manifest`).

`setMode('globe')`: `currents.setEnabled(false)`, hide `#buoy-marks`, ocean fieldset hidden via CSS.

Animation: `currents.tick(clock.getDelta())` inside existing `tick` when `bathymetryRunning`.

`prefersReducedMotion()` already exists in `main.ts` — pass it in.

No toast on 404.

- [ ] **Step 3: Docs**

`docs/data-sources.md`: add a short “Ocean snapshot” subsection stating files live in `data/ocean/`, produced by `make ocean`, gitignored, first-pull date still empty until someone runs it.

`README.md` serve table: add the three routes. Note they 404 until `make ocean`.

- [ ] **Step 4: Run full verification**

Run:

```
go test ./...
cd web && npm test && npx tsc --noEmit
```

Expected: PASS

Manual (not CI): with a valid `HYCOM_NCSS`, `make ocean && make run`, bathymetry view, currents move, a station id visible, globe hides ocean controls, network unplugged still serves the snapshot.

- [ ] **Step 5: Commit**

```bash
git add web/src/overlay/buoys.ts web/src/ui/labels.ts web/src/main.ts web/src/ui/controls.ts docs/data-sources.md README.md web/index.html
git commit -m "$(cat <<'EOF'
Mount NDBC buoys and wire ocean overlays into the viewer.

EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| Snapshot ingest, `cmd/ocean`, fail-closed | 4 |
| HYCOM NCSS CSV, cell centres, south-to-north | 3 |
| NDBC table + realtime2, 0.5° margin, no HTML render | 2 |
| JSON contract + decode | 1 |
| `/api/ocean/*`, 404/500, ETag, max-age 300, readyz independent | 5 |
| GPGPU particles, 8192, world-space trails, Z=18, cyan, FLOW_SCALE | 6, 10 |
| Reduced motion + float fallback = static arrows | 6, 10 |
| Buoy HTML barbs, knots, occupancy, readout | 7, 8, 11 |
| Toggles, hide in globe, caption valid times, about attribution | 8, 9, 11 |
| CI offline | 1–8 tests; `make ocean` not in CI |
| Slice 2 wind.json / globe / live proxy | omitted |

**Placeholder scan:** HYCOM URL is an explicit Makefile `HYCOM_NCSS` requirement, not a fake default. Dataset id in about comes from manifest after first pull.

**Type consistency:** `Currents`/`Buoys`/`Manifest`/`BBox`/`Source` names are shared Go→JSON→TS (`VelocityGrid` is the client grid; map `u`/`v` nulls when parsing fetch JSON in Task 11).
