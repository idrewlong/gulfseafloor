package server

import (
	"io/fs"
	"net/http"
	"runtime"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/ocean"
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
	// OceanDir is the snapshot JSON root (currents.json, buoys.json, manifest.json).
	// Default: data/ocean. Missing files are not a startup failure.
	OceanDir string
	// AircraftEnabled fetches and serves live ADS-B positions.
	AircraftEnabled bool
	// OpenSkyURL is the OpenSky states endpoint.
	OpenSkyURL string
	// AdsbLolURL is the adsb.lol API origin.
	AdsbLolURL string
	// AircraftNow supplies the cache clock. Default: time.Now().UTC.
	AircraftNow func() time.Time
	// AircraftCacheTTL controls how long a successful fetch stays fresh. Default: 10s.
	AircraftCacheTTL time.Duration
	// AircraftStaleFor controls how long a prior success may mask feed failure. Default: 60s.
	AircraftStaleFor time.Duration
	// OceanRefreshEnabled re-fetches HYCOM currents in the background.
	// Off means zero egress: the disk snapshot is served unchanged.
	OceanRefreshEnabled bool
	// OceanRefreshEvery is the refresh period. Default: 1h.
	OceanRefreshEvery time.Duration
	// HYCOMURL is the NCSS base. Default: ocean.DefaultHYCOMBase.
	HYCOMURL string
	// OceanNow supplies the refresher clock. Default: time.Now().UTC.
	OceanNow func() time.Time
	// OceanClient is the refresher's HTTP client. Default: 90s timeout.
	OceanClient *http.Client
	// OceanFirstRefreshDelay delays the first refresh after boot so startup
	// never waits on NCSS. Default: 15s. Tests set it small.
	OceanFirstRefreshDelay time.Duration
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
	if c.AircraftNow == nil {
		c.AircraftNow = func() time.Time { return time.Now().UTC() }
	}
	if c.AircraftCacheTTL == 0 {
		c.AircraftCacheTTL = 10 * time.Second
	}
	if c.AircraftStaleFor == 0 {
		c.AircraftStaleFor = 60 * time.Second
	}
	if c.TileWorkers <= 0 {
		c.TileWorkers = runtime.GOMAXPROCS(0)
		if c.TileWorkers < 1 {
			c.TileWorkers = 1
		}
	}
	if c.OceanRefreshEvery == 0 {
		c.OceanRefreshEvery = time.Hour
	}
	if c.HYCOMURL == "" {
		c.HYCOMURL = ocean.DefaultHYCOMBase
	}
	if c.OceanNow == nil {
		c.OceanNow = func() time.Time { return time.Now().UTC() }
	}
	if c.OceanClient == nil {
		c.OceanClient = &http.Client{Timeout: 90 * time.Second}
	}
	if c.OceanFirstRefreshDelay == 0 {
		c.OceanFirstRefreshDelay = firstRefreshDelay
	}
	return c
}
