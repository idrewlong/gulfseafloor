package server

import (
	"io/fs"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

type manifest struct {
	Regions []region `json:"regions"`
	// DataVersion identifies the current heightfield build. Tile URLs are not
	// content-addressed, so the client stamps this onto tile requests to avoid
	// reading a stale pyramid out of the HTTP cache after the tiler re-runs.
	DataVersion string `json:"dataVersion"`
}

type region struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	BBox      []float64 `json:"bbox"`
	CRS       string    `json:"crs"`
	MinZoom   int       `json:"minZoom"`
	MaxZoom   int       `json:"maxZoom"`
	Encoding  string    `json:"encoding"`
	TileURL   string    `json:"tileURL"`
	Synthetic bool      `json:"synthetic"`
	// DepthSource names the bathymetry the heightfield was built from, so the
	// viewer caption cites the same grid the tiles were cut from.
	DepthSource string `json:"depthSource"`
	Attribution string `json:"attribution"`
}

var mississippiSound = manifest{
	Regions: []region{{
		ID:       "mississippi-sound",
		Name:     "Mississippi Bight",
		BBox:     []float64{tiles.AOI.West, tiles.AOI.South, tiles.AOI.East, tiles.AOI.North},
		CRS:      "EPSG:4326",
		MinZoom:  6,
		MaxZoom:  14,
		Encoding: "terrain-rgb",
		TileURL:  "/tiles/{z}/{x}/{y}.png",
		// Open-shelf depths are GEBCO. The Sound, the bays and the lagoons are
		// still the procedural near-shore model, because GEBCO does not resolve
		// them — so the surface as a whole is modified, not the published grid.
		Synthetic:   false,
		DepthSource: "GEBCO 2024 (modified)",
		Attribution: "Coastline and island outlines © OpenStreetMap contributors (ODbL). " +
			"Open-shelf depths derived from GEBCO Compilation Group (2024) GEBCO 2024 Grid " +
			"(doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f); " +
			"resampled and blended with a procedural near-shore model — modified, not the " +
			"original unaltered grid. Nearshore, bay and lagoon depths remain a procedural " +
			"stand-in. Not for navigation. Not an official NOAA product; GEBCO, IHO and IOC " +
			"do not endorse this viewer.",
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
