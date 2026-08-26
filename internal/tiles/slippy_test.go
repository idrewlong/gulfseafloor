package tiles

import (
	"math"
	"testing"
)

func TestAOICoversNewOrleansToOrangeBeachAnd42354(t *testing.T) {
	points := []struct {
		name     string
		lon, lat float64
	}{
		{"CARL1 New Orleans", -90.135, 29.933},
		{"PPTA1 Orange Beach / Perdido", -87.556, 30.279},
		{"42354 Chandeleur SE", -88.643, 29.579},
	}
	for _, p := range points {
		if !AOI.Contains(p.lon, p.lat) {
			t.Errorf("%s (%.3f, %.3f) must lie inside AOI %+v", p.name, p.lon, p.lat, AOI)
		}
	}
}

func TestLonLatToTileKnown(t *testing.T) {
	// Null Island at z=0 is tile 0/0/0.
	got := LonLatToTile(0, 0, 0)
	if got != (Tile{Z: 0, X: 0, Y: 0}) {
		t.Fatalf("z0: got %v", got)
	}

	// Gulfport, MS should land in the Mississippi Sound covering at z=8.
	gulf := LonLatToTile(-89.09, 30.37, 8)
	cover := Covering(AOI, 8)
	found := false
	for _, c := range cover {
		if c == gulf {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("AOI covering at z=8 does not include tile for Gulfport: %v in %v", gulf, cover)
	}
}

func TestBoundsRoundTrip(t *testing.T) {
	tile := LonLatToTile(-89.1, 29.8, 10)
	b := Bounds(tile)
	if !b.Contains(-89.1, 29.8) {
		t.Fatalf("tile %v bounds %v does not contain the seed point", tile, b)
	}
	// A point clearly outside the tile.
	if b.Contains(-80, 40) {
		t.Fatal("bounds unexpectedly huge")
	}
}

func TestPixelLonLatCentre(t *testing.T) {
	tile := Tile{Z: 8, X: 67, Y: 105}
	lon, lat := PixelLonLat(tile, 128, 128, 256)
	b := Bounds(tile)
	midLon := (b.West + b.East) / 2
	midLat := (b.South + b.North) / 2
	if math.Abs(lon-midLon) > 0.01 || math.Abs(lat-midLat) > 0.01 {
		t.Fatalf("pixel centre %g,%g vs bbox mid %g,%g", lon, lat, midLon, midLat)
	}
}

func TestParentChildren(t *testing.T) {
	p := Tile{Z: 4, X: 4, Y: 6}
	kids := p.Children()
	if len(kids) != 4 {
		t.Fatal(kids)
	}
	for _, k := range kids {
		got, ok := k.Parent()
		if !ok || got != p {
			t.Fatalf("child %v parent = %v, %v", k, got, ok)
		}
	}
}

func TestCoveringNonEmpty(t *testing.T) {
	tiles := Covering(AOI, 9)
	if len(tiles) == 0 {
		t.Fatal("expected tiles over the AOI")
	}
	for _, tile := range tiles {
		b := Bounds(tile)
		if b.East < AOI.West || b.West > AOI.East || b.North < AOI.South || b.South > AOI.North {
			t.Fatalf("tile %v bounds %v does not intersect AOI", tile, b)
		}
	}
}

func TestSpanMetresPositive(t *testing.T) {
	span := SpanMetres(LonLatToTile(-89, 29.5, 10))
	if span < 1000 || span > 200_000 {
		t.Fatalf("implausible tile span: %g m", span)
	}
}

func TestIntersectClipsToOverlap(t *testing.T) {
	tile := BBox{
		West:  AOI.West - 1,
		South: AOI.South - 1,
		East:  (AOI.West + AOI.East) / 2,
		North: (AOI.South + AOI.North) / 2,
	}
	got, ok := Intersect(tile, AOI)
	if !ok {
		t.Fatal("expected overlap")
	}
	want := BBox{West: AOI.West, South: AOI.South, East: tile.East, North: tile.North}
	if got != want {
		t.Fatalf("clip = %#v want %#v", got, want)
	}
}

func TestIntersectEmptyWhenDisjoint(t *testing.T) {
	if _, ok := Intersect(BBox{West: 0, South: 0, East: 1, North: 1}, AOI); ok {
		t.Fatal("disjoint boxes should not intersect")
	}
}

func TestHeightUvRectFullTile(t *testing.T) {
	b := BBox{West: -90, South: 28, East: -88, North: 30}
	ox, oy, sx, sy := HeightUvRect(b, b)
	if ox != 0 || oy != 0 || sx != 1 || sy != 1 {
		t.Fatalf("full tile uv = %g,%g + %g×%g", ox, oy, sx, sy)
	}
}

func TestHeightUvRectPartialClip(t *testing.T) {
	tile := BBox{West: -91, South: 28, East: -89, North: 30}
	clip := BBox{West: -90, South: 28.5, East: -89, North: 30}
	ox, oy, sx, sy := HeightUvRect(tile, clip)
	if math.Abs(ox-0.5) > 1e-9 || math.Abs(oy-0.25) > 1e-9 {
		t.Fatalf("offset = %g,%g", ox, oy)
	}
	if math.Abs(sx-0.5) > 1e-9 || math.Abs(sy-0.75) > 1e-9 {
		t.Fatalf("scale = %g×%g", sx, sy)
	}
}
