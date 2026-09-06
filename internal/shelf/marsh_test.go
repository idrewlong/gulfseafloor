package shelf

import (
	"math"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// interiorPoint returns a point strictly inside a simple ring, found by
// casting a scanline across the middle and taking the midpoint of the first
// span. A vertex average is not enough: these rings are concave, and the
// centroid of a marsh islet frequently lands in the water beside it.
func interiorPoint(ring [][]float64) (float64, float64, bool) {
	minLat, maxLat := math.Inf(1), math.Inf(-1)
	for _, p := range ring {
		minLat = math.Min(minLat, p[1])
		maxLat = math.Max(maxLat, p[1])
	}
	for _, frac := range []float64{0.5, 0.35, 0.65, 0.2, 0.8} {
		y := minLat + (maxLat-minLat)*frac
		var xs []float64
		for i := 0; i+1 < len(ring); i++ {
			x1, y1 := ring[i][0], ring[i][1]
			x2, y2 := ring[i+1][0], ring[i+1][1]
			if (y1 > y) != (y2 > y) {
				xs = append(xs, x1+(y-y1)/(y2-y1)*(x2-x1))
			}
		}
		if len(xs) < 2 {
			continue
		}
		for i := range xs {
			for j := i + 1; j < len(xs); j++ {
				if xs[j] < xs[i] {
					xs[i], xs[j] = xs[j], xs[i]
				}
			}
		}
		// Spans alternate inside/outside; the first is inside.
		if mid := (xs[0] + xs[1]) / 2; xs[1]-xs[0] > 1e-9 {
			return mid, y, true
		}
	}
	return 0, 0, false
}

// The Louisiana marsh is thousands of closed coastline rings. gen_outlines.py
// used to throw every one of them away, which punched 430 km2 of open water
// through the chart west of the delta. Every ring the generator keeps must
// sample as land.
func TestMarshRingsAreLand(t *testing.T) {
	rings := data().Marsh
	if len(rings) < 500 {
		t.Fatalf("expected the marsh rings to be present, got %d", len(rings))
	}
	checked, water := 0, 0
	for _, r := range rings {
		lon, lat, ok := interiorPoint(r)
		if !ok {
			continue
		}
		// The coastline is fetched past the chart edge on purpose, so some
		// rings fall outside the AOI and correctly sample as nodata.
		if !tiles.AOI.Contains(lon, lat) {
			continue
		}
		checked++
		if Sample(lon, lat) < 0 {
			water++
			if water <= 5 {
				t.Errorf("marsh interior (%.4f, %.4f) samples as water %.2f m", lon, lat, Sample(lon, lat))
			}
		}
	}
	if checked < 400 {
		t.Fatalf("only found interiors for %d rings", checked)
	}
	if water > 0 {
		t.Errorf("%d of %d marsh interiors sample as water", water, checked)
	}
}

// Named islands come from the Islands map, which the Go side once read through
// a hardcoded list of the eight Sound barrier islands — so Grand Isle and
// Point au Fer were in outlines.json, drawn by the web overlay, and still
// sampled as open water by the tiler.
func TestEveryNamedIslandIsLand(t *testing.T) {
	for _, ring := range islandRings() {
		lon, lat, ok := interiorPoint(ring)
		if !ok {
			t.Errorf("could not find an interior point for a named island ring")
			continue
		}
		if e := Sample(lon, lat); e < 0 {
			t.Errorf("named island interior (%.4f, %.4f) samples as water %.2f m", lon, lat, e)
		}
	}
	if got := len(islandRings()); got != len(data().Islands) {
		t.Errorf("islandRings dropped %d of %d named islands", len(data().Islands)-got, len(data().Islands))
	}
}

// The mainland polygon is the open coastline sealed with three synthetic
// edges. Those edges were once fixed at the original chart's bounds
// (-90.35 / -87.30), so widening the AOI turned them into a clip: Houma,
// Thibodaux, Morgan City and the whole Florida panhandle fell outside the ring
// and sampled as open water. The closure must always enclose the chart.
func TestMainlandRingEnclosesTheChart(t *testing.T) {
	ring := data().Mainland
	west, east := math.Inf(1), math.Inf(-1)
	north := math.Inf(-1)
	for _, p := range ring {
		west = math.Min(west, p[0])
		east = math.Max(east, p[0])
		north = math.Max(north, p[1])
	}
	if west > tiles.AOI.West {
		t.Errorf("mainland ring closes at %.3f, east of the chart's west edge %.3f", west, tiles.AOI.West)
	}
	if east < tiles.AOI.East {
		t.Errorf("mainland ring closes at %.3f, west of the chart's east edge %.3f", east, tiles.AOI.East)
	}
	if north < tiles.AOI.North {
		t.Errorf("mainland ring closes at %.3f, south of the chart's north edge %.3f", north, tiles.AOI.North)
	}
}

// Inland towns across the full width of the chart. Each is well away from the
// waterline, so any of them reading as water means the land polygon is being
// clipped rather than the coastline being wrong.
func TestInlandTownsAreLand(t *testing.T) {
	for _, p := range []struct {
		name     string
		lon, lat float64
	}{
		{"Morgan City, LA", -91.207, 29.699},
		{"Houma, LA", -90.720, 29.596},
		{"Thibodaux, LA", -90.820, 29.800},
		{"New Orleans, LA", -90.080, 29.960},
		{"Gulfport, MS", -89.090, 30.367},
		{"Mobile, AL", -88.040, 30.690},
		{"Pensacola, FL", -87.217, 30.421},
		{"Navarre, FL", -86.862, 30.402},
	} {
		if e := Sample(p.lon, p.lat); e < 0 {
			t.Errorf("%s (%.3f, %.3f) should be land, samples %.2f m", p.name, p.lon, p.lat, e)
		}
	}
}
