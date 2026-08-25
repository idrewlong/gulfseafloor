package ocean

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"time"
)

// DecodeCurrents reads currents.json. Unknown keys are ignored so Slice 2 can
// add fields without breaking Slice 1 readers.
func DecodeCurrents(r io.Reader) (Currents, error) {
	var c Currents
	if err := json.NewDecoder(r).Decode(&c); err != nil {
		return Currents{}, fmt.Errorf("ocean: currents: %w", err)
	}
	valid, err := requireUTC(c.ValidTime)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: currents: validTime %w", err)
	}
	c.ValidTime = valid
	if c.ValidTime.IsZero() {
		return Currents{}, fmt.Errorf("ocean: currents: missing validTime")
	}
	if c.Source.Name == "" {
		return Currents{}, fmt.Errorf("ocean: currents: missing source.name")
	}
	if c.Grid != "centers" {
		return Currents{}, fmt.Errorf("ocean: currents: grid %q is not centers", c.Grid)
	}
	if c.NX <= 0 || c.NY <= 0 {
		return Currents{}, fmt.Errorf("ocean: currents: nx and ny must be positive")
	}
	need := c.NX * c.NY
	if len(c.U) != need || len(c.V) != need {
		return Currents{}, fmt.Errorf("ocean: currents: u/v length must equal nx*ny (%d)", need)
	}
	if c.BBox.West >= c.BBox.East || c.BBox.South >= c.BBox.North {
		return Currents{}, fmt.Errorf("ocean: currents: bbox west<east and south<north required")
	}
	return c, nil
}

// DecodeBuoys reads buoys.json. Empty stations is allowed.
func DecodeBuoys(r io.Reader) (Buoys, error) {
	var b Buoys
	if err := json.NewDecoder(r).Decode(&b); err != nil {
		return Buoys{}, fmt.Errorf("ocean: buoys: %w", err)
	}
	valid, err := requireUTC(b.ValidTime)
	if err != nil {
		return Buoys{}, fmt.Errorf("ocean: buoys: validTime %w", err)
	}
	b.ValidTime = valid
	if b.Source.Name == "" {
		return Buoys{}, fmt.Errorf("ocean: buoys: missing source.name")
	}
	for i, s := range b.Stations {
		if s.ID == "" {
			return Buoys{}, fmt.Errorf("ocean: buoys: station %d missing id", i)
		}
		if !finite(s.Lon) || !finite(s.Lat) {
			return Buoys{}, fmt.Errorf("ocean: buoys: station %s non-finite lon/lat", s.ID)
		}
		obs, err := requireUTCPtr(s.ObsTime)
		if err != nil {
			return Buoys{}, fmt.Errorf("ocean: buoys: station %s obsTime %w", s.ID, err)
		}
		b.Stations[i].ObsTime = obs
	}
	return b, nil
}

// DecodeManifest reads manifest.json. Currents and Buoys may be absent.
func DecodeManifest(r io.Reader) (Manifest, error) {
	var m Manifest
	if err := json.NewDecoder(r).Decode(&m); err != nil {
		return Manifest{}, fmt.Errorf("ocean: manifest: %w", err)
	}
	retrieved, err := requireUTC(m.RetrievedAt)
	if err != nil {
		return Manifest{}, fmt.Errorf("ocean: manifest: retrievedAt %w", err)
	}
	m.RetrievedAt = retrieved
	if m.RetrievedAt.IsZero() {
		return Manifest{}, fmt.Errorf("ocean: manifest: missing retrievedAt")
	}
	if err := utcLayer(&m.Currents, "currents"); err != nil {
		return Manifest{}, err
	}
	if err := utcLayer(&m.Buoys, "buoys"); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

func utcLayer(info *LayerInfo, name string) error {
	t, err := requireUTCPtr(info.ValidTime)
	if err != nil {
		return fmt.Errorf("ocean: manifest: %s validTime %w", name, err)
	}
	info.ValidTime = t
	return nil
}

// requireUTC accepts RFC3339 Z and +00:00; it rejects any non-zero offset.
func requireUTC(t time.Time) (time.Time, error) {
	if t.IsZero() {
		return t, nil
	}
	_, offset := t.Zone()
	if offset != 0 {
		return time.Time{}, fmt.Errorf("must be RFC3339 UTC")
	}
	return t.UTC(), nil
}

func requireUTCPtr(t *time.Time) (*time.Time, error) {
	if t == nil {
		return nil, nil
	}
	utc, err := requireUTC(*t)
	if err != nil {
		return nil, err
	}
	return &utc, nil
}

func finite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
