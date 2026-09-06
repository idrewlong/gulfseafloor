package shelf

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// viewerDepthMin reads DEFAULT_DEPTH_MIN out of the viewer's own config
// rather than restating it here. The renderer's depth window and the terrain
// the tiler generates are two halves of one decision, in two languages; this
// is the seam where they can silently drift apart, and they already had.
func viewerDepthMin(t *testing.T) float64 {
	t.Helper()
	path := filepath.Join("..", "..", "web", "src", "viewerConfig.ts")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("viewer config not readable (%v); skipping the cross-language check", err)
	}
	m := regexp.MustCompile(`DEFAULT_DEPTH_MIN\s*=\s*(-?[0-9.]+)`).FindSubmatch(b)
	if m == nil {
		t.Fatalf("DEFAULT_DEPTH_MIN not found in %s — this check is stale", path)
	}
	v, err := strconv.ParseFloat(string(m[1]), 64)
	if err != nil {
		t.Fatalf("DEFAULT_DEPTH_MIN is not a number: %v", err)
	}
	return v
}

// The south-east corner of the AOI is the head of the Mississippi Canyon, and
// GEBCO puts it near -2506 m. A `depth = -85` clamp at the end of Sample used
// to flatten everything past 85 m onto one plate: 38% of the water in the box,
// running to -2506 m, all rendered at the same depth and the same colour. The
// renderer's depth window reaches -2500 m, so the hypsometric ramp had data in
// only the top 4% of its range.
//
// This guards the shape of the result rather than one number: the chart has to
// keep reaching real deep water, and has to get there as a slope rather than a
// step.
func TestChartReachesTheMississippiCanyon(t *testing.T) {
	// The corner GEBCO says is deepest.
	got := Sample(-87.507, 28.500)
	if got > -2000 {
		t.Fatalf("the AOI's deep corner should reach canyon depth, got %.1f m "+
			"(a clamp in Sample is the usual cause)", got)
	}
	raw, ok := gebcoAt(-87.507, 28.500)
	if !ok {
		t.Fatal("GEBCO has no cell at the deep corner")
	}
	// Sample adds small nearshore terms that are ~0 this far out, so it should
	// track the grid closely rather than merely being "deep".
	if d := got - raw; d < -20 || d > 20 {
		t.Errorf("open-shelf depth should track GEBCO within 20 m, got %.1f vs %.1f", got, raw)
	}
}

// Deep water must be reached by a gradient, not a cliff. A clamp produces a
// plate with a hard edge; a real shelf break does not.
func TestShelfBreakIsASlopeNotAStep(t *testing.T) {
	const lon = -87.507
	prev := Sample(lon, 30.0)
	worst, worstLat := 0.0, 0.0
	for lat := 29.98; lat >= tiles.AOI.South; lat -= 0.02 {
		got := Sample(lon, lat)
		if step := prev - got; step > worst {
			worst, worstLat = step, lat
		}
		prev = got
	}
	// 0.02 deg is ~2.2 km. The continental slope here genuinely drops fast,
	// but a single 2 km step of more than 400 m is a wall, not a slope.
	if worst > 400 {
		t.Errorf("depth falls %.0f m in one 2 km step near %.2f N — that is a wall", worst, worstLat)
	}
}

// The renderer's depth window and the terrain it displays have to agree. If
// the model stops well short of the window, most of the hypsometric ramp is
// dead and the chart reads as one flat colour.
func TestModelFillsMostOfTheRenderedDepthWindow(t *testing.T) {
	aoi := tiles.AOI
	const n = 200
	min := 1e9
	for i := 0; i <= n; i++ {
		for j := 0; j <= n; j++ {
			lon := aoi.West + (aoi.East-aoi.West)*float64(i)/n
			lat := aoi.South + (aoi.North-aoi.South)*float64(j)/n
			if v := Sample(lon, lat); v < min {
				min = v
			}
		}
	}
	window := viewerDepthMin(t)
	if min > window*0.5 {
		t.Errorf("model bottoms out at %.0f m but the viewer scales its ramp to %.0f m; "+
			"most of the colour range would carry no data", min, window)
	}
}
