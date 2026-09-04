package server

import (
	"crypto/sha256"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/idrewlong/gulfseafloor/internal/weather"
)

const (
	// Frames are immutable once written — the name carries the instant — so
	// they may be cached hard. The manifests move every few minutes.
	weatherFrameCacheControl    = "public, max-age=86400, immutable"
	weatherManifestCacheControl = "public, max-age=60"
	weatherMaxBytes             = 16 << 20
)

// frameName is the only shape a radar frame file may have. The name arrives
// off the wire and is joined to a directory path, so it is matched against
// this rather than cleaned: "reject what is not obviously safe" leaves no
// room for a traversal that survives normalisation.
var frameName = regexp.MustCompile(`^\d{8}T\d{6}Z\.png$`)

func (s *Server) handleWeather(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/weather/")
	if name, ok := strings.CutPrefix(rest, "frames/"); ok {
		s.serveWeatherFrame(w, r, name)
		return
	}

	var file string
	var cache *etagCache
	switch rest {
	case "radar":
		file, cache = weather.RadarManifest, s.wrc
	case "forecast":
		file, cache = weather.ForecastManifest, s.wfc
	default:
		http.NotFound(w, r)
		return
	}

	if body, etag, ok := cache.get(); ok {
		writeWeatherJSON(w, r, body, etag)
		return
	}
	body, err := os.ReadFile(filepath.Join(s.cfg.WeatherDir, file))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	writeWeatherJSON(w, r, body, etagFor(sha256.Sum256(body)))
}

func writeWeatherJSON(w http.ResponseWriter, r *http.Request, body []byte, etag string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", weatherManifestCacheControl)
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(body)
}

func (s *Server) serveWeatherFrame(w http.ResponseWriter, r *http.Request, name string) {
	if !frameName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	body, err := os.ReadFile(filepath.Join(s.cfg.WeatherDir, "radar", name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", weatherFrameCacheControl)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(body)
}
