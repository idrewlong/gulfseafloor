.PHONY: test tiles web server run tidy ocean gebco

DATA_DIR ?= data/tiles
BIN ?= gulf-viewer
HYCOM_NCSS ?=

test:
	go test ./...

ZMIN ?= 6
ZMAX ?= 14

tiles:
	@echo "tile synth z$(ZMIN)–$(ZMAX) → $(DATA_DIR)  (often ~20 min; live ETA on stderr)"
	go run ./cmd/tiler synth -out $(DATA_DIR) -zmin $(ZMIN) -zmax $(ZMAX)

web:
	cd web && npm install && npm run build

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
	@echo "clipping GEBCO $(GEBCO_YEAR) to the AOI (~350 range requests, no full download)"
	python3 scripts/fetch-gebco.py --year $(GEBCO_YEAR)

# One-shot seed/refresh of data/ocean; the server's background refresher
# now re-fetches HYCOM currents on its own ~1h ticker while running, so this
# target is the seeding and air-gap path (GULF_OCEAN_REFRESH=0), not the
# only path currents data ever takes.
ocean:
	@test -n "$(HYCOM_NCSS)" || (echo "set HYCOM_NCSS to a THREDDS NCSS URL"; exit 2)
	go run ./cmd/ocean -out data/ocean -hycom-url "$(HYCOM_NCSS)"
