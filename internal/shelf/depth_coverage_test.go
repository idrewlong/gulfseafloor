package shelf

import (
	"math"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestWaterSouthOfCatIslandMatchesSouthOfHorn(t *testing.T) {
	southOfCat := Sample(-89.12, 30.10)
	southOfHorn := Sample(-88.67, 30.10)
	if southOfCat >= 0 {
		t.Fatalf("south of Cat Island should be water, got %g", southOfCat)
	}
	if southOfHorn >= 0 {
		t.Fatalf("south of Horn Island should be water, got %g", southOfHorn)
	}
	// A longitude wall at -88.80 used to cap everything west of Horn as lagoon,
	// so this patch rendered as a pale 3 m plate next to −30 m gulf.
	if southOfCat > southOfHorn+8 {
		t.Fatalf("south of Cat (%g) is lagoon-capped; south of Horn is %g", southOfCat, southOfHorn)
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
