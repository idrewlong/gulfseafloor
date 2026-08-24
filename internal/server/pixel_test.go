package server

import (
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestLonLatToPixelRoundTrip(t *testing.T) {
	tile := tiles.LonLatToTile(-89.1, 29.8, 10)
	const size = 256
	for _, px := range []int{0, 50, 100, 255} {
		for _, py := range []int{0, 50, 128, 255} {
			lon, lat := tiles.PixelLonLat(tile, px, py, size)
			gotX, gotY := lonLatToPixel(tile, lon, lat, size)
			if gotX != px || gotY != py {
				t.Fatalf("pixel (%d,%d) round-trip (%d,%d) lonlat=%g,%g", px, py, gotX, gotY, lon, lat)
			}
		}
	}
}
