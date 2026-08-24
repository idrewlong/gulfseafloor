# ADR 0003 — three.js vs Cesium

## Context

The visible product is a heightfield the operator can exaggerate,
recolour, and contour. Defense geospatial groups often standardise
on Cesium. WebGL shops often standardise on three.js. We have to
pick one for the first renderer and write down why the other is
not gone.

Constraints that matter here:

- Full control of the height decode and the hillshade (the
  interesting code is GLSL, not a globe widget).
- A planar Web Mercator AOI of two degrees, not a planet.
- A static bundle we can embed in a Go binary. No ion, no
  external asset CDN.
- A later stretch that *is* “the same data on a WGS84 ellipsoid,”
  because that sentence is what a C2 / TAK-adjacent interviewer
  is listening for.

## Options

### A — three.js (WebGL2), custom shaders

A scene, a camera, one shared `PlaneGeometry`, our
`terrain.vert.glsl` / `terrain.frag.glsl`, a quadtree we own.

- The decode, exaggeration, hypsometric LUT, hillshade, and
  `fwidth` contours are ours. That is the demonstration.
- Vite emits a directory that `//go:embed` can swallow. No Cesium
  ion token, no `Assets/Textures` tree from a CDN.
- Bundle size stays in the range of a single-page tool, not a
  globe engine.
- deck.gl (Phase 4 soundings) composes with a three.js /
  luma.gl stack more naturally than with a full Cesium scene.

Costs: we write LOD, crack/skirt policy (or accept seams), and
controls. We are on a plane; we do not get ellipsoid math,
horizon culling, or 3D Tiles for free. “I have shipped Cesium”
is not a sentence this option earns.

### B — CesiumJS as the first renderer

`Cesium.TerrainProvider` (custom or quantized-mesh) on a WGS84
globe, our tiles or a mesh derivative as the source.

- Instant globe, world-class LOD, a résumé phrase that matches
  job ads.
- Quantized-mesh or Cesium World Terrain conventions; operators
  who already run TAK-adjacent tooling recognise the camera.

Costs: the interesting GLSL is behind an engine. Air-gap means
vendoring Cesium's assets and proving we do not call ion at
runtime — doable, and easy to get subtly wrong (a default
ion token, an imagery fallback). Embed size is larger. A
two-degree shelf on a globe spends most of the demo convincing
the camera it is not looking at the planet. Hillshade-from-
texel-neighbours fights Cesium's own lighting unless we drop to
a custom primitive, at which point we have written three.js
inside Cesium.

### C — Both, with a flag, in the first increment

Rejected. Two cameras, two LOD systems, two air-gap asset lists.
The comparison belongs in this ADR and in a later branch, not
in `main` on week three.

## Decision

**three.js r160+ / WebGL2 for the current increment.** Cesium is
a documented stretch: same terrain-RGB (or a quantized-mesh
derivative of the same GeoTIFF), true ellipsoid, kept as a
second renderer rather than a rewrite. We do not pretend the
planar viewer is a globe.

## Consequences

- Phase 2 work is `web/src/terrain/*` and two shader files. The
  quadtree is our code; bugs there are ours.
- Vertical exaggeration as a live morph is a uniform change, not
  a Cesium terrain-exaggeration setting we only half control.
- Distortion and “flat earth over the Bight” are known limits
  (README). Do not demo this as a navigation globe.
- A Cesium port later is an ADR-backed stretch, not an admission
  that three.js was a mistake. The data contract (`{z}/{x}/{y}`
  PNG, Terrarium/terrain-RGB packing) stays. The engine changes.
- Job-ad coverage: the repo can eventually say both “custom
  WebGL terrain” and “I have shipped Cesium,” if the stretch is
  built. Today it can only say the first, and only after Phase 2
  lands.
