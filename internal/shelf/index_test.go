package shelf

import (
	"math"
	"math/rand"
	"testing"
)

// The index is only worth having if it agrees with the linear scan it replaced.
func TestRingIndexMatchesLinearScan(t *testing.T) {
	ring := data().Mainland
	idx := newRingIndex(ring)
	rng := rand.New(rand.NewSource(7))

	for i := 0; i < 4000; i++ {
		lon := -89.85 + rng.Float64()*2.15
		lat := 29.90 + rng.Float64()*0.95
		if got, want := idx.contains(lon, lat), ringContains(ring, lon, lat); got != want {
			t.Fatalf("contains(%.5f, %.5f) = %v, linear scan says %v", lon, lat, got, want)
		}
	}
}

func TestSegIndexMatchesLinearScan(t *testing.T) {
	coast := data().Coast
	idx := newSegIndex([][][]float64{coast})
	rng := rand.New(rand.NewSource(11))

	for i := 0; i < 600; i++ {
		lon := -89.80 + rng.Float64()*2.0
		lat := 29.95 + rng.Float64()*0.85
		got := idx.nearest(lon, lat)
		want := distToPolylineMetres(coast, lon, lat)
		if math.Abs(got-want) > 1e-6 {
			t.Fatalf("nearest(%.5f, %.5f) = %.4f m, linear scan says %.4f m", lon, lat, got, want)
		}
	}
}

func TestSegIndexHandlesPointsFarOutsideTheGrid(t *testing.T) {
	line := [][]float64{{-89.0, 30.3}, {-88.9, 30.3}}
	idx := newSegIndex([][][]float64{line})
	got := idx.nearest(-80.0, 20.0)
	want := distToPolylineMetres(line, -80.0, 20.0)
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("nearest far outside = %.4f m, want %.4f m", got, want)
	}
}

func TestValueNoiseIsSmoothAndBounded(t *testing.T) {
	prev := fbm(0, 0, 4)
	for i := 1; i <= 2000; i++ {
		x := float64(i) * 0.01
		v := fbm(x, x*0.7, 4)
		if v < 0 || v > 1 {
			t.Fatalf("fbm out of range at %.2f: %g", x, v)
		}
		// A unit lattice sampled every 0.01 must not jump.
		if math.Abs(v-prev) > 0.2 {
			t.Fatalf("fbm discontinuity at %.2f: %g -> %g", x, prev, v)
		}
		prev = v
	}
}
