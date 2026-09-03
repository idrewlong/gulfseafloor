package server

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// The manifest cites GEBCO 2024 and tells the viewer the region is not
// synthetic. That claim is about the bytes in data/tiles, not about
// shelf.Sample — and the two drift apart silently whenever the shelf model
// changes and the pyramid is not re-baked. That drift shipped once: the
// pyramid still held the pre-GEBCO procedural surface, so the chart reported
// -21 m offshore while the grid, and shelf.Sample, said -42 m. Unit tests all
// passed, because none of them read a tile.
//
// Depths are read straight from the GEBCO_2024 clip; see internal/shelf.
// Skipped when the pyramid has not been built — data/tiles is generated.
func TestBakedPyramidMatchesCitedGrid(t *testing.T) {
	const tileDir = "../../data/tiles"
	if _, err := os.Stat(tileDir + "/14"); err != nil {
		t.Skip("no tile pyramid; run `make tiles`")
	}
	h := New(Config{TileDir: tileDir, WebDir: t.TempDir()})

	refs := []struct {
		lon, lat, want float64
		note           string
	}{
		{-88.1613, 29.5163, -42, "Mississippi Bight"},
		{-88.6430, 29.5790, -19, "NDBC 42354"},
		{-88.7500, 30.0200, -14, "inner shelf south of the barrier chain"},
		{-87.6000, 29.5200, -57, "opening toward DeSoto Canyon"},
		{-89.0000, 29.5200, -10, "Breton Sound side"},
	}
	for _, r := range refs {
		rec := httptest.NewRecorder()
		url := fmt.Sprintf("/api/depth?lon=%g&lat=%g", r.lon, r.lat)
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d", r.note, rec.Code)
			continue
		}
		var got depthResponse
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("%s: %v", r.note, err)
		}
		// Wide enough for the fbm detail ripple and 0.1 m quantisation, far too
		// tight for a stale pyramid built from a different shelf model.
		if diff := math.Abs(got.ElevationM - r.want); diff > 6 {
			t.Errorf("%s (%g,%g): tile says %.1f m, GEBCO says %.0f m (off by %.1f) — re-run `make tiles`",
				r.note, r.lon, r.lat, got.ElevationM, r.want, diff)
		}
		if got.Encoding != "terrain-rgb" {
			t.Errorf("%s: encoding %q", r.note, got.Encoding)
		}
	}
}
