#!/usr/bin/env python3
"""Simplify OSM coastline/island/bay geometry into outlines.json.

Reads internal/shelf/osm/ (Overpass + Nominatim GeoJSON, ODbL), written by
scripts/fetch-osm-outlines.sh. Depths stay synthetic.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
OSM = HERE / "osm"
OUT_GO = HERE / "outlines.json"
OUT_WEB = HERE.parents[1] / "web/src/geo/sound-outlines.json"

EPS_ISLAND = 0.00045  # ~45 m
EPS_BAY = 0.00075
# The heightfield samples the coast down to z14 (~8 m/px), so the waterline the
# Go sampler reads is kept near that. The browser only strokes it as an overlay
# line, so it gets a much coarser copy to keep the bundle small.
EPS_COAST_GO = 0.00008  # ~9 m
EPS_COAST_WEB = 0.0006  # ~65 m

# The mainland ring closes outside every coastline node so the synthetic edges
# can never be the nearest "shore" to a sampled point.
CLOSE_WEST = -89.78
CLOSE_EAST = -87.70
CLOSE_NORTH = 30.82


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


def coastline_chains() -> list[list[list[float]]]:
    """Stitch natural=coastline ways head-to-tail into continuous paths.

    Overpass returns the coastline as several hundred fragments in arbitrary
    order. Closed fragments are islands and are dropped — named islands come
    from their own Nominatim polygons.
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
    runs west → east and everything north of it is mainland. The ring is closed
    well outside the AOI; shelf.Sample measures shore distance against the
    waterline alone so these three synthetic edges never act as a coast.
    """
    start, end = coast[0], coast[-1]
    return [p[:] for p in coast] + [
        [CLOSE_EAST, end[1]],
        [CLOSE_EAST, CLOSE_NORTH],
        [CLOSE_WEST, CLOSE_NORTH],
        [CLOSE_WEST, start[1]],
        start[:],
    ]


def main() -> None:
    cat = simplify_rings(outer_rings(pick_feature(load("cat.json"))), EPS_ISLAND)
    horn = simplify_rings(outer_rings(pick_feature(load("horn.json"))), EPS_ISLAND)
    petit = simplify_rings(outer_rings(pick_feature(load("petit.json"))), EPS_ISLAND)
    ship = simplify_rings(outer_rings(pick_feature(load("ship.json"))), EPS_ISLAND)
    dauphin = simplify_rings(outer_rings(pick_feature(load("dauphin.json"), skip_admin=True)), EPS_ISLAND)
    deer = simplify_rings(outer_rings(pick_feature(load("deer.json"))), EPS_ISLAND)
    stlouis = simplify_rings(outer_rings(pick_feature(load("stlouis.json"))), EPS_BAY)
    mobile = simplify_rings(outer_rings(pick_feature(load("mobile.json"))), EPS_BAY)

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
    }
    # Back Bay of Biloxi and the Pascagoula River mouth used to be hand-typed
    # boxes here, and they drowned Ocean Springs, D'Iberville and Pascagoula.
    # The real coastline already carves them out of the mainland, so `bays`
    # now only shapes the depth profile of water that is already water.
    payload = {
        "attribution": attribution,
        "coast": coast,
        "mainland": mainland_ring(coast),
        "bays": stlouis + mobile,
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
    print(f"mainland {len(payload['mainland']):6d} pts")
    for k, v in islands.items():
        print(f"  {k:10} {len(v):4d} pts")
    print("  bays     ", [len(b) for b in payload["bays"]])
    print(f"bytes    go {len(text)}  web {len(web_text)}")


if __name__ == "__main__":
    main()
