#!/usr/bin/env bash
# Fetch the OpenStreetMap source geometry that internal/shelf/gen_outlines.py
# simplifies into outlines.json.
#
#   scripts/fetch-osm-outlines.sh
#
# Output lands in internal/shelf/osm/, which is gitignored: the raw dumps are
# large and re-fetchable, only the simplified outlines.json is committed.
#
# Data © OpenStreetMap contributors, ODbL 1.0 (https://osm.org/copyright).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OSM_DIR="$ROOT/internal/shelf/osm"
UA="gulf-seafloor-viewer/0.2 (outline build; https://github.com/idrewlong/gulfseafloor)"

OVERPASS="${OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
NOMINATIM="${NOMINATIM_URL:-https://nominatim.openstreetmap.org/search}"

# Generous margin around the AOI (-90.20,29.50,-87.45,30.78) so the stitched
# coastline runs past both ends and the mainland ring can close outside it.
COAST_BBOX="29.40,-90.40,30.95,-87.30"

mkdir -p "$OSM_DIR"

fetch_nominatim() {
	local name="$1" query="$2"
	local out="$OSM_DIR/$name.json"
	if [[ -s "$out" ]]; then
		echo "have    $name.json"
		return
	fi
	echo "fetch   $name.json"
	curl -sS --fail --max-time 60 -A "$UA" -G "$NOMINATIM" \
		--data-urlencode "q=$query" \
		--data-urlencode "format=geojson" \
		--data-urlencode "polygon_geojson=1" \
		--data-urlencode "limit=5" \
		-o "$out"
	# Nominatim asks for at most one request per second.
	sleep 1.2
}

echo "fetch   coastline.json (Overpass, bbox $COAST_BBOX)"
curl -sS --fail --max-time 300 -A "$UA" -G "$OVERPASS" \
	--data-urlencode "data=[out:json][timeout:240];way[\"natural\"=\"coastline\"]($COAST_BBOX);out geom;" \
	-o "$OSM_DIR/coastline.json"

fetch_nominatim cat "Cat Island, Harrison County, Mississippi"
fetch_nominatim ship "Ship Island, Harrison County, Mississippi"
fetch_nominatim horn "Horn Island, Jackson County, Mississippi"
fetch_nominatim petit "Petit Bois Island, Jackson County, Mississippi"
fetch_nominatim dauphin "Dauphin Island, Mobile County, Alabama"
fetch_nominatim deer "Deer Island, Biloxi, Mississippi"
fetch_nominatim stlouis "Bay of Saint Louis, Mississippi"
fetch_nominatim mobile "Mobile Bay, Alabama"
fetch_nominatim pontchartrain "Lake Pontchartrain, Louisiana"
fetch_nominatim borgne "Lake Borgne, Louisiana"
fetch_nominatim perdido "Perdido Bay, Alabama"

echo
echo "done. now run: python3 internal/shelf/gen_outlines.py"
