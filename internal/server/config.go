package server

import (
	"io/fs"
	"runtime"
)

// Config is the runtime knobs for the tile/API server.
type Config struct {
	// TileDir is the XYZ pyramid root. Default: data/tiles.
	TileDir string
	// WebDir is a disk SPA root (preferred when index.html exists). Default: web/dist.
	WebDir string
	// Embed is the fallback SPA (placeholder at compile time; real dist in Docker).
	Embed fs.FS
	// CORSOrigin, when set to a single origin (never "*"), is echoed on responses.
	CORSOrigin string
	// TileWorkers bounds concurrent tile disk I/O. Default: GOMAXPROCS.
	TileWorkers int
	// ImageryEnabled proxies public XYZ satellite tiles. Default: true.
	// Set false (GULF_IMAGERY=0) for air-gap — the handler 404s.
	ImageryEnabled bool
	// ImageryTemplate is fmt.Sprintf'd with (z, y, x). Empty → Esri World Imagery.
	ImageryTemplate string
	// OceanDir is the snapshot JSON root (currents.json, buoys.json, manifest.json).
	// Default: data/ocean. Missing files are not a startup failure.
	OceanDir string
}

func (c Config) withDefaults() Config {
	if c.TileDir == "" {
		c.TileDir = "data/tiles"
	}
	if c.WebDir == "" {
		c.WebDir = "web/dist"
	}
	if c.OceanDir == "" {
		c.OceanDir = "data/ocean"
	}
	if c.TileWorkers <= 0 {
		c.TileWorkers = runtime.GOMAXPROCS(0)
		if c.TileWorkers < 1 {
			c.TileWorkers = 1
		}
	}
	return c
}
