# Gulf Seafloor Viewer

A bathymetric terrain viewer for the Mississippi Bight. Elevation is packed into
terrain-RGB PNG tiles, decoded in a WebGL2 vertex shader, and served from a
single static Go binary. The intended delivery chassis is a hardened, air-gap
capable Kubernetes package.

This document is the system design record, not a tutorial. Companion notes live
under [`docs/`](docs/).

**Build status.** This repository is mid-build. The current increment is
Phases 0–3 of the build spec: environment, synthetic tile generation, the
three.js renderer, and the Go tile server. A Phase 7 chassis *skeleton*
exists (`deploy/Dockerfile`, hardened k8s manifests, OPA tests, CI, Zarf
package spec) but has not been installed on a disconnected cluster.
Phases 4–6 (soundings, S-102, live SNS ingest) are specified and not yet
implemented. Interview claims that assume a Go S-102 reader, live SNS
ingest, or a tested Zarf install are not true of this tree today.

---

## 1. Problem statement

Naval oceanography and hydrographic offices already hold compiled bathymetry,
crowdsourced soundings, and IHO S-102 surfaces; what they lack in a typical
web stack is a path from those rasters to an interactive heightfield that
still runs when the network is gone. This system takes publicly downloadable
NOAA rasters over a fixed Gulf of Mexico AOI, reprojects them to Web Mercator,
encodes elevation into 24-bit RGB, and serves a slippy-map pyramid to a
browser that displaces a shared mesh on the GPU. The server is one Go binary
with the UI embedded. The delivery target is a cluster that has no route to
the public internet. Nothing in the repo is classified, CUI, or behind a
login. The demonstration is the pipeline and the chassis, not a product and
not a navigation tool.

---

## 2. Data provenance

No NOAA, GEBCO, USGS, HYCOM, NDBC, or Argo byte has been fetched into this
repository. Retrieval dates are therefore empty. Before the first pull, check
the [NESDIS Notice of Changes](https://www.nesdis.noaa.gov/about/documents-reports/notice-of-changes)
— NOAA has been retiring marine, coastal, and estuary products at an elevated
rate since 2025. Record the retrieval date in [`docs/data-sources.md`](docs/data-sources.md)
at the moment of first download, not later from memory.

Intended sources (all unauthenticated; `aws s3 ls --no-sign-request` for the
NODD buckets):

| Source | Access | License / terms | Attribution |
|---|---|---|---|
| NOAA National Bathymetric Source | `s3://noaa-ocs-nationalbathymetry-pds` | NODD open | Requested for unaltered data; no endorsement; modified data must not be presented as original |
| NOAA DCDB crowdsourced bathymetry | `s3://noaa-dcdb-bathymetry-pds` | NODD open | Same NODD rules |
| NOAA S-102 surfaces | `s3://noaa-s102-pds` | NODD open; IHO S-102 format | Same NODD rules |
| NOAA OCS hydrographic surveys | `s3://noaa-ocs-hydrodata` | NODD open | Same NODD rules |
| NOAA/NGA SCuBA (ICESat-2) | `s3://noaa-nos-scuba-icesat2-pds` | NODD open | Same NODD rules |
| GEBCO global grid | gebco.net | Public domain; terms of use apply | Required; no implied IHO/IOC endorsement |
| USGS 3DEP lidar | AWS Open Data Registry | U.S. government work, public domain | Requested |
| SRTM / Copernicus DEM | public DEM archives | SRTM: public domain. Copernicus DEM: Copernicus licence | Copernicus requires attribution |
| HYCOM | public THREDDS/OPeNDAP | public model output | Consortium acknowledgment |
| NDBC buoys | ndbc.noaa.gov | NODD / NOAA open; no API key | NODD rules |
| Argo floats | argo.ucsd.edu | freely redistributable | Standard Argo acknowledgment |

What *is* in `data/tiles` after `make tiles` is a procedural shelf generated
by `cmd/tiler synth`. It is not NOAA data, not a survey, and not suitable for
navigation. See [`docs/data-sources.md`](docs/data-sources.md) for the full
table, the allowed/not-allowed boundary, and the empty retrieval-date column.

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
│    /api/ocean/manifest       ocean snapshot inventory (404 until    │
│    /api/ocean/currents       `make ocean`; snapshot, air-gap safe)  │
│    /api/ocean/buoys                                                 │
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

Three decisions sit under that diagram. Detail and rejected alternatives are
in [`docs/architecture.md`](docs/architecture.md) and the ADRs.

**Terrain-RGB on the GPU.** Elevation is a colour. The packing used here
(and by `rio rgbify -b -10000 -i 0.1`) is

```
elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
```

That is 0.1 m over −10 000 m to +6 777.215 m, which covers the Sigsbee Deep
and any coastal height in the AOI. The vertex shader samples the PNG and
displaces a shared 129×129 plane; the CPU never materialises a heightfield.
The same files are ordinary slippy-map tiles: cacheable, inspectable, and
air-gap friendly. This is the Mapbox Terrain-RGB / `rio-rgbify` packing.
Mapzen Terrarium (`(R*256 + G + B/256) − 32768`) is a different formula; we
do not emit it. See [ADR 0001](docs/adr/0001-terrain-rgb-vs-quantized-mesh.md).

**Single static Go binary.** `//go:embed` of `web/dist` plus `CGO_ENABLED=0`
produces one file, `gulf-viewer`, that serves tiles, JSON, and the UI.
There is no Node runtime, no nginx config, and no CDN at serve time. That
is the unit you copy onto a disconnected machine. See
[ADR 0002](docs/adr/0002-go-tile-server-vs-static-tiles.md).

**Air-gap as a constraint, not a stretch.** The serve path has no outbound
calls. Seed tiles travel with the binary (local) or inside a Zarf tarball
(cluster). The ocean overlay is the same: `GET /api/ocean/manifest`,
`/api/ocean/currents`, and `/api/ocean/buoys` serve the last snapshot from
`data/ocean/` (404 until `make ocean`). GDAL, SNS, S3, HYCOM, and NDBC
exist only on ingest, which is not required to view already-built tiles.

The renderer is three.js / WebGL2 on a planar Web Mercator quad, not a
WGS84 ellipsoid. Cesium is the documented stretch, not the current target.
See [ADR 0003](docs/adr/0003-three-js-vs-cesium.md).

---

## 4. Deployment

Two paths. Neither has been executed on a disconnected cluster. The Zarf
procedure in [`docs/deployment.md`](docs/deployment.md) is drafted from the
intended `zarf.yaml` shape; it is not a lab notebook.

### Local

From a machine with Go 1.26+, Node 20.19+ (Vite 8), and this repo:

```bash
make tiles && make web && make server && ./gulf-viewer
```

Then open `http://127.0.0.1:8080`. Equivalent: `make run`.

| Target | What it does today |
|---|---|
| `make tiles` | `go run ./cmd/tiler synth` → procedural PNG pyramid under `data/tiles` (z 6–11). No GDAL. No NOAA. |
| `make web` | `cd web && npm install && npm run build` → `web/dist` for embed |
| `make server` | `go build` of `./cmd/server` → `./gulf-viewer` |
| `make run` | the three above, then `./gulf-viewer` |

`make tiles`, `make web`, and `make server` all have implementations in
this increment (`cmd/tiler`, `web/`, `cmd/server`). GDAL is optional and
local-only: `scripts/build-tiles.sh` is the path from a real NOAA
GeoTIFF to the same pyramid layout, once a retrieval is recorded.

### Air-gap / Zarf

Intended sequence, **not executed**:

1. On a connected build host: produce the serve image (Chainguard static
   base, non-root, `CGO_ENABLED=0`), generate or copy a seed tile set,
   `syft` + `grype`, `cosign sign` / `cosign attest`, `zarf package create .`
2. Move `zarf-package-gulf-viewer-amd64.tar.zst` by whatever physical or
   approved transfer the site uses.
3. On the disconnected cluster: `zarf package deploy zarf-package-gulf-viewer-amd64.tar.zst`
4. Confirm `/healthz` and a tile `GET` succeed with the cluster's egress
   denied.

What has been run: local Go tests for Terrarium encode/decode and slippy-map
math; synthetic tile generation via `cmd/tiler synth`. What has not been
run: the container build in CI, image signing, a Zarf package create or
deploy, and any install on a cluster without an internet route.

---

## 5. Threat model

The ingest path parses untrusted rasters. GDAL has a history of
memory-corruption and arbitrary-code-execution CVEs on crafted files
(heap overflows in drivers and in bundled libtiff/PROJ, among others). A
source bucket that serves a malicious GeoTIFF is a code-execution event
on the ingest worker, not a data-quality event.

Mitigations we are designing to, and have not yet built: pin the GDAL
version in the ingest image; run as non-root on a distroless/Chainguard
base; keep network away from the parser process if the runtime allows it;
enforce size limits; allow-list drivers; SBOM + grype fail-on-high on the
ingest image; SQS redrive to a DLQ so a poison object does not tight-loop.

The serve path is a file server with integer `{z}/{x}/{y}` coordinates.
Path traversal is the main HTTP risk. Cache poisoning is largely irrelevant:
tiles are immutable once written and are addressed by those integers, not
by a client-supplied cache key.

Full STRIDE in [`docs/threat-model.md`](docs/threat-model.md).

---

## 6. Scope boundary

Every byte that enters this repository must come from a source that is
publicly downloadable with no login, no EULA click-through, and no `.mil`
host. If a dataset asks you to agree to terms or to authenticate, it stays
out. We do not route around a gate.

That rule is an export-control and classification-hygiene statement, not a
convenience. This repo will not hold CUI, will not hold DTED Level 2+,
will not hold NGA limited-distribution products, and will not hold Navy
survey multibeam over operational areas. DTED 0/1, GEBCO, USGS 3DEP, SRTM,
Copernicus DEM, and NOAA NODD buckets are in scope because they are
publicly posted. Stating the line in writing is part of the design.

| Allowed | Not allowed |
|---|---|
| NOAA NODD S3 buckets (open, unauthenticated) | Anything behind a CAC/PKI wall |
| GEBCO global grid | DTED Level 2 and above |
| USGS 3DEP lidar | NGA restricted / limited-distribution products |
| SRTM / Copernicus DEM | Navy survey multibeam over operational areas |
| DTED Level 0/1 | Any dataset requiring a distribution statement |

This is a data and infrastructure demonstration. It is not a weapons-effects,
guidance, seeker, or RCS model, and it is not a navigation product.

---

## 7. Known limitations

- **Synthetic seed tiles, not NOAA.** `cmd/tiler synth` writes a procedural
  Mississippi Bight shelf (coastal ~0 m, mid-shelf ~−80 m, a canyon-like
  drop in the southwest). Depths are invented. They must not be labelled
  or demoed as National Bathymetric Source.
- **No NOAA bytes on disk.** The five NODD buckets have not been listed
  from this repo's documented retrieval process; no GeoTIFF, HDF5, or CSV
  from those buckets is vendored.
- **No soundings.** `/soundings/{z}/{x}/{y}` and the DCDB CSV → binary
  batch pipeline are Phase 4. deck.gl is not in the tree.
- **No S-102 reader.** `internal/s102` and `s102 convert` are Phase 5.
  There is no HDF5 walk of `BathymetryCoverage`.
- **No live SNS ingest.** Phase 6. No SQS consumer, no Terraform, no DLQ
  alarm. New objects in a NODD bucket do nothing to this system.
- **Planar renderer, not ellipsoid.** Tiles are Web Mercator on a flat
  quad. There is no WGS84 globe and no quantized-mesh terrain. Cesium is
  a stretch goal with an ADR, not a second renderer.
- **GDAL is optional and local.** The checked-in tiler does not link
  GDAL. Reprojection, nodata fill, and `gdal2tiles.py` exist only as a
  planned operator path on a workstation that already has GDAL 3.8+.
- **Same-origin, no wildcard CORS.** The UI is served from the same
  binary that serves tiles. A second origin is opt-in via
  `GULF_CORS_ORIGIN` and is a single origin, not `*`.
- **Not for navigation.** No ENC, no CATZOC, no uncertainty surface in
  the current increment. Contours are a shader effect on a height
  texture, not a chart product.

---

## Repository layout

Matches the build spec. **Present** means the path exists in this tree
today. **Planned** means the spec names it and the current increment has
not landed it (or has only a Makefile stub).

```
gulf-seafloor-viewer/
├── README.md                  # this file
├── docs/                      # present — architecture, provenance, threat, deploy, ADRs
├── cmd/
│   ├── tiler/                 # present — synth only; GDAL path is scripts/
│   ├── ingest/                # planned — SQS consumer (Phase 6)
│   └── server/                # present — tile + API server (Phase 3)
├── internal/
│   ├── terrain/               # present — Terrarium/terrain-RGB encode/decode
│   ├── tiles/                 # present — slippy-map math, AOI, covering
│   ├── server/                # present — HTTP handlers (not in the spec sketch; lives here)
│   ├── s102/                  # planned — S-102 HDF5 reader (Phase 5)
│   └── soundings/             # planned — CSV → spatial index → binary batches (Phase 4)
├── web/                       # present — Vite + three.js (Phase 2)
├── deploy/                    # present as a drafted chassis — Dockerfile, k8s, policy, terraform, zarf.yaml
├── scripts/                   # present — fetch-source-data.sh, build-tiles.sh, list-buckets.sh
└── .github/workflows/         # present — CI sketch; do not read it as a completed air-gap run
```

Also present, outside the spec tree: `Makefile`, `go.mod` (Go 1.26),
`projectspec.md`. Generated artefacts (`data/tiles`, `web/dist`,
`./gulf-viewer`) are gitignored. `deploy/` and CI exist as files; the
disconnected-cluster procedure has still not been executed.

---

## Running locally

```bash
make tiles && make web && make server && ./gulf-viewer
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080).

| Variable | Default | Role |
|---|---|---|
| `GULF_ADDR` | `:8080` | listen address |
| `GULF_TILE_DIR` | `data/tiles` | on-disk XYZ pyramid |
| `GULF_WEB_DIR` | `web/dist` | SPA root if `index.html` is there; otherwise the binary embed |
| `GULF_CORS_ORIGIN` | empty (same-origin only) | single allowed origin; `*` is ignored, never emitted |
| `LOG_FORMAT` | `text` | `json` for a collector; anything else is text |

See [`docs/deployment.md`](docs/deployment.md).

---

## Attribution

NOAA data disseminated through the NOAA Open Data Dissemination (NODD)
program is open and free to use. NOAA requests attribution for the use or
dissemination of unaltered NOAA data. It is not permissible to state or
imply endorsement by, or affiliation with, NOAA. If NOAA data are
modified, the result must not be stated or implied to be original,
unaltered NOAA data.

This project has not yet retrieved NOAA data. When it does, the viewer
about panel will carry the same text. Synthetic tiles produced by
`cmd/tiler synth` are not NOAA data and must not be presented as such.

GEBCO, USGS, Copernicus, HYCOM, and Argo each have their own
acknowledgment rules; those are listed in
[`docs/data-sources.md`](docs/data-sources.md) and apply only after those
bytes are actually pulled.
