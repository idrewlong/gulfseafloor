# Ocean overlay — currents, NDBC buoys, later wind grid

Date: 2026-08-24
Status: approved in conversation; implementation plan not started

Slice 1 of the project spec stretch goal: HYCOM surface-current particle
advection on the bathymetry chart, plus NDBC station observations with
wind barbs. Slice 2 (GFS 10 m wind as a coarse barb grid) is specified
only far enough that Slice 1 does not paint it into a corner.

## 1. Decisions already made

| Question | Choice |
|---|---|
| Layers | Surface currents + wind + buoy observations |
| Data path | Snapshot ingest. Last files on disk. Server has no outbound calls. |
| Wind in Slice 1 | Only at NDBC stations (barbs). Not a second particle field. |
| Wind in Slice 2 | GFS/HRRR 10 m barbs on a coarse grid. Third toggle. No particles. |
| Renderer | Bathymetry (three.js) only. Globe / Cesium unchanged. |
| Shape | One AOI JSON grid + GPGPU particles. Not a velocity tile pyramid. Not CPU particles. |

## 2. Goals and non-goals

**Goals**

- Timestamped HYCOM surface `u,v` over `internal/tiles.AOI`, animated as
  a particle field on the planar chart.
- NDBC stations in that box (plus margin) as HTML glyphs with wind barbs
  and a focus/hover readout.
- Air-gap: `make run` with the network unplugged still serves whatever
  snapshot was last written. `make ocean` is the only networked step.
- Terrain remains the content. Overlay is optional and quiet.

**Non-goals (Slice 1)**

- Live refresh, browser calls to NOAA, or a Go proxy to THREDDS.
- Globe-mode particles or buoys.
- GFS/HRRR ingest or a continuous wind field.
- Radar, SST colour overlay, WAVEWATCH, Argo.
- Third-party weather APIs (keys, ToS, view-time network).
- Physical time-accurate advection. Particle speed is visual.

## 3. Architecture

Ingest is a different program from serve, same split as tiles.

```
HYCOM THREDDS NCSS (surface u, v)     NDBC station table + realtime2
              │                                    │
              └──────── cmd/ocean (online) ────────┘
                                 │
                                 ▼
                        data/ocean/          gitignored
                          currents.json
                          buoys.json
                          manifest.json
                                 │
                                 ▼
                        gulf-viewer          no outbound
                          GET /api/ocean/manifest
                          GET /api/ocean/currents
                          GET /api/ocean/buoys
                                 │
                                 ▼
                        bathymetry scene
                          overlay/currents.ts
                          overlay/buoys.ts
```

`internal/tiles.AOI` is the clip box (Mississippi Sound as in code today,
not the older two-degree shelf window in `projectspec.md` §1). Ocean
products follow that box if it moves.

`gulf-viewer` never fetches HYCOM or NDBC. Missing `data/ocean/` is not
a startup failure.

## 4. Ingest — `cmd/ocean`

A CGO-free Go command. Not invoked by `make run`. `make ocean` writes
`data/ocean/` (override `-out`, default `data/ocean`).

### 4.1 HYCOM

Public THREDDS NetCDF Subset Service, no login. Request:

- Variables: surface (or depth 0) `water_u`, `water_v` in m/s
- BBox: `internal/tiles.AOI`
- Time: latest available on that node
- Prefer CSV or JSON from NCSS so the command stays HTTP + parse

Pin the working experiment URL, dataset id, and retrieval UTC in
`docs/data-sources.md` on the first successful pull. HYCOM experiment
IDs move; the spec does not freeze a hostname that may already be
retired. If NCSS is gone, fail with a clear error naming the URL — do
not scrape HTML, do not add a login portal.

Oceanographic convention: `u` eastward, `v` northward.

### 4.2 NDBC

No API key.

1. `https://www.ndbc.noaa.gov/data/stations/station_table.txt`
2. Keep stations whose lat/lon fall in AOI expanded by 0.5° on each
   side.
3. For each id, `https://www.ndbc.noaa.gov/data/realtime2/{id}.txt`
   (standard meteorological). Parse the most recent row.

Fields to keep when present: `WDIR` (degrees true, direction from),
`WSPD` and `GST` (m/s), `WVHT` (m), `WTMP` (°C), obs timestamp. A
station with no wind still ships if it has position and id; the client
omits the barb.

Timeouts and size caps on every request. User-Agent that identifies
this project. Parallelism bounded (a small worker pool, not one
goroutine per station).

### 4.3 Write protocol

Fail closed: if either HYCOM or NDBC fails, do not overwrite a good
previous snapshot. Write a temp directory, fsync files, then rename
into `data/ocean/`. Non-zero exit on failure.

CI does not run `make ocean`.

`.gitignore` gains `data/ocean/` (and `/ocean` next to `/tiler`).

## 5. On-disk and HTTP contract

Three inspectable JSON files. UTF-8. No NaN in JSON; missing velocity
cells are `null` in `u`/`v` (same index). Missing buoy fields are
omitted keys, not nulls.

### 5.1 `currents.json`

```json
{
  "validTime": "2026-08-24T18:00:00Z",
  "source": {
    "name": "HYCOM",
    "dataset": "GLBy0.08-expt_93.0",
    "url": "https://example.invalid/thredds/ncss/..."
  },
  "bbox": { "west": -89.70, "south": 29.95, "east": -87.85, "north": 30.52 },
  "nx": 2,
  "ny": 1,
  "grid": "centers",
  "u": [0.12, null],
  "v": [-0.04, null]
}
```

- `u` and `v` length **must** equal `nx * ny`.
- Row-major, west-to-east, **south-to-north** (index 0 is southwest
  cell). Matches `HeightUvRect` (`v=0` is south).
- Units: m/s.
- `bbox` is the grid extent using **cell centres** of the first and last
  sample (`grid` must be `"centers"`; reject any other value).
- Example `dataset` / `url` above are illustrative. The live values are
  whatever the first successful pull recorded in `docs/data-sources.md`.

### 5.2 `buoys.json`

```json
{
  "validTime": "2026-08-24T19:50:00Z",
  "source": { "name": "NDBC", "url": "https://www.ndbc.noaa.gov/" },
  "stations": [
    {
      "id": "WYCM6",
      "name": "Gulfport Harbor",
      "lon": -89.081,
      "lat": 30.36,
      "obsTime": "2026-08-24T19:50:00Z",
      "wdir": 180,
      "wspd": 6.2,
      "gst": 8.1,
      "wvht": 0.4,
      "wtmp": 29.1
    }
  ]
}
```

`validTime` is the newest `obsTime` in the file, or the retrieval time
if every obs time is missing.

### 5.3 `manifest.json`

```json
{
  "retrievedAt": "2026-08-24T20:01:00Z",
  "currents": { "present": true, "validTime": "2026-08-24T18:00:00Z" },
  "buoys": { "present": true, "validTime": "2026-08-24T19:50:00Z", "count": 12 },
  "attribution": [
    "HYCOM consortium; dataset id as retrieved",
    "NDBC / NOAA. Not an official NOAA product."
  ]
}
```

Slice 2 may add a `wind` object. Slice 1 clients ignore unknown keys.

### 5.4 Routes

| Method | Path | Body |
|---|---|---|
| GET | `/api/ocean/manifest` | `manifest.json` |
| GET | `/api/ocean/currents` | `currents.json` |
| GET | `/api/ocean/buoys` | `buoys.json` |

Missing file: **404**, empty body. Malformed JSON on disk: **500**,
structured log, no path in the response body.

Cache-Control: `public, max-age=300`. ETag from a hash of the file
bytes (snapshots are not immutable tiles).

Config: `GULF_OCEAN_DIR` (default `data/ocean`), same pattern as
`TileDir`. `/readyz` does **not** require these files.

`/api/manifest` (tiles) is unchanged.

## 6. Currents renderer

Files: `web/src/overlay/currents.ts` plus small GLSL next to it.
Mounted from `main.ts` only in bathymetry mode. `addCoastOverlay`
stays; this is a sibling group.

**Velocity texture.** Upload `u,v` once as an `RG` float texture,
`nx × ny`, `v=0` south. Bilinear sample. Null cells: do not advect;
respawn the particle.

**Particles.** Default **8192** (128×64 state texture). Two ping-pong
float textures: `x, y` (local metres), `age`, `seed`. Fragment shader
advects by sampled velocity. Leave the AOI or exceed max age → respawn
at a random point in the box (seed-stable hash, not `Math.random` in
the sim shader).

**Trails.** World-space only. Store previous `x,y`; draw a short
`GL_LINES` (or line segments) per particle. No screen-space trail FBO
(it smears under MapControls pan/tilt).

**Placement.** Lift ~18 m in local Z, same order of magnitude as the
coast overlay, so traces sit on the water surface, not in the
bathymetry.

**Colour.** Quiet cyan, low opacity. Not `#C0006E`.

**Visual speed.** `uFlowScale` is a dimensionless exaggeration so a
typical ~0.5 m/s shelf current is obviously moving at the default
camera. It is not a physical dt. Name it in the about panel as visual
exaggeration.

**Reduced motion.** If `prefers-reduced-motion: reduce`, do not run the
sim. Draw static arrows on HYCOM cell centres (one arrow per cell with
non-null velocity).

**GPU fallback.** If `OES_texture_float` / render-to-float-texture is
missing, use that same static-arrow path.

**Toggle.** Currents off/on. Default **on** when `currents.json` loaded,
**off** and `disabled` on 404/parse failure. Off means no sim, no draw.

Particle work happens only while bathymetry is the active view, the
toggle is on, and reduced-motion/fallback is not in effect.

## 7. Buoys and UI

HTML overlay, not WebGL. Sibling of `#geo-labels`. SVG wind barb +
station id. Marks are `<button>`s (or equivalent) so they are
keyboard-focusable.

**Barb.** Meteorological: staff points **into** the wind (direction
the wind is coming from). Speed in knots (`wspd * 1.94384`). Standard
NH barbs (pennant 50 kt, full barb 10 kt, half 5 kt). Calm (< 2.5 kt):
a circle, no staff. No `wspd`/`wdir`: id mark only.

Ink: chart dark stroke. Not magenta.

**Readout.** Focus or hover replaces the depth readout content with
id, name if any, wind (dir + speed + gust), wave height, water temp,
obs time. Restore depth readout on blur/leave. Missing fields omitted.

**Collision.** Feed buoy screen positions into the same occupancy pass
as place labels (`labelLayout`). Place labels rank higher; a buoy that
sits too close is hidden, not the place name.

**Controls.** New fieldset next to imagery: Currents off/on, Buoys
off/on. Same radio/label pattern as existing controls. Hide this
fieldset in globe mode (layers do not draw there).

**Caption.** When any ocean layer is on, append valid times:

`Currents HYCOM 18Z · Buoys NDBC 19:50Z`

Use the `validTime` from each file. Hours UTC, compact.

**About.** HYCOM consortium acknowledgment (dataset id from manifest)
and NDBC/NOAA NODD-class attribution, plus the existing “not an
official NOAA product” line. Do not imply endorsement.

**Reduced motion.** Barbs are already static.

## 8. Error handling

| Case | Behaviour |
|---|---|
| Missing `data/ocean` | 404 per route; toggles disabled; terrain works |
| Only currents or only buoys | The other toggle disabled; partial overlay allowed |
| Bad JSON | 500 from server; client treats as unavailable |
| Bad station row | Drop field or station; keep the layer |
| Stale snapshot (>48 h) | Still draw; timestamp stays visible. Do not auto-hide |
| Ingest failure | Previous snapshot left intact; non-zero exit |
| NDBC HTML / unexpected content | Parse fail for that station; never `innerHTML` a payload |
| Float-texture missing | Static arrows, same as reduced motion |

Trust: public HTTP is untrusted. Size caps, timeouts, parse then
discard raw bytes. Attribution strings are from our docs / manifest
writer, not from a remote HTML page.

No auto-refresh in the browser or the server.

## 9. Testing

Offline only in CI.

**Go** (`httptest` fixtures, no live network):

- HYCOM-like grid parse: `len(u)==nx*ny`, bbox clip, `grid: "centers"`
- NDBC `realtime2` fixture: field extract; station-in-margin filter
- Fail-closed: error path does not replace existing files
- Handler: 404 when dir empty; 200 + ETag with fixtures; `readyz` 200
  with ocean missing

**Client** (`node --test`, add files to the `npm test` list):

- Bilinear sample of a 2×2 `u,v` grid at known points
- Particle wrap/respawn against the AOI
- m/s → knots; barb counts for 0, 5, 10, 50 kt
- Occupancy: buoy yields to a place label
- Manifest 404 → both toggles disabled (pure function on fetch result,
  not a DOM browser test)

No shader pixel tests. No `make ocean` in GitHub Actions.

**Manual, not CI:** networked `make ocean && make run`; particles
read as shelf flow; a real station id is present; unplug network and
reload — snapshot still serves. Switch to globe: overlay gone, globe
unchanged.

## 10. Slice 2 (not this work)

Add `wind.json` (GFS or HRRR 10 m `u,v`, same grid conventions as
currents, coarser than native if needed). `cmd/ocean` gains a wind
fetch. Third toggle: grid barbs, HTML or a quiet three.js line set,
not particles. Ignore this section when implementing Slice 1 except:
leave unknown `manifest.json` keys alone; keep the control fieldset
extensible.

## 11. Files likely to change (Slice 1)

| Path | Role |
|---|---|
| `cmd/ocean/` | Fetch + write snapshot |
| `internal/ocean/` | Parse, clip, JSON types, barb math if shared |
| `internal/server/ocean.go` | Static file routes |
| `internal/server/handler.go` | Mux + config `OceanDir` |
| `web/src/overlay/currents.ts` (+ GLSL) | GPGPU particles |
| `web/src/overlay/buoys.ts` | HTML stations |
| `web/src/overlay/windBarb.ts` | Knots + SVG barb (unit-tested) |
| `web/src/ui/labelLayout.ts` | Occupancy includes buoys |
| `web/src/ui/controls.ts`, `web/index.html`, `web/src/style.css` | Toggles, caption |
| `web/src/main.ts` | Mount, fetch, reduced motion |
| `Makefile`, `.gitignore` | `make ocean`, `data/ocean/` |
| `docs/data-sources.md` | Fill retrieval row after first pull |
| `README.md` | Routes + stretch status |

## 12. Attribution (canonical)

HYCOM: acknowledge the HYCOM consortium and the dataset / experiment
id actually retrieved. NDBC: NOAA open data; request attribution; do
not imply NOAA endorsement; this viewer is not an official NOAA
product. Same NODD-class rules as `docs/data-sources.md`.
