package server

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func oceanHandler(t *testing.T, oceanDir string) http.Handler {
	t.Helper()
	return New(Config{
		TileDir:  filepath.Join("testdata", "tiles"),
		WebDir:   t.TempDir(),
		OceanDir: oceanDir,
	})
}

const validCurrentsJSON = `{
  "validTime": "2026-08-24T18:00:00Z",
  "source": {"name": "HYCOM", "dataset": "test", "url": "https://example.invalid/ncss"},
  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
  "nx": 2, "ny": 1, "grid": "centers",
  "u": [0.12, null],
  "v": [-0.04, null]
}`

const validBuoysJSON = `{
  "validTime": "2026-08-24T19:50:00Z",
  "source": {"name": "NDBC", "url": "https://www.ndbc.noaa.gov/"},
  "stations": [{"id": "WYCM6", "lon": -89.081, "lat": 30.36, "wdir": 180, "wspd": 6.2}]
}`

const validManifestJSON = `{
  "retrievedAt": "2026-08-24T20:01:00Z",
  "currents": {"present": false},
  "buoys": {"present": false}
}`

func writeOceanSnapshot(t *testing.T, dir string) {
	t.Helper()
	files := map[string]string{
		"currents.json": validCurrentsJSON,
		"buoys.json":    validBuoysJSON,
		"manifest.json": validManifestJSON,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOceanMissingIs404AndReadyzStillOK(t *testing.T) {
	h := oceanHandler(t, t.TempDir())
	for _, p := range []string{"/api/ocean/manifest", "/api/ocean/currents", "/api/ocean/buoys"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", p, rec.Code)
		}
		if rec.Body.Len() != 0 {
			t.Fatalf("%s: 404 body must be empty, got %q", p, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz %d", rec.Code)
	}
}

func TestOceanServesValidatedJSON(t *testing.T) {
	dir := t.TempDir()
	writeOceanSnapshot(t, dir)
	h := oceanHandler(t, dir)

	cases := []struct {
		path string
		body string
	}{
		{"/api/ocean/currents", validCurrentsJSON},
		{"/api/ocean/buoys", validBuoysJSON},
		{"/api/ocean/manifest", validManifestJSON},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", tc.path, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s content-type %q", tc.path, rec.Header().Get("Content-Type"))
		}
		if rec.Header().Get("Cache-Control") != "public, max-age=300" {
			t.Fatalf("%s cache %q", tc.path, rec.Header().Get("Cache-Control"))
		}
		sum := sha256.Sum256([]byte(tc.body))
		wantETag := `"` + hex.EncodeToString(sum[:]) + `"`
		if rec.Header().Get("ETag") != wantETag {
			t.Fatalf("%s etag %q want %q", tc.path, rec.Header().Get("ETag"), wantETag)
		}
		if rec.Body.String() != tc.body {
			t.Fatalf("%s body mismatch", tc.path)
		}
	}
}

func TestOceanHEADOmitsBody(t *testing.T) {
	dir := t.TempDir()
	writeOceanSnapshot(t, dir)
	h := oceanHandler(t, dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/api/ocean/currents", nil))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=300" {
		t.Fatalf("cache %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("missing ETag")
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("content-type %q", rec.Header().Get("Content-Type"))
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD body %q", rec.Body.String())
	}
}

func TestOceanMethodNotAllowed(t *testing.T) {
	h := oceanHandler(t, t.TempDir())
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/api/ocean/currents", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: %d", method, rec.Code)
		}
	}
}

func TestOceanMalformedJSONIs500(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "currents.json"), []byte(`{not json`), 0o644)
	h := oceanHandler(t, dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil))
	if rec.Code != 500 {
		t.Fatalf("%d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), dir) {
		t.Fatal("must not leak path")
	}
	if rec.Body.String() != "ocean snapshot unavailable\n" {
		t.Fatalf("body %q", rec.Body.String())
	}
}

func TestOceanTrailingGarbageIs500(t *testing.T) {
	dir := t.TempDir()
	body := validCurrentsJSON + "\n trailing garbage"
	if err := os.WriteFile(filepath.Join(dir, "currents.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	h := oceanHandler(t, dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil))
	if rec.Code != 500 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), dir) {
		t.Fatal("must not leak path")
	}
}

func TestOceanInvalidSnapshotIs500(t *testing.T) {
	dir := t.TempDir()
	body := `{
	  "validTime":"2026-08-24T18:00:00Z","source":{"name":"HYCOM","url":"x"},
	  "bbox":{"west":-89,"south":29,"east":-88,"north":30},
	  "nx":2,"ny":1,"grid":"edges","u":[0,0],"v":[0,0]
	}`
	if err := os.WriteFile(filepath.Join(dir, "currents.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	h := oceanHandler(t, dir)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil))
	if rec.Code != 500 {
		t.Fatalf("%d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), dir) {
		t.Fatal("must not leak path")
	}
}

func TestOceanPathDoesNotTraverse(t *testing.T) {
	h := oceanHandler(t, t.TempDir())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/../tiles", nil))
	// Exact mux paths: Go cleans ".." and 307s away. The ocean handler never sees it.
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Code == http.StatusTemporaryRedirect && rec.Header().Get("Location") == "/api/ocean/tiles" {
		t.Fatal("must not keep the request under /api/ocean")
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ocean/wind", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown name: %d", rec.Code)
	}
}
