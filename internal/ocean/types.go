package ocean

import (
	"strings"
	"time"
)

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

// Step is one forecast time of the surface velocity grid. U and V are
// row-major, west-to-east, south-to-north; nil cells are missing.
type Step struct {
	ValidTime time.Time  `json:"validTime"`
	U         []*float64 `json:"u"`
	V         []*float64 `json:"v"`
}

// Currents is a stack of surface velocity grids (u eastward, v northward,
// m/s) sharing one bbox and shape. ValidTime is the first step.
type Currents struct {
	ValidTime time.Time `json:"validTime"`
	Source    Source    `json:"source"`
	BBox      BBox      `json:"bbox"`
	NX        int       `json:"nx"`
	NY        int       `json:"ny"`
	Grid      string    `json:"grid"`
	Steps     []Step    `json:"steps"`

	// U and V are the legacy single-step fields. They are decode-only:
	// DecodeCurrents lifts them into Steps and they are never marshalled.
	U []*float64 `json:"u,omitempty"`
	V []*float64 `json:"v,omitempty"`
}

// StationKind is the platform class NDBC records in station_table.txt's
// ttype column. A moored float and a station bolted to a pier report the
// same stdmet fields but are not the same instrument, and the viewer draws
// them with different glyphs, so the class travels with the observation
// rather than being guessed from the ID format.
type StationKind string

const (
	KindBuoy  StationKind = "buoy"
	KindFixed StationKind = "fixed"
	KindRig   StationKind = "rig"
	KindDart  StationKind = "dart"
	KindOther StationKind = "other"
)

// StationKindFromTType classifies an NDBC ttype cell.
//
// TTYPE is free text, not an enum: the live station_table.txt carries about
// sixty-five distinct spellings ("3-meter discus buoy", "Water Level
// Observation Network", "C-MAN Station", "Oil Platform", "2.6 meter DART
// buoy"). So this matches on keywords, and the order of the checks matters —
// "2.6 meter DART buoy" and "STB - SAIC Tsunami Buoy" both contain "buoy",
// and must be caught as DART first.
//
// Unrecognized and empty cells become KindOther rather than an error: NDBC
// adds platform types without notice, and an unclassifiable one is still a
// real station worth drawing.
func StationKindFromTType(ttype string) StationKind {
	t := strings.ToLower(strings.TrimSpace(ttype))
	if t == "" {
		return KindOther
	}
	switch {
	case strings.Contains(t, "dart"), strings.Contains(t, "tsunami"):
		return KindDart
	case strings.Contains(t, "platform"), strings.Contains(t, "oil"):
		return KindRig
	// Lightships float and are moored, so they read as buoys under the
	// hollow-means-it-floats rule the glyphs follow.
	case strings.Contains(t, "buoy"), strings.Contains(t, "lightship"):
		return KindBuoy
	case strings.Contains(t, "station"),
		strings.Contains(t, "tower"),
		strings.Contains(t, "network"),
		strings.Contains(t, "c-man"):
		return KindFixed
	default:
		return KindOther
	}
}

// NormalizeKind resolves an absent or unrecognized kind to KindOther. A
// buoys.json written before this field existed carries no kind at all, and
// decoding one must still yield a value the viewer can pick a glyph from.
func NormalizeKind(k StationKind) StationKind {
	switch k {
	case KindBuoy, KindFixed, KindRig, KindDart:
		return k
	default:
		return KindOther
	}
}

// Station is one NDBC observation. Optional numeric fields are omitted or null
// when the station did not report them.
type Station struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Kind    StationKind `json:"kind"`
	Lon     float64     `json:"lon"`
	Lat     float64     `json:"lat"`
	ObsTime *time.Time  `json:"obsTime"`
	WDir    *float64    `json:"wdir"`
	WSpd    *float64    `json:"wspd"`
	Gst     *float64    `json:"gst"`
	WVHT    *float64    `json:"wvht"`
	WTMP    *float64    `json:"wtmp"`
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
	// RetrievedAt is when this layer was actually fetched from its upstream.
	// Optional and independent of the top-level Manifest.RetrievedAt: the
	// currents refresher and the buoys ingest (`make ocean`) run on
	// decoupled schedules, so one timestamp cannot honestly describe both.
	// Nil when unknown (e.g. a manifest written before this field existed).
	RetrievedAt *time.Time `json:"retrievedAt,omitempty"`
}

// Manifest is the inventory of files under data/ocean/.
type Manifest struct {
	RetrievedAt time.Time `json:"retrievedAt"`
	Currents    LayerInfo `json:"currents"`
	Buoys       LayerInfo `json:"buoys"`
	Attribution []string  `json:"attribution"`
}
