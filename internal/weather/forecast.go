package weather

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// NWSAPI is the National Weather Service public API. No key, no login; it
// asks only for a User-Agent that identifies the caller.
const NWSAPI = "https://api.weather.gov"

// LonLat is one forecast sample position.
type LonLat struct {
	Lon float64 `json:"lon"`
	Lat float64 `json:"lat"`
}

// gridValue is one entry of an NWS gridpoint series: a value that holds for
// an ISO 8601 interval rather than at an instant.
type gridValue struct {
	Interval string   `json:"validTime"`
	Value    *float64 `json:"value"`
}

// Step is the forecast field at one time. Slices are row-major, west to east
// and south to north, matching the currents grid so the client can index
// them identically. A nil cell is no data and is never filled in.
type Step struct {
	ValidTime time.Time  `json:"validTime"`
	Sky       []*float64 `json:"sky"`    // cloud cover, percent
	Pop       []*float64 `json:"pop"`    // precipitation probability, percent
	Precip    []*float64 `json:"precip"` // quantitative precipitation, mm
	WindU     []*float64 `json:"windU"`  // eastward, m/s
	WindV     []*float64 `json:"windV"`  // northward, m/s
	TempC     []*float64 `json:"tempC"`
}

// Period is one slot of the plain-language outlook — "This Afternoon",
// "Tonight", "Thursday". NWS publishes these for land points only.
type Period struct {
	Name          string    `json:"name"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	IsDaytime     bool      `json:"isDaytime"`
	Temp          int       `json:"temp"`
	TempUnit      string    `json:"tempUnit"`
	WindSpeed     string    `json:"windSpeed"`
	WindDirection string    `json:"windDirection"`
	Short         string    `json:"short"`
	Detailed      string    `json:"detailed"`
	Pop           *int      `json:"pop,omitempty"`
}

// Forecast is the gridded outlook over the AOI plus the plain-language
// periods for a nearby land point.
type Forecast struct {
	Source    Source     `json:"source"`
	BBox      tiles.BBox `json:"bbox"`
	NX        int        `json:"nx"`
	NY        int        `json:"ny"`
	Points    []LonLat   `json:"points"`
	Steps     []Step     `json:"steps"`
	Periods   []Period   `json:"periods"`
	PeriodsAt *LonLat    `json:"periodsAt,omitempty"`
	Retrieved time.Time  `json:"retrieved"`
}

var isoDuration = regexp.MustCompile(`^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$`)

// parseISODuration handles the subset NWS emits: PT1H, PT6H, P1D, P1DT6H.
func parseISODuration(s string) (time.Duration, error) {
	m := isoDuration.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("duration %q", s)
	}
	var d time.Duration
	units := []time.Duration{24 * time.Hour, time.Hour, time.Minute, time.Second}
	any := false
	for i, unit := range units {
		if m[i+1] == "" {
			continue
		}
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return 0, fmt.Errorf("duration %q: %w", s, err)
		}
		d += time.Duration(n) * unit
		any = true
	}
	if !any {
		return 0, fmt.Errorf("duration %q carries no components", s)
	}
	return d, nil
}

// parseInterval splits "<RFC3339>/<ISO duration>".
func parseInterval(s string) (time.Time, time.Duration, error) {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] != '/' {
			continue
		}
		start, err := time.Parse(time.RFC3339, s[:i])
		if err != nil {
			return time.Time{}, 0, err
		}
		dur, err := parseISODuration(s[i+1:])
		if err != nil {
			return time.Time{}, 0, err
		}
		return start.UTC(), dur, nil
	}
	return time.Time{}, 0, errors.New("interval has no duration: " + s)
}

// valueAt returns the value covering t, or nil.
//
// NWS publishes a value once for the whole span it covers, so a PT6H entry
// is six hours of that number. Treating it as a single hour would leave five
// hours of holes in a field that is not actually missing.
func valueAt(vals []gridValue, t time.Time) *float64 {
	for _, v := range vals {
		start, dur, err := parseInterval(v.Interval)
		if err != nil {
			continue
		}
		if !t.Before(start) && t.Before(start.Add(dur)) {
			return v.Value
		}
	}
	return nil
}

// samplePoints lays an nx-by-ny lattice over box, row-major, west to east
// and south to north. A single row or column samples the centre rather than
// an edge, so a degenerate grid still describes the middle of the chart.
func samplePoints(box tiles.BBox, nx, ny int) []LonLat {
	if nx < 1 || ny < 1 {
		return nil
	}
	out := make([]LonLat, 0, nx*ny)
	axis := func(lo, hi float64, n, i int) float64 {
		if n == 1 {
			return (lo + hi) / 2
		}
		return lo + (hi-lo)*float64(i)/float64(n-1)
	}
	for j := 0; j < ny; j++ {
		for i := 0; i < nx; i++ {
			out = append(out, LonLat{
				Lon: axis(box.West, box.East, nx, i),
				Lat: axis(box.South, box.North, ny, j),
			})
		}
	}
	return out
}

// windComponents converts an NWS wind report to eastward/northward metres
// per second.
//
// NWS gives the direction the wind blows *from* and a speed in km/h. The
// negation is the whole point: a north wind pushes rain southward, and a
// rain streak tilted the wrong way is worse than an untilted one.
func windComponents(kmh, fromDeg float64) (u, v float64) {
	ms := kmh / 3.6
	rad := fromDeg * math.Pi / 180
	return -ms * math.Sin(rad), -ms * math.Cos(rad)
}

// gridpointDoc is the shape of /gridpoints/{wfo}/{x},{y}.
type gridpointDoc struct {
	Properties struct {
		SkyCover                   struct{ Values []gridValue } `json:"skyCover"`
		ProbabilityOfPrecipitation struct{ Values []gridValue } `json:"probabilityOfPrecipitation"`
		QuantitativePrecipitation  struct{ Values []gridValue } `json:"quantitativePrecipitation"`
		WindSpeed                  struct{ Values []gridValue } `json:"windSpeed"`
		WindDirection              struct{ Values []gridValue } `json:"windDirection"`
		Temperature                struct{ Values []gridValue } `json:"temperature"`
	} `json:"properties"`
}

func decodeGridpoint(raw []byte) (*gridpointDoc, error) {
	var doc gridpointDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return &doc, nil
}

// ForecastOptions tunes one forecast ingest.
type ForecastOptions struct {
	NX, NY int
	// From is the first step; Steps of Step follow it.
	From  time.Time
	Steps int
	Step  time.Duration
	// PeriodsAt is the point the plain-language outlook is read at. NWS
	// serves those for land only, so this is deliberately a shore point
	// rather than the chart centre, which is water.
	PeriodsAt *LonLat
	// Concurrency caps in-flight gridpoint requests.
	Concurrency int
}

type pointsDoc struct {
	Properties struct {
		GridID   string `json:"gridId"`
		GridX    int    `json:"gridX"`
		GridY    int    `json:"gridY"`
		Forecast string `json:"forecast"`
	} `json:"properties"`
}

type forecastDoc struct {
	Properties struct {
		Periods []struct {
			Name             string `json:"name"`
			StartTime        string `json:"startTime"`
			EndTime          string `json:"endTime"`
			IsDaytime        bool   `json:"isDaytime"`
			Temperature      int    `json:"temperature"`
			TemperatureUnit  string `json:"temperatureUnit"`
			WindSpeed        string `json:"windSpeed"`
			WindDirection    string `json:"windDirection"`
			ShortForecast    string `json:"shortForecast"`
			DetailedForecast string `json:"detailedForecast"`
			Pop              struct {
				Value *int `json:"value"`
			} `json:"probabilityOfPrecipitation"`
		} `json:"periods"`
	} `json:"properties"`
}

// FetchForecast samples the NWS gridded forecast over box and, when
// PeriodsAt is set, the plain-language outlook for that point.
//
// A sample point that fails leaves nil cells rather than failing the ingest:
// the AOI straddles two forecast offices and reaches offshore, and one dead
// gridpoint should cost one cell, not the whole field. A marine 404 on the
// plain-language endpoint costs the periods only.
func FetchForecast(ctx context.Context, client *http.Client, base string, box tiles.BBox, opt ForecastOptions) (*Forecast, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if opt.NX < 1 || opt.NY < 1 {
		return nil, errors.New("forecast: grid must be at least 1x1")
	}
	if opt.Steps < 1 {
		return nil, errors.New("forecast: need at least one step")
	}
	if opt.Step <= 0 {
		opt.Step = time.Hour
	}
	if opt.Concurrency <= 0 {
		opt.Concurrency = 6
	}
	base = strings.TrimRight(base, "/")

	pts := samplePoints(box, opt.NX, opt.NY)
	docs := make([]*gridpointDoc, len(pts))

	sem := make(chan struct{}, opt.Concurrency)
	var wg sync.WaitGroup
	for i, p := range pts {
		wg.Add(1)
		go func(i int, p LonLat) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			doc, err := gridpointFor(ctx, client, base, p)
			if err != nil {
				return // leaves docs[i] nil: a hole, not a guess
			}
			docs[i] = doc
		}(i, p)
	}
	wg.Wait()

	fc := &Forecast{
		Source: Source{
			Name:    "NOAA/NWS",
			Dataset: "gridpoints",
			URL:     base,
		},
		BBox:      box,
		NX:        opt.NX,
		NY:        opt.NY,
		Points:    pts,
		Retrieved: time.Now().UTC(),
	}

	from := opt.From.UTC()
	if from.IsZero() {
		from = time.Now().UTC().Truncate(time.Hour)
	}
	for s := 0; s < opt.Steps; s++ {
		at := from.Add(time.Duration(s) * opt.Step)
		step := Step{
			ValidTime: at,
			Sky:       make([]*float64, len(pts)),
			Pop:       make([]*float64, len(pts)),
			Precip:    make([]*float64, len(pts)),
			WindU:     make([]*float64, len(pts)),
			WindV:     make([]*float64, len(pts)),
			TempC:     make([]*float64, len(pts)),
		}
		for i, doc := range docs {
			if doc == nil {
				continue
			}
			p := &doc.Properties
			step.Sky[i] = valueAt(p.SkyCover.Values, at)
			step.Pop[i] = valueAt(p.ProbabilityOfPrecipitation.Values, at)
			step.Precip[i] = valueAt(p.QuantitativePrecipitation.Values, at)
			step.TempC[i] = valueAt(p.Temperature.Values, at)
			spd := valueAt(p.WindSpeed.Values, at)
			dir := valueAt(p.WindDirection.Values, at)
			if spd != nil && dir != nil {
				u, v := windComponents(*spd, *dir)
				step.WindU[i], step.WindV[i] = &u, &v
			}
		}
		fc.Steps = append(fc.Steps, step)
	}

	if opt.PeriodsAt != nil {
		if periods, err := fetchPeriods(ctx, client, base, *opt.PeriodsAt); err == nil {
			fc.Periods = periods
			at := *opt.PeriodsAt
			fc.PeriodsAt = &at
		}
	}
	return fc, nil
}

func gridpointFor(ctx context.Context, client *http.Client, base string, p LonLat) (*gridpointDoc, error) {
	raw, err := get(ctx, client, fmt.Sprintf("%s/points/%.4f,%.4f", base, p.Lat, p.Lon), maxMetaSize)
	if err != nil {
		return nil, err
	}
	var pd pointsDoc
	if err := json.Unmarshal(raw, &pd); err != nil {
		return nil, err
	}
	if pd.Properties.GridID == "" {
		return nil, errors.New("points: no gridId")
	}
	u := fmt.Sprintf("%s/gridpoints/%s/%d,%d", base, pd.Properties.GridID, pd.Properties.GridX, pd.Properties.GridY)
	body, err := get(ctx, client, u, maxGridpointSize)
	if err != nil {
		return nil, err
	}
	return decodeGridpoint(body)
}

func fetchPeriods(ctx context.Context, client *http.Client, base string, p LonLat) ([]Period, error) {
	raw, err := get(ctx, client, fmt.Sprintf("%s/points/%.4f,%.4f", base, p.Lat, p.Lon), maxMetaSize)
	if err != nil {
		return nil, err
	}
	var pd pointsDoc
	if err := json.Unmarshal(raw, &pd); err != nil {
		return nil, err
	}
	u := pd.Properties.Forecast
	if u == "" {
		u = fmt.Sprintf("%s/gridpoints/%s/%d,%d/forecast", base,
			pd.Properties.GridID, pd.Properties.GridX, pd.Properties.GridY)
	}
	body, err := get(ctx, client, u, maxGridpointSize)
	if err != nil {
		return nil, err
	}
	var doc forecastDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	out := make([]Period, 0, len(doc.Properties.Periods))
	for _, p := range doc.Properties.Periods {
		start, _ := time.Parse(time.RFC3339, p.StartTime)
		end, _ := time.Parse(time.RFC3339, p.EndTime)
		out = append(out, Period{
			Name:          p.Name,
			Start:         start.UTC(),
			End:           end.UTC(),
			IsDaytime:     p.IsDaytime,
			Temp:          p.Temperature,
			TempUnit:      p.TemperatureUnit,
			WindSpeed:     p.WindSpeed,
			WindDirection: p.WindDirection,
			Short:         p.ShortForecast,
			Detailed:      p.DetailedForecast,
			Pop:           p.Pop.Value,
		})
	}
	return out, nil
}
