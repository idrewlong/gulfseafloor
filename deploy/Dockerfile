# Multi-stage: static Go binary + optional SPA embed. No shell in the final image.
FROM golang:1.26 AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Prefer a real Vite build when the caller provided web/dist. Local `go build`
# still succeeds with only cmd/server/assets/index.html (the placeholder).
RUN if [ -f web/dist/index.html ]; then \
      rm -rf cmd/server/assets && \
      mkdir -p cmd/server/assets && \
      cp -a web/dist/. cmd/server/assets/; \
    fi

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# Carry the tile pyramid into the image when the caller built one. data/tiles
# is gitignored and takes hours to synth, so it is produced once and copied in
# rather than rebuilt per deploy — the pyramid is a pure function of
# internal/shelf/gebco.bin, internal/shelf/outlines.json and tiles.AOI, so it
# only needs regenerating when one of those changes.
#
# The mkdir keeps the COPY valid on a checkout with no tiles: the server then
# starts and serves an empty pyramid instead of failing the build.
RUN mkdir -p /out/tiles
RUN if [ -d data/tiles ]; then cp -a data/tiles/. /out/tiles/; fi

FROM cgr.dev/chainguard/static:latest
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/tiles /data/tiles
ENV GULF_TILE_DIR=/data/tiles
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
