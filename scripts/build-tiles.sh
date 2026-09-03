#!/usr/bin/env bash
# Real-data GDAL path: GeoTIFF → EPSG:3857 AOI clip → terrain-RGB → XYZ tiles.
# If GDAL / rio are missing, use the synthetic Go tiler: `make tiles`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW_DIR="${ROOT}/data/raw"
WORK_DIR="${ROOT}/data/work"
TILE_DIR="${ROOT}/data/tiles"

AOI_WEST="-90.20"
AOI_SOUTH="29.50"
AOI_EAST="-87.45"
AOI_NORTH="30.78"

WARPED="${WORK_DIR}/aoi_3857.tiff"
RGB="${WORK_DIR}/terrain_rgb.tiff"

need_gdal() {
  echo "GDAL / rio-rgbify are not available on this machine." >&2
  echo "The real-data pipeline needs gdalinfo, gdalwarp, gdal2tiles.py, and rio rgbify." >&2
  echo >&2
  echo "Offline fallback (synthetic tiles, no NOAA download):" >&2
  echo "  make tiles" >&2
  echo >&2
  echo "That runs: go run ./cmd/tiler synth" >&2
  exit 1
}

process_count() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu
  else
    echo 4
  fi
}

for bin in gdalinfo gdalwarp; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    need_gdal
  fi
done

if command -v gdal2tiles.py >/dev/null 2>&1; then
  GDAL2TILES="gdal2tiles.py"
elif command -v gdal2tiles >/dev/null 2>&1; then
  GDAL2TILES="gdal2tiles"
else
  need_gdal
fi

if ! command -v rio >/dev/null 2>&1; then
  need_gdal
fi

SRC="${1:-}"
if [ -z "${SRC}" ]; then
  shopt -s nullglob
  candidates=("${RAW_DIR}"/*.tif "${RAW_DIR}"/*.tiff "${RAW_DIR}"/*.TIF "${RAW_DIR}"/*.TIFF)
  shopt -u nullglob
  if [ "${#candidates[@]}" -eq 0 ]; then
    echo "No source GeoTIFF. Pass a path or place one in ${RAW_DIR}/." >&2
    echo "  ./scripts/fetch-source-data.sh" >&2
    echo "Offline fallback: make tiles" >&2
    exit 1
  fi
  SRC="${candidates[0]}"
  if [ "${#candidates[@]}" -gt 1 ]; then
    echo "Multiple rasters in ${RAW_DIR}/; using ${SRC}"
    echo "Pass an explicit path to override."
  fi
fi

if [ ! -f "${SRC}" ]; then
  echo "Source raster not found: ${SRC}" >&2
  exit 1
fi

mkdir -p "${WORK_DIR}" "${TILE_DIR}"

echo "==> gdalinfo -stats ${SRC}"
gdalinfo -stats "${SRC}"

echo "==> gdalwarp → ${WARPED}  (EPSG:3857, AOI ${AOI_WEST} ${AOI_SOUTH} ${AOI_EAST} ${AOI_NORTH})"
gdalwarp -overwrite \
  -t_srs EPSG:3857 \
  -te_srs EPSG:4326 \
  -te "${AOI_WEST}" "${AOI_SOUTH}" "${AOI_EAST}" "${AOI_NORTH}" \
  -r cubic \
  -dstnodata -9999 \
  "${SRC}" "${WARPED}"

echo "==> rio rgbify -b -10000 -i 0.1 → ${RGB}"
rm -f "${RGB}"
rio rgbify -b -10000 -i 0.1 "${WARPED}" "${RGB}"

PROCS="$(process_count)"
echo "==> ${GDAL2TILES} --xyz -z 6-13 --processes=${PROCS} → ${TILE_DIR}"
"${GDAL2TILES}" --xyz -z 6-13 --processes="${PROCS}" "${RGB}" "${TILE_DIR}"

echo
echo "Tiles written to ${TILE_DIR}"
echo "Verify a known pixel against the warped (pre-rgbify) raster:"
echo "  python3 ${ROOT}/scripts/verify_terrain_rgb.py ${TILE_DIR}/<z>/<x>/<y>.png"
echo "  gdallocationinfo -wgs84 -valonly ${WARPED} <lon> <lat>"
