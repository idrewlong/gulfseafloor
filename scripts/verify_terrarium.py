#!/usr/bin/env python3
"""Decode Mapzen Terrarium terrain-RGB pixels to elevation in metres.

Spec formula (projectspec.md § Phase 1, matches internal/terrain):

    elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)

This is the Phase 1 exit criterion: a known RGB triple decodes to a depth
you can check against `gdallocationinfo` on the pre-rgbify GeoTIFF.

Stdlib only. Pillow is optional and used solely when a PNG path is passed.
"""

from __future__ import annotations

import argparse
import sys

OFFSET_METRES = 10000.0
INTERVAL_METRES = 0.1

# Hand-picked (R, G, B) -> metres. Packed integer = (elevation + 10000) / 0.1.
# These are exact at 0.1 m quantisation; the Go tiler uses the same triples.
FIXTURES: tuple[tuple[tuple[int, int, int], float], ...] = (
    ((0, 0, 0), -10000.0),  # scheme floor
    ((0, 0, 1), -9999.9),  # one interval above the floor
    ((1, 134, 160), 0.0),  # sea level; packed = 100000
    ((1, 134, 59), -10.1),  # matches Go TestRoundTripKnownDepths
    ((1, 133, 216), -20.0),  # typical Mississippi Bight shelf
    ((0, 253, 232), -3500.0),  # Sigsbee Deep, rounded
)


def decode_terrarium(r: int, g: int, b: int) -> float:
    """Return elevation in metres from an 8-bit Terrarium RGB triple."""
    if not all(0 <= c <= 255 for c in (r, g, b)):
        raise ValueError(f"RGB components must be 0–255, got {(r, g, b)}")
    packed = (r * 256 * 256) + (g * 256) + b
    return -OFFSET_METRES + (packed * INTERVAL_METRES)


def assert_fixtures() -> None:
    """Fail loudly if the spec formula does not hold for the known triples."""
    for (r, g, b), want in FIXTURES:
        got = decode_terrarium(r, g, b)
        if abs(got - want) > 1e-9:
            raise AssertionError(
                f"Terrarium decode ({r},{g},{b}): got {got} m, want {want} m"
            )


def _pixel_rgb(pixel: object) -> tuple[int, int, int]:
    if isinstance(pixel, (tuple, list)) and len(pixel) >= 3:
        return int(pixel[0]), int(pixel[1]), int(pixel[2])
    raise TypeError(
        f"pixel 0,0 is not an RGB(A) triple ({type(pixel).__name__}={pixel!r}); "
        "need a 3-band Terrarium PNG"
    )


def decode_png_origin(path: str) -> tuple[tuple[int, int, int], float]:
    """Decode pixel (0, 0) of a Terrarium PNG. Requires Pillow if a PNG is given."""
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError(
            "Pillow is not installed; cannot open a PNG. "
            "Fixtures still pass without it. Optional: pip install Pillow"
        ) from exc

    with Image.open(path) as img:
        rgb = img.convert("RGB")
        return _decode_origin_from_rgb(rgb.getpixel((0, 0)))


def _decode_origin_from_rgb(pixel: object) -> tuple[tuple[int, int, int], float]:
    rgb = _pixel_rgb(pixel)
    return rgb, decode_terrarium(*rgb)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Decode Terrarium RGB to elevation (metres)."
    )
    parser.add_argument(
        "png",
        nargs="?",
        help="optional Terrarium PNG; decodes pixel (0, 0) if Pillow is installed",
    )
    args = parser.parse_args(argv)

    assert_fixtures()
    print("verify_terrarium: all fixtures passed")
    for (r, g, b), metres in FIXTURES:
        print(f"  ({r:>3},{g:>3},{b:>3}) -> {metres:g} m")

    if args.png:
        try:
            (r, g, b), metres = decode_png_origin(args.png)
        except RuntimeError as exc:
            print(exc, file=sys.stderr)
            return 2
        except FileNotFoundError:
            print(f"PNG not found: {args.png}", file=sys.stderr)
            return 2
        except OSError as exc:
            print(f"Could not read {args.png}: {exc}", file=sys.stderr)
            return 2
        print(f"pixel (0,0) of {args.png}: RGB=({r},{g},{b}) elevation={metres:g} m")
        print(
            "Compare a geographic sample against the pre-rgbify raster, e.g.:\n"
            "  gdallocationinfo -wgs84 -valonly data/work/aoi_3857.tiff <lon> <lat>"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
