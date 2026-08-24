.PHONY: test tiles web server run tidy

DATA_DIR ?= data/tiles
BIN ?= gulf-viewer

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
