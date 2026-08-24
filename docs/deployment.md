# Deployment

Three environments, one binary. The serve path has no outbound
network calls. GDAL, when used, stays on the machine or image that
builds tiles.

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

What *has* been run in this increment: `go test ./...` for
`internal/terrain` and `internal/tiles`, and `go run ./cmd/tiler
synth` (via `make tiles`) on a connected developer machine. The
container image, cosign signing, SBOM gate, and Kubernetes
manifests are Phase 7.

---

## Environment variables

Read by `cmd/server` (Phase 3). Defaults are the local-dev values.

| Variable | Default | Meaning |
|---|---|---|
| `GULF_ADDR` | `:8080` | `host:port` passed to `ListenAndServe`. Use `127.0.0.1:8080` on a shared workstation. |
| `GULF_TILE_DIR` | `data/tiles` | Root of the XYZ pyramid (`$GULF_TILE_DIR/{z}/{x}/{y}.png`). Must be a directory; the process does not fetch NOAA data. |
| `GULF_WEB_DIR` | `web/dist` | SPA root used when `index.html` exists there. Otherwise the binary falls back to `//go:embed` of `cmd/server/assets`. |
| `GULF_CORS_ORIGIN` | empty | If set to a single origin, echoed as `Access-Control-Allow-Origin`. Empty means no CORS headers. `*` is ignored and never emitted. |
| `LOG_FORMAT` | `text` | `json` selects `slog` JSON; any other value is text. |

`GULF_TILE_WORKERS` (optional, default `GOMAXPROCS`) bounds concurrent
tile disk I/O. It is not a CORS or bind knob.

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
it is not a cluster air-gap check.

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
  if you already have a seed set).
- No `hostNetwork`, no `privileged`, no extra projected service-
  account tokens the process does not use.
- Network policy: serve receives 8080 from the ingress or in-cluster
  clients and has no egress. Ingest egress is the source bucket and
  the tile bucket only, or none if fetch is split out.
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
