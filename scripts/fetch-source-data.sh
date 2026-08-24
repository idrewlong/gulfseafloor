#!/usr/bin/env bash
# Pull (or discover) public NOAA bathymetry for the Mississippi Sound AOI.
#
# Hard rule: --no-sign-request only. Never configure keys, never aws s3 sync
# an entire bucket, never follow a login/EULA/.mil/DTED-2+/NGA-restricted path.
#
# NESDIS Notice of Changes — check before treating a product as current:
#   https://www.nesdis.noaa.gov/notice-of-changes
# Record the retrieval date in docs/data-sources.md when a raster is committed
# to the provenance log (this script does not write docs/).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${ROOT}/data/raw"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# WGS84 AOI: Mississippi Sound, Lake Borgne to Dauphin Island.
AOI_WEST="-89.70"
AOI_SOUTH="29.95"
AOI_EAST="-87.85"
AOI_NORTH="30.52"

NBS_BUCKET="s3://noaa-ocs-nationalbathymetry-pds"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
# Refuse a blind multi-gigabyte copy. Print the exact cp command instead.
MAX_COPY_BYTES=$((1024 * 1024 * 1024))

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found. Install AWS CLI v2; no account or keys are required." >&2
  echo "  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  echo "This script lists public NOAA buckets with --no-sign-request only." >&2
  echo "Do not run aws configure and do not add access keys for this pipeline." >&2
  exit 1
fi

echo "Operator reminder: NOAA has been retiring products via NESDIS Notice of Changes."
echo "  https://www.nesdis.noaa.gov/notice-of-changes"
echo "Do not treat a listed key as current until that page is checked."
echo
echo "AOI (WGS84): ${AOI_WEST}, ${AOI_SOUTH}, ${AOI_EAST}, ${AOI_NORTH}"
echo

echo "---- Phase 0: list five public NOAA buckets ----"
"${SCRIPT_DIR}/list-buckets.sh"
echo "---- end bucket listing ----"
echo

# --- NBS discovery ----------------------------------------------------------
# NOAA key layouts change. List shallowly, print what we found, and only copy
# a GeoTIFF when a single reasonably sized AOI candidate is obvious.

s3_ls() {
  aws s3 ls --no-sign-request --region "${REGION}" "$1"
}

is_raster_key() {
  local lc
  lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${lc}" in
    *.tif|*.tiff|*.cog) return 0 ;;
    *) return 1 ;;
  esac
}

# Higher score = more likely to cover the Mississippi Sound AOI.
score_key() {
  local lc score
  lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  score=0
  if ! is_raster_key "${lc}"; then
    echo 0
    return
  fi
  score=1
  case "${lc}" in
    *utm16*|*16n*|*zone16*) score=$((score + 5)) ;;
  esac
  case "${lc}" in
    *gulf*|*gom*|*bight*|*mississipp*|*alabama*|*louisiana*|*mobile*|*pascagoula*)
      score=$((score + 4))
      ;;
  esac
  if printf '%s' "${lc}" | grep -Eq 'n0?(28|29|30)[^0-9]*w0?(88|89|90)'; then
    score=$((score + 10))
  fi
  if printf '%s' "${lc}" | grep -Eq 'w0?(88|89|90)[^0-9]*n0?(28|29|30)'; then
    score=$((score + 10))
  fi
  echo "${score}"
}

prefix_looks_useful() {
  local lc
  lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${lc}" in
    *tif*|*tiff*|*geotiff*|*cog*|*tiled*|*nbs*|*bag*|*utm16*|*16n*|*gulf*|*gom*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Parse `aws s3 ls` object lines: DATE TIME SIZE KEY-OR-NAME
# Prefix lines contain " PRE ".
print_human_next_steps() {
  echo
  echo "Could not automatically identify a single NBS GeoTIFF covering the AOI."
  echo "NOAA key layouts change; inspect the listing above, then run one of:"
  echo
  echo "  aws s3 ls --no-sign-request --region ${REGION} ${NBS_BUCKET}/"
  echo "  aws s3 ls --no-sign-request --region ${REGION} --recursive ${NBS_BUCKET}/<promising-prefix>/ | grep -iE 'tif|cog'"
  echo
  echo "When you have a key that overlaps ${AOI_WEST} ${AOI_SOUTH} ${AOI_EAST} ${AOI_NORTH}:"
  echo
  echo "  mkdir -p ${DEST_DIR}"
  echo "  aws s3 cp --no-sign-request --region ${REGION} \\"
  echo "    ${NBS_BUCKET}/<path-to-tile>.tiff \\"
  echo "    ${DEST_DIR}/"
  echo
  echo "Do not 'aws s3 sync' the whole bucket. Then:"
  echo "  ./scripts/build-tiles.sh ${DEST_DIR}/<file>.tiff"
  echo
  echo "Offline fallback (no NOAA download): make tiles"
}

echo "---- NBS prefix discovery (${NBS_BUCKET}) ----"
echo "Listing top-level keys (layouts change; this is informational):"
if ! root_listing="$(s3_ls "${NBS_BUCKET}/")"; then
  echo "WARN: could not list ${NBS_BUCKET}/" >&2
  print_human_next_steps
  exit 0
fi
printf '%s\n' "${root_listing}"
echo

# Collect first-level prefixes and any rasters sitting at the bucket root.
prefixes=()
# candidate records: score|size|key
candidates=()

while IFS= read -r line || [ -n "${line}" ]; do
  [ -z "${line}" ] && continue
  case "${line}" in
    *' PRE '*)
      pre="${line#* PRE }"
      pre="${pre%"${pre##*[![:space:]]}"}"
      prefixes+=("${pre}")
      ;;
    *)
      size="$(printf '%s\n' "${line}" | awk '{print $3}')"
      name="$(printf '%s\n' "${line}" | awk '{print $4}')"
      if is_raster_key "${name}"; then
        sc="$(score_key "${name}")"
        candidates+=("${sc}|${size}|${name}")
      fi
      ;;
  esac
done <<EOF
${root_listing}
EOF

echo "Top-level prefixes found:"
if [ "${#prefixes[@]}" -eq 0 ]; then
  echo "  (none)"
else
  for pre in "${prefixes[@]}"; do
    echo "  ${pre}"
  done
fi
echo

# One extra listing level — enough to see how the bucket is organised without
# walking hundreds of thousands of objects.
child_prefixes=()
for pre in "${prefixes[@]}"; do
  echo "Listing ${NBS_BUCKET}/${pre}"
  if ! child_listing="$(s3_ls "${NBS_BUCKET}/${pre}")"; then
    echo "  WARN: list failed"
    echo
    continue
  fi
  printf '%s\n' "${child_listing}"
  echo
  while IFS= read -r line || [ -n "${line}" ]; do
    [ -z "${line}" ] && continue
    case "${line}" in
      *' PRE '*)
        child="${line#* PRE }"
        child="${child%"${child##*[![:space:]]}"}"
        child_prefixes+=("${pre}${child}")
        ;;
      *)
        size="$(printf '%s\n' "${line}" | awk '{print $3}')"
        name="$(printf '%s\n' "${line}" | awk '{print $4}')"
        if is_raster_key "${name}"; then
          key="${pre}${name}"
          sc="$(score_key "${key}")"
          candidates+=("${sc}|${size}|${key}")
        fi
        ;;
    esac
  done <<EOF
${child_listing}
EOF
done

# One more level, but only under prefixes that look like raster product trees.
for pre in "${child_prefixes[@]}"; do
  if ! prefix_looks_useful "${pre}"; then
    continue
  fi
  echo "Listing promising prefix ${NBS_BUCKET}/${pre}"
  if ! deep_listing="$(s3_ls "${NBS_BUCKET}/${pre}")"; then
    echo "  WARN: list failed"
    echo
    continue
  fi
  printf '%s\n' "${deep_listing}"
  echo
  while IFS= read -r line || [ -n "${line}" ]; do
    [ -z "${line}" ] && continue
    case "${line}" in
      *' PRE '*) ;;
      *)
        size="$(printf '%s\n' "${line}" | awk '{print $3}')"
        name="$(printf '%s\n' "${line}" | awk '{print $4}')"
        if is_raster_key "${name}"; then
          key="${pre}${name}"
          sc="$(score_key "${key}")"
          candidates+=("${sc}|${size}|${key}")
        fi
        ;;
    esac
  done <<EOF
${deep_listing}
EOF
done

echo "Raster candidates scored against the AOI (score|bytes|key):"
if [ "${#candidates[@]}" -eq 0 ]; then
  echo "  (none visible in the first two listing levels)"
  print_human_next_steps
  exit 0
fi

best_score=0
best_count=0
best_size=""
best_key=""
for rec in "${candidates[@]}"; do
  echo "  ${rec}"
  sc="${rec%%|*}"
  rest="${rec#*|}"
  size="${rest%%|*}"
  key="${rest#*|}"
  if [ "${sc}" -gt "${best_score}" ]; then
    best_score="${sc}"
    best_count=1
    best_size="${size}"
    best_key="${key}"
  elif [ "${sc}" -eq "${best_score}" ] && [ "${key}" != "${best_key}" ]; then
    best_count=$((best_count + 1))
  fi
done
echo

# score 1 is "it is a GeoTIFF" with no geographic hint — not enough to copy.
if [ "${best_score}" -lt 5 ] || [ "${best_count}" -ne 1 ]; then
  echo "No unique AOI-overlapping candidate (best score=${best_score}, ties=${best_count})."
  print_human_next_steps
  exit 0
fi

case "${best_size}" in
  ''|*[!0-9]*)
    echo "Candidate ${best_key} has an unparsed size (${best_size}); refusing automatic copy."
    print_human_next_steps
    echo "If this key is the right tile:"
    echo "  aws s3 cp --no-sign-request --region ${REGION} ${NBS_BUCKET}/${best_key} ${DEST_DIR}/"
    exit 0
    ;;
esac

if [ "${best_size}" -ge "${MAX_COPY_BYTES}" ]; then
  echo "Candidate ${best_key} is ${best_size} bytes (>= 1 GiB). Refusing a blind download."
  echo "If you have inspected the object and still want it:"
  echo "  mkdir -p ${DEST_DIR}"
  echo "  aws s3 cp --no-sign-request --region ${REGION} ${NBS_BUCKET}/${best_key} ${DEST_DIR}/"
  echo "  ./scripts/build-tiles.sh ${DEST_DIR}/$(basename "${best_key}")"
  exit 0
fi

mkdir -p "${DEST_DIR}"
dest="${DEST_DIR}/$(basename "${best_key}")"
echo "Copying unique AOI candidate (score=${best_score}, ${best_size} bytes):"
echo "  ${NBS_BUCKET}/${best_key}"
echo "  -> ${dest}"
aws s3 cp --no-sign-request --region "${REGION}" "${NBS_BUCKET}/${best_key}" "${dest}"
echo
echo "Record the retrieval date and this key in docs/data-sources.md."
echo "Re-check NESDIS Notice of Changes before treating the file as current."
echo "Next: ./scripts/build-tiles.sh ${dest}"
