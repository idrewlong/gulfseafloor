#!/usr/bin/env python3
"""Clip the GEBCO global grid to the AOI without downloading all 7.4 GB.

The published grid is a single netCDF-4 file on CEDA. Its `elevation` variable
is contiguous and uncompressed, so the byte offset of any cell is arithmetic:
once h5py reports where the array starts, each AOI row is one HTTP range
request of a few kilobytes. The whole clip costs about 500 KB over ~350
requests instead of a 7.4 GB download.

Writes internal/shelf/gebco.bin (int16 little-endian, row-major, rows south to
north, columns west to east) and internal/shelf/gebco.json beside it.

Usage:
    python3 scripts/fetch-gebco.py            # GEBCO_2024
    python3 scripts/fetch-gebco.py --year 2026

GEBCO is public domain; use requires the attribution recorded in
docs/data-sources.md and carries GEBCO's not-for-navigation disclaimer.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import struct
import sys
import urllib.request
from pathlib import Path

import h5py
import numpy as np

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "internal/shelf"

# internal/tiles.AOI, plus room for the shelf sampler's own pad so bilinear
# interpolation at the AOI edge still has four real corners.
AOI_WEST, AOI_SOUTH, AOI_EAST, AOI_NORTH = -90.20, 29.50, -87.45, 30.78
PAD = 0.08

# GEBCO is a 15 arc-second, pixel-centre-registered global grid.
RES = 1.0 / 240.0
NLON, NLAT = 86400, 43200

TIMEOUT = 120


def grid_url(year: int) -> str:
    base = f"https://dap.ceda.ac.uk/bodc/gebco/global/gebco_{year}/ice_surface_elevation/netcdf"
    # BODC renamed the file after the 2024 release.
    name = "GEBCO_2024_CF.nc" if year == 2024 else f"GEBCO_{year}.nc"
    return f"{base}/{name}"


class RangeReader(io.RawIOBase):
    """Minimal seekable file over HTTP range requests, with a block cache.

    h5py only needs the header and a few dimension scales through this; the
    elevation rows are pulled by explicit range requests below.
    """

    BLOCK = 1 << 18

    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        self.blocks: dict[int, bytes] = {}
        self.requests = 0
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            if r.headers.get("Accept-Ranges") == "none":
                raise SystemExit(f"{url} does not accept range requests")
            self.size = int(r.headers["Content-Length"])

    def get_range(self, start: int, length: int) -> bytes:
        end = start + length - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            if r.status != 206:
                raise SystemExit(f"expected 206 partial content, got {r.status}")
            data = r.read()
        self.requests += 1
        if len(data) != length:
            raise SystemExit(f"short range read: asked {length}, got {len(data)}")
        return data

    def _block(self, n: int) -> bytes:
        if n not in self.blocks:
            start = n * self.BLOCK
            self.blocks[n] = self.get_range(start, min(self.BLOCK, self.size - start))
        return self.blocks[n]

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b) -> int:
        want = min(len(b), self.size - self.pos)
        got = 0
        while got < want:
            blk = self._block((self.pos + got) // self.BLOCK)
            off = (self.pos + got) % self.BLOCK
            take = min(want - got, len(blk) - off)
            b[got:got + take] = blk[off:off + take]
            got += take
        self.pos += got
        return got


def cell_index(value: float, origin: float) -> float:
    """Fractional grid index of a coordinate on a pixel-centre-registered axis."""
    return (value - origin) / RES - 0.5


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2024, help="GEBCO release (default 2024)")
    args = ap.parse_args()

    url = grid_url(args.year)
    print(f"source {url}", file=sys.stderr)

    reader = RangeReader(url)
    print(f"remote size {reader.size / 1e9:.2f} GB", file=sys.stderr)

    with h5py.File(reader, "r") as h:
        elev = h["elevation"]
        if elev.shape != (NLAT, NLON):
            raise SystemExit(f"unexpected grid shape {elev.shape}")
        if elev.chunks is not None or elev.compression is not None:
            raise SystemExit("elevation is chunked or compressed; byte-offset clip will not work")
        if elev.dtype != np.dtype("int16"):
            raise SystemExit(f"expected int16 elevation, got {elev.dtype}")
        base = elev.id.get_offset()
        if base is None:
            raise SystemExit("elevation has no contiguous storage offset")

        # Confirm the registration this script assumes rather than trusting it.
        lat0, lat1 = float(h["lat"][0]), float(h["lat"][-1])
        lon0, lon1 = float(h["lon"][0]), float(h["lon"][-1])

    if lat1 < lat0:
        raise SystemExit("latitude axis runs north to south; row order assumption is wrong")
    for got, want, name in ((lat0, -90 + RES / 2, "lat[0]"), (lon0, -180 + RES / 2, "lon[0]")):
        if abs(got - want) > RES / 100:
            raise SystemExit(f"{name} is {got}, expected pixel-centre {want}")
    print(f"registration ok: lat {lat0:.6f}..{lat1:.6f}, lon {lon0:.6f}..{lon1:.6f}", file=sys.stderr)

    i0 = int(np.floor(cell_index(AOI_WEST - PAD, -180.0)))
    i1 = int(np.ceil(cell_index(AOI_EAST + PAD, -180.0)))
    j0 = int(np.floor(cell_index(AOI_SOUTH - PAD, -90.0)))
    j1 = int(np.ceil(cell_index(AOI_NORTH + PAD, -90.0)))
    cols, rows = i1 - i0 + 1, j1 - j0 + 1
    print(f"clip {cols} x {rows} cells ({cols * rows * 2 / 1024:.0f} KB)", file=sys.stderr)

    out = np.empty((rows, cols), dtype="<i2")
    row_bytes = cols * 2
    for n, j in enumerate(range(j0, j1 + 1)):
        start = base + (j * NLON + i0) * 2
        out[n] = np.frombuffer(reader.get_range(start, row_bytes), dtype="<i2")
        if n % 50 == 0 or n == rows - 1:
            print(f"  row {n + 1}/{rows}", file=sys.stderr)

    west = -180.0 + (i0 + 0.5) * RES
    south = -90.0 + (j0 + 0.5) * RES
    meta = {
        "grid": f"GEBCO_{args.year}",
        "source": url,
        "retrieved": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Ice-surface elevation, metres above MSL, negative down. Public domain; "
                "attribution required. Not for navigation.",
        "west": west,
        "south": south,
        "res": RES,
        "cols": cols,
        "rows": rows,
        "order": "row-major, rows south to north, columns west to east, int16 little-endian",
        "min": int(out.min()),
        "max": int(out.max()),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "gebco.bin").write_bytes(out.tobytes())
    (OUT_DIR / "gebco.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(
        f"wrote {OUT_DIR / 'gebco.bin'} ({rows * row_bytes / 1024:.0f} KB) "
        f"in {reader.requests} range requests; depth range {meta['min']}..{meta['max']} m",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
