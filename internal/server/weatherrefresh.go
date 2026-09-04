package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
	"github.com/idrewlong/gulfseafloor/internal/weather"
)

// startWeatherRefresh primes both weather caches from disk — a pure local
// read, no egress — then, only if refresh is enabled, starts the two poll
// loops. With WeatherRefreshEnabled false the server never contacts NOAA for
// this layer and serves whatever `make weather` last wrote, which is what
// makes the air-gap claim literal here as it is for the ocean layers.
//
// Radar and forecast poll separately because their upstreams move at very
// different rates: the reflectivity mosaic republishes every couple of
// minutes, while the NWS gridded forecast is regenerated about hourly.
func (s *Server) startWeatherRefresh(ctx context.Context) {
	s.primeWeatherCache(weather.RadarManifest, s.wrc)
	s.primeWeatherCache(weather.ForecastManifest, s.wfc)
	if !s.cfg.WeatherRefreshEnabled {
		return
	}
	go refreshLoop(ctx, s.cfg.WeatherFirstRefreshDelay, s.cfg.RadarRefreshEvery, s.refreshRadar)
	// Offset the first forecast poll: one NWS gridpoint pass is a dozen
	// requests, and firing it in the same instant as the radar pull would
	// stack two bursts on boot.
	go refreshLoop(ctx, s.cfg.WeatherFirstRefreshDelay+10*time.Second,
		s.cfg.ForecastRefreshEvery, s.refreshForecast)
}

// primeWeatherCache loads a manifest already on disk into memory. A missing
// or unreadable file just leaves the cache empty; the disk fallback in
// weather.go then answers, and an absent snapshot is a 404, not an error.
func (s *Server) primeWeatherCache(file string, cache *etagCache) {
	body, err := os.ReadFile(filepath.Join(s.cfg.WeatherDir, file))
	if err != nil {
		return
	}
	cache.set(body)
}

func (s *Server) weatherClient() *http.Client {
	if s.cfg.OceanClient != nil {
		return s.cfg.OceanClient
	}
	return &http.Client{Timeout: 90 * time.Second}
}

func (s *Server) refreshRadar(ctx context.Context) {
	set, err := weather.FetchRadar(ctx, s.weatherClient(), s.cfg.RadarURL, tiles.AOI,
		s.cfg.WeatherDir, weather.Options{
			Step:      weather.DefaultRadarStep,
			MaxFrames: weather.DefaultRadarFrames,
			Width:     weather.DefaultRadarWidth,
			Height:    weather.RadarHeightFor(tiles.AOI, weather.DefaultRadarWidth),
			MaxAge:    weather.DefaultRadarMaxAge,
		})
	if err != nil {
		// Serve stale. FetchRadar writes nothing on failure, so the frames
		// and manifest already on disk stand.
		slog.Warn("radar refresh", "err", err)
		return
	}
	body, err := json.MarshalIndent(set, "", "  ")
	if err != nil {
		slog.Warn("radar refresh: marshal", "err", err)
		return
	}
	s.wrc.set(body)
	slog.Info("radar refresh", "frames", len(set.Frames),
		"newest", set.Frames[len(set.Frames)-1].ValidTime.Format(time.RFC3339))
}

func (s *Server) refreshForecast(ctx context.Context) {
	fc, err := weather.FetchForecast(ctx, s.weatherClient(), s.cfg.NWSBase, tiles.AOI,
		weather.ForecastOptions{
			NX:        weather.DefaultForecastNX,
			NY:        weather.DefaultForecastNY,
			From:      time.Now().UTC().Truncate(time.Hour),
			Steps:     weather.DefaultForecastSteps,
			Step:      time.Hour,
			PeriodsAt: &weather.DefaultPeriodsPoint,
		})
	if err != nil {
		slog.Warn("forecast refresh", "err", err)
		return
	}
	body, err := json.MarshalIndent(fc, "", "  ")
	if err != nil {
		slog.Warn("forecast refresh: marshal", "err", err)
		return
	}
	// Write through before publishing, so a restart finds on disk exactly
	// what the last live poll served.
	//
	// An unwritable directory is NOT fatal to serving, exactly as it is not
	// on the ocean path (see oceanrefresh.go). The hardened image runs with
	// readOnlyRootFilesystem and only the declared volumes writable; a
	// `return` here meant a successfully fetched forecast was thrown away
	// and the layer reported itself permanently unavailable in the pod.
	// The fetch succeeded, so the fetch gets published; only the restart
	// durability is lost.
	if err := os.WriteFile(filepath.Join(s.cfg.WeatherDir, weather.ForecastManifest), body, 0o644); err != nil {
		slog.Warn("forecast refresh: write-through", "err", err)
	}
	s.wfc.set(body)
	slog.Info("forecast refresh", "steps", len(fc.Steps), "periods", len(fc.Periods))
}
