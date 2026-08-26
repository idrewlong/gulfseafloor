package aircraft

import "time"

type Source string

const (
	SourceOpenSky Source = "opensky"
	SourceAdsbLol Source = "adsb.lol"
)

const MaxAircraft = 200

type Aircraft struct {
	ICAO24   string   `json:"icao24"`
	Callsign string   `json:"callsign,omitempty"`
	Lon      float64  `json:"lon"`
	Lat      float64  `json:"lat"`
	AltBaroM *float64 `json:"altBaroM,omitempty"`
	TrackDeg *float64 `json:"trackDeg,omitempty"`
	GsMps    *float64 `json:"gsMps,omitempty"`
	OnGround *bool    `json:"onGround,omitempty"`
}

type Snapshot struct {
	Source    Source     `json:"source"`
	FetchedAt time.Time  `json:"fetchedAt"`
	Aircraft  []Aircraft `json:"aircraft"`
}
