// Command server is the Gulf Seafloor Viewer tile + API host.
//
// Static assets: disk GULF_WEB_DIR (default web/dist) if index.html exists,
// otherwise the embed of cmd/server/assets (placeholder locally; real SPA
// is copied over that directory during the Docker build).
package main

import (
	"context"
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/server"
)

//go:embed all:assets
var embeddedAssets embed.FS

func main() {
	setupLog()

	webFS, err := fs.Sub(embeddedAssets, "assets")
	if err != nil {
		slog.Error("embed assets", "err", err)
		os.Exit(1)
	}

	addr := env("GULF_ADDR", ":8080")
	cfg := server.Config{
		TileDir:         env("GULF_TILE_DIR", "data/tiles"),
		WebDir:          env("GULF_WEB_DIR", "web/dist"),
		Embed:           webFS,
		CORSOrigin:      os.Getenv("GULF_CORS_ORIGIN"),
		TileWorkers:     envInt("GULF_TILE_WORKERS", 0),
		ImageryEnabled:  os.Getenv("GULF_IMAGERY") != "0",
		ImageryTemplate: os.Getenv("GULF_IMAGERY_URL"),
		OceanDir:        env("GULF_OCEAN_DIR", "data/ocean"),
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           server.New(cfg),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening",
			"addr", addr,
			"tile_dir", cfg.TileDir,
			"web_dir", cfg.WebDir,
		)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			slog.Error("listen", "err", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown", "err", err)
			os.Exit(1)
		}
	}
}

func setupLog() {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo}
	var h slog.Handler
	if os.Getenv("LOG_FORMAT") == "json" {
		h = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(h))
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil {
			return n
		}
	}
	return fallback
}
