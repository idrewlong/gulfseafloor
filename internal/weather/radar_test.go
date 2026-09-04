package weather

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return v
}

func TestParseTimeExtent(t *testing.T) {
	body := []byte(`{"timeInfo":{"timeExtent":[1788480734000,1788487137000]}}`)
	start, end, err := parseTimeExtent(body)
	if err != nil {
		t.Fatalf("parseTimeExtent: %v", err)
	}
	if got := start.UTC().Format(time.RFC3339); got != "2026-09-04T00:12:14Z" {
		t.Errorf("start = %s", got)
	}
	if got := end.UTC().Format(time.RFC3339); got != "2026-09-04T01:58:57Z" {
		t.Errorf("end = %s", got)
	}
}

func TestParseTimeExtentRejectsMissing(t *testing.T) {
	for _, body := range []string{`{}`, `{"timeInfo":{}}`, `{"timeInfo":{"timeExtent":[1]}}`, `not json`} {
		if _, _, err := parseTimeExtent([]byte(body)); err == nil {
			t.Errorf("body %q: expected an error", body)
		}
	}
}

func TestFrameTimesWalkBackFromTheNewest(t *testing.T) {
	start := mustTime(t, "2026-09-04T00:00:00Z")
	end := mustTime(t, "2026-09-04T02:00:00Z")
	got := frameTimes(start, end, 30*time.Minute, 12)
	want := []string{
		"2026-09-04T00:00:00Z",
		"2026-09-04T00:30:00Z",
		"2026-09-04T01:00:00Z",
		"2026-09-04T01:30:00Z",
		"2026-09-04T02:00:00Z",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d frames, want %d: %v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].UTC().Format(time.RFC3339) != w {
			t.Errorf("frame %d = %s, want %s", i, got[i].UTC().Format(time.RFC3339), w)
		}
	}
}

// The newest frame is the one a viewer opens on, so a cap must drop the
// oldest, never the newest.
func TestFrameTimesCapKeepsTheNewest(t *testing.T) {
	start := mustTime(t, "2026-09-04T00:00:00Z")
	end := mustTime(t, "2026-09-04T02:00:00Z")
	got := frameTimes(start, end, 30*time.Minute, 3)
	if len(got) != 3 {
		t.Fatalf("got %d frames, want 3", len(got))
	}
	if got[len(got)-1].UTC().Format(time.RFC3339) != "2026-09-04T02:00:00Z" {
		t.Errorf("last frame = %s, want the newest", got[len(got)-1])
	}
	if got[0].UTC().Format(time.RFC3339) != "2026-09-04T01:00:00Z" {
		t.Errorf("first frame = %s, want the cap applied to the oldest end", got[0])
	}
}

func TestFrameTimesDegenerateExtent(t *testing.T) {
	at := mustTime(t, "2026-09-04T02:00:00Z")
	got := frameTimes(at, at, 30*time.Minute, 12)
	if len(got) != 1 || !got[0].Equal(at) {
		t.Fatalf("a zero-width extent should yield exactly its one instant, got %v", got)
	}
	if n := len(frameTimes(at, at.Add(-time.Hour), 30*time.Minute, 12)); n != 0 {
		t.Errorf("an inverted extent should yield no frames, got %d", n)
	}
}

func TestExportURLCarriesBBoxAndTime(t *testing.T) {
	at := mustTime(t, "2026-09-04T02:00:00Z")
	box := tiles.BBox{West: -90.20, South: 29.50, East: -87.45, North: 30.78}
	got := exportURL("https://example.test/ImageServer", box, 1024, 477, at)
	for _, want := range []string{
		"bbox=-90.2%2C29.5%2C-87.45%2C30.78",
		"bboxSR=4326",
		"imageSR=4326",
		"size=1024%2C477",
		// png32 rather than png: the plain encoder returns 8-bit RGB, and a
		// radar layer with no alpha would paint an opaque sheet over the sea.
		"format=png32",
		"transparent=true",
		"time=1788487200000",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("exportURL missing %q\n  got %s", want, got)
		}
	}
}

// A frame that 404s must not sink the whole set: radar ingest runs every few
// minutes and a partial loop is worth more than none.
func TestFetchRadarSkipsAFailedFrameAndWritesTheRest(t *testing.T) {
	const png = "\x89PNG\r\n\x1a\n" + "fake image bytes"
	var exported int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "exportImage") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"timeInfo":{"timeExtent":[1788480000000,1788483600000]}}`))
			return
		}
		exported++
		if exported == 2 {
			http.Error(w, "upstream hiccup", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte(png))
	}))
	defer srv.Close()

	dir := t.TempDir()
	box := tiles.BBox{West: -90.20, South: 29.50, East: -87.45, North: 30.78}
	set, err := FetchRadar(context.Background(), srv.Client(), srv.URL, box, dir, Options{
		Step: 30 * time.Minute, MaxFrames: 12, Width: 8, Height: 4,
	})
	if err != nil {
		t.Fatalf("FetchRadar: %v", err)
	}
	if len(set.Frames) != 2 {
		t.Fatalf("want 2 surviving frames of 3, got %d", len(set.Frames))
	}
	for i := 1; i < len(set.Frames); i++ {
		if !set.Frames[i].ValidTime.After(set.Frames[i-1].ValidTime) {
			t.Errorf("frames must be ascending in time: %v", set.Frames)
		}
	}
	for _, f := range set.Frames {
		if _, err := os.Stat(filepath.Join(dir, radarDir, f.File)); err != nil {
			t.Errorf("frame file missing: %v", err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, RadarManifest))
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	var round Radar
	if err := json.Unmarshal(raw, &round); err != nil {
		t.Fatalf("manifest is not valid json: %v", err)
	}
	if round.Width != 8 || round.Height != 4 {
		t.Errorf("manifest lost the image shape: %+v", round)
	}
	if round.BBox != box {
		t.Errorf("manifest lost the bbox: %+v", round.BBox)
	}
}

// Every frame failing is a real outage, and must not leave a manifest
// claiming a loop that has no images behind it.
func TestFetchRadarFailsWhenNoFrameSurvives(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "exportImage") {
			_, _ = w.Write([]byte(`{"timeInfo":{"timeExtent":[1788480000000,1788483600000]}}`))
			return
		}
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	dir := t.TempDir()
	if _, err := FetchRadar(context.Background(), srv.Client(), srv.URL,
		tiles.AOI, dir, Options{Step: 30 * time.Minute, MaxFrames: 12, Width: 8, Height: 4}); err == nil {
		t.Fatal("expected an error when every frame failed")
	}
	if _, err := os.Stat(filepath.Join(dir, RadarManifest)); !os.IsNotExist(err) {
		t.Error("a total failure must not write a manifest")
	}
}

// Frames age out of the upstream's own window; files for times no longer in
// the manifest are dead weight in an air-gapped tree.
func TestFetchRadarPrunesFramesItNoLongerServes(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, radarDir), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, radarDir, "20260101T000000Z.png")
	if err := os.WriteFile(stale, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "exportImage") {
			_, _ = w.Write([]byte(`{"timeInfo":{"timeExtent":[1788480000000,1788483600000]}}`))
			return
		}
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	}))
	defer srv.Close()
	if _, err := FetchRadar(context.Background(), srv.Client(), srv.URL, tiles.AOI, dir,
		Options{Step: 30 * time.Minute, MaxFrames: 12, Width: 8, Height: 4}); err != nil {
		t.Fatalf("FetchRadar: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("a frame no longer in the manifest should have been pruned")
	}
}

// The eventdriven service has been observed advertising a window days out of
// date. Frames from it are real images, so nothing downstream can tell they
// are stale — the ingest has to refuse them here, and leave the last good
// snapshot in place rather than overwrite it with history.
func TestFetchRadarRejectsAStaleServiceWindow(t *testing.T) {
	stale := time.Now().UTC().Add(-96 * time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "exportImage") {
			_, _ = fmt.Fprintf(w, `{"timeInfo":{"timeExtent":[%d,%d]}}`,
				stale.Add(-2*time.Hour).UnixMilli(), stale.UnixMilli())
			return
		}
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	}))
	defer srv.Close()

	dir := t.TempDir()
	_, err := FetchRadar(context.Background(), srv.Client(), srv.URL, tiles.AOI, dir, Options{
		Step: 30 * time.Minute, MaxFrames: 4, Width: 8, Height: 4, MaxAge: 3 * time.Hour,
	})
	if err == nil {
		t.Fatal("expected a stale service window to be refused")
	}
	if !strings.Contains(err.Error(), "stale") {
		t.Errorf("error should name the problem, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, RadarManifest)); !os.IsNotExist(err) {
		t.Error("a refused window must not write a manifest")
	}
}

func TestFetchRadarAcceptsAFreshWindow(t *testing.T) {
	end := time.Now().UTC()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "exportImage") {
			_, _ = fmt.Fprintf(w, `{"timeInfo":{"timeExtent":[%d,%d]}}`,
				end.Add(-2*time.Hour).UnixMilli(), end.UnixMilli())
			return
		}
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	}))
	defer srv.Close()
	if _, err := FetchRadar(context.Background(), srv.Client(), srv.URL, tiles.AOI, t.TempDir(), Options{
		Step: 30 * time.Minute, MaxFrames: 4, Width: 8, Height: 4, MaxAge: 3 * time.Hour,
	}); err != nil {
		t.Fatalf("a current window should be accepted: %v", err)
	}
}

// The manifest and the images are fetched by the client independently, so a
// browser one manifest behind is still entitled to the frames its copy
// names. Pruning to exactly the live set made those 404 and punched holes in
// the loop for a poll interval after every refresh.
func TestFetchRadarKeepsRecentlyDroppedFramesForClientsOneManifestBehind(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, radarDir), 0o755); err != nil {
		t.Fatal(err)
	}
	// The service window below ends at 1788483600000 ms. A frame a single
	// step behind the oldest one this fetch will serve is exactly the case a
	// client one manifest behind still asks for.
	end := time.UnixMilli(1788483600000).UTC()
	justDropped := end.Add(-7 * 30 * time.Minute)
	recent := filepath.Join(dir, radarDir, frameFile(justDropped))
	if err := os.WriteFile(recent, []byte("recent"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "exportImage") {
			_, _ = w.Write([]byte(`{"timeInfo":{"timeExtent":[1788480000000,1788483600000]}}`))
			return
		}
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nfake"))
	}))
	defer srv.Close()

	set, err := FetchRadar(context.Background(), srv.Client(), srv.URL, tiles.AOI, dir,
		Options{Step: 30 * time.Minute, MaxFrames: 12, Width: 8, Height: 4})
	if err != nil {
		t.Fatalf("FetchRadar: %v", err)
	}
	for _, f := range set.Frames {
		if f.File == filepath.Base(recent) {
			t.Fatal("test is not exercising the grace window: the frame is still live")
		}
	}
	if _, err := os.Stat(recent); err != nil {
		t.Errorf("a frame just dropped from the manifest must survive one more "+
			"poll for clients still holding the previous copy: %v", err)
	}
}

// A file the package did not write is not ours to delete.
func TestPruneFramesLeavesForeignFilesAlone(t *testing.T) {
	dir := t.TempDir()
	foreign := filepath.Join(dir, "notes.png")
	if err := os.WriteFile(foreign, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	keep := []Frame{{ValidTime: time.Now().UTC(), File: frameFile(time.Now().UTC())}}
	if err := pruneFrames(dir, keep, time.Hour); err != nil {
		t.Fatalf("pruneFrames: %v", err)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Errorf("a file this package did not write must be left alone: %v", err)
	}
}
