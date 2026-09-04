# Data sources

Provenance, terms, and retrieval state for every dataset named in the
build spec. One dataset has now been pulled into this repository: an
AOI clip of the GEBCO global grid, vendored at
`internal/shelf/gebco.bin`. Every other row below is still unretrieved,
and no NOAA bytes are on disk.

Before the first pull of any NOAA product, read the
[NESDIS Notice of Changes](https://www.nesdis.noaa.gov/about/documents-reports/notice-of-changes).
NOAA has been decommissioning marine, coastal, and estuary products at
an elevated rate since 2025; several services carry 2026 retirement
dates. The NODD bathymetry buckets look healthy as of this writing.
Verify, then write the date you actually downloaded the bytes — not
the date you meant to.

All NODD S3 access is unauthenticated:

```
aws s3 ls --no-sign-request s3://<bucket>/
```

No AWS account is required. If a future path asks for a login or an
“I agree,” stop; that dataset is out of scope (see Allowed / not
allowed).

---

## Area of interest

North-central Gulf — Atchafalaya Bay to Pensacola, mainland south past
Southwest Pass to the shelf break and the head of Mississippi Canyon,
WGS84:

| | |
|---|---|
| West | −91.36 |
| South | 28.50 |
| East | −86.69 |
| North | 30.78 |

The east–west span is a viewer constraint, not just a coverage one. At
452 × 254 km the box is 1.78:1, matching a 16:9 viewport. The camera
cover-fits the chart — it fills the frame and crops the overflow rather
than showing background — so a narrower box would crop the north–south
extent on a widescreen monitor and put Mississippi Canyon off screen at
load.

`internal/tiles.AOI` is this box, and it is the authority — the table
above is a copy of it. GEBCO and (eventually) NOAA tiles are clipped
to it. The box is a demonstration window, not a chart limit.

---

## Demo tiles — GEBCO-derived, not NOAA data

`make tiles` runs `cmd/tiler synth` and writes an XYZ PNG pyramid
under `data/tiles` (default z 6–11). The surface is now two things
joined at the shelf boundary:

- **Open shelf** — the GEBCO 2024 grid, clipped to the AOI and
  bilinearly resampled. Real bathymetry, from −4 m behind the
  Chandeleur chain to −81 m at the southeast corner.
- **Sound, bays, lakes and lagoons** — still the procedural
  near-shore model. GEBCO does not resolve this water: its cells span
  about 460 m, so they blur the barrier islands into open water, and
  its land mask reads −10 m in Lake Pontchartrain (really about 4 m)
  and +22 m in Perdido Bay, which is water.

The result is therefore **modified** GEBCO, not the published grid,
and it must not be presented as the original unaltered grid. It is
**not** National Bathymetric Source, **not** a hydrographic survey,
**not** unaltered NOAA data, and **not for navigation**. The manifest
carries `depthSource` so a UI about panel cites the right grid and
cannot attribute the surface to NOAA. `data/tiles` is gitignored;
regenerating is the source of truth.

---

## Source index

Retrieval date: recorded per row. Rows without one are **not
retrieved — verify NESDIS Notice of Changes before first pull.**

| Dataset | Access path | License / terms | Attribution requirement | Bundled in repo |
|---|---|---|---|---|
| National Bathymetric Source | `s3://noaa-ocs-nationalbathymetry-pds` (AWS us-east-1, `--no-sign-request`). SNS new-object topic exists for later ingest. | NOAA NODD: open, free to use. U.S. government work. | Request attribution for unaltered data. Do not state or imply NOAA endorsement or affiliation. Modified data must not be presented as original unaltered NOAA data. | No |
| Crowdsourced Bathymetry (DCDB) | `s3://noaa-dcdb-bathymetry-pds` — CSV under `csb/csv/YYYY/MM/`. Header: `UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER`. | NODD open, same as above. | Same NODD attribution / no-endorsement / no-misrepresent-as-original rules. | No |
| S-102 Bathymetric Surfaces | `s3://noaa-s102-pds`. Keys encode S-102 edition and region; `US00` is the IHO producer code for OCS. HDF5 under the IHO S-102 profile. | NODD open for the NOAA-posted files. S-102 is an IHO standard; the *format* is not a data licence. | Same NODD rules on the NOAA-posted surfaces. Do not imply IHO endorsement of this viewer. | No |
| OCS Hydrographic Survey Data | `s3://noaa-ocs-hydrodata`. Raw surveys, qualified and unqualified. | NODD open. | Same NODD rules. Unqualified surveys are still NOAA-posted public data; they are not a quality stamp. | No |
| SCuBA (NOAA/NGA ICESat-2) | `s3://noaa-nos-scuba-icesat2-pds`. Satellite-derived bathymetry. NGA is a partner on the product; the bytes we would use are on the public NOAA bucket. | NODD open. | Same NODD rules. NGA partnership does not move this dataset behind a `.mil` or CAC gate; if that ever changes, it leaves scope. | No |
| GEBCO global grid | `https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2024/ice_surface_elevation/netcdf/GEBCO_2024_CF.nc` (CEDA, no registration; one of the files forming the GEBCO 2024 DOI). Retrieved 2026-09-03T01:26:58Z by `scripts/fetch-gebco.py`, which HTTP-range-reads the AOI rows out of the 7.4 GB grid rather than downloading it. | Public domain. [GEBCO terms of use](https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use): free to copy, adapt, and commercially exploit. Use constitutes acceptance of the disclaimer (not for navigation / safety of navigation). | Required. Form (version-specific), e.g. `GEBCO Compilation Group (2024) GEBCO 2024 Grid (doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f)`. Must not imply GEBCO, IHO, or IOC endorsement. Must not misrepresent the grid or its source. | **Yes** — AOI clip at `internal/shelf/gebco.bin` (700 × 347 cells, 15 arc-second, int16), provenance in `internal/shelf/gebco.json`. Modified: resampled and blended with the procedural near-shore model. |
| USGS 3DEP lidar | [AWS Open Data Registry — USGS 3DEP](https://registry.opendata.aws/usgs-lidar/). Topography side of the coastal strip. | U.S. government work, public domain. | Attribution requested (USGS 3DEP). No endorsement implied. | No |
| SRTM / Copernicus DEM | SRTM via public NASA / OpenTopography-class archives. Copernicus DEM via the Copernicus programme distribution (registration-free mirrors only; if a portal requires an account, do not use that portal). | SRTM: U.S. government work, public domain. Copernicus DEM: Copernicus licence (free use with attribution; no implied endorsement). | SRTM: NASA / NGA collection acknowledgment. Copernicus: “produced using Copernicus WorldDEM-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved” (confirm the exact string for the edition pulled). | No |
| HYCOM | Public THREDDS NCSS `https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest`. Two paths now pull it: `make ocean` does a one-shot classic-NetCDF request (single step, surface `vertCoord=0`) to seed or refresh an air-gapped tree; the server's background refresher (default on, `GULF_OCEAN_REFRESH=0` to disable) does 10 recurring single-time classic-NetCDF requests spanning a `-3h..+24h` window on a ~1 h jittered ticker, merging them into one step per forecast time. (CSV was tried for the refresher first; NCSS's grid endpoint rejects `accept=csv` for a grid subset with HTTP 400 — CSV is only valid there for point requests.) Whichever last ran wins on disk, so the retrieval date below is continuously replaced while the refresher is enabled, not fixed at one pull. Last `make ocean` retrieval: 2026-08-26T00:15:02Z, snapshot validTime 2026-08-26T00:00:00Z. | Public model output; distributor terms on the THREDDS node in use. | Acknowledge the HYCOM consortium and the specific run / experiment ID. | No |
| NDBC buoys | [ndbc.noaa.gov](https://www.ndbc.noaa.gov/). No API key. Two paths pull it: `make ocean` does a one-shot seed, and the server's background refresher (default on, `GULF_OCEAN_REFRESH=0` to disable) re-polls `station_table.txt` plus each in-AOI station's `realtime2` file on a ~10 m jittered ticker. Whichever last ran wins on disk, so the retrieval date is continuously replaced, not fixed at one pull. Station platform class comes from the table's free-text `TTYPE` column (~65 distinct spellings; classified by keyword, never inferred from the ID). Last `make ocean` retrieval: 2026-08-26T00:15:02Z. | NOAA open / NODD-class public data. | Same NODD rules. | No |
| Argo floats | [argo.ucsd.edu](https://argo.ucsd.edu/). NetCDF profiles. | Freely available; collected and distributed by the International Argo Program and contributing national programmes. | Required: “These data were collected and made freely available by the International Argo Program and the national programs that contribute to it. (https://argo.ucsd.edu, https://www.ocean-ops.org). The Argo Program is part of the Global Ocean Observing System.” | No |
| NOAA radar mosaic (base reflectivity) | `https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer` — ArcGIS `exportImage`, `f=image&format=png32`, clipped to the AOI at one instant per request. Anonymous, no key. The service's own `timeInfo.timeExtent` is the history available (about two hours), so a loop exists on first boot rather than being accumulated. Two paths pull it: `make weather` seeds `data/weather/`, and the server's background refresher (default on, `GULF_WEATHER_REFRESH=0` to disable) rebuilds the loop every ~5 m. **Rendered imagery, not values** — the frames are a colour-mapped picture, so nothing downstream can report a dBZ. Observed intermittently advertising a window days out of date; `internal/weather` refuses a window staler than 3 h rather than serving history as current, and leaves the previous snapshot in place. Retrieval date is continuously replaced while the refresher is enabled. | NOAA/NWS public service. | Acknowledge NOAA/NWS. No endorsement implied. Not for navigation. Must not be presented as an official NWS radar product. | No — `data/weather/` is gitignored |
| NWS gridded forecast + outlook | `https://api.weather.gov` — `/points/{lat},{lon}` then `/gridpoints/{wfo}/{x},{y}` for a 5×3 lattice over the AOI (skyCover, probabilityOfPrecipitation, quantitativePrecipitation, windSpeed, windDirection, temperature), plus `/gridpoints/.../forecast` for the plain-language 7-day outlook. No key; a `User-Agent` identifying the caller is required. Refreshed hourly by the server, or seeded by `make weather`. The AOI straddles WFO LIX and MOB and reaches offshore; a gridpoint that fails leaves nil cells rather than failing the field. The **plain-language** endpoint is land-only — a marine point returns `MarineForecastNotSupported` — so the outlook is read at a shore point (Biloxi, 30.40 N / 88.89 W) and the UI names it as such. | U.S. government work, public domain. | Acknowledge NOAA/NWS. No endorsement implied. Not a marine forecast. Not for navigation. | No — `data/weather/` is gitignored |
| adsb.lol | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}`, anonymous, no key. Primary live feed at view time via `/api/aircraft`. | ODbL as documented by the API. | Acknowledge adsb.lol / feeders. No endorsement. Not for navigation. | No |
| OpenSky Network | `https://opensky-network.org/api/states/all` bbox, anonymous, no key. Reserve feed only, used when adsb.lol fails. | OpenSky terms for non-commercial/research use of the REST API. | Acknowledge The OpenSky Network. No endorsement. Not for navigation. | No |

Fill the retrieval date in a follow-up commit at first pull, per row,
as an ISO date plus the exact key or URL. Until then leave the
column as the italicised sentence at the top of this section.

---

## Ocean snapshot

HYCOM surface currents and NDBC station observations are not vendored in
the repository. `make ocean` writes `data/ocean/{currents,buoys,manifest}.json`
(gitignored) as a one-shot pull; that snapshot is the seed and the air-gap
fallback.

By default the running server does more than serve those files. Two
background goroutines refresh the two layers on independent tickers,
because their upstreams republish on very different cadences:

| Layer | Ticker | First run | Writes |
|---|---|---|---|
| HYCOM currents | ~1 h, jittered | 15s after boot | `data/ocean/currents.json` |
| NDBC buoys | ~10 m, jittered (`GULF_BUOY_REFRESH_EVERY`) | 20s after boot | `data/ocean/buoys.json` |

Each writes through to disk and publishes to an in-memory cache; a failed
fetch serves the last good data instead of failing the request. Nothing on
the HTTP request path calls out. Set `GULF_OCEAN_REFRESH=0` to stop **both**
tickers — the server then serves only whatever is already on disk, with no
outbound calls, which is also how `/api/ocean/manifest` behaves in every
configuration.

Because both layers refresh, their retrieval dates are continuously
replaced while the server runs with refresh enabled, not fixed at one pull.
The dates below are the most recent `make ocean` seed, not a claim about
what is currently on disk.

`manifest.json` records `retrievedAt` **per layer**, and a refresh of one
layer carries the other's timestamp forward untouched rather than
restamping it — a currents-only refresh never claims NDBC was re-polled,
and a buoys-only refresh never claims HYCOM was. The top-level
`retrievedAt` mirrors the currents layer and is kept only for readers that
predate the per-layer fields; prefer those.

Seed retrieval: **2026-08-26T00:15:02Z**, dataset `GLBy0.08/latest`,
currents validTime `2026-08-26T00:00:00Z`. Files live in `data/ocean/` (gitignored).

`https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest`

CSV is not offered on that node for a grid subset at all: NCSS answers
`accept=csv` there with HTTP 400, "Format csv is not supported for Grid
data request" (CSV is valid on this node only for point requests). Both
paths therefore request classic NetCDF (`accept=netcdf`), with surface
`vertCoord=0`. `make ocean` sends a single-timestamp query, omitting
`time=latest` (invalid on this FMRC) and yielding one step. The background
refresher sends 10 such single-time requests, one per 3-hourly step across
an explicit `-3h..+24h` window, and merges the responses into one step per
forecast time (deduping by returned validTime, quantized to 3 decimals,
1 mm/s). CI does not run `make ocean` and does not start the refresher.

NCSS also names the valid-time coordinate variable differently across
queries — `time`/`time2` in the vendored fixtures, but a live single
`time=` grid request against `GLBy0.08/latest` came back with `time4` (plus
a `time4_run` companion holding the forecast *reference* time, not the
valid time). `parseHYCOMNetCDF` resolves this by CF `standard_name` metadata
("time" vs. "forecast_reference_time"), not by name, so per-step requests
against the live service parse regardless of which numeral NCSS picks.

---

## Live aircraft

Live ADS-B positions are not vendored and are not an ocean-style snapshot.
`GET /api/aircraft` is fetched at view time from adsb.lol, with The
OpenSky Network held in reserve for when adsb.lol fails. The server polls
only when a client asks, with a 10 s floor, and one cache serves every
client.

adsb.lol leads on rate limit, not on data quality — sampled over this AOI
the two feeds agree on the large majority of contacts. Anonymous OpenSky
allows 400 API credits/day per IP and this AOI costs about one credit per
fetch, so a 10 s poll (8,640 fetches/day) exhausts the day's budget in
roughly 40 minutes and the layer then goes dark. adsb.lol publishes no
such ceiling, so it carries the session.

Set `GULF_AIRCRAFT=0` to remove this egress: the route returns 404 and the
aircraft toggle disables. Terrain has no outbound calls regardless. Ocean
currents are a separate egress now (see Ocean snapshot, above) — a full
air-gap needs `GULF_OCEAN_REFRESH=0` as well. CI does not hit the live
feeds and does not start the currents refresher.

---

## Allowed vs not allowed

Hard rule: every byte in this repo comes from a source that is
publicly downloadable with no login, no EULA acceptance, and no
`.mil` address. If a dataset requires “I agree” or a credential, it
does not go in. Do not route around a gate.

| Allowed | Not allowed |
|---|---|
| NOAA NODD S3 buckets (open, unauthenticated) | Anything behind a CAC/PKI wall |
| GEBCO global grid | DTED Level 2 and above |
| USGS 3DEP lidar | NGA restricted / limited-distribution products |
| SRTM / Copernicus DEM | Navy survey multibeam over operational areas |
| DTED Level 0/1 | Any dataset requiring a distribution statement |

DTED 0/1 is listed as allowed because it is publicly posted. This
increment does not use it; GEBCO and NOAA NBS cover the same need
without a NGA product name in the demo.

SCuBA is allowed only while it remains on an unauthenticated NODD
bucket. A move behind Earthdata Login, a `.mil` host, or a
distribution statement takes it out.

---

## NOAA attribution (canonical text)

Reproduce this in the README, this file, and the application about
panel once NOAA bytes are on disk.

NOAA data disseminated through the NOAA Open Data Dissemination
(NODD) program is open and free to use. NOAA requests attribution
for the use or dissemination of unaltered NOAA data. It is not
permissible to state or imply endorsement by, or affiliation with,
NOAA. If NOAA data are modified, the result must not be stated or
implied to be original, unaltered NOAA data.

Reprojection to EPSG:3857, terrain-RGB encoding, and any shader
hillshade or hypsometric colouring are modifications. Tiles produced
that way are derived products. Label them as derived. Do not put a
“NOAA National Bathymetric Source” title on a terrain-RGB PNG without
the derived-product qualifier.

Synthetic tiles produced by `cmd/tiler synth` are not NOAA data and
must not carry NOAA attribution.

---

## What we will record at first pull

For each object:

1. Bucket / URL and full key
2. `ETag` or checksum
3. Retrieval date (UTC)
4. NESDIS Notice of Changes check date (same day)
5. Licence string as posted on that date
6. Whether the file was altered before commit (it should not be
   committed raw; `data/raw/` is gitignored)

Do not vendor multi-gigabyte rasters. Commit the script, the
manifest, and the licence note.
