# Map time axis — design

Status: approved 2026-09-03. First slice of a larger weather effort
(radar, clouds, rain, 7-day forecast); those are separate specs and are
**not** in scope here.

## Problem

Every layer on the chart carries a time, and none of them say so. The
HYCOM stack already spans `-3h..+24h` and `interpolateGrid` already
interpolates between steps, but `main.ts` only ever asks for
`Date.now()` — so twenty-four hours of fetched forecast is unreachable.
Buoys and aircraft are observations at an instant and are drawn as if
they were simply "current". There is no way to look at the chart at a
time other than this one.

The weather layers that follow make this worse, not better: radar covers
the past two hours, an NWS forecast reaches seven days out, and neither
window matches HYCOM's. Each layer inventing its own animation control
would leave four clocks on one chart.

So: one time axis, owned in one place, that every layer registers its
coverage with and reads its display time from.

## Non-goals

No new data source. No radar, clouds, rain, or forecast panel. No Go
changes — the server, the refreshers, and `data/ocean/` are untouched.
No URL/deep-link state (additive later, and cheap once the axis exists).

## Decisions

**Layers drop out where they have no data.** Scrub past the end of a
layer's coverage and it stops drawing; its legend row is struck through
and names the boundary. The alternative — holding the last frame,
dimmed — would put a two-hour-old radar echo under a caption that says
now, which is the class of claim this repo's README exists to avoid.
`interpolateGrid` already refuses to blend a null rather than invent a
velocity; this is the same rule at layer scale.

**One axis, spanning past and future.** A single track from the earliest
loaded frame to the latest, with a `NOW` tick on it. Play sweeps left to
right and loops. `LIVE` re-pins the head to the wall clock and
auto-advances as fresh data lands — today's behaviour, made explicit and
escapable rather than assumed.

**Observations register as instants, not zero-width spans.** A wall-clock
float never compares equal to an observation timestamp, so a zero-width
span would blink buoys out on almost every frame. An instant carries a
`staleAfterMs` — the observation's own nominal validity, ~60 min for
NDBC and ~60 s for ADS-B — and is covered while `|head − t0| ≤
staleAfterMs`. This is not "hold the last value": the window is the
datum's own declared freshness, and outside it the layer drops out like
any other.

## Components

### `web/src/time/axis.ts` — the state machine

Pure. No DOM, no three.js, and no `Date.now()` inside it: the clock is
an argument, the way `interpolateGrid(stack, tMs)` already takes one.
That is what makes it testable without fake timers.

```
State    { headMs, live, playing, rateX, coverage[] }
Coverage { id, label, kind: 'span' | 'instant', t0, t1, staleAfterMs? }
```

- `extent(coverage)` — union of every registered window; `null` when
  nothing has loaded, which is how the bar knows to stay hidden.
- `covers(coverage, id, tMs)` — the drop-out predicate.
- `clampHead(state, tMs)` — the head never leaves the extent.
- `advance(state, dtMs)` — `live` re-pins to the clock and ignores
  `dtMs`; `playing` steps by `dtMs * rateX` and loops at `t1`.
- `snapLive(state, nowMs)`, `scrubTo(state, tMs)` (clears `live` and
  `playing`), `register`/`unregister`.

### `web/src/ui/timeline.ts` — the bar

Bottom chrome. One track over the extent, a `NOW` tick at the wall
clock, and a thin coverage row per layer beneath it, so a gap is visible
before you scrub into it. Head readout uses the existing `formatValidZ`.
`[▶]` play/pause and `[◉ LIVE]`, lit when live and dimmed when scrubbed.
Pointerdown on the track scrubs. `role="slider"` with `aria-valuetext`
carrying the timestamp; arrow/space/`L` keys bound **on the bar element
only** — `MapControls.listenToKeyEvents(canvas)` owns the arrows when
the canvas has focus, and the two must not fight.

### Wiring in `main.ts`

The `CURSOR_MS` / `lastCursor` / `Date.now()` block in the render loop
is deleted and replaced by an axis subscription; currents then call
`interpolateGrid(currentsStack, head)`. Currents register a `span` from
`times[0]..times[last]`, re-registering on each ETag refresh. Buoys and
aircraft register an `instant` at their snapshot `validTime`. Drop-out
calls the `setEnabled(false)` that every overlay handle already exposes,
so no handle API changes.

## Testing

`web/src/time/axis.test.ts`, added to the explicit file list in
`package.json`. Extent union over disjoint spans; `null` extent when
empty; head clamped into extent; `advance` loops at `t1`; `live`
re-pins and ignores `dtMs`; scrub clears `live`; instant covered inside
`staleAfterMs` and dropped outside it; `covers()` false for an
unregistered id. All pure — no fake timers, no DOM.
