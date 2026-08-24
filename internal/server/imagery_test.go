package server

import (
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseImageryXYZ(t *testing.T) {
	z, x, y, ok := parseImageryXYZ("/imagery/10/258/424.jpg")
	if !ok || z != 10 || x != 258 || y != 424 {
		t.Fatalf("got %d/%d/%d ok=%v", z, x, y, ok)
	}
	if _, _, _, ok := parseImageryXYZ("/imagery/10/258/424.png"); ok {
		t.Fatal("png suffix should be rejected")
	}
	if _, _, _, ok := parseImageryXYZ("/imagery/10/../../etc/passwd"); ok {
		t.Fatal("accepted traversal")
	}
	if _, _, _, ok := parseImageryXYZ("/imagery/10/258/../424.jpg"); ok {
		t.Fatal("accepted .. in y")
	}
}

func TestImageryURLUsesPinnedHostAndXYZ(t *testing.T) {
	u, err := imageryURL(defaultImageryTemplate, 10, 258, 424)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u, "https://services.arcgisonline.com/") {
		t.Fatalf("unpinned host: %s", u)
	}
	if !strings.HasSuffix(u, "/tile/10/424/258") {
		t.Fatalf("Esri expects z/y/x, got %s", u)
	}
}

func TestImageryProxyServesUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tile/8/105/67" {
			t.Errorf("upstream path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "image/jpeg")
		img := image.NewRGBA(image.Rect(0, 0, 1, 1))
		_ = jpeg.Encode(w, img, &jpeg.Options{Quality: 80})
	}))
	t.Cleanup(up.Close)

	h := New(Config{
		TileDir:          "testdata/tiles",
		WebDir:           t.TempDir(),
		ImageryTemplate:  up.URL + "/tile/%d/%d/%d",
		ImageryEnabled:   true,
		TileWorkers:      1,
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/imagery/8/67/105.jpg", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "image/jpeg") {
		t.Fatalf("ctype %s", rec.Header().Get("Content-Type"))
	}
	if rec.Body.Len() < 32 {
		t.Fatal("empty jpeg")
	}
}

func TestImageryDisabledIs404(t *testing.T) {
	h := New(Config{
		TileDir:        "testdata/tiles",
		WebDir:         t.TempDir(),
		ImageryEnabled: false,
		TileWorkers:    1,
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/imagery/8/67/105.jpg", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestImageryPathTraversalRejected(t *testing.T) {
	h := testHandler(t)
	for _, p := range []string{
		"/imagery/../etc/passwd",
		"/imagery/10/../../../etc/passwd",
		"/imagery/10/258/../424.jpg",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code == http.StatusOK {
			t.Errorf("%s: served OK", p)
		}
		if rec.Code == http.StatusInternalServerError {
			t.Errorf("%s: got 500", p)
		}
	}
}

func TestImageryRedirectDoesNotLeavePinnedHost(t *testing.T) {
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("followed redirect off the pinned host")
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(evil.Close)

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/secret", http.StatusFound)
	}))
	t.Cleanup(up.Close)

	h := New(Config{
		TileDir:         "testdata/tiles",
		WebDir:          t.TempDir(),
		ImageryTemplate: up.URL + "/tile/%d/%d/%d",
		ImageryEnabled:  true,
		TileWorkers:     1,
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/imagery/8/67/105.jpg", nil))
	if rec.Code == http.StatusTeapot {
		t.Fatal("proxy followed an off-host redirect")
	}
	if rec.Code == http.StatusOK {
		t.Fatal("redirect should not be served as a tile")
	}
}
