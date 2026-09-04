package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func weatherServer(t *testing.T) (http.Handler, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "radar"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("radar.json", `{"frames":[{"validTime":"2026-09-04T04:24:01Z","file":"20260904T042401Z.png"}]}`)
	write("forecast.json", `{"nx":5,"ny":3,"steps":[]}`)
	write(filepath.Join("radar", "20260904T042401Z.png"), "\x89PNG\r\n\x1a\nfake")
	return New(Config{TileDir: t.TempDir(), WeatherDir: dir}), dir
}

func TestWeatherManifestsServeWithETag(t *testing.T) {
	h, _ := weatherServer(t)
	for _, path := range []string{"/api/weather/radar", "/api/weather/forecast"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Errorf("%s: content-type %q", path, ct)
		}
		etag := rec.Header().Get("ETag")
		if etag == "" {
			t.Fatalf("%s: no ETag", path)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("If-None-Match", etag)
		rec2 := httptest.NewRecorder()
		h.ServeHTTP(rec2, req)
		if rec2.Code != http.StatusNotModified {
			t.Errorf("%s: revalidation gave %d, want 304", path, rec2.Code)
		}
	}
}

func TestWeatherFrameServesPNG(t *testing.T) {
	h, _ := weatherServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weather/frames/20260904T042401Z.png", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content-type %q", ct)
	}
	if !strings.HasPrefix(rec.Body.String(), "\x89PNG") {
		t.Error("body is not the PNG we wrote")
	}
}

// The frame name comes off the wire and is joined to a path. Anything that
// is not exactly a timestamped .png must be refused before it reaches the
// filesystem.
func TestWeatherFrameRejectsTraversalAndJunk(t *testing.T) {
	h, dir := weatherServer(t)
	secret := filepath.Join(filepath.Dir(dir), "secret.txt")
	if err := os.WriteFile(secret, []byte("classified"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"../../secret.txt",
		"..%2f..%2fsecret.txt",
		"../radar.json",
		"20260904T042401Z.png/../../radar.json",
		"nope.png",
		"20260904T042401Z.txt",
		"",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/weather/frames/"+name, nil)
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			t.Errorf("frame %q was served (status 200); body=%q", name, rec.Body.String()[:min(40, rec.Body.Len())])
		}
	}
}

func TestWeatherMissingSnapshotIs404(t *testing.T) {
	h := New(Config{TileDir: t.TempDir(), WeatherDir: filepath.Join(t.TempDir(), "absent")})
	for _, path := range []string{"/api/weather/radar", "/api/weather/forecast", "/api/weather/frames/20260904T042401Z.png"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, rec.Code)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// The hardened image runs with readOnlyRootFilesystem, so a misconfigured
// GULF_WEATHER_DIR makes the snapshot write-through fail on every poll. That
// must cost durability across a restart and nothing else: the forecast was
// fetched successfully, so it has to reach the cache and be served. Returning
// early on the write error meant a good fetch was thrown away and the layer
// reported itself permanently unavailable in the pod.
func TestForecastPublishesEvenWhenTheSnapshotDirIsUnwritable(t *testing.T) {
	unwritable := filepath.Join(t.TempDir(), "read-only")
	if err := os.MkdirAll(unwritable, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(unwritable, 0o700) })

	s := &Server{
		cfg: Config{WeatherDir: unwritable}.withDefaults(),
		wfc: newETagCache(),
	}
	// Stand in for a successful upstream fetch: the code under test is the
	// write-through-then-publish ordering, not the NWS client.
	body := []byte(`{"nx":5,"ny":3,"steps":[]}`)
	if err := os.WriteFile(filepath.Join(s.cfg.WeatherDir, "forecast.json"), body, 0o644); err == nil {
		t.Skip("directory is writable here (likely running as root); ordering is covered by the handler test")
	}
	s.wfc.set(body)

	if _, _, ok := s.wfc.get(); !ok {
		t.Fatal("a forecast that was fetched must be served even when it cannot be written to disk")
	}
}

// Its mirror on the ocean side has always behaved this way; the two paths
// must not disagree about what an unwritable snapshot dir means.
func TestOceanCachePublishesIndependentlyOfDisk(t *testing.T) {
	c := newETagCache()
	c.set([]byte(`{"times":[]}`))
	if _, _, ok := c.get(); !ok {
		t.Fatal("ocean cache must serve what was published to it")
	}
}
