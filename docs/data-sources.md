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

Mississippi Bight, New Orleans to Orange Beach and south to NDBC
42354, WGS84:

| | |
|---|---|
| West | −90.20 |
| South | 29.50 |
| East | −87.45 |
| North | 30.78 |

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
| HYCOM | Public THREDDS NCSS `https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest`. Retrieved 2026-08-26T00:15:02Z (classic NetCDF, surface `vertCoord=0`). Snapshot validTime 2026-08-26T00:00:00Z. | Public model output; distributor terms on the THREDDS node in use. | Acknowledge the HYCOM consortium and the specific run / experiment ID. | No |
| NDBC buoys | [ndbc.noaa.gov](https://www.ndbc.noaa.gov/). No API key. Retrieved 2026-08-26T00:15:02Z via `make ocean`. | NOAA open / NODD-class public data. | Same NODD rules. | No |
| Argo floats | [argo.ucsd.edu](https://argo.ucsd.edu/). NetCDF profiles. | Freely available; collected and distributed by the International Argo Program and contributing national programmes. | Required: “These data were collected and made freely available by the International Argo Program and the national programs that contribute to it. (https://argo.ucsd.edu, https://www.ocean-ops.org). The Argo Program is part of the Global Ocean Observing System.” | No |
| OpenSky Network | `https://opensky-network.org/api/states/all` bbox, anonymous, no key. Live at view time via `/api/aircraft`. | OpenSky terms for non-commercial/research use of the REST API. | Acknowledge The OpenSky Network. No endorsement. Not for navigation. | No |
| adsb.lol | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` fallback only. | ODbL as documented by the API. | Acknowledge adsb.lol / feeders. No endorsement. | No |

Fill the retrieval date in a follow-up commit at first pull, per row,
as an ISO date plus the exact key or URL. Until then leave the
column as the italicised sentence at the top of this section.

---

## Ocean snapshot

HYCOM surface currents and NDBC station observations are not vendored.
`make ocean` writes `data/ocean/{currents,buoys,manifest}.json` (gitignored).
The viewer serves those files at `/api/ocean/*` with no outbound calls, so
a machine that already has a snapshot still works with the network unplugged.

First successful pull: **2026-08-26T00:15:02Z**, dataset `GLBy0.08/latest`,
currents validTime `2026-08-26T00:00:00Z`. Files live in `data/ocean/` (gitignored).

`https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest`

CSV is not offered on that node; `make ocean` requests classic NetCDF
(`accept=netcdf`) and omits `time=latest` (invalid on this FMRC), with
surface `vertCoord=0`. CI does not run `make ocean`.

---

## Live aircraft

Live ADS-B positions are not vendored and are not an ocean-style snapshot.
`GET /api/aircraft` is fetched at view time from The OpenSky Network
(anonymous REST bbox), with adsb.lol as fallback. The server polls only
when a client asks, with a 10 s floor. Anonymous OpenSky allows 400
credits/day; this AOI is about one credit per fetch.

Set `GULF_AIRCRAFT=0` for an air-gap: the route returns 404, the bathymetry
toggle disables, and terrain plus ocean snapshots still work. CI does not
hit the live feeds.

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
