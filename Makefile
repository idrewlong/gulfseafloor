.PHONY: test tiles web server run tidy ocean weather gebco

DATA_DIR ?= data/tiles
BIN ?= gulf-viewer
HYCOM_NCSS ?=

test:
	go test ./...

ZMIN ?= 6
ZMAX ?= 14

tiles:
	@echo "tile synth z$(ZMIN)–$(ZMAX) → $(DATA_DIR)  (live ETA on stderr; the"
	@echo "  ETA extrapolates from cheap low zooms and under-reads badly — z14"
	@echo "  is ~75% of the work. Budget well over the first estimate.)"
	go run ./cmd/tiler synth -out $(DATA_DIR) -zmin $(ZMIN) -zmax $(ZMAX)

# --no-audit is not cosmetic: the audit endpoint is unreachable from here and
# npm blocks on it until fetch-timeout (default 5 min) expires, long after the
# install itself has finished. --no-fund drops another needless round trip.
# Run `npm audit` on its own when you actually want the report.
web:
	cd web && npm install --no-audit --no-fund && npm run build

server:
	go build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/server

# Reuse data/tiles when present. `make tiles` still rebuilds the pyramid.
run: web server
	@if [ ! -d "$(DATA_DIR)/6" ]; then $(MAKE) tiles; fi
	./$(BIN)

tidy:
	go test ./...
	cd web && npm run build

# Re-clip the GEBCO grid. The result is vendored at internal/shelf/gebco.bin,
# so this only needs running to change AOI, resolution, or GEBCO release.
GEBCO_YEAR ?= 2024

gebco:
	@echo "clipping GEBCO $(GEBCO_YEAR) to the AOI (~600 range requests, no full download)"
	python3 scripts/fetch-gebco.py --year $(GEBCO_YEAR) --bbox "$$(go run ./cmd/tiler aoi -format=csv)"

# One-shot seed/refresh of data/ocean. While the server runs it re-fetches
# HYCOM currents (~1h) and NDBC buoys (~10m) on their own tickers, so this
# target is the seeding and air-gap path (GULF_OCEAN_REFRESH=0), not the only
# path either layer's data ever takes.
ocean:
	@test -n "$(HYCOM_NCSS)" || (echo "set HYCOM_NCSS to a THREDDS NCSS URL"; exit 2)
	go run ./cmd/ocean -out data/ocean -hycom-url "$(HYCOM_NCSS)"

# Seeds data/weather with a NOAA radar loop and an NWS gridded forecast.
# Needs no key and no URL: both services are public and unauthenticated.
weather:
	go run ./cmd/weather -out data/weather
