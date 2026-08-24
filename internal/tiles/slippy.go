// Package tiles implements slippy-map (XYZ) math in Web Mercator (EPSG:3857).
package tiles

import (
	"fmt"
	"math"
)

// AOI is the Mississippi Sound, WGS84 — Lake Borgne to Dauphin Island,
// mainland to just south of the barrier-island chain.
var AOI = BBox{
	West:  -89.70,
	South: 29.95,
	East:  -87.85,
	North: 30.52,
}

// BBox is a geographic bounding box in EPSG:4326 degrees.
type BBox struct {
	West, South, East, North float64
}

func (b BBox) Contains(lon, lat float64) bool {
	return lon >= b.West && lon <= b.East && lat >= b.South && lat <= b.North
}

// Intersect returns the overlapping box of a and b.
func Intersect(a, b BBox) (BBox, bool) {
	out := BBox{
		West:  math.Max(a.West, b.West),
		South: math.Max(a.South, b.South),
		East:  math.Min(a.East, b.East),
		North: math.Min(a.North, b.North),
	}
	if out.West >= out.East || out.South >= out.North {
		return BBox{}, false
	}
	return out, true
}

// HeightUvRect maps clip onto tile texture space. v=0 is south, v=1 is north.
func HeightUvRect(tile, clip BBox) (offsetX, offsetY, scaleX, scaleY float64) {
	tw := tile.East - tile.West
	th := tile.North - tile.South
	if tw == 0 || th == 0 {
		return 0, 0, 1, 1
	}
	return (clip.West - tile.West) / tw,
		(clip.South - tile.South) / th,
		(clip.East - clip.West) / tw,
		(clip.North - clip.South) / th
}

// Tile is a slippy-map XYZ coordinate.
type Tile struct {
	Z, X, Y int
}

func (t Tile) String() string {
	return fmt.Sprintf("%d/%d/%d", t.Z, t.X, t.Y)
}

func (t Tile) Parent() (Tile, bool) {
	if t.Z <= 0 {
		return Tile{}, false
	}
	return Tile{Z: t.Z - 1, X: t.X / 2, Y: t.Y / 2}, true
}

func (t Tile) Children() []Tile {
	return []Tile{
		{Z: t.Z + 1, X: t.X * 2, Y: t.Y * 2},
		{Z: t.Z + 1, X: t.X*2 + 1, Y: t.Y * 2},
		{Z: t.Z + 1, X: t.X * 2, Y: t.Y*2 + 1},
		{Z: t.Z + 1, X: t.X*2 + 1, Y: t.Y*2 + 1},
	}
}

// LonLatToTile returns the tile containing (lon, lat) at zoom z.
func LonLatToTile(lon, lat float64, z int) Tile {
	n := float64(int(1) << uint(z))
	x := int(math.Floor((lon + 180.0) / 360.0 * n))
	latRad := lat * math.Pi / 180.0
	y := int(math.Floor((1.0 - math.Log(math.Tan(latRad)+1.0/math.Cos(latRad))/math.Pi) / 2.0 * n))
	x = clampInt(x, 0, int(n)-1)
	y = clampInt(y, 0, int(n)-1)
	return Tile{Z: z, X: x, Y: y}
}

// Bounds returns the WGS84 bounding box of tile t.
func Bounds(t Tile) BBox {
	n := float64(int(1) << uint(t.Z))
	west := float64(t.X)/n*360.0 - 180.0
	east := float64(t.X+1)/n*360.0 - 180.0
	north := yToLat(float64(t.Y) / n)
	south := yToLat(float64(t.Y+1) / n)
	return BBox{West: west, South: south, East: east, North: north}
}

// PixelLonLat returns the WGS84 coordinate of the centre of pixel (px, py)
// in a 256×256 tile.
func PixelLonLat(t Tile, px, py, tileSize int) (lon, lat float64) {
	if tileSize <= 0 {
		tileSize = 256
	}
	n := float64(int(1) << uint(t.Z))
	lon = (float64(t.X) + (float64(px)+0.5)/float64(tileSize)) / n * 360.0 - 180.0
	y := (float64(t.Y) + (float64(py)+0.5)/float64(tileSize)) / n
	lat = yToLat(y)
	return lon, lat
}

// Covering returns every tile at zoom z that intersects bbox.
func Covering(bbox BBox, z int) []Tile {
	nw := LonLatToTile(bbox.West, bbox.North, z)
	se := LonLatToTile(bbox.East, bbox.South, z)
	minX, maxX := nw.X, se.X
	minY, maxY := nw.Y, se.Y
	if minX > maxX {
		minX, maxX = maxX, minX
	}
	if minY > maxY {
		minY, maxY = maxY, minY
	}
	out := make([]Tile, 0, (maxX-minX+1)*(maxY-minY+1))
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			out = append(out, Tile{Z: z, X: x, Y: y})
		}
	}
	return out
}

// SpanMetres approximates the east-west ground span of a tile at its
// centre latitude. Used by the renderer as uTileSpanMeters.
func SpanMetres(t Tile) float64 {
	b := Bounds(t)
	midLat := (b.North + b.South) / 2
	return haversineMetres(b.West, midLat, b.East, midLat)
}

func yToLat(y float64) float64 {
	return math.Atan(math.Sinh(math.Pi*(1 - 2*y))) * 180.0 / math.Pi
}

func haversineMetres(lon1, lat1, lon2, lat2 float64) float64 {
	const r = 6371000.0
	φ1 := lat1 * math.Pi / 180
	φ2 := lat2 * math.Pi / 180
	dφ := (lat2 - lat1) * math.Pi / 180
	dλ := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dφ/2)*math.Sin(dφ/2) + math.Cos(φ1)*math.Cos(φ2)*math.Sin(dλ/2)*math.Sin(dλ/2)
	return 2 * r * math.Asin(math.Min(1, math.Sqrt(a)))
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
