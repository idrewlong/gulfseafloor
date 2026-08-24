package server

import (
	"io/fs"
	"net/http"
	"path/filepath"
	"strconv"
)

type manifest struct {
	Regions []region `json:"regions"`
	// DataVersion identifies the current heightfield build. Tile URLs are not
	// content-addressed, so the client stamps this onto tile requests to avoid
	// reading a stale pyramid out of the HTTP cache after the tiler re-runs.
	DataVersion string `json:"dataVersion"`
}

type region struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	BBox        []float64 `json:"bbox"`
	CRS         string    `json:"crs"`
	MinZoom     int       `json:"minZoom"`
	MaxZoom     int       `json:"maxZoom"`
	Encoding    string    `json:"encoding"`
	TileURL     string    `json:"tileURL"`
	Synthetic   bool      `json:"synthetic"`
	Attribution string    `json:"attribution"`
}

var mississippiSound = manifest{
	Regions: []region{{
		ID:        "mississippi-sound",
		Name:      "Mississippi Sound",
		BBox:      []float64{-89.70, 29.95, -87.85, 30.52},
		CRS:       "EPSG:4326",
		MinZoom:   6,
		MaxZoom:   14,
		Encoding:  "terrarium",
		TileURL:   "/tiles/{z}/{x}/{y}.png",
		Synthetic: true,
		Attribution: "Coastline and island outlines © OpenStreetMap contributors (ODbL). " +
			"Depths are a synthetic stand-in for demonstration. Not an official NOAA product. " +
			"When unaltered NOAA National Bathymetric Source data is substituted, attribute NOAA/NODD; do not imply endorsement.",
	}},
}

func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	out := mississippiSound
	out.DataVersion = tileDataVersion(s.cfg.TileDir)
	writeJSON(w, http.StatusOK, out)
}

// tileDataVersion fingerprints the tile pyramid by newest mtime and file count.
// Cheap enough for the single manifest request each page load.
func tileDataVersion(dir string) string {
	var newest int64
	count := 0
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(p) != ".png" {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		count++
		if t := fi.ModTime().UnixMilli(); t > newest {
			newest = t
		}
		return nil
	})
	if count == 0 {
		return "empty"
	}
	return strconv.FormatInt(newest, 36) + "-" + strconv.Itoa(count)
}
