package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// csvTwoSteps carries two latitudes so the parsed BBox has South < North:
// a single-latitude grid (as an earlier draft of this fixture had) yields
// South == North, which WriteSnapshot's own DecodeCurrents round-trip
// rejects, so the on-disk write-through would never happen.
const csvTwoSteps = "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
	"2026-09-03T12:00:00Z,30.0,-89.0,0.11,-0.05\n" +
	"2026-09-03T12:00:00Z,30.0,-88.0,0.22,-0.06\n" +
	"2026-09-03T12:00:00Z,30.5,-89.0,0.15,-0.05\n" +
	"2026-09-03T12:00:00Z,30.5,-88.0,0.25,-0.06\n" +
	"2026-09-03T15:00:00Z,30.0,-89.0,0.33,-0.07\n" +
	"2026-09-03T15:00:00Z,30.0,-88.0,0.44,-0.08\n" +
	"2026-09-03T15:00:00Z,30.5,-89.0,0.35,-0.07\n" +
	"2026-09-03T15:00:00Z,30.5,-88.0,0.45,-0.08\n"

// failingTransport fails the test if anything dials out.
type failingTransport struct{ t *testing.T }

func (f failingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	f.t.Fatalf("unexpected outbound request to %s", r.URL)
	return nil, nil
}

func seedOceanDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"currents.json": validCurrentsJSON,
		"buoys.json":    validBuoysJSON,
		"manifest.json": validManifestJSON,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestRefreshReplacesTheServedStack(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(csvTwoSteps))
	}))
	defer upstream.Close()

	dir := seedOceanDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:             filepath.Join("testdata", "tiles"),
		WebDir:              t.TempDir(),
		OceanDir:            dir,
		OceanRefreshEnabled: true,
		OceanRefreshEvery:   time.Hour,
		HYCOMURL:            upstream.URL,
		OceanClient:         upstream.Client(),
		// Without this the first refresh is 15s out and the 2s deadline below
		// can never be met.
		OceanFirstRefreshDelay: time.Millisecond,
	})

	waitForSteps(t, h, 2)

	// Write-through means a restart keeps the freshness.
	onDisk, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Steps []struct{} `json:"steps"`
	}
	if err := json.Unmarshal(onDisk, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Steps) != 2 {
		t.Errorf("on-disk steps = %d, want 2", len(got.Steps))
	}
}

func TestRefreshServesStaleWhenUpstreamFails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer upstream.Close()

	dir := seedOceanDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:                filepath.Join("testdata", "tiles"),
		WebDir:                 t.TempDir(),
		OceanDir:               dir,
		OceanRefreshEnabled:    true,
		OceanRefreshEvery:      time.Hour,
		HYCOMURL:               upstream.URL,
		OceanClient:            upstream.Client(),
		OceanFirstRefreshDelay: time.Millisecond,
	})

	// The refresh must actually be attempted and fail before this proves
	// anything, so give the goroutine a moment.
	time.Sleep(50 * time.Millisecond)
	// The seeded snapshot must still be served, as a lifted one-step stack.
	waitForSteps(t, h, 1)
}

// This is the air-gap claim, so it gets a test rather than a comment.
func TestRefreshDisabledMakesNoOutboundRequest(t *testing.T) {
	dir := seedOceanDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := NewWithContext(ctx, Config{
		TileDir:             filepath.Join("testdata", "tiles"),
		WebDir:              t.TempDir(),
		OceanDir:            dir,
		OceanRefreshEnabled: false,
		OceanRefreshEvery:   time.Millisecond,
		HYCOMURL:            "https://example.invalid/ncss",
		OceanClient:         &http.Client{Transport: failingTransport{t: t}},
		// The refresher would fire immediately if the disabled flag were
		// ignored. With the default 15s delay this test could not fail.
		OceanFirstRefreshDelay: time.Millisecond,
	})
	time.Sleep(50 * time.Millisecond)
	waitForSteps(t, h, 1)
}

func waitForSteps(t *testing.T, h http.Handler, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var last int
	for time.Now().Before(deadline) {
		req := httptest.NewRequest(http.MethodGet, "/api/ocean/currents", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			var got struct {
				Steps []struct{} `json:"steps"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err == nil {
				last = len(got.Steps)
				if last == want {
					return
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("steps = %d, want %d before deadline", last, want)
}
