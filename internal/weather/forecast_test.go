package weather

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestParseISODuration(t *testing.T) {
	cases := map[string]time.Duration{
		"PT1H":    time.Hour,
		"PT3H":    3 * time.Hour,
		"PT6H":    6 * time.Hour,
		"PT30M":   30 * time.Minute,
		"P1D":     24 * time.Hour,
		"P1DT6H":  30 * time.Hour,
		"PT1H30M": 90 * time.Minute,
	}
	for in, want := range cases {
		got, err := parseISODuration(in)
		if err != nil {
			t.Errorf("%s: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("%s = %v, want %v", in, got, want)
		}
	}
	for _, bad := range []string{"", "1H", "PT", "PTXH", "banana"} {
		if _, err := parseISODuration(bad); err == nil {
			t.Errorf("%q should not parse", bad)
		}
	}
}

func TestParseInterval(t *testing.T) {
	start, dur, err := parseInterval("2026-09-03T17:00:00+00:00/PT3H")
	if err != nil {
		t.Fatalf("parseInterval: %v", err)
	}
	if got := start.UTC().Format(time.RFC3339); got != "2026-09-03T17:00:00Z" {
		t.Errorf("start = %s", got)
	}
	if dur != 3*time.Hour {
		t.Errorf("dur = %v", dur)
	}
	if _, _, err := parseInterval("2026-09-03T17:00:00+00:00"); err == nil {
		t.Error("an interval with no duration should not parse")
	}
}

// NWS publishes a value once for the whole span it covers — a PT6H entry is
// six hours of that number, not one hour followed by a hole.
func TestValueAtSpansTheWholeInterval(t *testing.T) {
	vals := []gridValue{
		{Interval: "2026-09-03T17:00:00+00:00/PT1H", Value: f(47)},
		{Interval: "2026-09-03T18:00:00+00:00/PT6H", Value: f(80)},
	}
	at := func(s string) *float64 {
		ts, _ := time.Parse(time.RFC3339, s)
		return valueAt(vals, ts)
	}
	if got := at("2026-09-03T17:30:00Z"); got == nil || *got != 47 {
		t.Errorf("inside the first hour = %v, want 47", got)
	}
	if got := at("2026-09-03T21:00:00Z"); got == nil || *got != 80 {
		t.Errorf("four hours into a PT6H span = %v, want 80", got)
	}
	if got := at("2026-09-04T01:00:00Z"); got != nil {
		t.Errorf("past the last span = %v, want no value", got)
	}
	if got := at("2026-09-03T10:00:00Z"); got != nil {
		t.Errorf("before the first span = %v, want no value", got)
	}
}

// A null must stay null. Forecast grids are sparse at range, and filling a
// gap with a neighbouring hour would invent weather.
func TestValueAtKeepsNullNull(t *testing.T) {
	vals := []gridValue{{Interval: "2026-09-03T17:00:00+00:00/PT1H", Value: nil}}
	ts, _ := time.Parse(time.RFC3339, "2026-09-03T17:30:00Z")
	if got := valueAt(vals, ts); got != nil {
		t.Errorf("got %v, want nil", got)
	}
}

func TestSamplePointsCoverTheBoxCornerToCorner(t *testing.T) {
	box := tiles.BBox{West: -90, South: 29, East: -88, North: 30}
	pts := samplePoints(box, 3, 2)
	if len(pts) != 6 {
		t.Fatalf("got %d points, want 6", len(pts))
	}
	// Row-major, west to east then south to north — the same order the
	// currents grid uses, so the client can index them the same way.
	if pts[0].Lon != -90 || pts[0].Lat != 29 {
		t.Errorf("first point = %+v, want the south-west corner", pts[0])
	}
	if pts[5].Lon != -88 || pts[5].Lat != 30 {
		t.Errorf("last point = %+v, want the north-east corner", pts[5])
	}
	if pts[1].Lon != -89 {
		t.Errorf("second point lon = %v, want the midpoint", pts[1].Lon)
	}
}

func TestSamplePointsSingleColumn(t *testing.T) {
	box := tiles.BBox{West: -90, South: 29, East: -88, North: 30}
	pts := samplePoints(box, 1, 1)
	if len(pts) != 1 {
		t.Fatalf("got %d points, want 1", len(pts))
	}
	// A one-by-one sample takes the centre, not a corner.
	if pts[0].Lon != -89 || pts[0].Lat != 29.5 {
		t.Errorf("got %+v, want the box centre", pts[0])
	}
}

func TestWindComponentsPointDownwind(t *testing.T) {
	// NWS reports the direction wind blows *from*. A north wind (0°) must
	// push southward: v negative, u zero.
	u, v := windComponents(36, 0)
	if math.Abs(u) > 1e-9 {
		t.Errorf("u = %v, want ~0", u)
	}
	if v >= 0 {
		t.Errorf("v = %v, want negative for a north wind", v)
	}
	// 36 km/h is 10 m/s.
	if math.Abs(math.Hypot(u, v)-10) > 1e-6 {
		t.Errorf("speed = %v m/s, want 10", math.Hypot(u, v))
	}
	// An east wind (90°) blows toward the west: u negative.
	u, _ = windComponents(36, 90)
	if u >= 0 {
		t.Errorf("u = %v, want negative for an east wind", u)
	}
}

func f(v float64) *float64 { return &v }

// --- FetchForecast --------------------------------------------------------

func nwsStub(t *testing.T, failGrid map[string]bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/points/"):
			id := strings.TrimPrefix(r.URL.Path, "/points/")
			_, _ = fmt.Fprintf(w, `{"properties":{"gridId":"LIX","gridX":1,"gridY":2,
			  "forecast":%q}}`, "http://"+r.Host+"/gridpoints/LIX/1,2/forecast?p="+url.QueryEscape(id))
		case strings.HasSuffix(r.URL.Path, "/forecast"):
			_, _ = w.Write([]byte(`{"properties":{"periods":[
			  {"name":"This Afternoon","startTime":"2026-09-03T17:00:00+00:00","endTime":"2026-09-03T23:00:00+00:00",
			   "isDaytime":true,"temperature":88,"temperatureUnit":"F","windSpeed":"10 mph","windDirection":"SE",
			   "shortForecast":"Scattered Showers","detailedForecast":"Showers likely.",
			   "probabilityOfPrecipitation":{"value":60}}]}}`))
		case strings.HasPrefix(r.URL.Path, "/gridpoints/"):
			if failGrid[r.URL.Path] {
				http.Error(w, "nope", http.StatusInternalServerError)
				return
			}
			_, _ = w.Write([]byte(`{"properties":{
			  "skyCover":{"uom":"wmoUnit:percent","values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":47}]},
			  "probabilityOfPrecipitation":{"values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":19}]},
			  "quantitativePrecipitation":{"values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":0.5}]},
			  "windSpeed":{"values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":36}]},
			  "windDirection":{"values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":0}]},
			  "temperature":{"values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":29.5}]}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestFetchForecastBuildsAGridOnASharedAxis(t *testing.T) {
	srv := nwsStub(t, nil)
	defer srv.Close()
	from, _ := time.Parse(time.RFC3339, "2026-09-03T17:00:00Z")
	box := tiles.BBox{West: -90, South: 29, East: -88, North: 30}

	fc, err := FetchForecast(context.Background(), srv.Client(), srv.URL, box, ForecastOptions{
		NX: 3, NY: 2, From: from, Steps: 2, Step: time.Hour,
		PeriodsAt: &LonLat{Lon: -88.89, Lat: 30.40},
	})
	if err != nil {
		t.Fatalf("FetchForecast: %v", err)
	}
	if fc.NX != 3 || fc.NY != 2 || len(fc.Points) != 6 {
		t.Fatalf("grid shape wrong: nx=%d ny=%d pts=%d", fc.NX, fc.NY, len(fc.Points))
	}
	if len(fc.Steps) != 2 {
		t.Fatalf("got %d steps, want 2", len(fc.Steps))
	}
	s := fc.Steps[0]
	if len(s.Sky) != 6 || len(s.WindU) != 6 {
		t.Fatalf("step arrays must be one cell per point: sky=%d windU=%d", len(s.Sky), len(s.WindU))
	}
	if s.Sky[0] == nil || *s.Sky[0] != 47 {
		t.Errorf("sky[0] = %v, want 47", s.Sky[0])
	}
	// 36 km/h from 000° is 10 m/s blowing south.
	if s.WindV[0] == nil || math.Abs(*s.WindV[0]+10) > 1e-6 {
		t.Errorf("windV[0] = %v, want -10", s.WindV[0])
	}
	if len(fc.Periods) != 1 || fc.Periods[0].Name != "This Afternoon" {
		t.Fatalf("periods not parsed: %+v", fc.Periods)
	}
	if fc.Periods[0].Pop == nil || *fc.Periods[0].Pop != 60 {
		t.Errorf("period pop = %v, want 60", fc.Periods[0].Pop)
	}
}

// One dead sample point must leave a hole, not sink the field.
func TestFetchForecastNilsAFailedPointWithoutFailing(t *testing.T) {
	srv := nwsStub(t, map[string]bool{"/gridpoints/LIX/1,2": true})
	defer srv.Close()
	from, _ := time.Parse(time.RFC3339, "2026-09-03T17:00:00Z")
	fc, err := FetchForecast(context.Background(), srv.Client(), srv.URL,
		tiles.BBox{West: -90, South: 29, East: -88, North: 30},
		ForecastOptions{NX: 2, NY: 1, From: from, Steps: 1, Step: time.Hour})
	if err != nil {
		t.Fatalf("FetchForecast: %v", err)
	}
	for i, v := range fc.Steps[0].Sky {
		if v != nil {
			t.Errorf("cell %d = %v, want nil when its gridpoint failed", i, v)
		}
	}
}

// Marine points have no plain-language forecast. That must cost the periods,
// never the grid.
func TestFetchForecastSurvivesAMarineForecast404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/points/"):
			_, _ = fmt.Fprintf(w, `{"properties":{"gridId":"LIX","gridX":1,"gridY":2,"forecast":%q}}`,
				"http://"+r.Host+"/gridpoints/LIX/1,2/forecast")
		case strings.HasSuffix(r.URL.Path, "/forecast"):
			http.Error(w, `{"title":"Marine Forecast Not Supported"}`, http.StatusNotFound)
		case strings.HasPrefix(r.URL.Path, "/gridpoints/"):
			_, _ = w.Write([]byte(`{"properties":{"skyCover":{"values":[{"validTime":"2026-09-03T17:00:00+00:00/PT3H","value":12}]}}}`))
		}
	}))
	defer srv.Close()
	from, _ := time.Parse(time.RFC3339, "2026-09-03T17:00:00Z")
	fc, err := FetchForecast(context.Background(), srv.Client(), srv.URL,
		tiles.BBox{West: -90, South: 29, East: -88, North: 30},
		ForecastOptions{NX: 1, NY: 1, From: from, Steps: 1, Step: time.Hour,
			PeriodsAt: &LonLat{Lon: -88.5, Lat: 29.5}})
	if err != nil {
		t.Fatalf("a marine 404 must not fail the whole forecast: %v", err)
	}
	if len(fc.Periods) != 0 {
		t.Errorf("expected no periods, got %d", len(fc.Periods))
	}
	if fc.Steps[0].Sky[0] == nil || *fc.Steps[0].Sky[0] != 12 {
		t.Errorf("the grid should still be there: %v", fc.Steps[0].Sky[0])
	}
}
