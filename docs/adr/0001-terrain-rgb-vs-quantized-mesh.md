# ADR 0001 — Terrain-RGB tiles vs quantized-mesh terrain

## Context

The renderer needs elevation at interactive frame rates over a
two-degree Gulf shelf window, at zooms that go from “the whole AOI”
to “a small channel.” Two industry formats do that job:

- **Terrain-RGB** (here: Mapbox / `rio-rgbify -b -10000 -i 0.1`
  packing in a PNG slippy map). Height is a colour. Any XYZ tile
  server can store it. A vertex shader decodes it.
- **Quantized-mesh** (Cesium ion / `quantized-mesh-1.0`). A
  per-tile triangle mesh with skirt geometry, horizon culling
  metadata, and a compact vertex buffer. It is what a globe engine
  wants.

We also have to air-gap the result, inspect it with ordinary tools,
and keep the CPU off the heightfield. The first increment is a
planar Web Mercator viewer, not a WGS84 globe.

## Options

### A — Terrain-RGB PNG pyramid

Encode metres into RGB, cut an XYZ pyramid (`gdal2tiles.py --xyz`
or `cmd/tiler synth`), fetch `{z}/{x}/{y}.png`, decode in GLSL.

- 0.1 m over −10 000 … +6 777 m. Matches the AOI and the Sigsbee
  Deep.
- One shared `PlaneGeometry`; swap a texture.
- Files are PNGs. `file`, a browser, and a cache all understand
  them. Integrity is “this path, this image.”
- No second toolchain. GDAL and `rio-rgbify` already emit this.
- Hillshade and contours become texel-neighbour math in the
  fragment shader, not a second derivative raster.

Costs: no precomputed mesh simplification; a 129×129 grid is a
fixed tessellation regardless of terrain roughness. Planar only
unless we later drape the same tiles on an ellipsoid. Quantisation
is 0.1 m (acceptable).

### B — Quantized-mesh

Run a mesh pipeline (Cesium ion, `ctb-tile`, or a homegrown
encoder) and serve `.terrain` blobs.

- Adaptive triangles. Better for a globe and for steep relief.
- Native Cesium path; “we ship quantized-mesh” is a known phrase
  in C2 / TAK-adjacent shops.
- Skirts hide LOD cracks.

Costs: a format you cannot open in Preview. A custom server or
Cesium ion (ion is a network dependency and a vendor). The
air-gap unit becomes “mesh tiles + Cesium assets + ion-free
endpoint,” which we would have to own. Shader hillshade on a
pre-built mesh is a different problem than sampling a height
texture. For a first increment it is a second product.

### C — Raw float / COG in the browser

`geotiff.js` over HTTP range requests against a NOAA COG.

Useful as a later demo of cloud-optimized access. Not an air-gap
story (it *is* the network), and not a LOD story we control. Rejected
as the primary format.

## Decision

**Terrain-RGB PNG tiles, decoded on the GPU.** Packing:

```
elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
```

implemented in `internal/terrain` and in the vertex/fragment
shaders. Quantized-mesh is deferred with the Cesium stretch
(ADR 0003). The two are not mutually exclusive later; they are
mutually exclusive as the *first* format.

## Consequences

- Serve is a file server with integer paths. That is a smaller
  threat surface than a mesh transcode endpoint.
- The CPU never allocates a heightfield for drawing. Hover depth
  samples the resident texture or `/api/depth`.
- We inherit slippy-map conventions (Web Mercator, 256 px, z/x/y).
  Distortion at 28–30°N is accepted.
- A reviewer who decodes with the Mapzen Terrarium formula will
  get the wrong depths. Document the packing everywhere, including
  the about panel.
- A future Cesium port will either drape these PNGs as a custom
  terrain provider or regenerate quantized-mesh from the same
  GeoTIFF. The source raster stays the source of truth; the PNG
  pyramid is a derived cache.
- Fixed 129×129 tessellation will look coarse on a canyon wall at
  high exaggeration. That is a known visual limit, not a surprise.
