package server

import (
	"bytes"
	"errors"
	"image/png"
	"net/http"
	"os"
	"strconv"

	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// nodataThreshold matches the GDAL -dstnodata used in the Phase 1 pipeline
// and the tiler's terrain.MinMetres sentinel (−10000).
const nodataThreshold = -9999.0

const minQueryZoom = 6
const maxQueryZoom = 14

type depthResponse struct {
	Lat        float64 `json:"lat"`
	Lon        float64 `json:"lon"`
	ElevationM float64 `json:"elevation_m"`
	Nodata     bool    `json:"nodata"`
	Tile       string  `json:"tile"`
	Encoding   string  `json:"encoding"`
}

func parseCoord(r *http.Request) (lat, lon float64, err error) {
	lat, err = strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	if err != nil {
		return 0, 0, err
	}
	lon, err = strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
	if err != nil {
		return 0, 0, err
	}
	if lat <= -90 || lat >= 90 || lon < -180 || lon > 180 {
		return 0, 0, errors.New("out of range")
	}
	return lat, lon, nil
}

func (s *Server) handleDepth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lat, lon, err := parseCoord(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid lat or lon"})
		return
	}

	for z := maxQueryZoom; z >= minQueryZoom; z-- {
		t := tiles.LonLatToTile(lon, lat, z)
		tb, err := s.tiles.get(t.Z, t.X, t.Y)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, errTraversal) {
				continue
			}
			http.Error(w, "tile unavailable", http.StatusInternalServerError)
			return
		}
		img, err := png.Decode(bytes.NewReader(tb.data))
		if err != nil {
			http.Error(w, "tile unavailable", http.StatusInternalServerError)
			return
		}
		b := img.Bounds()
		tileSize := b.Dx()
		if tileSize <= 0 {
			continue
		}
		px, py := lonLatToPixel(t, lon, lat, tileSize)
		elev, err := terrain.DecodeAt(img, b.Min.X+px, b.Min.Y+py)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no tile"})
			return
		}
		writeJSON(w, http.StatusOK, depthResponse{
			Lat:        lat,
			Lon:        lon,
			ElevationM: elev,
			Nodata:     elev <= nodataThreshold,
			Tile:       t.String(),
			Encoding:   "terrarium",
		})
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "no tile"})
}
