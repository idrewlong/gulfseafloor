# Architecture

Ingest produces a terrain-RGB tile pyramid. Serve hands those tiles and a
small JSON API to a browser. Render decodes elevation on the GPU and
displaces a shared mesh. The three stages share one contract: a PNG at
`/tiles/{z}/{x}/{y}.png` whose RGB triple is metres, not colour.

This increment implements serve + render against synthetic tiles.
Ingest against live NODD objects is Phase 6.

---

## 1. Ingest

```
source raster
  → validate (size, driver, CRS, nodata)
  → gdalwarp to EPSG:3857, clamp to AOI
  → rio rgbify -b -10000 -i 0.1
  → gdal2tiles.py --xyz
  → object store + manifest
```

The AOI is the Mississippi Bight / Gulf shelf south of Long Beach,
WGS84:

```
west, south, east, north = -90.0, 28.5, -88.0, 30.4
```

`internal/tiles.AOI` is that box. `cmd/tiler synth` covers it at z 6–11
with a procedural shelf so the rest of the stack can run with the
network unplugged. The GDAL path (planned `scripts/build-tiles.sh`) is
the same pyramid layout from a real NOAA GeoTIFF:

```
gdalwarp -t_srs EPSG:3857 \
         -te_srs EPSG:4326 -te -90.0 28.5 -88.0 30.4 \
         -r cubic -dstnodata -9999 \
         source.tiff aoi_3857.tiff

rio rgbify -b -10000 -i 0.1 aoi_3857.tiff terrain_rgb.tiff

gdal2tiles.py --xyz -z 6-13 --processes=8 terrain_rgb.tiff data/tiles/
```

Web Mercator is a serve-time convenience, not a claim about the
ellipsoid. The renderer is planar; an ellipsoidal port is the Cesium
stretch (ADR 0003). Cubic resampling is a visual choice for a hillshade
shader that differences neighbouring texels — nearest-neighbour leaves
block edges in the normal field.

Live ingest (Phase 6) is the same transform driven by NODD SNS → SQS
instead of a shell script. The worker is a different image from the
server: it needs GDAL. The server does not.

---

## 2. Terrain-RGB / Terrarium packing

Elevation is a 24-bit unsigned integer stored in an 8-bit PNG:

```
packed     = R * 65536 + G * 256 + B
elevation  = -10000 + packed * 0.1     # metres
```

Range: −10 000.0 m … +6 777.215 m. Quantisation: 0.1 m. That window
covers the Sigsbee Deep (~−3 500 m) and every coastal elevation in the
AOI with margin.

`internal/terrain` implements the pair:

```
Encode(elevationMetres) → (R, G, B)
Decode(R, G, B)         → elevationMetres
```

Values outside the range clamp. Alpha is ignored on decode so a
premultiplied RGBA read cannot collapse a packed height to the nodata
floor.

The build spec calls this “Terrarium.” The numbers are the Mapbox
Terrain-RGB / `rio-rgbify -b -10000 -i 0.1` packing. Mapzen Terrarium
is a different formula:

```
# Mapzen Terrarium — not what we write
elevation = (R * 256 + G + B / 256) - 32768
```

A decoder that assumes Mapzen Terrarium will report garbage depths on
our tiles. The GLSL in the renderer must match `internal/terrain`, not
a blog post about Mapzen.

Why pack height into RGB at all: the GPU already uploads textures; a
`sampler2D` is the native way to get a value to a vertex. A float
heightfield would be a second upload path, a second cache policy, and
a format no ordinary tile proxy understands. A PNG is inspectable with
`file` and `gdalinfo` (after decode) and is immutable under a
`{z}/{x}/{y}` key.

---

## 3. Serve

`cmd/server` (Phase 3) is a static Go binary:

| Route | Body |
|---|---|
| `GET /tiles/{z}/{x}/{y}.png` | terrain-RGB tile |
| `GET /soundings/{z}/{x}/{y}` | binary point batch (Phase 4) |
| `GET /api/depth?lat=&lon=` | point sample |
| `GET /api/manifest` | regions, extents, stats, synthetic flag |
| `GET /healthz`, `GET /readyz` | liveness / readiness |
| `GET /` | embedded SPA |

`cmd/server` embeds `all:assets` as a fallback SPA. Locally, if
`GULF_WEB_DIR` (default `web/dist`) contains `index.html`, that
directory wins so a Vite build does not require a rebuild of the
Go binary. The Docker image copies the real `web/dist` over
`cmd/server/assets` before `go build`, so the air-gap unit is still
one file. At runtime there is no Node, no CDN, and no separate
static host. Copy `gulf-viewer` and a tile directory (or bake the
tiles into the image / Zarf package).

Tiles are immutable. Responses carry a long `Cache-Control` and an
`ETag`. On-the-fly generation, when it exists, is a bounded worker
pool plus `singleflight` so concurrent misses for the same `{z}/{x}/{y}`
collapse to one encode. The current increment serves pregenerated files
only (ADR 0002).

`{z}`, `{x}`, `{y}` are parsed as integers. The handler rejects `..`,
extra path segments, and any join that would escape `GULF_TILE_DIR`.
See [`threat-model.md`](threat-model.md).

### Why embed

A disconnected machine should not need `npm`, a volume of JS files with
the right layout, or a second process. The production image embeds the
UI so version cannot drift from the server. `GULF_WEB_DIR` is the local
path (`web/dist` after `make web`) and is also how a developer iterates
shaders without rebuilding Go.

### Why no wildcard CORS

The SPA and the tile routes share an origin. CORS is unnecessary for
the primary deployment. `Access-Control-Allow-Origin: *` would advertise
the API to every browser origin that can reach the host — including a
page on a classified-adjacent workstation that should not be mixing
contexts. If a second origin is required, `GULF_CORS_ORIGIN` is one
explicit origin. There is no list and no `*`. Credentials are not
used; cookies are not part of the API.

---

## 4. Render

three.js r160+, WebGL2. Geometry stays cheap; work stays in shaders.

### Quadtree LOD

Do not load the pyramid. Maintain a quadtree keyed by slippy-map
`{z}/{x}/{y}`. Subdivide a node when its projected screen-space error
exceeds a threshold (start at 2 px). Collapse when the error falls
below. Leaves hold one height texture and a model matrix. Parents
release GPU memory when all children are resident, and the reverse on
collapse.

Covering the AOI at z 11 is a few hundred tiles; at z 13 it is
thousands. The quadtree is what keeps the working set at “what the
screen can distinguish,” not “what exists on disk.”

### Shared 129×129 plane

Every tile reuses one `PlaneGeometry` with 128 segments per edge
(129 vertices). Only the height texture and the per-tile uniforms
change.

129 is 2⁷+1: a power-of-two tessellation plus the closing vertex, which
is the usual DEM convention (a 128×128 quad grid can sample a 256×256
texture at 2:1 without obvious faceting, and edge vertices line up if
we later add skirts). Allocating one `PlaneGeometry` per tile would
duplicate the same vertex buffer hundreds of times and churn on every
LOD split. One buffer, many draw calls, swap `uHeightTex`.

Displacement:

```
pos.z = (elev / uTileSpanMeters) * uExaggeration
```

`uTileSpanMeters` is the east–west ground span at the tile centre
(`internal/tiles.SpanMetres`). Dividing by it keeps vertical
exaggeration scale-free across zoom levels. Default exaggeration is
15×; at 1× the shelf is a sheet.

### Fragment stage

Hypsometric colour from a 1D LUT, normalised to the operator's depth
window. Hillshade from finite differences on neighbouring texels
(same decode as the vertex stage). Contours via `fwidth` so line width
is roughly constant in screen space. Magenta is reserved for
out-of-bounds / nodata, matching ENC convention — it is not a brand
accent.

Hover depth is a CPU-side sample of the resident height texture, not a
GPU readback. `/api/depth` is the fallback when the tile is not on
the GPU.

### What the renderer is not

It is not a globe. Web Mercator is treated as a plane. Distortion at
30°N is acceptable for this AOI and is the cost of staying on a
shared quad and a slippy-map address. A WGS84 ellipsoid with
quantized-mesh terrain is the Cesium stretch, not a toggle.

---

## 5. Process and trust boundaries

```
[public S3 / SNS]     untrusted bytes
        │
        ▼
[ingest image]        GDAL, rootless, no serve ports
        │
        ▼
[tile store]          immutable {z}/{x}/{y}.png + manifest
        │
        ▼
[serve image]         static Go, no GDAL, no egress
        │
        ▼
[browser]             WebGL2, same origin
```

Ingest and serve do not share a container. GDAL's CVE history is
confined to the worker that must parse rasters
([`threat-model.md`](threat-model.md)). The serve image is
`cgr.dev/chainguard/static` (or Iron Bank equivalent): no shell, no
package manager, UID 65532.

---

## 6. Current increment vs later phases

| Stage | Now | Later |
|---|---|---|
| Ingest | `cmd/tiler synth` writes a labelled synthetic pyramid | GDAL script; then SNS→SQS worker |
| Serve | Phase 3 binary present; pregenerated tiles; disk `web/dist` or embed | on-the-fly pool; soundings; depth index |
| Render | three.js planar quadtree present | deck.gl points; optional Cesium port |
| Formats | PNG terrain-RGB only | S-102 → GeoTIFF; DCDB CSV → binary batches |
