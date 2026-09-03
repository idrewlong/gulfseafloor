package ocean

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testAOI = BBox{West: -90.2, South: 29.5, East: -87.45, North: 30.78}

func TestCurrentsQueryAsksForOneNetCDFTime(t *testing.T) {
	when := time.Date(2026, 9, 3, 15, 0, 0, 0, time.UTC)
	raw, err := CurrentsQuery(DefaultHYCOMBase, testAOI, when)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	// netcdf, not csv: NCSS's grid endpoint rejects accept=csv for a grid
	// subset ("Format csv is not supported for Grid data request").
	if q.Get("accept") != "netcdf" {
		t.Errorf("accept = %q, want netcdf", q.Get("accept"))
	}
	if q.Get("vertCoord") != "0" {
		t.Errorf("vertCoord = %q, want 0", q.Get("vertCoord"))
	}
	if got := q["var"]; len(got) != 2 {
		t.Errorf("var = %v, want water_u and water_v", got)
	}
	if q.Get("time") != "2026-09-03T15:00:00Z" {
		t.Errorf("time = %q, want 2026-09-03T15:00:00Z", q.Get("time"))
	}
	if _, ok := q["time_start"]; ok {
		t.Errorf("time_start must not be set (single-time query): %v", q["time_start"])
	}
	if _, ok := q["time_end"]; ok {
		t.Errorf("time_end must not be set (single-time query): %v", q["time_end"])
	}
}

func TestCurrentsQueryRejectsAnEmptyBase(t *testing.T) {
	if _, err := CurrentsQuery("  ", testAOI, time.Now().UTC()); err == nil {
		t.Fatal("want error for empty base")
	}
}

func TestRequestTimesSnapsToThreeHourBoundaries(t *testing.T) {
	now := time.Date(2026, 9, 3, 14, 27, 0, 0, time.UTC) // between 12Z and 15Z
	times := requestTimes(now)
	want := []time.Time{
		time.Date(2026, 9, 3, 9, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 15, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 18, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 3, 21, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 4, 3, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 4, 6, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 4, 9, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC),
	}
	if len(times) != len(want) {
		t.Fatalf("len = %d, want %d: %v", len(times), len(want), times)
	}
	for i, wt := range want {
		if !times[i].Equal(wt) {
			t.Errorf("times[%d] = %s, want %s", i, times[i].Format(time.RFC3339), wt.Format(time.RFC3339))
		}
	}
	for i := 1; i < len(times); i++ {
		if d := times[i].Sub(times[i-1]); d != 3*time.Hour {
			t.Fatalf("cadence at %d = %s, want 3h", i, d)
		}
	}
	for _, tt := range times {
		if tt.Hour()%3 != 0 || tt.Minute() != 0 || tt.Second() != 0 || tt.Nanosecond() != 0 {
			t.Errorf("time %s is not on a 3h UTC boundary", tt.Format(time.RFC3339))
		}
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
	// Every one of the 10 per-step requests returns this same fixed body
	// (and therefore the same validTime), so dedupe must collapse them to 1.
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

// readHYCOMFixture serves the existing gitignored NetCDF fixture used by
// hycom_test.go. It is a real, already-tested single-time HYCOM response,
// so it exercises fetchHYCOM's real parseHYCOMNetCDF path without needing a
// new binary fixture (*.nc is gitignored, so a new one would never reach
// CI).
func readHYCOMFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/hycom.nc")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return data
}

func TestFetchCurrentsMergesAndDedupesIdenticalValidTimes(t *testing.T) {
	fixture := readHYCOMFixture(t)
	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		_, _ = w.Write(fixture)
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 3, 14, 0, 0, 0, time.UTC)
	c, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, now)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got := atomic.LoadInt32(&requests); got != 10 {
		t.Fatalf("requests = %d, want 10", got)
	}
	// NCSS snaps time= to the nearest available model time: every one of
	// the 10 requests here returns the fixture's single fixed validTime, so
	// the merge must dedupe them down to exactly one step.
	if len(c.Steps) != 1 {
		t.Fatalf("steps = %d, want 1 (deduped)", len(c.Steps))
	}
	wantTime := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	if !c.Steps[0].ValidTime.Equal(wantTime) {
		t.Fatalf("validTime = %s, want %s", c.Steps[0].ValidTime.Format(time.RFC3339), wantTime.Format(time.RFC3339))
	}
	if c.NX != 24 || c.NY != 15 {
		t.Fatalf("nx=%d ny=%d, want 24x15", c.NX, c.NY)
	}
}

func TestFetchCurrentsRejectsShapeMismatch(t *testing.T) {
	fixture := readHYCOMFixture(t) // 24x15
	// A 2x2 grid via the CSV path: same fetchHYCOM/ParseHYCOM dispatch,
	// deliberately a different nx/ny than the fixture above.
	mismatch := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T15:00:00Z,29.6,-89.5,0.10,-0.02\n" +
		"2026-09-03T15:00:00Z,29.6,-88.5,0.11,-0.03\n" +
		"2026-09-03T15:00:00Z,30.6,-89.5,0.12,-0.04\n" +
		"2026-09-03T15:00:00Z,30.6,-88.5,0.13,-0.05\n"
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&n, 1) == 1 {
			_, _ = w.Write(fixture)
			return
		}
		_, _ = w.Write([]byte(mismatch))
	}))
	defer srv.Close()

	_, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "step grid shape differs") {
		t.Fatalf("want a shape-differs error, got %v", err)
	}
}

func TestFetchCurrentsReturnsPartialOnSomeStepFailures(t *testing.T) {
	now := time.Date(2026, 9, 3, 14, 0, 0, 0, time.UTC)
	times := requestTimes(now)
	fail := map[string]bool{}
	for i, tt := range times {
		if i%2 == 0 {
			fail[tt.Format(time.RFC3339)] = true
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tParam := r.URL.Query().Get("time")
		if fail[tParam] {
			http.Error(w, "synthetic failure", http.StatusBadGateway)
			return
		}
		body := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
			tParam + ",29.6,-89.5,0.10,-0.02\n" +
			tParam + ",29.6,-88.5,0.11,-0.03\n" +
			tParam + ",30.6,-89.5,0.12,-0.04\n" +
			tParam + ",30.6,-88.5,0.13,-0.05\n"
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, now)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	wantSteps := 0
	for _, tt := range times {
		if !fail[tt.Format(time.RFC3339)] {
			wantSteps++
		}
	}
	if wantSteps == 0 || wantSteps == len(times) {
		t.Fatalf("test setup: want a genuine mix of failures and successes, got %d/%d successes", wantSteps, len(times))
	}
	if len(c.Steps) != wantSteps {
		t.Fatalf("steps = %d, want %d (partial failure should keep the successes)", len(c.Steps), wantSteps)
	}
	for i := 1; i < len(c.Steps); i++ {
		if !c.Steps[i].ValidTime.After(c.Steps[i-1].ValidTime) {
			t.Fatalf("steps not strictly increasing ascending at %d", i)
		}
	}
	if c.NX != 2 || c.NY != 2 {
		t.Fatalf("nx=%d ny=%d, want 2x2", c.NX, c.NY)
	}
}

// TestFetchCurrentsSourceURLCoversWholeWindow guards F8: merged.Source used
// to be copied verbatim from the first successful step, so currents.json's
// source.url cited a single time= query as the provenance of the whole
// 10-step stack. It must instead describe the window the persisted stack
// actually covers.
func TestFetchCurrentsSourceURLCoversWholeWindow(t *testing.T) {
	now := time.Date(2026, 9, 3, 14, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tParam := r.URL.Query().Get("time")
		body := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
			tParam + ",29.6,-89.5,0.10,-0.02\n" +
			tParam + ",29.6,-88.5,0.11,-0.03\n" +
			tParam + ",30.6,-89.5,0.12,-0.04\n" +
			tParam + ",30.6,-88.5,0.13,-0.05\n"
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, now)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(c.Steps) != 10 {
		t.Fatalf("steps = %d, want 10 (distinct time= per request)", len(c.Steps))
	}
	u, err := url.Parse(c.Source.URL)
	if err != nil {
		t.Fatalf("source.url did not parse: %v", err)
	}
	q := u.Query()
	if q.Get("time") != "" {
		t.Errorf("source.url still carries a single time=%q; a merged stack must not cite one step's query", q.Get("time"))
	}
	wantStart := c.Steps[0].ValidTime.UTC().Format(time.RFC3339)
	wantEnd := c.Steps[len(c.Steps)-1].ValidTime.UTC().Format(time.RFC3339)
	if q.Get("time_start") != wantStart || q.Get("time_end") != wantEnd {
		t.Errorf("source.url window = [%s, %s], want [%s, %s]", q.Get("time_start"), q.Get("time_end"), wantStart, wantEnd)
	}
}

func TestFetchCurrentsFailsWhenAllStepsFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer srv.Close()
	_, err := FetchCurrents(context.Background(), srv.Client(), srv.URL, testAOI, time.Now().UTC())
	if err == nil {
		t.Fatal("want an error when every step fails, so the caller serves stale data instead")
	}
}
