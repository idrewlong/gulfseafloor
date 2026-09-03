package shelf

import (
	"math"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// Reference depths read straight out of the GEBCO_2024 clip in gebco.bin,
// cross-checked against the GEBCO_2020 grid served by api.opentopodata.org
// (every point agreed within 8 m). These are the numbers the chart is supposed
// to report; the procedural ramp they replaced read -21 m at the first one.
var gebcoRef = []struct {
	lon, lat float64
	metres   float64
}{
	{-88.1613, 29.5163, -42}, // Mississippi Bight, the readout that started this
	{-88.6430, 29.5790, -19}, // NDBC 42354
	{-88.7500, 30.0200, -14}, // inner shelf south of the barrier chain
	{-87.6000, 29.5200, -57}, // opening toward DeSoto Canyon
	{-89.0000, 29.5200, -10}, // Breton Sound side, genuinely shallow
}

// Offshore, the surface should be GEBCO rather than a procedural guess. The
// tolerance leaves room for the fbm detail ripple, not for a different shelf.
func TestSampleTracksGEBCOOffshore(t *testing.T) {
	for _, p := range gebcoRef {
		got := Sample(p.lon, p.lat)
		if diff := math.Abs(got - p.metres); diff > 6 {
			t.Errorf("Sample(%.4f, %.4f) = %.1f m, GEBCO says %.0f m (off by %.1f)",
				p.lon, p.lat, got, p.metres, diff)
		}
	}
}

// The clip has to cover the sampler's own pad, or the AOI edge falls back to
// nodata and the southern tiles render as a wall.
func TestGEBCOCoversPaddedAOI(t *testing.T) {
	aoi := tiles.AOI
	corners := [][2]float64{
		{aoi.West - padDeg, aoi.South - padDeg},
		{aoi.East + padDeg, aoi.South - padDeg},
		{aoi.West - padDeg, aoi.North + padDeg},
		{aoi.East + padDeg, aoi.North + padDeg},
	}
	for _, c := range corners {
		if _, ok := gebcoAt(c[0], c[1]); !ok {
			t.Errorf("GEBCO clip does not cover padded AOI corner %.3f,%.3f", c[0], c[1])
		}
	}
}

// Bilinear interpolation, not nearest-neighbour: a 15 arc-second grid steps
// about 460 m, and the chart draws down to z14. The probes have to land on cell
// centres — sampling at round coordinates lands mid-cell and compares
// interpolated values to each other, which proves nothing.
func TestGEBCOInterpolatesBetweenCells(t *testing.T) {
	g := gebco()
	row := int((29.52 - g.South) / g.Res)
	lat := g.South + float64(row)*g.Res

	for col := int((-88.40 - g.West) / g.Res); col < g.Cols-1; col++ {
		west, east := gebcoSample(t, g.West+float64(col)*g.Res, lat),
			gebcoSample(t, g.West+float64(col+1)*g.Res, lat)
		if west == east {
			continue // flat pair; step east until the floor changes
		}
		mid := gebcoSample(t, g.West+(float64(col)+0.5)*g.Res, lat)
		want := (west + east) / 2
		if math.Abs(mid-want) > 0.01 {
			t.Fatalf("midpoint between %.2f and %.2f is %.2f, want %.2f — not interpolating",
				west, east, mid, want)
		}
		return
	}
	t.Fatal("no pair of differing neighbouring cells found on this row")
}

func gebcoSample(t *testing.T, lon, lat float64) float64 {
	t.Helper()
	v, ok := gebcoAt(lon, lat)
	if !ok {
		t.Fatalf("%.4f,%.4f is outside the clip", lon, lat)
	}
	return v
}
