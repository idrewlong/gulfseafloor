package server

import (
	"math"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// lonLatToPixel maps a WGS84 point to a pixel inside tile t.
// Inverse of tiles.PixelLonLat (centre of the returned pixel).
func lonLatToPixel(t tiles.Tile, lon, lat float64, tileSize int) (px, py int) {
	if tileSize <= 0 {
		tileSize = 256
	}
	n := float64(int(1) << uint(t.Z))
	fx := (lon + 180.0) / 360.0 * n
	latRad := lat * math.Pi / 180.0
	fy := (1.0 - math.Log(math.Tan(latRad)+1.0/math.Cos(latRad))/math.Pi) / 2.0 * n
	px = int(math.Floor((fx - float64(t.X)) * float64(tileSize)))
	py = int(math.Floor((fy - float64(t.Y)) * float64(tileSize)))
	if px < 0 {
		px = 0
	}
	if py < 0 {
		py = 0
	}
	if px >= tileSize {
		px = tileSize - 1
	}
	if py >= tileSize {
		py = tileSize - 1
	}
	return px, py
}
