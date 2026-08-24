# Threat model

STRIDE over the two process boundaries that matter: ingest (untrusted
rasters) and serve (HTTP file + API). The renderer is a same-origin
static client; it is in scope only where it can be used to abuse the
server.

This document describes the design we are building to. The ingest
image, DLQ, SBOM gate, and hardened manifests are Phase 6–7. They
are not running in this tree today.

---

## Assets

| Asset | Why it matters |
|---|---|
| Ingest host / container | Runs GDAL on bytes we did not author |
| Tile store | Immutable `{z}/{x}/{y}.png` plus manifest; if replaced, every client sees a false seafloor |
| Serve binary and embed FS | One process facing the network |
| Manifest / `/api/depth` | Operators will treat numbers as depths |
| Cluster identity (later) | Image signatures, SBOM attestations, admission policy |

We do not hold credentials for the source buckets. NODD is
`--no-sign-request`. That removes a class of secret-theft from the
ingest role; it does not make the *objects* trusted.

---

## Trust boundaries

```
untrusted     NODD / GEBCO / operator USB  ──►  ingest parser (GDAL)
semi-trusted  tile store (we wrote it)     ──►  serve process
untrusted     browser / HTTP client        ──►  serve process
```

A tile we generated from a raster we parsed is only as trustworthy as
that parse. Once written, we treat the PNG as immutable content
addressed by `{z}/{x}/{y}`. Overwrite is an ingest event, not a
cache event.

---

## Ingest path

```
SNS New*Object → SQS → ingest worker → GDAL → tile store → manifest
                 └──► DLQ
```

Until Phase 6 the same GDAL tools may be run by hand on a
workstation (`gdalwarp`, `rio rgbify`, `gdal2tiles.py`). The
workstation *is* the ingest host. The same questions apply.

### What happens if a source bucket serves a malicious raster?

GDAL is a C/C++ format zoo. It has a documented history of
memory-corruption bugs that become arbitrary code execution when a
crafted file is opened. That is not hypothetical:

- Driver and helper-library heap overflows (libtiff, GeoTIFF, and
  GDAL's own drivers have all appeared in CVE streams).
- Concrete cases: CVE-2021-45943 is a heap overflow in the PCIDSK
  driver (GDAL 3.3.0–3.4.0) on a crafted file — Debian's advisory
  called out potential arbitrary code execution. CVE-2019-17546 is
  an integer overflow in libtiff as shipped with GDAL through 3.0.1,
  triggered by a crafted RGBA image. The IDs rotate; the pattern
  does not: **opening a file is executing a parser**.

If `s3://noaa-ocs-nationalbathymetry-pds/...tiff` were replaced, via
bucket compromise or a confused-deputy copy, with a file that
triggers such a bug, the ingest worker runs attacker code with
whatever privilege the container has, on whatever network the
container can reach. A poisoned object is a shell, not a bad pixel.

Manual `gdalinfo` on a laptop is the same bug with a human in front
of it.

### STRIDE — ingest

| | Threat | Design response |
|---|---|---|
| **S**poofing | A message that claims to be an SNS notification for a key we should fetch, or a worker identity that can write the tile prefix. | SQS subscription on the real NODD topic (not a URL we poll). Least-privilege IAM: read the source bucket object named in the message, write only the tile prefix. No long-lived keys in the image. |
| **T**ampering | Crafted raster; swapped object under a known key; truncated or corrupt PNG written as a “successful” tile. | Treat source bytes as hostile. Pin GDAL (and libtiff/PROJ) to a version, not `latest`. Allow-list drivers (`GTiff`, `netCDF`, `HDF5` — not the kitchen sink). Enforce compressed and decompressed size caps before `gdalwarp`. Check CRS, band count, and nodata against a manifest schema. Write tiles to a staging prefix; publish by rename after encode verification (`internal/terrain.Decode` on a known pixel vs `gdallocationinfo`). |
| **R**epudiation | Cannot tell which object produced which tile after a bad depth shows up in a demo. | Structured log: source bucket, key, ETag, GDAL version, output `{z}/{x}/{y}` range, worker image digest. Manifest records the same. |
| **I**nformation disclosure | Worker has egress and a shell; a GDAL RCE becomes a pivot. | Distroless / Chainguard ingest image, non-root (65532), read-only root FS, no extra capabilities. Prefer no network from the parser process: fetch in a sidecar or init, then exec GDAL with the file already on a tmpfs. If the runtime cannot split fetch from parse, deny egress except the source bucket and the tile bucket via network policy. |
| **D**enial of service | A 200 GB “GeoTIFF”, a decompression bomb, or a message that crashes GDAL in a tight SQS retry. | Size limits at download and at `gdalinfo`. Timeouts. SQS visibility timeout longer than a healthy job, `maxReceiveCount` → DLQ. Alarm on DLQ depth. Do not auto-retry a message that failed in the parser; that is how a poison object becomes a CPU outage. |
| **E**levation of privilege | Parser RCE as root, or a privileged Kubernetes context. | `runAsNonRoot`, `runAsUser: 65532`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`. Admission policy (OPA/Gatekeeper) rejects any ingest manifest that omits those. |

### Mitigations (ingest image)

These are requirements on the Phase 6–7 image, not a claim they are
in CI today.

1. **Pin GDAL.** Exact version in the Dockerfile (3.8.x or newer as
   specified, locked by digest). Rebuild when you intend to, not
   when a floating tag moves.
2. **Non-root, distroless / Chainguard.** No shell, no package
   manager in the runtime image. UID 65532.
3. **No network from the parser if possible.** Fetch, then parse
   files already on disk. If that split is too expensive for a first
   worker, lock egress with a network policy.
4. **Size limits.** Reject objects over a configured compressed
   cap (start at hundreds of MB per AOI tile, not tens of GB) and
   over a decompressed-pixel cap.
5. **Reject unexpected drivers.** `GDAL_SKIP` / allow-list so a
   `.tiff` that is actually a different GDAL driver does not get a
   parser we never reviewed.
6. **SBOM + grype on the ingest image.** `syft` → SPDX, `grype
   --fail-on high`. Cosign sign and attach the SBOM. A GDAL CVE
   that lands in the pinned version fails the build; it does not
   silently ship.
7. **DLQ for poison messages.** After N parse failures the message
   leaves the main queue. An alarm fires. A human inspects the key;
   the worker does not keep dying on it.

GDAL on a developer laptop is the same risk with weaker isolation.
Do not `gdalinfo` random files as root. The laptop path is
explicitly optional and local.

---

## Serve path

The server opens files under `GULF_TILE_DIR` and returns bytes. It
does not run GDAL. It does not fetch from S3 at request time in
this increment.

### STRIDE — serve

| | Threat | Design response |
|---|---|---|
| **S**poofing | A client pretending to be another origin in order to read tiles in a browser context that should not have them. | Same-origin by default. `GULF_CORS_ORIGIN` is a single origin or empty. No `*`. No cookies, so classic CSRF against a cookie session does not apply. |
| **T**ampering | Path traversal: `GET /tiles/../.ssh/id_rsa` or `GET /tiles/6/../../etc/passwd`. Oversize `{z}/{x}/{y}` that walks out of the tile root. | Parse `z`, `x`, `y` as integers with range checks (`z` in 0–15, `x`,`y` in `[0, 2^z)`). Join only those integers: `$TILE_DIR/$z/$x/$y.png`. Reject any request whose cleaned path is not still under `GULF_TILE_DIR`. Do not pass the raw URL path to `os.Open`. |
| **R**epudiation | No record of who asked for `/api/depth` on a shared workstation. | Structured access logs (method, path, status, duration). No user identity in this increment — there is no login — so this is host-level, not attribution to a person. |
| **I**nformation disclosure | Directory listing of `GULF_TILE_DIR`; stack traces; `GULF_WEB_DIR` pointed at `/`. | No `http.Dir` listing. Generic 404 for missing tiles. No panic traces to the client. `GULF_WEB_DIR` is an override for development; production uses embed. |
| **D**enial of service | Slowloris; unbounded on-the-fly encode; concurrent stampede on one missing tile. | Timeouts and limits on the `http.Server`. Pregenerated tiles are `open` + `copy`. When on-the-fly exists: bounded worker pool, `singleflight` per `{z}/{x}/{y}`, reject when the queue is full. |
| **E**levation of privilege | Container breakout from a file server is low-value but still in scope for the chassis. | Same hardened `securityContext` as ingest. Serve image has no GDAL and no shell (`chainguard/static`). |

### Path traversal, specifically

The only safe API is “three integers, then a fixed suffix.” String
concatenation of the URL path is how this class of server leaks
`/etc/passwd`. Tests should include `..`, encoded `..` (`%2e%2e`),
absolute paths, extra segments (`/tiles/6/1/2/3.png`), and a
negative `z`.

### Cache poisoning — why it is mostly not a serve-path issue

Tiles are immutable and addressed by `{z}/{x}/{y}`. A client cannot
ask the server to store a representation under a key of the client's
choosing. `Cache-Control: public, max-age=31536000, immutable` plus
an `ETag` tells shared caches to keep *that* file. A poisoned
*shared cache* would require either (a) an on-path attacker who can
already modify responses, or (b) the server handing out a wrong body
for a well-known URL.

(b) is an ingest or deploy problem: someone overwrote
`6/17/25.png` in the tile directory. That is tampering of the store,
not HTTP cache poisoning. Content-addressing by xyz is weaker than
content-addressing by digest, but the URL *is* the identity of the
tile in a slippy map; a digest in the path would break every
quadtree client. Integrity of the store is a write-path control
(staging + rename, signed image, read-only volume), not a
`Cache-Control` trick.

If we ever put a CDN in front — we do not, on purpose — purge and
origin integrity become real. Air-gap deployments have no CDN.

---

## Out of scope (for this model)

- Browser WebGL exploits. We ship shaders we wrote; we do not eval
  user GLSL.
- Classification spill. The data boundary in the README is the
  control; the threat model assumes that boundary holds.
- Authentication. There is none. The server is as sensitive as the
  network you bind it on. Bind `127.0.0.1` on a shared workstation
  if that is the threat.

---

## Residual risk

A zero-day in the pinned GDAL still executes if we open the file.
Driver allow-listing and process isolation shrink the blast radius;
they do not make parsing safe. The honest mitigation for a raster
you have no reason to trust is “do not parse it on a machine you
care about,” which is why ingest and serve are different images.
