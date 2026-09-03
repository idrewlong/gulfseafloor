package shelf

import (
	"math"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// A longitude wall at -88.80 used to cap everything west of Horn as lagoon, so
// this patch rendered as a pale 3 m plate next to −30 m gulf.
//
// This used to assert the two ends were within 8 m of each other. They are not,
// and should not be: GEBCO puts the water behind the Chandeleur chain at about
// −4 m and the open Bight south of Horn at about −16 m. That 12 m is a real
// shelf gradient, and reproducing it is the point of using the grid. What the
// test was actually guarding is that the two are joined by a ramp rather than a
// step, so it now scans the whole line instead of comparing its endpoints.
func TestWaterSouthOfCatIslandMatchesSouthOfHorn(t *testing.T) {
	const lat = 30.10
	prevLon := -89.30
	prev := Sample(prevLon, lat)
	for lon := -89.28; lon <= -88.50; lon += 0.02 {
		got := Sample(lon, lat)
		if got >= 0 {
			t.Fatalf("water at %.2f,%.2f should be water, got %g", lon, lat, got)
		}
		if math.Abs(got-prev) > 4 {
			t.Fatalf("water jumps %.1f m from %.2f (%g) to %.2f (%g) — lagoon wall",
				math.Abs(got-prev), prevLon, prev, lon, got)
		}
		prev, prevLon = got, lon
	}
	if prev > -12 {
		t.Fatalf("the line should reach the open Bight by %.2f, got %g", prevLon, prev)
	}
}

func TestMississippiSoundHasNoLongitudeWall(t *testing.T) {
	west := Sample(-89.00, 30.28)
	east := Sample(-88.50, 30.28)
	if west >= 0 || east >= 0 {
		t.Fatalf("Sound should be water, west %g east %g", west, east)
	}
	if math.Abs(west-east) > 6 {
		t.Fatalf("Sound depth jumps %.1f m from west (%g) to east (%g) — longitude wall", math.Abs(west-east), west, east)
	}
}

// Gulfport's label sits at +4 m. The plain used to stay on a ~1 m berm for the
// first several kilometres, so the city rendered as wet sand.
func TestGulfportSitsOnTheCoastalRidge(t *testing.T) {
	elev := Sample(-89.09, 30.367)
	if elev < 3 || elev > 10 {
		t.Fatalf("Gulfport should sit a few metres above the berm, got %g", elev)
	}
}

// A 1.4 km beach shoal plus the island apron pulled the Sound off Gulfport
// onto the −0.4 m clamp, which the shader paints as a sand plate.
func TestSoundOffGulfportIsNotASandPlate(t *testing.T) {
	near := Sample(-89.09, 30.34)
	mid := Sample(-89.09, 30.28)
	if near >= 0 || mid >= 0 {
		t.Fatalf("Sound off Gulfport should be water, near %g mid %g", near, mid)
	}
	if near > -2 {
		t.Fatalf("nearshore off Gulfport (%g) is a sand plate, not the Sound", near)
	}
	if mid > -2 {
		t.Fatalf("Sound off Gulfport (%g) should be a few metres, not a sand plate", mid)
	}
}

// westernLagoon used to end at lon −89.35, so the water just east of New
// Orleans jumped from a −3 m lagoon to −20 m inner shelf in one tile.
func TestWaterEastOfNewOrleansStaysLagoon(t *testing.T) {
	for _, lon := range []float64{-89.50, -89.40, -89.30, -89.25} {
		elev := Sample(lon, 30.05)
		if elev >= 0 {
			continue // marsh spits in Borgne
		}
		if elev < -12 {
			t.Fatalf("water at %.2f, 30.05 is mid-shelf (%g); Borgne / Breton should stay a lagoon", lon, elev)
		}
	}
}

// A boolean wall at lon −89.52 painted Louisiana as wet sand and Mississippi
// as pine scrub along a vertical tile-shaped seam through Pearlington.
func TestLandHasNoLongitudeWallAtThePearl(t *testing.T) {
	const lat = 30.42
	prevLon := -89.70
	prev := Sample(prevLon, lat)
	for lon := -89.66; lon <= -89.38; lon += 0.02 {
		got := Sample(lon, lat)
		if prev > 0 && got > 0 && math.Abs(got-prev) > 2.2 {
			t.Fatalf("land jumps %.1f m from %.2f (%g) to %.2f (%g)", math.Abs(got-prev), prevLon, prev, lon, got)
		}
		prev, prevLon = got, lon
	}
}

// westernLagoon and lat < 30.16 were axis-aligned boxes, so the Sound / Borgne /
// inner shelf met on straight lines that read as miscolored tiles.
func TestWaterHasNoLatitudeWallSouthOfTheIslands(t *testing.T) {
	const lon = -88.67
	prevLat := 30.24
	prev := Sample(lon, prevLat)
	for lat := 30.22; lat >= 30.08; lat -= 0.02 {
		got := Sample(lon, lat)
		if prev < 0 && got < 0 && math.Abs(got-prev) > 5 {
			t.Fatalf("water jumps %.1f m from %.2f (%g) to %.2f (%g)", math.Abs(got-prev), prevLat, prev, lat, got)
		}
		prev, prevLat = got, lat
	}
}

func TestWaterHasNoLongitudeWallAtLagoonEdge(t *testing.T) {
	const lat = 30.05
	prevLon := -89.40
	prev := Sample(prevLon, lat)
	for lon := -89.35; lon <= -88.70; lon += 0.05 {
		got := Sample(lon, lat)
		if prev < 0 && got < 0 && math.Abs(got-prev) > 6 {
			t.Fatalf("water jumps %.1f m from %.2f (%g) to %.2f (%g)", math.Abs(got-prev), prevLon, prev, lon, got)
		}
		prev, prevLon = got, lon
	}
}

func TestAOIGridHasNoNodataHoles(t *testing.T) {
	aoi := tiles.AOI
	for lat := aoi.South; lat <= aoi.North; lat += 0.04 {
		for lon := aoi.West; lon <= aoi.East; lon += 0.04 {
			if Sample(lon, lat) <= terrain.MinMetres+1 {
				t.Fatalf("nodata hole at %.3f,%.3f", lon, lat)
			}
		}
	}
}
