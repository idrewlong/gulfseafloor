# Gulf Seafloor Viewer — Build Spec

A GPU-accelerated bathymetric terrain viewer built on public NOAA data, deployed with a
DoD-style hardened, air-gap-capable delivery chassis.

**Target audience for this artifact:** hiring managers and technical leads at Stennis Space
Center tenants (NAVOCEANO, NRL Ocean Sciences, NOAA) and at Eglin/Fort Walton Beach defense
software shops.

---

## 1. Why this project

Most web developers applying into defense geospatial roles have never touched scientific data
formats, never rendered a heightfield on the GPU, and never thought about disconnected
deployment. This project attacks all three at once, using a dataset that is literally offshore
of the target employer.

### What it demonstrates, mapped to real job requirements

| Capability | Where it shows up in the build | Job req it answers |
|---|---|---|
| Scientific data formats | NetCDF, HDF5, GeoTIFF/COG, S-102 parsing | "Experience with netCDF/HDF5 scientific data" |
| Geospatial processing | GDAL pipeline, reprojection, tiling, DEM derivatives | "GIS / geospatial data processing" |
| GPU / visualization | Custom GLSL shaders, terrain-RGB decode, LOD | "Data visualization", "WebGL/Cesium" |
| Cloud-native ingest | S3, SNS→SQS event-driven pipeline, IaC | AWS SAA material, "cloud engineering" |
| Systems programming | Go tile server, concurrent tile generation | "Go/Python backend services" |
| DevSecOps | Hardened images, SBOM, signing, policy-as-code | "DevSecOps", "STIG", "RMF/ATO support" |
| Disconnected operations | Zarf air-gap bundle, zero external dependencies | The unspoken requirement nobody advertises |

### Non-goals

This is a data and infrastructure demonstration. It is deliberately **not**:

- A weapons effects, guidance, seeker, or radar cross-section model
- A classified or CUI data handler
- A commercial product (NOAA data attribution rules apply; see §11)

---

## 2. Export control and data boundary

**Hard rule: every byte in this repo comes from a source that is publicly downloadable with no
login, no EULA acceptance, and no `.mil` address.**

| Allowed | Not allowed |
|---|---|
| NOAA NODD S3 buckets (open, unauthenticated) | Anything behind a CAC/PKI wall |
| GEBCO global grid | DTED Level 2 and above |
| USGS 3DEP lidar | NGA restricted/limited-distribution products |
| SRTM / Copernicus DEM | Navy survey multibeam over operational areas |
| DTED Level 0/1 | Any dataset requiring a distribution statement |

If a dataset requires you to click "I agree" or authenticate, it does not go in this repo.
Do not route around a gate. Write the boundary into the README explicitly — stating that you
understand where the line is, is itself a signal.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  PUBLIC DATA (AWS, us-east-1, --no-sign-request)                    │
│                                                                     │
│  s3://noaa-ocs-nationalbathymetry-pds    National Bathymetric Source│
│  s3://noaa-dcdb-bathymetry-pds           Crowdsourced soundings CSV │
│  s3://noaa-s102-pds                      S-102 (HDF5) surfaces      │
│  s3://noaa-ocs-hydrodata                 Raw hydrographic surveys   │
│  s3://noaa-nos-scuba-icesat2-pds         Satellite-derived bathy    │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
                   │  SNS new-object topic  ──►  SQS  ──►  ingest worker
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  INGEST (Go + GDAL, containerized)                                  │
│    fetch → validate → reproject (EPSG:3857) → terrain-RGB encode    │
│    → tile pyramid → write to object store + manifest                │
└──────────────────┬──────────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SERVE (Go)                                                         │
│    /tiles/{z}/{x}/{y}.png    terrain-RGB elevation tiles            │
│    /soundings/{z}/{x}/{y}    binary point batches                   │
│    /api/depth?lat&lon        point query                            │
│    /api/manifest             available regions, extents, stats      │
│    embedded static assets (single binary, no CDN)                   │
└──────────────────┬──────────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  RENDER (three.js / WebGL2)                                         │
│    tile-quadtree LOD  →  vertex shader height displacement          │
│    fragment shader: hypsometric LUT + hillshade + contours          │
│    controls: exaggeration, depth range, contour interval, layers    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Ingest / server | **Go 1.22+** | You already publish Go tools; single static binary is ideal for air-gap |
| Geo processing | **GDAL 3.8+** (CLI + Python bindings) | The universal tool; every geospatial shop uses it |
| Scientific formats | **h5py**, **netCDF4**, **rasterio** | For S-102 and HYCOM work |
| Renderer | **three.js r160+** (WebGL2) | Full shader control |
| Point cloud | **deck.gl** | GPU instancing for millions of soundings |
| Build | **Vite** + TypeScript | Fast, and produces a static bundle for embedding |
| Container | **Chainguard/Iron Bank base** | Not `node:latest` |
| IaC | **Terraform** | GovCloud-compatible patterns |
| Packaging | **Zarf** | The DoD air-gap standard |

---

## 5. Repository structure

```
gulf-seafloor-viewer/
├── README.md                  # System design doc — see §10
├── docs/
│   ├── architecture.md
│   ├── data-sources.md        # provenance, licenses, attribution
│   ├── threat-model.md
│   ├── deployment.md          # incl. air-gap procedure
│   └── adr/                   # architecture decision records
│       ├── 0001-terrain-rgb-vs-quantized-mesh.md
│       ├── 0002-go-tile-server-vs-static-tiles.md
│       └── 0003-three-js-vs-cesium.md
├── cmd/
│   ├── tiler/                 # CLI: source raster → tile pyramid
│   ├── ingest/                # SQS consumer
│   └── server/                # tile + API server
├── internal/
│   ├── terrain/               # terrain-RGB encode/decode
│   ├── s102/                  # S-102 HDF5 reader
│   ├── tiles/                 # slippy-map math, pyramid mgmt
│   └── soundings/             # CSV → spatial index → binary batches
├── web/
│   ├── src/
│   │   ├── main.ts
│   │   ├── terrain/
│   │   │   ├── TerrainTile.ts
│   │   │   ├── QuadtreeLOD.ts
│   │   │   └── shaders/
│   │   │       ├── terrain.vert.glsl
│   │   │       └── terrain.frag.glsl
│   │   ├── layers/soundings.ts
│   │   └── ui/
│   └── vite.config.ts
├── deploy/
│   ├── Dockerfile
│   ├── k8s/                   # hardened manifests
│   ├── policy/                # OPA/Rego
│   ├── terraform/
│   └── zarf.yaml
├── scripts/
│   ├── fetch-source-data.sh
│   └── build-tiles.sh
└── .github/workflows/
    └── ci.yml                 # test → SBOM → scan → sign → publish
```

---

## 6. Build phases

### Phase 0 — Environment (½ day)

```bash
# GDAL
sudo apt install gdal-bin python3-gdal libgdal-dev
gdalinfo --version   # need 3.8+

# Python side
pip install rasterio rio-rgbify h5py netCDF4 numpy

# Verify unauthenticated S3 access — no AWS account needed
aws s3 ls --no-sign-request s3://noaa-ocs-nationalbathymetry-pds/
aws s3 ls --no-sign-request s3://noaa-dcdb-bathymetry-pds/csb/csv/
```

**Exit criteria:** you can list all five buckets and `gdalinfo` a downloaded raster.

---

### Phase 1 — Data acquisition and tiling (2–3 days)

Start with one region: the Mississippi Bight / Gulf shelf south of Long Beach, roughly
`-90.0, 28.5, -88.0, 30.4` (WGS84).

```bash
# 1. Pull a National Bathymetric Source tile covering the AOI
aws s3 cp --no-sign-request \
  s3://noaa-ocs-nationalbathymetry-pds/<path-to-tile>.tiff ./data/raw/

# 2. Inspect: CRS, nodata, band stats, overviews
gdalinfo -stats ./data/raw/source.tiff

# 3. Reproject to Web Mercator, fill nodata, clamp to AOI
gdalwarp -t_srs EPSG:3857 \
         -te_srs EPSG:4326 -te -90.0 28.5 -88.0 30.4 \
         -r cubic -dstnodata -9999 \
         ./data/raw/source.tiff ./data/work/aoi_3857.tiff

# 4. Encode elevation into RGB (Terrarium scheme)
rio rgbify -b -10000 -i 0.1 \
  ./data/work/aoi_3857.tiff ./data/work/terrain_rgb.tiff

# 5. Generate the tile pyramid
gdal2tiles.py --xyz -z 6-13 --processes=8 \
  ./data/work/terrain_rgb.tiff ./data/tiles/
```

**Terrarium encoding** — the value packed into each pixel:

```
elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
```

This gives 0.1 m resolution across a −10,000 m to +6,777 m range, which comfortably covers
the Sigsbee Deep and every coastal elevation you care about.

**Exit criteria:** a directory of PNG tiles, and a Python script that decodes a known pixel
back to a depth you can verify against `gdallocationinfo`.

---

### Phase 2 — The renderer (1 week)

This is the centerpiece. Keep geometry cheap; do the work on the GPU.

**Vertex shader** (`terrain.vert.glsl`):

```glsl
precision highp float;

uniform sampler2D uHeightTex;
uniform float uExaggeration;
uniform float uTileSpanMeters;

varying vec2  vUv;
varying float vElevation;

float decodeTerrarium(vec3 rgb) {
  return -10000.0 + ((rgb.r * 255.0 * 65536.0
                    + rgb.g * 255.0 * 256.0
                    + rgb.b * 255.0) * 0.1);
}

void main() {
  vUv = uv;
  float elev = decodeTerrarium(texture2D(uHeightTex, uv).rgb);
  vElevation = elev;

  vec3 pos = position;
  pos.z = (elev / uTileSpanMeters) * uExaggeration;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
```

**Fragment shader** (`terrain.frag.glsl`) — hypsometric color, shader-computed hillshade,
and contour lines:

```glsl
precision highp float;

uniform sampler2D uHeightTex;
uniform sampler2D uColorLUT;      // 1D hypsometric ramp
uniform vec2  uTexelSize;
uniform vec3  uSunDir;
uniform float uContourInterval;   // metres, 0 = off
uniform float uDepthMin;
uniform float uDepthMax;

varying vec2  vUv;
varying float vElevation;

float decodeTerrarium(vec3 rgb) {
  return -10000.0 + ((rgb.r * 255.0 * 65536.0
                    + rgb.g * 255.0 * 256.0
                    + rgb.b * 255.0) * 0.1);
}

float sampleElev(vec2 uv) {
  return decodeTerrarium(texture2D(uHeightTex, uv).rgb);
}

void main() {
  // Hypsometric tint, normalised across the visible depth window
  float t = clamp((vElevation - uDepthMin) / (uDepthMax - uDepthMin), 0.0, 1.0);
  vec3 base = texture2D(uColorLUT, vec2(t, 0.5)).rgb;

  // Hillshade from finite differences on neighbouring texels
  float l = sampleElev(vUv - vec2(uTexelSize.x, 0.0));
  float r = sampleElev(vUv + vec2(uTexelSize.x, 0.0));
  float d = sampleElev(vUv - vec2(0.0, uTexelSize.y));
  float u = sampleElev(vUv + vec2(0.0, uTexelSize.y));
  vec3 normal = normalize(vec3(l - r, d - u, 2.0));
  float shade = clamp(dot(normal, normalize(uSunDir)), 0.0, 1.0);
  vec3 color = base * (0.55 + 0.45 * shade);

  // Contour lines: screen-space-consistent width via derivatives
  if (uContourInterval > 0.0) {
    float f  = vElevation / uContourInterval;
    float df = fwidth(f);
    float line = 1.0 - smoothstep(0.0, df * 1.5, abs(fract(f) - 0.5) - 0.5 + df);
    color = mix(color, vec3(0.05, 0.08, 0.10), line * 0.7);
  }

  gl_FragColor = vec4(color, 1.0);
}
```

**Quadtree LOD.** Do not load every tile. Maintain a quadtree keyed by slippy-map
`{z}/{x}/{y}`; subdivide a node when its projected screen-space error exceeds a threshold
(start with 2 px), collapse when it drops below. Reuse a shared `PlaneGeometry` (129×129
segments is a good default) across all tiles and swap only the height texture — this keeps
geometry allocation at exactly one buffer.

**Controls to expose:**

- Vertical exaggeration slider, 1×–50×, default 15× (at true scale the shelf is a flat sheet)
- Depth window (min/max) driving the color ramp normalisation
- Contour interval: off / 10 m / 50 m / 100 m
- Sun azimuth + altitude for hillshade
- Depth readout on hover, sampled from the height texture on the CPU side

**Exit criteria:** smooth 60 fps navigation over the AOI, correct depths on hover, contours
that hold constant screen width at all zoom levels.

---

### Phase 3 — Go tile server (3–4 days)

```go
// cmd/server/main.go — sketch
package main

import (
    "embed"
    "net/http"
)

//go:embed all:web/dist
var webAssets embed.FS   // single binary, no CDN, air-gap friendly

func main() {
    mux := http.NewServeMux()
    mux.Handle("/tiles/", cacheControl(tileHandler(store)))
    mux.Handle("/soundings/", soundingsHandler(index))
    mux.HandleFunc("/api/depth", depthQueryHandler(store))
    mux.HandleFunc("/api/manifest", manifestHandler(store))
    mux.Handle("/", spaHandler(webAssets))

    http.ListenAndServe(":8080", securityHeaders(mux))
}
```

Points to get right, because they are the ones an interviewer will poke at:

- `embed.FS` for the frontend — one binary, zero runtime dependencies
- Aggressive `Cache-Control` and `ETag` on tiles (they are immutable)
- A bounded worker pool for on-the-fly tile generation, with singleflight to collapse
  duplicate concurrent requests for the same tile
- Graceful shutdown, structured logging, `/healthz` and `/readyz`
- No wildcard CORS

**Exit criteria:** `./gulf-viewer` with no arguments serves the full app on `:8080` on a
machine with the network cable unplugged.

---

### Phase 4 — Sounding point cloud (3–4 days)

The crowdsourced bathymetry bucket ships plain CSV with a stable header:

```
UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER
```

```bash
aws s3 cp --recursive --no-sign-request \
  s3://noaa-dcdb-bathymetry-pds/csb/csv/2024/06/ ./data/soundings/
```

Pipeline: CSV → spatial bin by tile → pack to a compact binary format (float32 lon/lat/depth
plus a uint16 platform id) → serve per-tile batches → render with deck.gl `PointCloudLayer`,
colored by depth, filtered GPU-side by platform and date range.

This is where you demonstrate volume handling. Target several million points at interactive
frame rates. Do not curate a small sample — the point is that it doesn't fall over.

**Exit criteria:** ≥2M soundings rendered, filters responding in under one frame.

---

### Phase 5 — S-102 reader (3–4 days)

**This is the highest-signal, lowest-glamour piece of the whole project.** S-102 is the IHO
standard for bathymetric surfaces — HDF5 underneath — and it is what hydrographic offices and
naval oceanography actually exchange gridded bathymetry in. Very few developers have parsed it.

```bash
aws s3 ls --no-sign-request s3://noaa-s102-pds/
```

Bucket keys encode the S-102 edition and geographic region; `US00` is the IHO producer code for
the U.S. Office of Coast Survey. Write a reader that:

1. Opens the HDF5 container and walks the `BathymetryCoverage` group hierarchy
2. Reads the georeferencing attributes (origin, spacing, CRS)
3. Extracts the depth and uncertainty arrays
4. Emits a GeoTIFF that drops straight into the Phase 1 pipeline

Do it in Python first with `h5py` to understand the structure, then port to Go using
`gonum.org/v1/hdf5` or a cgo binding. Having a Go S-102 reader on GitHub is a genuinely rare
artifact.

**Exit criteria:** `s102 convert input.h5 output.tif` produces a raster that renders correctly
and whose depths match the source arrays.

---

### Phase 6 — Event-driven ingest (3–4 days)

Each NODD bucket publishes an SNS topic on new-object events. Subscribe SQS to it and you have
a live pipeline against real government data feeds.

```
SNS (NewNationalBathymetryObject / NewDCDBBathymetryObject)
  → SQS (with DLQ)
    → ingest worker (Go, containerized)
      → GDAL transform → tile pyramid → object store → manifest update
```

Terraform this. Include: SQS with a dead-letter queue and redrive policy, least-privilege IAM,
KMS encryption at rest, CloudWatch alarms on DLQ depth, and an autoscaling policy driven by
queue depth.

**Exit criteria:** a new object lands in the bucket and tiles appear without human action;
a poisoned message lands in the DLQ and fires an alarm.

---

### Phase 7 — The DevSecOps chassis (1 week)

This phase matters more to your hiring outcome than everything above it.

**Container:**

```dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM cgr.dev/chainguard/static:latest
COPY --from=build /out/server /server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
```

Note what's absent: no shell, no package manager, no root, no `latest` on a distro base.

**Pipeline** (`.github/workflows/ci.yml`):

```yaml
- name: Generate SBOM
  run: syft . -o spdx-json=sbom.spdx.json

- name: Vulnerability scan
  run: grype sbom:sbom.spdx.json --fail-on high

- name: Build and push
  run: docker buildx build --push -t $IMAGE .

- name: Sign image
  run: cosign sign --yes $IMAGE

- name: Attach SBOM attestation
  run: cosign attest --yes --predicate sbom.spdx.json --type spdxjson $IMAGE
```

**Kubernetes hardening** — every manifest sets:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
```

**Policy as code** — OPA/Gatekeeper constraints that *reject* any workload missing the above.
Write the policy, then write a test that proves a non-compliant manifest is denied. The test is
the part people skip and the part that proves you mean it.

**Air-gap packaging** — a `zarf.yaml` that bundles the image, manifests, and a seed tile set
into a single tarball installable on a disconnected cluster:

```bash
zarf package create .
# transfer the .tar.zst by whatever means
zarf package deploy zarf-package-gulf-viewer-amd64.tar.zst
```

**Exit criteria:** the whole system installs and runs on a cluster with no internet route.

---

## 8. Visual design direction

Do not reach for the default dark-mode-with-neon-accent dashboard look. Ground the interface
in the vernacular of the subject: the nautical chart.

- **Palette** — derive from NOAA ENC chart conventions rather than inventing one:
  deep water `#0B2A3D`, shoal water `#1E6B8C`, drying heights `#7FA8B8`, land buff `#E8DCC4`,
  chart line black `#1A1A1A`, magenta `#C0006E` reserved for warnings and out-of-bounds data.
  Magenta is the one accent; it means the same thing on a real chart, so it carries meaning
  rather than decoration.
- **Typography** — a condensed grotesque for the UI chrome and depth labels. Chart soundings
  have been set in condensed numerals for a century; the type does real work here.
- **Structural device** — the depth scale itself. A vertical hypsometric legend pinned to one
  edge, doubling as the depth-window control. The reader learns the color mapping by using it.
- **Signature element** — the exaggeration slider driving a live morph from flat chart to
  sculpted relief. It is the single moment that explains what the tool is for.
- **Restraint** — no animated backgrounds, no glassmorphism, no gradient overlays on the
  terrain. The terrain is the content. Everything else stays quiet.
- **Floor** — keyboard-navigable controls, visible focus rings, `prefers-reduced-motion`
  respected, readable at 1280×720 on a locked-down government workstation.

---

## 9. Stretch goals

**Ocean current particle advection (three.js + GPGPU).** The visual showstopper. Pull HYCOM
surface velocity fields, store particle positions in a floating-point texture, advect each
particle by sampling the velocity field in a fragment shader, ping-pong between two render
targets, draw fading trails. Genuinely hard, looks extraordinary, and is exactly the kind of
display a naval oceanography product wants. Build this if you build only one stretch item.

**Cesium port.** Same data, rendered on a true WGS84 ellipsoid with quantized-mesh terrain.
Cesium is pervasive in defense C2 and TAK-adjacent tooling — "I have shipped Cesium" is a
phrase that lands. Keep both and write an ADR comparing them.

**COG direct-read demo.** A branch where `geotiff.js` reads a multi-gigabyte COG straight from
the NOAA bucket over HTTP range requests, no server at all. Open the network tab during a demo
and show 200 KB transferred for a 4 GB file. It makes "cloud-optimized" legible in ten seconds.

**Satellite-derived bathymetry comparison.** Diff the ICESat-2 SCuBA product against the
National Bathymetric Source over the same AOI and render the residual. This is an active
research question, and NGA is a partner on that dataset.

---

## 10. Documentation

Write the README as a system design document, not a getting-started guide. In this industry,
documentation quality reads as engineering maturity in a way that a polished UI does not.

Required sections:

1. **Problem statement** — one paragraph, no marketing
2. **Data provenance** — every source, its license, its attribution requirement, its retrieval date
3. **Architecture** — the diagram from §3, plus the reasoning
4. **Deployment** — including the air-gap procedure, tested and written from an actual run
5. **Threat model** — STRIDE over the ingest path. What happens if a source bucket serves a
   malicious raster? (GDAL has had CVEs. Say so, and say what you did about it.)
6. **Scope boundary** — the export-control statement from §2, in your own words
7. **Known limitations** — be specific. Vagueness here reads as not knowing.

Keep ADRs for the three real decisions: terrain-RGB vs quantized-mesh, on-the-fly vs
pre-generated tiles, three.js vs Cesium. Each: context, options, decision, consequences.

---

## 11. Attribution

NOAA data disseminated through NODD is open and free to use. NOAA requests attribution for
unaltered data, prohibits stating or implying NOAA endorsement or affiliation, and requires
that modified data not be presented as original unaltered NOAA data. Put a compliant
attribution block in the README, in `docs/data-sources.md`, and in the application's about
panel — getting attribution right is itself a small signal about how you handle compliance
requirements.

---

## 12. Schedule

Assumes evenings and weekends alongside a full-time job.

| Weeks | Phase | Deliverable |
|---|---|---|
| 1 | 0–1 | Tiles generated from real NOAA data, depths verified |
| 2–3 | 2 | Renderer running locally, shaders working |
| 4 | 3 | Single-binary server, offline-capable |
| 5 | 4 | Sounding point cloud at scale |
| 6 | 5 | S-102 reader, Python then Go |
| 7 | 6 | Event-driven ingest, Terraformed |
| 8–9 | 7 | Full DevSecOps chassis, air-gap bundle |
| 10 | 10 | Documentation, ADRs, threat model |
| 11+ | 9 | One stretch goal — recommend particle advection |

Ship Phase 3 publicly and keep building in the open. A repo with visible commit history over
ten weeks tells a better story than one that appears fully formed.

---

## 13. Interview talking points

Prepare a two-minute version of each. These are the hooks:

- "I parsed S-102 — the IHO HDF5 bathymetric surface standard — and wrote a Go reader for it."
- "The ingest is event-driven off NOAA's public SNS topics, so it processes new surveys within
  minutes of publication without polling."
- "I decode elevation in the vertex shader from terrain-RGB tiles, so the CPU never touches
  a heightfield."
- "Every container is distroless and non-root, images are cosign-signed with SBOM attestations,
  and OPA rejects any manifest that doesn't meet the security context baseline."
- "It's Zarf-packaged. I've tested the install on a cluster with no internet route, because
  that's the environment it would actually run in."

That last one is the one they'll remember.

---

## 14. Source index

| Dataset | Access | Notes |
|---|---|---|
| National Bathymetric Source | `s3://noaa-ocs-nationalbathymetry-pds` | Authoritative compiled bathymetry; SNS topic available |
| Crowdsourced Bathymetry (DCDB) | `s3://noaa-dcdb-bathymetry-pds` | CSV, date-partitioned; easiest entry point |
| S-102 Bathymetric Surfaces | `s3://noaa-s102-pds` | HDF5; keys encode edition + region |
| OCS Hydrographic Survey Data | `s3://noaa-ocs-hydrodata` | Raw surveys, qualified and unqualified |
| SCuBA (NOAA/NGA ICESat-2) | `s3://noaa-nos-scuba-icesat2-pds` | Satellite-derived bathymetry |
| GEBCO global grid | gebco.net | Free global coverage, no registration |
| USGS 3DEP lidar | AWS Open Data Registry | Topography side |
| HYCOM | public THREDDS/OPeNDAP | For the particle advection stretch goal |
| NDBC buoys | ndbc.noaa.gov | No API key |
| Argo floats | argo.ucsd.edu | NetCDF profiles |

**Before committing to any NOAA dataset, check the NESDIS Notice of Changes page.** NOAA has
been decommissioning products at an elevated rate since 2025 — including marine, coastal, and
estuary datasets — and several services have retirement dates in 2026. The core bathymetry
products and NODD buckets look healthy, but verify rather than assume, and record the
retrieval date in `docs/data-sources.md`.

All access above is unauthenticated: `aws s3 ls --no-sign-request s3://<bucket>/`