package aircraft

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func KnotsToMps(kt float64) float64 {
	return kt * 1852 / 3600
}

func FeetToMetres(ft float64) float64 {
	return ft * 0.3048
}

func ClipAndCap(rows []Aircraft, clip tiles.BBox) []Aircraft {
	filtered := make([]Aircraft, 0, len(rows))
	for _, a := range rows {
		if clip.Contains(a.Lon, a.Lat) {
			filtered = append(filtered, a)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].ICAO24 < filtered[j].ICAO24
	})
	if len(filtered) > MaxAircraft {
		filtered = filtered[:MaxAircraft]
	}
	return filtered
}

func ParseOpenSky(raw []byte, fetchedAt time.Time, clip tiles.BBox) (Snapshot, error) {
	var doc struct {
		States json.RawMessage `json:"states"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Snapshot{}, fmt.Errorf("aircraft: opensky: %w", err)
	}
	if doc.States == nil {
		return Snapshot{Source: SourceOpenSky, FetchedAt: fetchedAt.UTC(), Aircraft: nil}, nil
	}
	var states [][]json.RawMessage
	if err := json.Unmarshal(doc.States, &states); err != nil {
		return Snapshot{}, fmt.Errorf("aircraft: opensky: states: %w", err)
	}

	rows := make([]Aircraft, 0, len(states))
	for _, state := range states {
		a, ok := parseOpenSkyState(state)
		if !ok {
			continue
		}
		rows = append(rows, a)
	}
	return Snapshot{
		Source:    SourceOpenSky,
		FetchedAt: fetchedAt.UTC(),
		Aircraft:  ClipAndCap(rows, clip),
	}, nil
}

func parseOpenSkyState(state []json.RawMessage) (Aircraft, bool) {
	if len(state) < 11 {
		return Aircraft{}, false
	}
	icao24, ok := rawString(state[0])
	if !ok || icao24 == "" {
		return Aircraft{}, false
	}
	lon, okLon := rawFloat64(state[5])
	lat, okLat := rawFloat64(state[6])
	if !okLon || !okLat || !isFinite(lon) || !isFinite(lat) {
		return Aircraft{}, false
	}

	a := Aircraft{
		ICAO24: icao24,
		Lon:    lon,
		Lat:    lat,
	}
	if callsign, ok := rawString(state[1]); ok {
		callsign = strings.TrimSpace(callsign)
		if callsign != "" {
			a.Callsign = callsign
		}
	}
	if alt, ok := rawFloat64(state[7]); ok {
		a.AltBaroM = &alt
	}
	if onGround, ok := rawBool(state[8]); ok {
		a.OnGround = &onGround
	}
	if gs, ok := rawFloat64(state[9]); ok {
		a.GsMps = &gs
	}
	if track, ok := rawFloat64(state[10]); ok {
		a.TrackDeg = &track
	}
	return a, true
}

func ParseAdsbLol(raw []byte, fetchedAt time.Time, clip tiles.BBox) (Snapshot, error) {
	var doc struct {
		AC json.RawMessage `json:"ac"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Snapshot{}, fmt.Errorf("aircraft: adsb.lol: %w", err)
	}
	if doc.AC == nil {
		return Snapshot{Source: SourceAdsbLol, FetchedAt: fetchedAt.UTC(), Aircraft: nil}, nil
	}
	var ac []json.RawMessage
	if err := json.Unmarshal(doc.AC, &ac); err != nil {
		return Snapshot{}, fmt.Errorf("aircraft: adsb.lol: ac: %w", err)
	}

	rows := make([]Aircraft, 0, len(ac))
	for _, row := range ac {
		a, ok := parseAdsbLolRow(row)
		if !ok {
			continue
		}
		rows = append(rows, a)
	}
	return Snapshot{
		Source:    SourceAdsbLol,
		FetchedAt: fetchedAt.UTC(),
		Aircraft:  ClipAndCap(rows, clip),
	}, nil
}

func parseAdsbLolRow(raw json.RawMessage) (Aircraft, bool) {
	var row struct {
		Hex     string          `json:"hex"`
		Flight  string          `json:"flight"`
		Lat     *float64        `json:"lat"`
		Lon     *float64        `json:"lon"`
		AltBaro json.RawMessage `json:"alt_baro"`
		Track   *float64        `json:"track"`
		Gs      *float64        `json:"gs"`
		Ground  *bool           `json:"ground"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return Aircraft{}, false
	}
	if row.Hex == "" || row.Lat == nil || row.Lon == nil {
		return Aircraft{}, false
	}
	if !isFinite(*row.Lat) || !isFinite(*row.Lon) {
		return Aircraft{}, false
	}

	a := Aircraft{
		ICAO24: row.Hex,
		Lon:    *row.Lon,
		Lat:    *row.Lat,
	}
	callsign := strings.TrimSpace(row.Flight)
	if callsign != "" {
		a.Callsign = callsign
	}
	if alt, ok := parseAdsbLolAlt(row.AltBaro); ok {
		a.AltBaroM = &alt
	}
	if row.Track != nil {
		a.TrackDeg = row.Track
	}
	if row.Gs != nil {
		gs := KnotsToMps(*row.Gs)
		a.GsMps = &gs
	}
	if row.Ground != nil {
		a.OnGround = row.Ground
	}
	return a, true
}

func parseAdsbLolAlt(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if strings.EqualFold(s, "ground") {
			return 0, false
		}
		return 0, false
	}
	var ft float64
	if err := json.Unmarshal(raw, &ft); err != nil {
		return 0, false
	}
	return FeetToMetres(ft), true
}

func rawString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

func rawFloat64(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var v float64
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, false
	}
	return v, true
}

func rawBool(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, false
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, false
	}
	return v, true
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
