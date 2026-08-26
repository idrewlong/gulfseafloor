package shelf

import (
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestOutsideAOIIsNodata(t *testing.T) {
	if elev := Sample(-87.0, 29.5); elev > terrain.MinMetres+1 {
		t.Fatalf("outside AOI should be nodata, got %g", elev)
	}
}

func TestNewOrleansIsLand(t *testing.T) {
	if elev := Sample(-90.08, 29.96); elev < 0 {
		t.Fatalf("New Orleans should be land, got %g", elev)
	}
}

func TestOrangeBeachIsLand(t *testing.T) {
	if elev := Sample(-87.57, 30.34); elev < 0 {
		t.Fatalf("Orange Beach should be land, got %g", elev)
	}
}

func TestLakePontchartrainIsWater(t *testing.T) {
	elev := Sample(-90.12, 30.20)
	if elev >= 0 {
		t.Fatalf("Lake Pontchartrain should be water, got %g", elev)
	}
	if elev < -8 || elev > -1 {
		t.Fatalf("Pontchartrain is a few metres deep, got %g", elev)
	}
}

func TestPerdidoBayIsWater(t *testing.T) {
	elev := Sample(-87.48, 30.34)
	if elev >= 0 {
		t.Fatalf("Perdido Bay should be water, got %g", elev)
	}
	if elev < -6 {
		t.Fatalf("Perdido Bay should stay a shallow lagoon, got %g", elev)
	}
}

func TestOrangeBeachGulfDeeperThanSound(t *testing.T) {
	sound := Sample(-88.75, 30.30)
	surf := Sample(-87.57, 30.26)
	if surf >= 0 {
		t.Fatalf("gulf off Orange Beach should be water, got %g", surf)
	}
	if surf >= sound {
		t.Fatalf("Orange Beach gulf (%g) should be deeper than the Sound (%g)", surf, sound)
	}
	if surf < -20 {
		t.Fatalf("surf zone off Orange Beach is inner shelf, not mid-gulf, got %g", surf)
	}
}

func TestLakeBorgneIsLagoon(t *testing.T) {
	elev := Sample(-89.55, 30.08)
	if elev >= 0 {
		t.Fatalf("Lake Borgne should be water, got %g", elev)
	}
	if elev < -8 {
		t.Fatalf("Lake Borgne should stay a shallow lagoon, got %g", elev)
	}
}

func TestChandeleurSoundIsLagoon(t *testing.T) {
	elev := Sample(-89.00, 29.85)
	if elev >= 0 {
		t.Fatalf("Chandeleur Sound should be water, got %g", elev)
	}
	if elev < -12 {
		t.Fatalf("Chandeleur Sound should not take open-gulf mid-shelf depth, got %g", elev)
	}
}

func TestBuoy42354IsWater(t *testing.T) {
	if elev := Sample(-88.643, 29.579); elev >= 0 {
		t.Fatalf("42354 should be open water, got %g", elev)
	}
}

func TestSoundShallowerThanOpenGulf(t *testing.T) {
	sound := Sample(-88.75, 30.30)
	gulf := Sample(-88.75, 30.02)
	if sound < -12 || sound > -1 {
		t.Fatalf("Mississippi Sound should be a few metres deep, got %g", sound)
	}
	if gulf >= sound {
		t.Fatalf("gulf south of the islands (%g) should be deeper than the sound (%g)", gulf, sound)
	}
}

// The chart now runs south to 42354. The old 26 km / −40 m ramp finished just
// south of the islands, so the added water was a flat plate.
func TestOpenGulfDeepensToward42354(t *testing.T) {
	near := Sample(-88.75, 30.02)
	far := Sample(-88.643, 29.579)
	if near >= 0 {
		t.Fatalf("inner shelf south of the islands should be water, got %g", near)
	}
	if far >= near-20 {
		t.Fatalf("42354 (%g) should sit well below the inner shelf (%g)", far, near)
	}
	if far > -60 || far < -90 {
		t.Fatalf("42354 should be mid-shelf (~−80 m), got %g", far)
	}
}

func TestBarrierIslandNearSeaLevel(t *testing.T) {
	ship := Sample(-88.97, 30.213)
	if ship < 0 || ship > 5 {
		t.Fatalf("West Ship Island should be land near the waterline, got %g", ship)
	}
}

func TestMainlandIsLand(t *testing.T) {
	gulfport := Sample(-89.09, 30.39)
	if gulfport < 0 {
		t.Fatalf("Gulfport should be land, got %g", gulfport)
	}
}

func TestPassDeeperThanIsland(t *testing.T) {
	island := Sample(-88.97, 30.213)
	pass := Sample(-88.82, 30.21)
	if pass >= island {
		t.Fatalf("pass %g should be deeper than Ship Island %g", pass, island)
	}
}

func TestInteriorIsNeverNodata(t *testing.T) {
	elev := Sample((tiles.AOI.West+tiles.AOI.East)/2, (tiles.AOI.South+tiles.AOI.North)/2)
	if elev <= -9999 {
		t.Fatalf("AOI centre should be a depth, got %g", elev)
	}
}

func TestCatIslandIsLand(t *testing.T) {
	if elev := Sample(-89.12, 30.23); elev < 0 {
		t.Fatalf("Cat Island should be land, got %g", elev)
	}
}

func TestHornIslandIsLand(t *testing.T) {
	if elev := Sample(-88.67, 30.238); elev < 0 {
		t.Fatalf("Horn Island should be land, got %g", elev)
	}
}

func TestDauphinIslandIsLand(t *testing.T) {
	if elev := Sample(-88.13, 30.250); elev < 0 {
		t.Fatalf("Dauphin Island should be land, got %g", elev)
	}
}

func TestBayOfSaintLouisIsWater(t *testing.T) {
	if elev := Sample(-89.32, 30.34); elev >= 0 {
		t.Fatalf("Bay of St. Louis should be water, got %g", elev)
	}
}

func TestBackBayIsWater(t *testing.T) {
	if elev := Sample(-88.90, 30.42); elev >= 0 {
		t.Fatalf("Back Bay of Biloxi should be water, got %g", elev)
	}
}

func TestBiloxiPeninsulaIsLand(t *testing.T) {
	if elev := Sample(-88.91, 30.398); elev < 0 {
		t.Fatalf("Biloxi peninsula should be land, got %g", elev)
	}
}

// The mainland ring used to close with a straight jump at lon -88.08, which
// left everything east of it as open water at every latitude.
func TestAlabamaShoreEastOfMobileBayIsLand(t *testing.T) {
	if elev := Sample(-87.88, 30.50); elev < 0 {
		t.Fatalf("Alabama shore east of Mobile Bay should be land, got %g", elev)
	}
}

func TestMobileBayIsStillWater(t *testing.T) {
	if elev := Sample(-87.98, 30.45); elev >= 0 {
		t.Fatalf("Mobile Bay should be water, got %g", elev)
	}
}

// The ring's north edge sat exactly on the AOI north edge, so the top row of
// samples tested as outside the polygon and came back as water.
func TestNorthAOIEdgeIsLand(t *testing.T) {
	// Away from any river mouth, which is legitimately water.
	if elev := Sample(-88.30, tiles.AOI.North); elev < 0 {
		t.Fatalf("inland north AOI edge should be land, got %g", elev)
	}
}

// The mainland ring was hand-typed at 46 points, with a spurious notch at
// Gulfport, and Back Bay and the Pascagoula River were crude boxes laid over
// the coast. Every one of these towns sampled as open water.
func TestCoastalTownsAreLand(t *testing.T) {
	towns := map[string][2]float64{
		"Gulfport":      {-89.0928, 30.3674},
		"Pascagoula":    {-88.5561, 30.3658},
		"Ocean Springs": {-88.8281, 30.4113},
		"D'Iberville":   {-88.8903, 30.4260},
		"Waveland":      {-89.3767, 30.2869},
		"Moss Point":    {-88.5278, 30.4177},
		"Long Beach":    {-89.1528, 30.3505},
		"Gautier":       {-88.6119, 30.3855},
	}
	for name, p := range towns {
		if elev := Sample(p[0], p[1]); elev <= 0 {
			t.Errorf("%s should be land, got %g m", name, elev)
		}
	}
}

// Inland distance used to be measured to the nearest edge of the mainland
// ring, including the synthetic edge that closed it across the top. Past the
// midpoint that edge was the closest one, so the plain descended again and the
// northern third of the map flattened back to the shoreline height.
func TestCoastalPlainKeepsRisingToTheNorthEdge(t *testing.T) {
	const lon = -89.05
	prev := Sample(lon, 30.40)
	// Stay on the Sound coastal plain. North of ~30.56 the expanded OSM
	// waterline includes inland bayous, which are a real shore, not the
	// synthetic closing edge this test is watching for.
	for lat := 30.42; lat <= 30.56; lat += 0.02 {
		got := Sample(lon, lat)
		if got < prev-0.75 {
			t.Fatalf("plain drops from %g m to %g m at lat %.2f — measuring to the ring's closing edge again", prev, got, lat)
		}
		prev = got
	}
	if prev < 6 {
		t.Fatalf("plain at the north edge is only %g m; it should have climbed", prev)
	}
}

// River valleys subtracted (h + 1.8), which pushed the centreline below the
// waterline and opened fake channels through the coastal plain.
func TestRiverValleysDoNotBreachTheWaterline(t *testing.T) {
	for _, r := range rivers {
		for _, p := range r {
			if !indexed().mainland.contains(p[0], p[1]) {
				continue // tidal reach, genuinely water
			}
			if elev := Sample(p[0], p[1]); elev <= 0 {
				t.Errorf("river centreline at %.3f,%.3f cuts below the waterline: %g m", p[0], p[1], elev)
			}
		}
	}
}

func TestCoastalPlainRisesInland(t *testing.T) {
	nearShore := Sample(-89.05, 30.400)
	inland := Sample(-89.05, 30.500)
	if inland <= nearShore {
		t.Fatalf("plain %g at 11 km inland should sit above the shore %g", inland, nearShore)
	}
}

func TestRiverValleyCutsThePlain(t *testing.T) {
	river := Sample(-88.575, 30.465) // Pascagoula centreline
	bank := Sample(-88.640, 30.465)
	if river >= bank {
		t.Fatalf("Pascagoula River %g should sit below its bank %g", river, bank)
	}
}

// Depth used to be a pure function of latitude in the Gulf, so every east-west
// line rendered as a flat band. Contours should follow the island chain.
func TestGulfDepthVariesAlongLatitude(t *testing.T) {
	const lat = 30.05
	behindHorn := Sample(-88.67, lat)
	betweenIslands := Sample(-88.40, lat)
	if behindHorn == betweenIslands {
		t.Fatalf("gulf depth is constant along lat %g (%g) — latitude banding is back", lat, behindHorn)
	}
}

func TestIslandsSitOnAShoal(t *testing.T) {
	apron := Sample(-88.67, 30.213) // ~1 km south of Horn
	openSound := Sample(-88.67, 30.310)
	if apron <= openSound {
		t.Fatalf("island apron %g should be shallower than the open Sound %g", apron, openSound)
	}
}

func TestWaterNeverBecomesLand(t *testing.T) {
	// The island shoal is blended, not added, so it must not push water above
	// the waterline anywhere along the chain.
	for lon := -89.30; lon <= -88.00; lon += 0.005 {
		for lat := 30.16; lat <= 30.28; lat += 0.005 {
			e := Sample(lon, lat)
			if e > 0 && e < 0.5 {
				continue // genuine island berm
			}
			if e > 0.5 {
				continue // island interior
			}
			if e > -0.39 {
				t.Fatalf("water at %.3f,%.3f pinned to the clamp (%g)", lon, lat, e)
			}
		}
	}
}

func TestRingContainsSquare(t *testing.T) {
	sq := [][]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {0, 0}}
	if !ringContains(sq, 0.5, 0.5) {
		t.Fatal("centre should be inside")
	}
	if ringContains(sq, 2, 2) {
		t.Fatal("outside should miss")
	}
}
