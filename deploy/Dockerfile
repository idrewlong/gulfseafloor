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

FROM cgr.dev/chainguard/static:latest
COPY --from=build /out/server /server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
