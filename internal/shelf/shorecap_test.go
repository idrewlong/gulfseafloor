package shelf

import (
	"math"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// The nearest-shore search is capped at maxUsefulShoreDist because every ramp
// that consumes the distance saturates by 9 km. That is only sound if the
// surface is bit-identical with the cap lifted, so check it across the chart
// rather than trusting the reasoning.
func TestShoreCapDoesNotChangeTheSurface(t *testing.T) {
	const steps = 220
	lonStep := (tiles.AOI.East - tiles.AOI.West) / steps
	latStep := (tiles.AOI.North - tiles.AOI.South) / steps

	type sample struct{ lon, lat, elev float64 }
	capped := make([]sample, 0, (steps+1)*(steps+1))
	for i := 0; i <= steps; i++ {
		for j := 0; j <= steps; j++ {
			lon := tiles.AOI.West + float64(i)*lonStep
			lat := tiles.AOI.South + float64(j)*latStep
			capped = append(capped, sample{lon, lat, Sample(lon, lat)})
		}
	}

	// Lift the cap far past the chart diagonal so the search runs to the true
	// nearest shore, then compare.
	old := shoreSearchCap
	shoreSearchCap = math.Inf(1)
	defer func() { shoreSearchCap = old }()

	diffs := 0
	worst := 0.0
	for _, s := range capped {
		got := Sample(s.lon, s.lat)
		if got != s.elev {
			diffs++
			if d := math.Abs(got - s.elev); d > worst {
				worst = d
			}
		}
	}
	if diffs != 0 {
		t.Fatalf("cap changed %d of %d samples, worst delta %g m", diffs, len(capped), worst)
	}
}

// liftShoreCap removes the nearest-shore cap for tests that check the raw
// search, and returns a func that restores it.
func liftShoreCap() func() {
	old := shoreSearchCap
	shoreSearchCap = math.Inf(1)
	return func() { shoreSearchCap = old }
}

// Past the cap the search reports +Inf rather than a distance. Every ramp that
// consumes it clamps, so this documents the contract the callers rely on.
func TestShoreCapReports(t *testing.T) {
	line := [][]float64{{-89.0, 30.3}, {-88.9, 30.3}}
	idx := newSegIndex([][][]float64{line})

	if got := idx.nearest(-88.95, 30.31); math.IsInf(got, 1) {
		t.Fatalf("a shore 1 km away must still return a distance, got %v", got)
	}
	if got := idx.nearest(-80.0, 20.0); !math.IsInf(got, 1) {
		t.Fatalf("a shore 1400 km away is past the cap, want +Inf, got %v", got)
	}
	// smoothstep clamps +Inf to 1, which is the whole reason the cap is safe.
	if got := smoothstep(400, 9_000, math.Inf(1)); got != 1 {
		t.Fatalf("smoothstep must saturate at +Inf, got %v", got)
	}
}
