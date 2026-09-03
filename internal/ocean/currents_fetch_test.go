package ocean

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

var testAOI = BBox{West: -90.2, South: 29.5, East: -87.45, North: 30.78}

func TestCurrentsQueryAsksForACSVWindow(t *testing.T) {
	now := time.Date(2026, 9, 3, 14, 0, 0, 0, time.UTC)
	raw, err := CurrentsQuery(DefaultHYCOMBase, testAOI, now)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	// CSV, not netcdf: parseHYCOMNetCDF reads times[0] only.
	if q.Get("accept") != "csv" {
		t.Errorf("accept = %q, want csv", q.Get("accept"))
	}
	if q.Get("vertCoord") != "0" {
		t.Errorf("vertCoord = %q, want 0", q.Get("vertCoord"))
	}
	if got := q["var"]; len(got) != 2 {
		t.Errorf("var = %v, want water_u and water_v", got)
	}
	if q.Get("time_start") != "2026-09-03T11:00:00Z" {
		t.Errorf("time_start = %q, want now-3h", q.Get("time_start"))
	}
	if q.Get("time_end") != "2026-09-04T14:00:00Z" {
		t.Errorf("time_end = %q, want now+24h", q.Get("time_end"))
	}
}

func TestCurrentsQueryRejectsAnEmptyBase(t *testing.T) {
	if _, err := CurrentsQuery("  ", testAOI, time.Now().UTC()); err == nil {
		t.Fatal("want error for empty base")
	}
}

func TestFetchCurrentsParsesAndChecksAOI(t *testing.T) {
	body := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T12:00:00Z,30.0,-89.0,0.1,-0.05\n" +
		"2026-09-03T12:00:00Z,30.0,-88.0,0.2,-0.06\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, time.Now().UTC())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(c.Steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(c.Steps))
	}
	if c.Source.Name != "HYCOM" {
		t.Errorf("source.name = %q", c.Source.Name)
	}
}

func TestFetchCurrentsRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer srv.Close()
	_, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("want a 502 error, got %v", err)
	}
}
