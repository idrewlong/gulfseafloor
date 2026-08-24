# ADR 0002 — Go tile server vs static tiles only

## Context

After a pyramid exists on disk, something has to give the browser
`/tiles/{z}/{x}/{y}.png` and a page that loads the renderer. Two
honest options:

- **Static files.** `python -m http.server`, nginx, or a CDN in
  front of a directory. No application process.
- **An application server** that serves those files, embeds the UI,
  and leaves room for `/api/depth`, `/api/manifest`, soundings, and
  later on-the-fly encode.

The deployment constraint is a single artefact that still runs with
the network unplugged, including on a cluster that will not pull
from a CDN.

## Options

### A — Static tree only

`data/tiles` plus `web/dist` on any file server.

- Minimum moving parts. Fine for a laptop demo of shaders.
- No `/api/depth` without either shipping a giant JSON or doing
  all sampling in the client from textures that may not be loaded.
- No place to put `singleflight`, ETag policy we own, or a
  manifest that says “these tiles are synthetic.”
- Air-gap becomes “copy a directory tree and remember the right
  server flags.” Two artefacts, no embed, easy to desync UI and
  tiles.
- On-the-fly generation is impossible without adding a server
  later — at which point we will wish we had started with one.

### B — Go server, pregenerated tiles now, on-the-fly later

One `gulf-viewer` binary. `//go:embed` the Vite bundle. Tiles from
`GULF_TILE_DIR`. Routes for tiles, health, manifest, depth; stubs
or 501 for soundings until Phase 4.

- One file to copy. `CGO_ENABLED=0`. Matches the Chainguard static
  base (no libc needed).
- Cache headers and path-traversal rules live in code we test.
- On-the-fly encode can be added behind a worker pool without
  changing the URL contract.
- We already write Go in this repo (`cmd/tiler`, `internal/terrain`,
  `internal/tiles`). The server is the same module.

Costs: we own an HTTP server. That is a small surface if we do not
invent a framework.

### C — Pregenerated tiles behind nginx, API in a second process

Split static and API.

- Classic, and an extra container, an extra probe, an extra way
  to get CORS wrong.
- Air-gap package grows a second image for no gain in this
  increment.

Rejected.

### D — On-the-fly only, no pyramid

Decode source rasters per request.

- Rejected as the *primary* path. GDAL in the request path puts
  the CVE surface on the public process (see
  [`threat-model.md`](../threat-model.md)). Latency is worse. A
  disconnected laptop would still need the source GeoTIFF, which
  is larger and more sensitive to get wrong than a PNG pyramid.

On-the-fly remains an *optional* fill for cache misses after the
pyramid exists, in a bounded pool, never as the only mode.

## Decision

**A Go tile server that serves pregenerated XYZ tiles and embeds
the UI.** On-the-fly generation is a later, optional optimisation
behind a worker pool and `singleflight`, not the architecture.
Static-only hosting is allowed as a developer shortcut; it is not
the delivered system.

## Consequences

- `make server` produces `./gulf-viewer`. `make run` is tiles +
  web + that binary.
- The serve image does not contain GDAL. Adding on-the-fly for
  *arbitrary* GeoTIFF input would break that rule; on-the-fly, if
  it lands, operates on an already-trusted, already-reprojected
  raster we staged, or on a subset we generated ourselves.
- `GULF_WEB_DIR` overrides embed for shader work. Production uses
  embed so UI and server versions cannot drift.
- Path traversal tests are part of the server definition of done,
  not a hardening pass after the first demo.
- Interview line: “one static binary, cable unplugged, browser on
  `:8080`.” That line is true only after Phase 3 lands and you
  have actually unplugged the cable. It is the target of this
  decision, not a claim about yesterday.
