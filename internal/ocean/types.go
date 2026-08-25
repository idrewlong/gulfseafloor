package ocean

import "time"

// BBox is a geographic bounding box in EPSG:4326 degrees.
type BBox struct {
	West  float64 `json:"west"`
	South float64 `json:"south"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

// Source names the dataset a snapshot was taken from.
type Source struct {
	Name    string `json:"name"`
	Dataset string `json:"dataset"`
	URL     string `json:"url"`
}

// Currents is a surface velocity grid (u eastward, v northward, m/s).
// U and V are row-major, west-to-east, south-to-north; nil cells are missing.
type Currents struct {
	ValidTime time.Time  `json:"validTime"`
	Source    Source     `json:"source"`
	BBox      BBox       `json:"bbox"`
	NX        int        `json:"nx"`
	NY        int        `json:"ny"`
	Grid      string     `json:"grid"`
	U         []*float64 `json:"u"`
	V         []*float64 `json:"v"`
}

// Station is one NDBC observation. Optional numeric fields are omitted or null
// when the station did not report them.
type Station struct {
	ID      string     `json:"id"`
	Name    string     `json:"name"`
	Lon     float64    `json:"lon"`
	Lat     float64    `json:"lat"`
	ObsTime *time.Time `json:"obsTime"`
	WDir    *float64   `json:"wdir"`
	WSpd    *float64   `json:"wspd"`
	Gst     *float64   `json:"gst"`
	WVHT    *float64   `json:"wvht"`
	WTMP    *float64   `json:"wtmp"`
}

// Buoys is a snapshot of NDBC stations.
type Buoys struct {
	ValidTime time.Time `json:"validTime"`
	Source    Source    `json:"source"`
	Stations  []Station `json:"stations"`
}

// LayerInfo describes one product in a snapshot manifest.
type LayerInfo struct {
	Present   bool       `json:"present"`
	ValidTime *time.Time `json:"validTime"`
	Count     int        `json:"count"`
}

// Manifest is the inventory of files under data/ocean/.
type Manifest struct {
	RetrievedAt time.Time `json:"retrievedAt"`
	Currents    LayerInfo `json:"currents"`
	Buoys       LayerInfo `json:"buoys"`
	Attribution []string  `json:"attribution"`
}
