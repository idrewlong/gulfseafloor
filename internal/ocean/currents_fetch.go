package ocean

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultHYCOMBase is the NCSS endpoint the shipped snapshot was taken from.
const DefaultHYCOMBase = "https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest"

// The forecast window carried in one stack. GLBy0.08 posts 3-hourly, so this
// is 10 steps: enough to always bracket now, and to survive a failed refresh.
const (
	ForecastBack  = 3 * time.Hour
	ForecastAhead = 24 * time.Hour
)

// CurrentsQuery builds the NCSS URL for a surface velocity window around now.
// It requests CSV: the CSV parser carries a time column per row, while
// parseHYCOMNetCDF reads times[0] only and cannot express a stack.
func CurrentsQuery(base string, aoi BBox, now time.Time) (string, error) {
	base = strings.TrimSpace(base)
	if base == "" {
		return "", fmt.Errorf("ocean: currents: empty HYCOM base URL")
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("ocean: currents: %w", err)
	}
	q := url.Values{}
	q.Add("var", "water_u")
	q.Add("var", "water_v")
	q.Set("north", fmt.Sprintf("%g", aoi.North))
	q.Set("south", fmt.Sprintf("%g", aoi.South))
	q.Set("west", fmt.Sprintf("%g", aoi.West))
	q.Set("east", fmt.Sprintf("%g", aoi.East))
	q.Set("horizStride", "1")
	q.Set("vertCoord", "0")
	q.Set("accept", "csv")
	q.Set("time_start", now.UTC().Add(-ForecastBack).Format(time.RFC3339))
	q.Set("time_end", now.UTC().Add(ForecastAhead).Format(time.RFC3339))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// FetchCurrents downloads one forecast stack. It does not touch disk.
func FetchCurrents(ctx context.Context, client *http.Client, base string, aoi BBox, now time.Time) (Currents, error) {
	if client == nil {
		client = http.DefaultClient
	}
	raw, err := CurrentsQuery(base, aoi, now)
	if err != nil {
		return Currents{}, err
	}
	return fetchHYCOM(ctx, client, raw, aoi)
}

// fetchHYCOM downloads and parses one HYCOM URL against aoi. Shared by
// FetchSnapshot (single-step snapshot) and FetchCurrents (forecast stack) so
// the fetch/parse/dataset/bbox-check sequence lives in exactly one place.
func fetchHYCOM(ctx context.Context, client *http.Client, rawURL string, aoi BBox) (Currents, error) {
	body, status, err := getCapped(ctx, client, rawURL, hycomCSVLimit, false)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: fetch hycom: %w", err)
	}
	if status != http.StatusOK {
		return Currents{}, fmt.Errorf("ocean: fetch hycom: HTTP %d", status)
	}
	c, err := ParseHYCOM(bytes.NewReader(body), Source{Name: "HYCOM", URL: rawURL})
	if err != nil {
		return Currents{}, err
	}
	if c.Source.Dataset == "" {
		c.Source.Dataset = hycomDatasetFromURL(rawURL)
	}
	if !c.BBox.Intersects(aoi) {
		return Currents{}, fmt.Errorf("ocean: fetch hycom: bbox does not intersect AOI")
	}
	return c, nil
}
