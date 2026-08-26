# Live aircraft overlay — public ADS-B on the bathymetry chart

Date: 2026-08-25
Status: approved in conversation; implementation plan not started

Live ADS-B positions over `internal/tiles.AOI` while a user is on the
site. No paid API, no key. Bathymetry (three.js) only. Globe / Cesium
is unchanged and must not grow an aircraft layer.

This is a live exception to the ocean snapshot path. Terrain and ocean
snapshots still work air-gapped. This layer does not.

## 1. Decisions already made

| Question | Choice |
|---|---|
| When | Live while the viewer is open. Not a `make ocean` snapshot. |
| Paid API | No. No FlightAware, no ADS-B Exchange RapidAPI, no key in env. |
| Primary feed | OpenSky Network REST `GET /api/states/all` bbox, anonymous. |
| Fallback | adsb.lol `GET /v2/lat/{lat}/lon/{lon}/dist/{nm}` if OpenSky fails. |
| Who fetches | Go server. Browser only hits `/api/aircraft`. CSP stays `connect-src 'self'`. |
| Cache | On-demand, ~10 s TTL, `singleflight`. Polling only when a client asks. |
| Renderer | Bathymetry HTML glyphs (heading chevron + callsign). Not 3D models. |
| Globe | Out of scope. Hide chrome and stop polling in globe mode. |

## 2. Goals and non-goals

**Goals**

- Show aircraft currently reported inside `internal/tiles.AOI` on the
  planar chart (Gulfport, Mobile, overflights).
- Zero credentials. Public HTTP only.
- One upstream fetch shared by every open tab.
- Quiet overlay: optional, toggleable, terrain stays the content.
- Fail closed: dead feeds do not break tiles, ocean, or globe.

**Non-goals**

- Globe / Cesium aircraft, 3D models, or barometric altitude as height.
- Keyed or paid APIs.
- Browser-direct calls to OpenSky or adsb.lol.
- Snapshot ingest (`cmd/ocean`, `data/aircraft/`, air-gap replay).
- Flight routes, airport GIS, schedules, or a military-only filter.
- Historical tracks, playback, or OpenSky `time=` lookback (anonymous
  cannot use `time`).

## 3. Architecture

Same split as the Esri imagery proxy: the viewer process may call out;
the browser never does. Unlike ocean, nothing is written to disk.

```
OpenSky  GET /api/states/all?lamin&lomin&lamax&lomax
                │
                │  429 / timeout / non-200
                ▼
adsb.lol GET /v2/lat/{lat}/lon/{lon}/dist/{nm}
                │
         gulf-viewer (Go)
           internal/aircraft  fetch + normalize
           on-demand cache (~10 s)
           singleflight
           GET /api/aircraft  →  stable JSON
                │
         bathymetry chart
           overlay/aircraft.ts  HTML glyphs
```

Clip box is `internal/tiles.AOI` as in code (Mississippi Sound window,
not the older two-degree box in `projectspec.md` §1). If AOI moves,
this overlay follows.

`GULF_AIRCRAFT=0` disables the handler (404), same as `GULF_IMAGERY=0`.
`/readyz` does not require a live feed.

## 4. Go — fetch, normalize, cache

New package `internal/aircraft`: HTTP to pinned hosts, parse, clip,
emit the stable struct. `internal/server` owns the route, TTL cache,
and disable flag. Tests inject fake upstream URLs via config (empty → production
hosts). CI never hits the real networks.

### 4.1 OpenSky (primary)

Anonymous, no login.

`GET https://opensky-network.org/api/states/all` with `lamin`, `lomin`,
`lamax`, `lomax` from `tiles.AOI`.

This box is about 3.5 square degrees (1 credit). Anonymous daily
budget is 400 credits. On-demand + 10 s floor keeps a demo session
well under that. Do not poll 24/7 from a cloud IP with no clients.

Host pin: `opensky-network.org`. Timeout 6 s. Body cap 2 MiB. No
off-host redirects. User-Agent `gulf-seafloor-viewer` (same family as
the imagery proxy).

### 4.2 adsb.lol (fallback)

Only after OpenSky returns non-200, times out, or fails parse.

Circle that covers the AOI: center of the box, radius ~90 nmi (half
diagonal plus margin). Convert dump1090 units: `alt_baro` feet →
metres, `gs` knots → m/s. Host pin: `api.adsb.lol`. Same timeout,
size cap, redirect rule, User-Agent.

### 4.3 Cache and route

`GET` / `HEAD` `/api/aircraft`. HEAD uses the same cache rules and
omits the body. Other methods: 405.

1. Cache age < 10 s → return it. Concurrent misses share one
   upstream call (`singleflight`).
2. Fetch OpenSky. On failure, fetch adsb.lol.
3. Both fail: if last good snapshot is < 60 s old, serve it
   (still 200). Else 404, empty body.
4. `Cache-Control: no-store` so a browser cache cannot hide a dead
   feed behind a 200.
5. Disabled (`GULF_AIRCRAFT=0`) → 404.

Malformed JSON from upstream is a fetch failure, not a 500 with a
partial body.

### 4.4 Normalize

Drop rows with missing icao24 or missing/non-finite lat/lon. Clip to
AOI. If more than 200 remain, sort by icao24 and keep 200. Trim
callsign whitespace; omit empty callsigns (keep `icao24`). Missing
optional fields are omitted keys, not nulls. Never `innerHTML` a
payload on either side.

```json
{
  "source": "opensky",
  "fetchedAt": "2026-08-26T02:00:00Z",
  "aircraft": [
    {
      "icao24": "a1b2c3",
      "callsign": "DAL123",
      "lon": -89.08,
      "lat": 30.41,
      "altBaroM": 3200,
      "trackDeg": 270,
      "gsMps": 120,
      "onGround": false
    }
  ]
}
```

`source` is `"opensky"` or `"adsb.lol"`. `fetchedAt` is UTC RFC3339
from wall clock at successful parse (not OpenSky's `time` field,
which is quantized). `icao24` is required. Omit `onGround` when the
feed does not say; the client then skips dead-reckon for that row.

## 5. Chart overlay

HTML overlay `#aircraft-marks`, sibling of `#buoy-marks`. Mounted
from `main.ts` only while bathymetry is the active view.

**Globe is a hard skip.** Fieldset hidden, marks hidden, polling
stopped, Cesium code paths untouched. Same `oceanChromeHidden` idea
(`ViewerMode === 'globe'`).

**Marks.** `<button>` chevron rotated by `trackDeg` (true track,
north = 0) plus callsign (or `icao24` if no callsign). Grounded
aircraft with no track: small square instead of chevron. Project onto
the chart like buoys (terrain / water surface). Do not displace by
`altBaroM`.

**Polling.** Every 10 s while: layer on, document visible, mode is
bathymetry. `document.hidden` pauses the timer. Reuse DOM nodes by
`icao24`.

**Motion.** Dead-reckon with track + `gsMps` between polls. Snap to
the new report when it arrives. Skip dead-reckon when `onGround` is
true, when `onGround` is omitted, or when track/speed is missing.
`prefers-reduced-motion: reduce`: no coasting; jump to last report
only.

**Readout.** Hover or focus replaces the depth readout: callsign,
icao24, altitude (m), track (°), ground speed (kt). Restore depth on
blur/leave when nothing else is engaged (same pattern as buoys).
Missing fields omitted.

**Collision.** Feed screen positions into `labelLayout`. Lower rank
number wins: place labels (existing ranks), then buoys
(`BUOY_RANK` 10), then aircraft (`AIRCRAFT_RANK` 20). A jet over
Gulfport does not hide the city label.

**Controls.** Own fieldset **Aircraft** Off/On next to ocean. Same
radio pattern. Default **on** when the first `/api/aircraft` is 200,
**off** and `disabled` on 404. Off means no poll, no draw.

**Caption.** When the layer is on, append `Aircraft OpenSky 02:00Z`
or `Aircraft adsb.lol 02:00Z` using `source` + `fetchedAt` (same
compact UTC helper as ocean).

**About.** Live ADS-B, not a snapshot, not for navigation. Name
OpenSky (primary) and adsb.lol (fallback). Do not imply endorsement.
Do not call it radar.

## 6. Error handling

| Case | Behaviour |
|---|---|
| `GULF_AIRCRAFT=0` | 404; toggle disabled; terrain/ocean/globe unchanged |
| Both feeds down, no cache | 404; same |
| Both down, cache < 60 s | 200 stale snapshot |
| OpenSky 429 / timeout / bad JSON | Fall through to adsb.lol |
| Row missing lat/lon or icao24 | Drop that aircraft |
| More than 200 in box | Sort by icao24; keep 200 |
| Tab hidden or globe mode | Stop polling |
| Air-gap | Layer empty. Bathymetry + ocean snapshots still work |
| Bad client JSON | Treat as unavailable; do not throw past the overlay |

Trust: public HTTP is untrusted. Timeouts, size caps, pinned hosts,
parse then discard raw bytes. Attribution copy lives in our docs and
about panel, not in a remote HTML page.

## 7. Testing

Offline only in CI. Inject `httptest` servers for both feeds.

**Go**

- OpenSky array-of-arrays parse; drop null position; clip to AOI
- adsb.lol object parse; feet → m; knots → m/s
- Cap 200; missing icao24 dropped
- Cache TTL: second GET inside 10 s does not hit upstream
- `singleflight`: overlapping GETs cause one upstream call
- OpenSky 429 → adsb.lol 200
- Both fail, cache 30 s old → 200; cache 90 s old → 404
- `GULF_AIRCRAFT=0` / `AircraftEnabled: false` → 404
- HEAD omits body; POST is 405
- `readyz` 200 with aircraft disabled or feeds down
- Off-host redirect not followed

**Client** (`node --test`)

- Stable JSON parse; omit bad rows
- Dead-reckon: known track/speed/dt → expected lon/lat
- Reduced-motion flag skips coasting
- HTTP 200 → toggle enabled/on; 404 → disabled/off
- Rank 20 loses to a buoy or place at the same pixel

No live OpenSky/adsb.lol in GitHub Actions. No screenshot tests.

**Manual, not CI:** `make run` on a network; marks move over GPT/MOB
or overflights; hide the tab and confirm polls stop; switch to globe
and confirm marks and fieldset gone, globe unchanged; unplug network
and confirm terrain/ocean still serve, aircraft 404s after stale
window.

## 8. Files likely to change

| Path | Role |
|---|---|
| `internal/aircraft/` | Fetch, parse, clip, types |
| `internal/server/aircraft.go` | Route, cache, singleflight |
| `internal/server/handler.go` | Mux |
| `internal/server/config.go`, `cmd/server/main.go` | `AircraftEnabled`, `GULF_AIRCRAFT`, injectable feed URLs |
| `web/src/overlay/aircraft.ts` | Marks, poll, dead-reckon |
| `web/src/overlay/aircraftUi.ts` | Readout, caption, availability |
| `web/src/ui/controls.ts`, `web/index.html`, `web/src/style.css` | Fieldset, marks layer |
| `web/src/main.ts` | Mount, globe hide, caption |
| `web/src/ui/labels.ts` | Occupancy includes aircraft |
| `docs/data-sources.md`, `README.md` | Live exception + attribution |

Do not add `cmd/aircraft` or `data/aircraft/`.

## 9. Attribution (canonical)

OpenSky Network: public ADS-B/Mode S aggregation; anonymous REST; no
login for this call. Acknowledge The OpenSky Network. Do not imply
endorsement. Not for navigation or surveillance.

adsb.lol: used only as fallback. API documents ODbL. Acknowledge
adsb.lol / contributing feeders. Do not imply endorsement.

This layer is live at view time. It is the second outbound call from
`gulf-viewer` (after Esri imagery). It is not vendored, not air-gap,
and not a radar product. Record both URLs in `docs/data-sources.md`
when the adapters are written; fill a retrieval note on first
successful manual check (ISO UTC + which feed answered).
