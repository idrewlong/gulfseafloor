#!/usr/bin/env python3
"""Simplify OSM coastline/island/bay geometry into outlines.json.

Reads internal/shelf/osm/ (Overpass + Nominatim GeoJSON, ODbL), written by
scripts/fetch-osm-outlines.sh. Depths stay synthetic.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OSM = HERE / "osm"
OUT_GO = HERE / "outlines.json"
OUT_WEB = HERE.parents[1] / "web/src/geo/sound-outlines.json"

EPS_ISLAND = 0.00045  # ~45 m
EPS_BAY = 0.00075
# Marsh islets are small, so they are simplified far less than the barrier
# chain: 45 m would collapse most of them to a triangle.
EPS_MARSH = 0.00018  # ~18 m
# Closed coastline ways below this are dropped. The Louisiana marsh has 8543 of
# them holding 430 km2 of land; the 1248 at or above 0.025 km2 carry 95% of that
# area, which keeps the ring count and the index cost bounded. A 0.025 km2 islet
# is about 160 m across — 20 px at z14, so still worth drawing.
MIN_MARSH_AREA_M2 = 25_000.0
# The heightfield samples the coast down to z14 (~8 m/px), so the waterline the
# Go sampler reads is kept near that. The browser only strokes it as an overlay
# line, so it gets a much coarser copy to keep the bundle small.
EPS_COAST_GO = 0.00008  # ~9 m
EPS_COAST_WEB = 0.0006  # ~65 m

# The mainland ring closes outside every coastline node so the synthetic edges
# can never be the nearest "shore" to a sampled point.
#
# These were once fixed at -90.35/-87.30/31.05, which were the bounds of the
# original chart. They are not derived from the chart, so when it widened they
# silently became a clip: land west of -90.35 (Houma, Thibodaux, Morgan City)
# and east of -87.30 (Navarre, the Florida panhandle) fell outside the ring and
# sampled as open water. The closure is now taken from the stitched coastline
# itself, which always runs past the chart edges, so it cannot fall behind.
CLOSE_MARGIN = 0.25


def perp_dist(p, a, b) -> float:
    x, y = p
    x1, y1 = a
    x2, y2 = b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def rdp(pts: list[list[float]], eps: float) -> list[list[float]]:
    """Ramer–Douglas–Peucker. Iterative: the stitched coastline is ~26k points,
    which overflows Python's recursion limit."""
    if len(pts) < 3:
        return pts
    closed = pts[0] == pts[-1]
    work = pts[:-1] if closed else list(pts)
    if len(work) < 3:
        return [[round(float(x), 6), round(float(y), 6)] for x, y in pts]

    keep = [False] * len(work)
    keep[0] = keep[-1] = True
    stack = [(0, len(work) - 1)]
    while stack:
        s, e = stack.pop()
        dmax, idx = 0.0, s
        for i in range(s + 1, e):
            d = perp_dist(work[i], work[s], work[e])
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))

    out = [work[i] for i in range(len(work)) if keep[i]]
    if closed and out[0] != out[-1]:
        out.append(out[0][:])
    return [[round(float(x), 6), round(float(y), 6)] for x, y in out]


def load(name: str) -> dict:
    return json.loads((OSM / name).read_text())


def pick_feature(fc: dict, *, addresstype: str | None = None, skip_admin: bool = False) -> dict:
    for f in fc["features"]:
        g = f.get("geometry") or {}
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        props = f.get("properties") or {}
        if skip_admin and props.get("type") == "administrative":
            continue
        if addresstype and props.get("addresstype") != addresstype and props.get("type") != addresstype:
            continue
        return f
    raise SystemExit(f"no matching polygon in {fc.get('features', [{}])[0].get('properties')}")


def outer_rings(f: dict) -> list[list[list[float]]]:
    g = f["geometry"]
    if g["type"] == "Polygon":
        return [g["coordinates"][0]]
    return [poly[0] for poly in g["coordinates"]]


def simplify_rings(rings: list[list[list[float]]], eps: float) -> list[list[list[float]]]:
    out: list[list[list[float]]] = []
    for r in rings:
        s = rdp(r, eps)
        if len(s) >= 4:
            out.append(s)
    return out


ROUND_ISLAND = [
    [-88.595, 30.292],
    [-88.586, 30.298],
    [-88.576, 30.296],
    [-88.575, 30.290],
    [-88.584, 30.286],
    [-88.594, 30.288],
    [-88.595, 30.292],
]


M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(29.64))


def ring_area_m2(ring: list[list[float]]) -> float:
    """Shoelace area on the local metric plane. Sign is dropped."""
    total = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * M_PER_DEG_LON, ring[i][1] * M_PER_DEG_LAT
        x2, y2 = ring[i + 1][0] * M_PER_DEG_LON, ring[i + 1][1] * M_PER_DEG_LAT
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def marsh_islands() -> list[list[list[float]]]:
    """Closed natural=coastline ways, which are land.

    These used to be thrown away wholesale. That was harmless in the
    Mississippi Sound, where the only closed ways were the handful of barrier
    islands already fetched by name. West of the delta it is not: the
    Louisiana marsh is a maze of 8543 closed ways carrying 430 km2 of land,
    and dropping them punched that much open water through the chart.

    Every closed coastline way in the dump winds counter-clockwise, i.e. land
    inside. A clockwise ring would be water enclosed by land and must not
    become an island, so the winding is checked rather than assumed.
    """
    elements = json.loads((OSM / "coastline.json").read_text())["elements"]
    out: list[list[list[float]]] = []
    skipped_cw = 0
    for el in elements:
        geom = el.get("geometry") or []
        if len(geom) < 4:
            continue
        pts = [[round(float(n["lon"]), 7), round(float(n["lat"]), 7)] for n in geom]
        if pts[0] != pts[-1]:
            continue
        signed = 0.0
        for i in range(len(pts) - 1):
            x1, y1 = pts[i][0] * M_PER_DEG_LON, pts[i][1] * M_PER_DEG_LAT
            x2, y2 = pts[i + 1][0] * M_PER_DEG_LON, pts[i + 1][1] * M_PER_DEG_LAT
            signed += x1 * y2 - x2 * y1
        if signed <= 0:
            skipped_cw += 1
            continue
        if ring_area_m2(pts) < MIN_MARSH_AREA_M2:
            continue
        simple = rdp(pts, EPS_MARSH)
        if len(simple) < 4:
            continue
        if simple[0] != simple[-1]:
            simple.append(simple[0])
        out.append(simple)
    if skipped_cw:
        print(f"marsh    skipped {skipped_cw} clockwise (water) rings", file=sys.stderr)
    return out


def coastline_chains() -> list[list[list[float]]]:
    """Stitch natural=coastline ways head-to-tail into continuous paths.

    Overpass returns the coastline as several hundred fragments in arbitrary
    order. Closed fragments are islands and are handled by marsh_islands()
    rather than stitched; the named barrier islands come from their own
    Nominatim polygons.
    """
    elements = json.loads((OSM / "coastline.json").read_text())["elements"]
    pieces: list[list[list[float]]] = []
    for el in elements:
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        pts = [[round(float(n["lon"]), 7), round(float(n["lat"]), 7)] for n in geom]
        if pts[0] != pts[-1]:
            pieces.append(pts)

    by_start: dict[tuple[float, float], list[int]] = {}
    by_end: dict[tuple[float, float], list[int]] = {}
    for i, p in enumerate(pieces):
        by_start.setdefault(tuple(p[0]), []).append(i)
        by_end.setdefault(tuple(p[-1]), []).append(i)

    unused = set(range(len(pieces)))
    chains: list[list[list[float]]] = []
    while unused:
        chain = pieces[unused.pop()]
        growing = True
        while growing:
            growing = False
            for idx in by_start.get(tuple(chain[-1]), []):
                if idx in unused:
                    unused.discard(idx)
                    chain = chain + pieces[idx][1:]
                    growing = True
                    break
            if growing:
                continue
            for idx in by_end.get(tuple(chain[0]), []):
                if idx in unused:
                    unused.discard(idx)
                    chain = pieces[idx][:-1] + chain
                    growing = True
                    break
        chains.append(chain)
    chains.sort(key=len, reverse=True)
    return chains


def mainland_ring(coast: list[list[float]]) -> list[list[float]]:
    """Close the open waterline into a polygon whose interior is the land.

    OSM draws the coastline with land on the left, so the Sound-facing shore
    runs west → east and everything north of it is mainland. The closure is
    placed outside the coastline's own extent, so it encloses every node no
    matter how far the chart reaches; shelf.Sample measures shore distance
    against the waterline alone, so these three synthetic edges never act as
    a coast.
    """
    start, end = coast[0], coast[-1]
    close_west = min(p[0] for p in coast) - CLOSE_MARGIN
    close_east = max(p[0] for p in coast) + CLOSE_MARGIN
    close_north = max(p[1] for p in coast) + CLOSE_MARGIN
    print(
        f"mainland closes at west {close_west:.3f}, east {close_east:.3f}, "
        f"north {close_north:.3f}",
        file=sys.stderr,
    )
    return [p[:] for p in coast] + [
        [close_east, end[1]],
        [close_east, close_north],
        [close_west, close_north],
        [close_west, start[1]],
        start[:],
    ]


def main() -> None:
    cat = simplify_rings(outer_rings(pick_feature(load("cat.json"))), EPS_ISLAND)
    horn = simplify_rings(outer_rings(pick_feature(load("horn.json"))), EPS_ISLAND)
    petit = simplify_rings(outer_rings(pick_feature(load("petit.json"))), EPS_ISLAND)
    ship = simplify_rings(outer_rings(pick_feature(load("ship.json"))), EPS_ISLAND)
    dauphin = simplify_rings(outer_rings(pick_feature(load("dauphin.json"), skip_admin=True)), EPS_ISLAND)
    deer = simplify_rings(outer_rings(pick_feature(load("deer.json"))), EPS_ISLAND)
    # Nominatim returns Grand Isle twice: the town polygon and a bare island
    # point. The town covers the whole barrier island, so take the polygon.
    grand_isle = simplify_rings(outer_rings(pick_feature(load("grandisle.json"))), EPS_ISLAND)
    point_au_fer = simplify_rings(outer_rings(pick_feature(load("pointaufer.json"))), EPS_ISLAND)
    stlouis = simplify_rings(outer_rings(pick_feature(load("stlouis.json"))), EPS_BAY)
    mobile = simplify_rings(outer_rings(pick_feature(load("mobile.json"))), EPS_BAY)
    pontchartrain = simplify_rings(outer_rings(pick_feature(load("pontchartrain.json"))), EPS_BAY)
    perdido = simplify_rings(outer_rings(pick_feature(load("perdido.json"))), EPS_BAY)

    west_ship = ship[0]
    east_ship = ship[1] if len(ship) > 1 else []
    # West Ship is the western polygon (more negative lon).
    if east_ship and west_ship:
        def midlon(r: list[list[float]]) -> float:
            return sum(p[0] for p in r) / len(r)

        if midlon(west_ship) > midlon(east_ship):
            west_ship, east_ship = east_ship, west_ship

    raw_coast = coastline_chains()[0]
    coast = rdp(raw_coast, EPS_COAST_GO)
    marsh = marsh_islands()

    attribution = (
        "Coastline, island and bay outlines © OpenStreetMap contributors (ODbL). "
        "Depths are synthetic; not NOAA survey data."
    )
    islands = {
        "cat": cat[0],
        "westShip": west_ship,
        "eastShip": east_ship,
        "horn": horn[0],
        "petitBois": petit[0],
        "dauphin": dauphin[0],
        "deer": deer[0],
        "round": ROUND_ISLAND,
        "grandIsle": grand_isle[0],
        "pointAuFer": point_au_fer[0],
    }
    # Back Bay of Biloxi and the Pascagoula River mouth used to be hand-typed
    # boxes here, and they drowned Ocean Springs, D'Iberville and Pascagoula.
    # The real coastline already carves them out of the mainland, so `bays`
    # now only shapes the depth profile of water that is already water.
    payload = {
        "attribution": attribution,
        "coast": coast,
        "marsh": marsh,
        "mainland": mainland_ring(coast),
        "bays": stlouis + mobile + pontchartrain + perdido,
        "islands": islands,
    }
    text = json.dumps(payload, separators=(",", ":"))
    OUT_GO.write_text(text)

    # The browser only strokes the waterline as an overlay, and does not use
    # the mainland ring or the bays at all.
    web_payload = {
        "attribution": attribution,
        "coast": rdp(raw_coast, EPS_COAST_WEB),
        "islands": islands,
    }
    web_text = json.dumps(web_payload, separators=(",", ":"))
    OUT_WEB.parent.mkdir(parents=True, exist_ok=True)
    OUT_WEB.write_text(web_text)

    print(f"coast    {len(raw_coast):6d} raw -> {len(coast)} go / {len(web_payload['coast'])} web")
    print(f"marsh    {len(marsh)} rings, {sum(len(r) for r in marsh)} pts, "
          f"{sum(ring_area_m2(r) for r in marsh) / 1e6:.0f} km2 of land recovered")
    print(f"mainland {len(payload['mainland']):6d} pts")
    for k, v in islands.items():
        print(f"  {k:10} {len(v):4d} pts")
    print("  bays     ", [len(b) for b in payload["bays"]])
    print(f"bytes    go {len(text)}  web {len(web_text)}")


if __name__ == "__main__":
    main()
