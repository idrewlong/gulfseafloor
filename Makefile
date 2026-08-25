.PHONY: test tiles web server run tidy ocean

DATA_DIR ?= data/tiles
BIN ?= gulf-viewer
HYCOM_NCSS ?=

test:
	go test ./...

ZMIN ?= 6
ZMAX ?= 14

tiles:
	go run ./cmd/tiler synth -out $(DATA_DIR) -zmin $(ZMIN) -zmax $(ZMAX)

web:
	cd web && npm install && npm run build

server:
	go build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/server

run: tiles web server
	./$(BIN)

tidy:
	go test ./...
	cd web && npm run build

ocean:
	@test -n "$(HYCOM_NCSS)" || (echo "set HYCOM_NCSS to a THREDDS NCSS URL"; exit 2)
	go run ./cmd/ocean -out data/ocean -hycom-url "$(HYCOM_NCSS)"
