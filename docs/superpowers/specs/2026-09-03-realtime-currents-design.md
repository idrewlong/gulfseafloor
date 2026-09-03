# Real-time currents — forecast stack, background refresh, speed-ramped streaklines

Date: 2026-09-03
Status: approved in conversation; implementation plan not started

Two coupled changes to the currents overlay. First, the field stops being
a hand-run build artifact and becomes a self-refreshing forecast stack the
client interpolates to wall-clock time. Second, the overlay stops drawing
every particle in one flat cyan and starts encoding speed.

This moves `/api/ocean/currents` from the snapshot side of the air-gap line
to the live side, alongside `/api/aircraft`. That is a deliberate change to
a claim the README currently makes, and §8 covers the rewrite.

## 1. What is true of the tree today

Recorded because the whole design is a reaction to it.

| Fact | Evidence |
|---|---|
| Currents are a build artifact, written by hand via `make ocean` | `cmd/ocean/main.go`, `Makefile` |
| The on-disk snapshot is 8 days stale | `data/ocean/currents.json` `validTime` `2026-08-26T00:00Z` vs today |
| The server never refreshes; it reads a file per request | `internal/server/ocean.go:26` |
| The client fetches once at startup and never re-polls | `web/src/main.ts:405` |
| One time step only; no time axis exists | `internal/ocean/types.go` `Currents` |
| Grid is 36×33 = 1188 cells, HYCOM GLBy0.08 | `data/ocean/currents.json` |
| Speed is encoded nowhere in the visual | `currents.ts:23`, `trail.frag.glsl`, `particle.frag.glsl` |
| Trails are 2-vertex segments, hard head and tail, uniform alpha | `currentsGpu.ts`, `trail.vert.glsl` |
| Static arrows draw at all 1188 cells with no arrowhead | `currentsField.ts` `staticArrows` |

## 2. Decisions already made

| Question | Choice |
|---|---|
| What "real time" means | Both: server auto-refresh **and** a forecast stack interpolated to now |
| Air-gap posture | `GULF_OCEAN_REFRESH != "0"` — default on, opt out, matching `GULF_AIRCRAFT` |
| Who fetches | Go server, background goroutine. Browser only hits `/api/ocean/currents`. CSP stays `connect-src 'self'` |
| Refresh cadence | ~1 h, jittered. GLBy0.08 posts once daily; faster is noise against NCSS |
| Time UI | Honest caption, no control. No scrubber, no play toggle |
| Visual | Speed-ramped tapered streaklines. Keeps the GPU ping-pong architecture |
| Buoy assimilation | Rejected. A hand-rolled blend of NDBC obs into a model field is exactly what a Stennis reviewer would catch |

## 3. Goals and non-goals

**Goals**

- The displayed field is the field at *this minute*, and visibly evolves.
- A running server keeps itself current without anyone running `make ocean`.
- Speed is legible at a glance, and distinguishable from the bathymetry ramp.
- An air-gapped cluster behaves exactly as it does today, with zero egress.
- Provenance stays exact: interpolated model output never reads as observation.

**Non-goals**

- A time scrubber, playback, or forecast animation controls.
- Assimilating NDBC or any other observation into the model field.
- Depth levels below the surface. `vertCoord=0` as today.
- Globe / Cesium currents.
- Sub-surface, wave, or tide products.
- True width-tapered ribbons (see §7, deferred).

## 4. Schema — `Currents` gains a time axis

`internal/ocean/types.go`:

```go
// Step is one forecast time of the surface velocity grid.
type Step struct {
    ValidTime time.Time  `json:"validTime"`
    U         []*float64 `json:"u"`
    V         []*float64 `json:"v"`
}

type Currents struct {
    ValidTime time.Time `json:"validTime"` // first step; retained as a hint
    Source    Source    `json:"source"`
    BBox      BBox      `json:"bbox"`
    NX        int       `json:"nx"`
    NY        int       `json:"ny"`
    Grid      string    `json:"grid"`
    Steps     []Step    `json:"steps"`
}
```

- **Window: −3 h to +24 h, 10 steps** at HYCOM's 3-hourly cadence. Always
  brackets now, and survives a failed refresh for a day.
- **Quantize `u`/`v` to 3 decimals (1 mm/s).** Sub-mm/s precision on a 1/12°
  model is noise. Roughly halves the payload: ~250 KB for 10 steps
  uncompressed, well inside the existing 8 MiB `oceanMaxBytes` cap.
- **`DecodeCurrents` accepts the legacy flat `u`/`v` form** and lifts it to a
  one-step stack. The existing on-disk snapshot keeps working; no forced
  re-fetch, and every existing decode test stays meaningful.
- Every step shares one `nx`/`ny`/`bbox`. A step whose length disagrees is a
  decode error, not a silent truncation.
- The NCSS query grows a time window. Today `cmd/ocean` sends no time
  parameter and gets a single nearest step; the fetch adds
  `time_start`/`time_end` spanning −3 h to +24 h so NCSS returns the stack in
  one request. `horizStride=1` and `vertCoord=0` are unchanged.
- Null cells stay null per step. Land is land at every forecast hour.

## 5. Server — background refresher

New `internal/server/oceanrefresh.go`. Deliberately **not** shaped like
`aircraftCache`.

```
ticker (~1h, jittered)
      │
      ▼
ocean.FetchCurrents  NCSS, 10 steps
      │
      ▼
ocean.DecodeCurrents  validate
      │
      ├──► atomic in-memory swap  ──► GET /api/ocean/currents
      │
      └──► ocean.WriteSnapshot    ──► data/ocean/ (write-through)
```

- **Nothing fetches on the request path.** `/api/ocean/currents` always
  answers from memory, falling back to disk before the first refresh lands.
  A 90 s NCSS stall can never become request latency. The aircraft
  lazy-fetch-under-`singleflight` shape is correct for a 10 s TTL and wrong
  here, which is why this does not reuse it.
- **Fetch → validate → swap.** A response that fails `DecodeCurrents` is
  discarded and the previous stack stands. Same discipline as
  `ocean.WriteSnapshot` already applies to disk.
- **Write-through** to `OceanDir` via the existing `ocean.WriteSnapshot`, so
  a restart keeps the freshness rather than falling back to a stale file. An
  unwritable dir logs once and continues serving from memory.
- **Serve stale on failure.** Last good stack stays up. Fails closed, never
  blank, never a 500 on a transient upstream error.
- **First refresh is delayed ~15 s** after boot so startup never waits on
  NCSS, and a crash-loop cannot hammer the upstream.
- `manifest.json` is regenerated alongside so `/api/ocean/manifest` does not
  contradict `/api/ocean/currents`.
- Existing ETag and `Cache-Control: public, max-age=300` are unchanged; the
  ETag is what makes client polling cheap (§6).

**No staleness field is added.** The client compares now against the covered
window: if now falls outside `[first, last]`, the field is stale. It is
self-describing, and there is nothing to keep in sync with reality.

Config additions to `internal/server/config.go`, wired in `cmd/server/main.go`:

| Field | Env | Default |
|---|---|---|
| `OceanRefreshEnabled` | `GULF_OCEAN_REFRESH` | on unless `0` |
| `OceanRefreshEvery` | — | 1 h |
| `HYCOMURL` | `GULF_HYCOM_URL` | the `GLBy0.08/latest` NCSS base already in the snapshot's `source.url` |
| `OceanNow` | — | `time.Now().UTC` (injected in tests) |

## 6. Client — poll and time cursor

- `velocityGridFromJson` becomes `velocityStackFromJson` → `VelocityStack`
  (`nx`, `ny`, `bbox`, `times: number[]`, `u`/`v` per step). Still returns
  `null` on anything malformed. Still accepts the legacy single-step shape.
- New `web/src/overlay/currentsTime.ts`:
  `interpolateGrid(stack, tMs): VelocityGrid`. Pure function. Linear blend
  between the bracketing steps, clamped at both ends. **Null propagates** — a
  null in either bracketing step yields null, so no-data never smears into a
  fabricated velocity.
- **Recompute every 30 s of wall clock, not per frame.** 1188 cells is
  trivial, and 30 s of granularity against a 3-hour step is imperceptible.
- `mountCurrents` gains `setGrid(grid)`: re-uploads the velocity `DataTexture`
  in place. Same `nx`/`ny`, so no material or geometry rebuild, and the
  particle state survives the swap — the field changes under the particles
  rather than restarting them.
- **Poll `/api/ocean/currents` every 15 min** with `If-None-Match`. The
  existing ETag makes the steady state a 304 with no body.
- Caption: `Currents HYCOM 14:20Z · interpolated 12Z→15Z`, and `· stale` when
  now is outside the window.

CPU interpolation is chosen over a two-texture `uMix` in the shader on
purpose: the reduced-motion arrow geometry needs a CPU-side grid regardless,
so this keeps **one** code path and makes the core of the feature a
unit-testable pure function.

## 7. Visual — speed-ramped tapered streaklines

**Speed ramp** — new `web/src/overlay/speedRamp.ts`. Deep indigo → cyan →
mint → pale yellow. Anchored in cyan to keep the established currents
identity, ending high-luminance and saturated so it escapes the bathymetry's
muted teal-and-sand in `lut.ts:29-45`. The two ramps must never be
confusable; that is the constraint the hexes are tuned against.

**Curved multi-segment trails.** The 2-vertex segment becomes an 8-vertex
polyline. No history buffer and no second render target: the vertex shader
**back-integrates the velocity field** 8 short steps from the head, so
streaks curve along the flow instead of pointing rigidly downstream.
~65k vertices for 8192 particles.

> This draws a **streamline**, not a pathline. Over a ~4 s visual lag on a
> quasi-steady field the two coincide. It gets a comment in the shader
> rather than being left to read as a particle history.

**Taper by alpha**, `pow(1-t, 1.5)` from head to tail. WebGL ignores
`lineWidth`, so genuine width taper needs quad-expanded ribbons — deferred,
not attempted here.

**Slack water fades out.** `alpha *= smoothstep(0.0, 0.05, speed)`, so
near-zero flow stops rendering as a field of motionless dots.

**Static arrows fixed** — the reduced-motion and no-float-texture path, which
today is the ugliest thing on screen. Ramp-coloured, length proportional to
speed, a real 2-segment arrowhead, and cells below a speed floor dropped.
That alone removes the cyan hash noise at zoom-out.

**Legend.** A currents ramp labelled in knots, mirroring the existing
`#legend` aside in `web/index.html:61`, shown only while the layer is on.

## 8. Documentation

The README describes behaviour this change invalidates. These edits land
**with the implementation, not before it** — the tree's own build-status
section warns against claims that outrun the code.

- `README.md:102` — the architecture diagram calls `/api/ocean/currents`
  "snapshot, air-gap safe". Rewrite: live-refreshing by default, snapshot
  under `GULF_OCEAN_REFRESH=0`.
- `README.md:141-148` — "Terrain tiles and the ocean overlay have no outbound
  calls at serve time" becomes false by default. Rewrite so the air-gap claim
  is stated as the opt-out it now is, and so `/api/aircraft` is no longer
  described as the sole live exception.
- `README.md:335` — env table gains `GULF_OCEAN_REFRESH` and `GULF_HYCOM_URL`.
- `docs/data-sources.md` — HYCOM's row now describes a recurring serve-time
  fetch, not a one-shot ingest. Retrieval date handling needs a note that the
  snapshot is continuously replaced.
- `docs/threat-model.md` — a new scheduled outbound dependency in the serving
  binary is a threat-model change, not just a doc change.

**Separately flagged:** `README.md:42` already claims "No NOAA, USGS, HYCOM,
NDBC, or Argo bytes have been fetched." A real HYCOM snapshot sits in
`data/ocean/` dated 2026-08-26. It is gitignored, so the claim is true of the
repository and false of a running tree. That is a pre-existing inaccuracy,
not one this change introduces, and it should be corrected in the same pass.

## 9. Testing

**Go**

- Refresher against `httptest` with an injected clock: successful swap;
  serve-stale on upstream failure; malformed response leaves the prior stack
  intact; write-through produces a re-readable snapshot.
- **`GULF_OCEAN_REFRESH=0` performs zero HTTP calls** — asserted against a
  round-tripper that fails the test if called. This is the air-gap claim, so
  it gets a test rather than a comment.
- No fetch happens on the request path: a request served while the upstream
  is blocked returns promptly from cache.
- Decode: multi-step, legacy single-step, mismatched step lengths rejected,
  quantization round-trip.

**TypeScript**

- `interpolateGrid`: bracketing, both clamped ends, null propagation,
  one-step stack, exact-hit on a step boundary.
- Speed ramp: monotonic luminance, bounded output, endpoints stable.
- Caption formatting, including the stale case and the interpolation range.
- `velocityStackFromJson` rejects: bad `grid`, wrong array lengths, empty
  `steps`, non-monotonic times.

Existing `currents.test.ts`, `currentsField.test.ts`, `oceanUi.test.ts`, and
`ocean_test.go` must keep passing; where the API moved, they move with it.

## 10. Risks

| Risk | Handling |
|---|---|
| NCSS is slow, flaky, or changes its dataset path | Background-only fetch, serve-stale, `GULF_HYCOM_URL` override |
| Interpolated model output reads as observation | Caption states the bracketing forecast hours; §3 makes it a goal |
| 10-step payload cost | 3-decimal quantization; ~250 KB uncompressed vs an 8 MiB cap |
| Speed ramp collides with the depth ramp | Explicit constraint in §7; the ramps are tuned against each other |
| Default-on egress surprises an operator | Documented in §8; opt-out matches the existing `GULF_AIRCRAFT` convention |
