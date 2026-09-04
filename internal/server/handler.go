package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

// Server is the Gulf Seafloor Viewer HTTP API + tile + SPA host.
type Server struct {
	cfg   Config
	tiles *tileStore
	web   http.Handler
	ac    *aircraftCache
	oc    *etagCache // currents stack
	bc    *buoysCache
	wrc   *etagCache // radar manifest
	wfc   *etagCache // forecast manifest
	// snapMu serializes snapshot write-throughs across the currents and
	// buoys refreshers; see writeSnapshot.
	snapMu sync.Mutex
}

// New returns a handler with security headers applied to every response.
// It does not start background refresh; use NewWithContext for that.
func New(cfg Config) http.Handler {
	return newServer(context.Background(), cfg, false)
}

// NewWithContext returns a handler and starts background ocean refresh,
// which stops when ctx is done.
func NewWithContext(ctx context.Context, cfg Config) http.Handler {
	return newServer(ctx, cfg, true)
}

func newServer(ctx context.Context, cfg Config, refresh bool) http.Handler {
	cfg = cfg.withDefaults()
	s := &Server{
		cfg:   cfg,
		tiles: newTileStore(cfg.TileDir, cfg.TileWorkers),
		web:   handleSPA(resolveWeb(cfg)),
		ac:    newAircraftCache(cfg),
		oc:    newETagCache(),
		bc:    newBuoysCache(),
		wrc:   newETagCache(),
		wfc:   newETagCache(),
	}

	mux := http.NewServeMux()
	mux.Handle("/tiles/", http.HandlerFunc(s.handleTile))
	mux.Handle("/soundings/", http.HandlerFunc(handleSoundings))
	mux.HandleFunc("/api/depth", s.handleDepth)
	mux.HandleFunc("/api/manifest", s.handleManifest)
	mux.HandleFunc("/api/ocean/manifest", s.handleOcean)
	mux.HandleFunc("/api/ocean/currents", s.handleOcean)
	mux.HandleFunc("/api/ocean/buoys", s.handleOcean)
	mux.HandleFunc("/api/aircraft", s.handleAircraft)
	mux.HandleFunc("/api/weather/", s.handleWeather)
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.Handle("/", s.web)

	if refresh {
		s.startOceanRefresh(ctx)
		s.startWeatherRefresh(ctx)
	}

	return securityHeaders(withAccessLog(mux), cfg.CORSOrigin)
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	info, err := os.Stat(s.cfg.TileDir)
	if err != nil || !info.IsDir() {
		http.Error(w, "tile directory not found", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func handleSoundings(w http.ResponseWriter, r *http.Request) {
	// Phase 4: binary point batches. Empty for now.
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 0}
		next.ServeHTTP(sw, r)
		code := sw.code
		if code == 0 {
			code = http.StatusOK
		}
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", code,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}
