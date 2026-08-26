package server

import (
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

const (
	fixtureLat  = 29.5
	fixtureLon  = -89.0
	fixtureZ    = 10
	fixtureElev = -42.0
)

func TestMain(m *testing.M) {
	if err := writeFixtureTile(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func writeFixtureTile() error {
	t := tiles.LonLatToTile(fixtureLon, fixtureLat, fixtureZ)
	dir := filepath.Join("testdata", "tiles", strconv.Itoa(t.Z), strconv.Itoa(t.X))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	img.SetNRGBA(0, 0, terrain.EncodeNRGBA(fixtureElev))
	path := filepath.Join(dir, strconv.Itoa(t.Y)+".png")
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func fixtureTile() tiles.Tile {
	return tiles.LonLatToTile(fixtureLon, fixtureLat, fixtureZ)
}

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	return New(Config{
		TileDir:     filepath.Join("testdata", "tiles"),
		WebDir:      t.TempDir(),
		TileWorkers: 2,
	})
}

func TestSecurityHeadersPresent(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	hdr := rec.Header()
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	}
	for k, v := range want {
		if got := hdr.Get(k); got != v {
			t.Errorf("%s: got %q want %q", k, got, v)
		}
	}
	csp := hdr.Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("missing Content-Security-Policy")
	}
	if strings.Contains(csp, "connect-src *") || strings.Contains(csp, "*") && strings.Contains(csp, "connect-src") {
		// allow * only if it is not connect-src; reject wildcard connect-src
		if strings.Contains(csp, "connect-src *") || strings.Contains(csp, "connect-src*") {
			t.Fatalf("CSP must not wildcard connect-src: %s", csp)
		}
	}
	if strings.Contains(csp, "'unsafe-eval'") {
		t.Fatalf("CSP must not allow unsafe-eval: %s", csp)
	}
	if !strings.Contains(csp, "connect-src 'self'") {
		t.Fatalf("CSP must pin connect-src to self: %s", csp)
	}
}

func TestNoWildcardCORS(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "https://evil.example")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("wildcard CORS is forbidden")
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("CORS is off by default, got %q", got)
	}

	star := New(Config{
		TileDir:    filepath.Join("testdata", "tiles"),
		WebDir:     t.TempDir(),
		CORSOrigin: "*",
	})
	rec = httptest.NewRecorder()
	star.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Header().Get("Access-Control-Allow-Origin") == "*" {
		t.Fatal("GULF_CORS_ORIGIN=* must not enable wildcard CORS")
	}

	one := New(Config{
		TileDir:    filepath.Join("testdata", "tiles"),
		WebDir:     t.TempDir(),
		CORSOrigin: "https://viewer.navy.mil",
	})
	rec = httptest.NewRecorder()
	one.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://viewer.navy.mil" {
		t.Fatalf("explicit origin: got %q", got)
	}
}

func TestTilePathTraversalRejected(t *testing.T) {
	h := testHandler(t)
	paths := []string{
		"/tiles/../etc/passwd",
		"/tiles/10/../../../etc/passwd",
		"/tiles/10/258/../424.png",
		"/tiles/10/foo/424.png",
		"/tiles/-1/0/0.png",
		"/tiles/10/258/424.png/../../etc/passwd",
		"/tiles/10/258/notpng",
	}
	for _, p := range paths {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code == http.StatusOK && strings.HasPrefix(rec.Header().Get("Content-Type"), "image/png") {
			t.Errorf("%s: traversal served a PNG", p)
		}
		if rec.Code == http.StatusInternalServerError {
			t.Errorf("%s: got 500 (must be 404, no stack)", p)
		}
		body := rec.Body.String()
		if strings.Contains(body, "goroutine") || strings.Contains(body, "panic") {
			t.Errorf("%s: leaked stack trace", p)
		}
	}

	if z, x, y, ok := parseTileXYZ("/tiles/10/../../etc/passwd"); ok {
		t.Fatalf("parse accepted traversal as %d/%d/%d", z, x, y)
	}
	if _, _, _, ok := parseTileXYZ("/tiles/10/258/../424.png"); ok {
		t.Fatal("parse accepted .. in y")
	}
}

func TestDepthBadCoords(t *testing.T) {
	h := testHandler(t)
	cases := []string{
		"/api/depth",
		"/api/depth?lat=abc&lon=-89",
		"/api/depth?lat=29.5&lon=xyz",
		"/api/depth?lat=91&lon=-89",
		"/api/depth?lat=-91&lon=-89",
		"/api/depth?lat=29.5&lon=200",
		"/api/depth?lat=90&lon=-89",
	}
	for _, p := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d want 400", p, rec.Code)
		}
	}
}

func TestDepthFixture(t *testing.T) {
	h := testHandler(t)
	q := "/api/depth?lat=" + strconv.FormatFloat(fixtureLat, 'f', -1, 64) +
		"&lon=" + strconv.FormatFloat(fixtureLon, 'f', -1, 64)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, q, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var got depthResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Nodata {
		t.Fatal("fixture is data, not nodata")
	}
	if got.Encoding != "terrarium" {
		t.Fatalf("encoding %q", got.Encoding)
	}
	if got.Tile != fixtureTile().String() {
		t.Fatalf("tile %q want %q", got.Tile, fixtureTile())
	}
	if got.ElevationM < fixtureElev-0.1 || got.ElevationM > fixtureElev+0.1 {
		t.Fatalf("elevation %g want ~%g", got.ElevationM, fixtureElev)
	}
}

func TestDepthNoTile(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/depth?lat=0&lon=0", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404", rec.Code)
	}
}

func TestHealthz(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "ok" {
		t.Fatalf("body %q", rec.Body.String())
	}
}

func TestMissingStaticAssetIs404(t *testing.T) {
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<!doctype html><title>app</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := New(Config{
		TileDir: filepath.Join("testdata", "tiles"),
		WebDir:  web,
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/missing-chunk.js", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing worker: status %d body %q", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "<!doctype html>") {
		t.Fatal("SPA fallback must not feed HTML to a .js request")
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/chart/view", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("client route: status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<!doctype html>") {
		t.Fatalf("client route should serve index, got %q", rec.Body.String())
	}
}

func TestReadyz(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("existing tile dir: %d", rec.Code)
	}

	missing := New(Config{TileDir: filepath.Join(t.TempDir(), "nope"), WebDir: t.TempDir()})
	rec = httptest.NewRecorder()
	missing.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing tile dir: %d", rec.Code)
	}
}

func TestTileCacheControl(t *testing.T) {
	h := testHandler(t)
	tile := fixtureTile()
	path := "/tiles/" + tile.String() + ".png"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/png") {
		t.Fatalf("content-type %q", ct)
	}
	if got := rec.Header().Get("Cache-Control"); got != tileCacheControl {
		t.Fatalf("cache-control %q", got)
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("missing ETag")
	}
	body, _ := io.ReadAll(rec.Body)
	if len(body) < 8 || string(body[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatal("response is not a PNG")
	}

	// 404 must not be cached as immutable.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/tiles/6/0/0.png", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing tile: %d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") == tileCacheControl {
		t.Fatal("must not mark 404 tiles immutable")
	}
}

func TestManifest(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/manifest", nil))
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	var m manifest
	if err := json.NewDecoder(rec.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	if len(m.Regions) != 1 || m.Regions[0].ID != "mississippi-sound" || !m.Regions[0].Synthetic {
		t.Fatalf("%+v", m)
	}
	if m.DataVersion == "" || m.DataVersion == "empty" {
		t.Fatalf("manifest must carry a tile dataVersion for cache busting, got %q", m.DataVersion)
	}
}

// Tile URLs are not content-addressed. If they are ever cached as `immutable`,
// a regenerated pyramid can never reach the browser: the client fetches tiles
// with fetch(), which reads the disk cache even on a hard reload.
func TestTilesAreNotCachedImmutable(t *testing.T) {
	if strings.Contains(tileCacheControl, "immutable") {
		t.Fatalf("tile Cache-Control must allow revalidation, got %q", tileCacheControl)
	}
}

// The version stamp the client appends must not break path parsing.
func TestTileServedWithVersionQuery(t *testing.T) {
	h := testHandler(t)
	path := "/tiles/" + fixtureTile().String() + ".png?v=abc123-269"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("versioned tile: status %d body %s", rec.Code, rec.Body.String())
	}
	body, _ := io.ReadAll(rec.Body)
	if len(body) < 8 || string(body[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatal("versioned tile response is not a PNG")
	}
}

// A rebuilt pyramid must produce a different stamp, or caches stay stale.
func TestTileDataVersionChangesWithContent(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "6", "0"), 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "6", "0", "0.png")
	if err := os.WriteFile(p, []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first := tileDataVersion(dir)
	if first == "" || first == "empty" {
		t.Fatalf("expected a version, got %q", first)
	}
	if err := os.Chtimes(p, time.Now().Add(time.Hour), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if second := tileDataVersion(dir); second == first {
		t.Fatalf("version %q did not change after the tile was rewritten", second)
	}
	if empty := tileDataVersion(t.TempDir()); empty != "empty" {
		t.Fatalf("empty tile dir should report %q, got %q", "empty", empty)
	}
}

func TestSoundingsEmpty(t *testing.T) {
	h := testHandler(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/soundings/10/1/2", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestParseTileXYZ(t *testing.T) {
	z, x, y, ok := parseTileXYZ("/tiles/10/258/424.png")
	if !ok || z != 10 || x != 258 || y != 424 {
		t.Fatalf("got %d/%d/%d ok=%v", z, x, y, ok)
	}
	if _, _, _, ok := parseTileXYZ("/tiles/10/258/424"); ok {
		t.Fatal("missing .png")
	}
}
