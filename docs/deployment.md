# Deployment

Three environments, one binary. By default the serve path makes two
kinds of outbound call: a scheduled HYCOM currents refresh on a ~1h
ticker, and an on-demand aircraft fetch per client request to
`/api/aircraft`. Both are opt-out — `GULF_OCEAN_REFRESH=0` and
`GULF_AIRCRAFT=0` — and setting both is what restores a serve path
with no outbound network calls. GDAL, when used, stays on the machine
or image that builds tiles.

---

## Status of the air-gap path

> **Status: procedure drafted, not yet executed on a disconnected
> cluster.**
>
> The steps in [Air-gap (Zarf)](#air-gap-zarf) are the intended
> procedure, written as a runbook so they can be followed later
> without invention. They have not been run. There is no
> `zarf-package-gulf-viewer-*.tar.zst` in this repo, no Zarf
> package-create log, and no deploy onto a cluster whose egress was
> denied. Do not read this section as evidence that an air-gap
> install was tested.

What *has* been run in this increment, on a connected developer
machine and in CI:

- `go test -race ./...` (12 packages, 9 of which carry tests), plus
  `gofmt`, `go vet` and `staticcheck` as blocking CI steps.
- The web suite (`npm test`), `tsc --noEmit`, and `oxlint`.
- `go run ./cmd/tiler synth` (via `make tiles`).
- The server driven in a headless browser at four viewport widths,
  checking the layer panel, the shareable view-state hash and the
  responsive layout.
- A `deploy/policy` test that parses the real
  `deploy/k8s/deployment.yaml` and fails if a directory the server
  writes to stops resolving to a declared volume.

What has **not** been run: the container image build in CI, cosign
signing, the SBOM gate, a Zarf package create or deploy, and any
install on a cluster without an internet route. Those are Phase 7.

---

## Environment variables

Read by `cmd/server` (Phase 3). Defaults are the local-dev values.

| Variable | Default | Meaning |
|---|---|---|
| `GULF_ADDR` | `:8080` | `host:port` passed to `ListenAndServe`. Use `127.0.0.1:8080` on a shared workstation. |
| `GULF_TILE_DIR` | `data/tiles` | Root of the XYZ pyramid (`$GULF_TILE_DIR/{z}/{x}/{y}.png`). Must be a directory; the process does not fetch NOAA data. |
| `GULF_WEB_DIR` | `web/dist` | SPA root used when `index.html` exists there. Otherwise the binary falls back to `//go:embed` of `cmd/server/assets`. |
| `GULF_CORS_ORIGIN` | empty | If set to a single origin, echoed as `Access-Control-Allow-Origin`. Empty means no CORS headers. `*` is ignored and never emitted. |
| `GULF_TILE_WORKERS` | `GOMAXPROCS` | Bounds concurrent tile disk I/O. Not a CORS or bind knob. Values `<= 0` fall back to the default. |
| `LOG_FORMAT` | `text` | `json` selects `slog` JSON; any other value is text. |

### Snapshot directories

Every live layer writes its snapshot through to disk before publishing it
in memory. **Under `readOnlyRootFilesystem: true` these must point at a
writable mount.** Left at their defaults in the hardened image they resolve
onto the read-only root, and the two families do not fail the same way:

- Ocean degrades gracefully. The fetch still reaches the in-memory cache and
  is served; only durability across a restart is lost.
- Weather does not. Radar cannot create its frame directory at all, so the
  layer reports itself permanently unavailable in the pod.

`deploy/k8s/deployment.yaml` supplies an `emptyDir` for each, and
`deploy/policy` has a test that fails if either variable stops resolving to
a declared volume.

| Variable | Default | Meaning |
|---|---|---|
| `GULF_OCEAN_DIR` | `data/ocean` | `currents.json`, `buoys.json`, `manifest.json`. |
| `GULF_WEATHER_DIR` | `data/weather` | `radar.json`, `forecast.json`, and the frame directory `radar/*.png`. |

### Live layers

Each of these is off with `0` and on otherwise. Setting all three to `0`
leaves a server that makes no outbound request of any kind.

| Variable | Default | Meaning |
|---|---|---|
| `GULF_OCEAN_REFRESH` | on | HYCOM currents (~1 h) and NDBC buoys (~10 m) background refreshers. |
| `GULF_WEATHER_REFRESH` | on | NOAA radar (~5 m) and NWS gridded forecast (~1 h) background refreshers. |
| `GULF_AIRCRAFT` | on | `GET /api/aircraft`; `0` returns 404. Live ADS-B, polled only while a client asks. |

Upstream overrides and cadences, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `GULF_HYCOM_URL` | `ncss.hycom.org/.../GLBy0.08/latest` | NCSS base for the currents refresher. |
| `GULF_NDBC_BASE` | `https://www.ndbc.noaa.gov` | Station table + `realtime2` origin. |
| `GULF_BUOY_REFRESH_EVERY` | `10m` | Go duration. Matches how often `realtime2` is rewritten. |
| `GULF_RADAR_REFRESH_EVERY` | `5m` | Go duration. Upstream republishes about every two minutes. |
| `GULF_FORECAST_REFRESH_EVERY` | `1h` | Go duration. One pass is ~15 gridpoint requests — do not set this aggressively. |
| `GULF_ADSBLOL_URL` | adsb.lol public API | Primary ADS-B feed. |
| `GULF_OPENSKY_URL` | OpenSky states endpoint | Reserve feed, used when adsb.lol fails. |

An unparseable duration logs a warning and falls back to the default rather
than failing startup: a typo in one tuning knob must not keep the viewer
from booting.

---

## Local

Prerequisites for the full path: Go 1.26+, Node 20.19+ + npm (Vite 8 build),
this repo. GDAL is not required for synthetic tiles.

```bash
make tiles && make web && make server && ./gulf-viewer
```

Open `http://127.0.0.1:8080`.

`make run` is the same sequence in one target.

| Step | Command | Result |
|---|---|---|
| 1 | `make tiles` | `cmd/tiler synth` writes a procedural pyramid to `data/tiles` (z 6–11). Not NOAA data. |
| 2 | `make web` | `web/` install + Vite production build → `web/dist` |
| 3 | `make server` | `go build -trimpath -ldflags="-s -w" -o gulf-viewer ./cmd/server` |
| 4 | `./gulf-viewer` | listens on `GULF_ADDR` (default `:8080`) |

`make tiles`, `make web`, and `make server` are implemented in this
increment. If `web/dist/index.html` is missing, `/` returns 503
(`frontend not built — run make web`) rather than a blank 200.

Optional GDAL path (workstation only, after a real NOAA pull
recorded in [`data-sources.md`](data-sources.md)):

```
# planned: scripts/build-tiles.sh
gdalwarp → rio rgbify → gdal2tiles.py  →  data/tiles/
```

That replaces the synthetic pyramid with a derived NOAA product.
Label it as derived. Do not commit the rasters (`data/raw/`,
`data/work/`, `data/tiles/` are gitignored).

Unplug the network after the binary and tiles are on disk. The
serve process should continue. That is the local air-gap check;
it is not a cluster air-gap check. With `GULF_OCEAN_REFRESH` and
`GULF_AIRCRAFT` unset, this check does not prove zero egress: the
process keeps serving the last good currents snapshot while its
background refresh ticker fails silently every ~1h, and keeps serving
the last good aircraft response for up to 60s past disconnect (then
404s) while each client request retries the dead feed. For a genuine
no-egress check, set `GULF_OCEAN_REFRESH=0` and `GULF_AIRCRAFT=0`
before unplugging.

---

## Container

Intended serve image (Phase 7; not built in CI yet):

```
FROM golang:1.26 AS build
# CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM cgr.dev/chainguard/static:latest
COPY --from=build /out/server /server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
```

Absent on purpose: a shell, a package manager, root, a floating
`node:latest` or `ubuntu:latest` runtime, GDAL. Tiles are a volume
or a layer copied at image build, not a runtime `curl`.

Run, once the image exists:

```bash
docker run --rm -p 8080:8080 \
  -e GULF_ADDR=:8080 \
  -e GULF_TILE_DIR=/tiles \
  -e LOG_FORMAT=json \
  -v "$(pwd)/data/tiles:/tiles:ro" \
  gulf-viewer:local
```

Ingest is a *different* image: it needs GDAL, still non-root, still
pinned, still scanned. Do not add GDAL to the serve image to “make
on-the-fly easier.”

Pipeline gates on that image, when CI exists: `syft` SPDX SBOM,
`grype --fail-on high`, push, `cosign sign`, `cosign attest` of the
SBOM. Unsigned images are not what you deploy.

---

## Kubernetes hardening notes

Every workload manifest (serve and ingest) sets:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
```

Also:

- Resource requests and limits. Serve is memory-light (mapped PNGs);
  ingest is not — cap it so a large raster cannot evict the node.
- Read-only tile volume for serve (`emptyDir` is the wrong default
  if you already have a seed set — a mount over `/data/tiles` hides
  the pyramid baked into the image, and once did exactly that).
- Writable volumes for `GULF_OCEAN_DIR` and `GULF_WEATHER_DIR`. These
  are the opposite case to the tile pyramid: the image carries no
  snapshot for either, so there is nothing for a mount to mask, and
  the refreshers need somewhere to write. See "Snapshot directories"
  above for what breaks without them.
- No `hostNetwork`, no `privileged`, no extra projected service-
  account tokens the process does not use.
- Network policy: serve receives 8080 from the ingress or in-cluster
  clients. **Serve is no longer egress-free by default.** With the
  live layers on it reaches `ncss.hycom.org`, `www.ndbc.noaa.gov`,
  `mapservices.weather.noaa.gov`, `api.weather.gov` and `adsb.lol`
  on 443. Either allow those egress rules explicitly, or set
  `GULF_OCEAN_REFRESH=0`, `GULF_WEATHER_REFRESH=0` and
  `GULF_AIRCRAFT=0` and keep a deny-all egress policy — which is the
  configuration a disconnected cluster wants anyway. Do not write a
  deny-all egress policy while leaving the refreshers on: the layers
  will not fail loudly, they will quietly serve whatever snapshot was
  seeded and log a warning per tick. Ingest egress is the source
  bucket and the tile bucket only, or none if fetch is split out.
- Probes: `/healthz` (liveness), `/readyz` (readiness — tile dir
  present, embed FS readable).
- Admission: OPA/Gatekeeper constraints that *reject* a workload
  missing the `securityContext` above. A unit test of the policy
  against a non-compliant manifest is part of the definition of
  done for Phase 7; a YAML comment is not.

Iron Bank / Chainguard bases only. `node:latest` in a compose file
is a failed review.

---

## Air-gap (Zarf)

> **Status: procedure drafted, not yet executed on a disconnected
> cluster.** See the callout at the top of this file.

The intended package is a `zarf.yaml` that holds: the signed serve
image, the hardened manifests, and a seed tile set (synthetic or a
recorded NOAA-derived pyramid). One tarball. No pull-through cache
on the far side.

### On a connected build host

1. Build tiles (`make tiles`, or the GDAL script if NOAA data has
   been retrieved and dated).
2. Build the UI and the server (`make web && make server`) so the
   image build has `web/dist` to embed.
3. `docker buildx build` the serve image from `deploy/Dockerfile`.
   Pin base images by digest.
4. `syft . -o spdx-json=sbom.spdx.json`
5. `grype sbom:sbom.spdx.json --fail-on high`
6. Push to the registry Zarf will import from (or load into Zarf's
   local store).
7. `cosign sign --yes $IMAGE`
8. `cosign attest --yes --predicate sbom.spdx.json --type spdxjson $IMAGE`
9. `zarf package create .`
10. Confirm a file named like `zarf-package-gulf-viewer-amd64.tar.zst`
    exists and note its checksum.

### Transfer

Move the `.tar.zst` by the site's approved means (removable media,
guard, sneakernet). Do not assume HTTPS to Docker Hub from the
destination.

### On the disconnected cluster

1. Confirm the cluster has no default route to the public internet,
   or that the namespace's network policy denies egress. If you
   cannot confirm that, you are not testing air-gap; you are
   testing “it runs.”
2. `zarf package deploy zarf-package-gulf-viewer-amd64.tar.zst`
3. Wait until the serve pod is Ready under the hardened
   `securityContext`.
4. From a client that can reach the Service:
   - `GET /healthz` → 200
   - `GET /readyz` → 200
   - `GET /tiles/{z}/{x}/{y}.png` for a tile you know is in the
     seed set → 200, `image/png`
   - `GET /` → the SPA
5. Confirm the pod has no successful egress (deny logs, or a
   sidecar that would have failed a phone-home).

Until those five checks have been run on a cluster without an
internet route, the air-gap claim stays a design, not a result.

---

## What not to do

- Do not run the serve binary as root to “fix permissions” on
  `data/tiles`. Fix the directory mode.
- Do not set `GULF_CORS_ORIGIN=*`.
- Do not bake AWS keys into the serve image. Serve does not call
  S3.
- Do not claim a Zarf test you have not walked with egress off.
