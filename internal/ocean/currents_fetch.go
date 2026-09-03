package ocean

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
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
	stepCadence   = 3 * time.Hour
)

// CurrentsQuery builds the NCSS URL for ONE forecast time step.
//
// NCSS's grid endpoint rejects accept=csv for a grid subset — the live
// service answers "Format csv is not supported for Grid data request"
// (HTTP 400). CSV is only valid there for point requests. accept=netcdf
// with a single time= is the format the live service actually serves for a
// grid subset, and it is exactly what the already-tested parseHYCOMNetCDF
// handles (it reads times[0]). FetchCurrents issues one such per-step
// request per step in the forecast window and merges the results, rather
// than teaching the parser to index a multi-time NetCDF response.
func CurrentsQuery(base string, aoi BBox, t time.Time) (string, error) {
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
	q.Set("accept", "netcdf")
	q.Set("time", t.UTC().Format(time.RFC3339))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// snapTo3h floors t to the most recent 3-hourly UTC boundary
// (00,03,06,09,12,15,18,21Z), aligning requests with the model grid.
func snapTo3h(t time.Time) time.Time {
	t = t.UTC()
	h := (t.Hour() / 3) * 3
	return time.Date(t.Year(), t.Month(), t.Day(), h, 0, 0, 0, time.UTC)
}

// requestTimes returns the 3-hourly, 3h-boundary-snapped times to request,
// covering ForecastBack before now through ForecastAhead after now
// inclusive. With the current constants this is 10 steps.
func requestTimes(now time.Time) []time.Time {
	base := snapTo3h(now)
	start := base.Add(-ForecastBack)
	end := base.Add(ForecastAhead)
	var times []time.Time
	for t := start; !t.After(end); t = t.Add(stepCadence) {
		times = append(times, t)
	}
	return times
}

// FetchCurrents downloads one forecast stack by issuing N single-time NCSS
// requests (see CurrentsQuery) and merging the results.
//
// NCSS snaps time= to the nearest available model time, so distinct
// requests can come back with the same validTime; those are deduped,
// keeping the first (earliest-requested) occurrence, since DecodeCurrents
// requires strictly increasing step times. A step whose grid shape
// disagrees with the first successful step is an error, not a silent
// mismatch. Otherwise this is a best-effort merge: a step that fails to
// fetch or parse is logged and skipped so one bad NCSS response doesn't
// sink the whole refresh; a partial stack still beats serving a stale one.
// FetchCurrents only fails outright if every step failed.
func FetchCurrents(ctx context.Context, client *http.Client, base string, aoi BBox, now time.Time) (Currents, error) {
	if client == nil {
		client = http.DefaultClient
	}
	times := requestTimes(now)

	var merged Currents
	haveShape := false
	seen := make(map[time.Time]struct{}, len(times))
	var steps []Step
	var lastErr error

	for _, t := range times {
		raw, err := CurrentsQuery(base, aoi, t)
		if err != nil {
			return Currents{}, err
		}
		c, err := fetchHYCOM(ctx, client, raw, aoi)
		if err != nil {
			slog.Warn("ocean: hycom: step fetch failed", "requested", t.Format(time.RFC3339), "err", err)
			lastErr = err
			continue
		}
		if len(c.Steps) == 0 {
			slog.Warn("ocean: hycom: step returned no data", "requested", t.Format(time.RFC3339))
			continue
		}
		step := c.Steps[0]
		if !haveShape {
			merged.Source = c.Source
			merged.BBox = c.BBox
			merged.NX = c.NX
			merged.NY = c.NY
			haveShape = true
		} else if c.NX != merged.NX || c.NY != merged.NY || c.BBox != merged.BBox {
			return Currents{}, fmt.Errorf("ocean: hycom: step grid shape differs")
		}
		if _, dup := seen[step.ValidTime]; dup {
			continue
		}
		seen[step.ValidTime] = struct{}{}
		steps = append(steps, step)
	}

	if len(steps) == 0 {
		if lastErr != nil {
			return Currents{}, fmt.Errorf("ocean: hycom: all %d steps failed: %w", len(times), lastErr)
		}
		return Currents{}, fmt.Errorf("ocean: hycom: all %d steps failed", len(times))
	}

	sort.Slice(steps, func(i, j int) bool { return steps[i].ValidTime.Before(steps[j].ValidTime) })
	merged.Grid = "centers"
	merged.Steps = steps
	merged.ValidTime = steps[0].ValidTime
	return merged, nil
}

// fetchHYCOM downloads and parses one HYCOM URL against aoi. Shared by
// FetchSnapshot (single-step snapshot) and FetchCurrents (one step of the
// forecast stack) so the fetch/parse/dataset/bbox-check sequence lives in
// exactly one place.
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
