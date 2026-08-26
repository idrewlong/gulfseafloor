package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/aircraft"
)

func aircraftHandler(t *testing.T, sky http.HandlerFunc, lol http.HandlerFunc, now func() time.Time) http.Handler {
	t.Helper()
	up := httptest.NewServer(sky)
	t.Cleanup(up.Close)
	fb := httptest.NewServer(lol)
	t.Cleanup(fb.Close)
	return New(Config{
		TileDir:          "testdata/tiles",
		WebDir:           t.TempDir(),
		TileWorkers:      1,
		AircraftEnabled:  true,
		OpenSkyURL:       up.URL + "/states/all",
		AdsbLolURL:       fb.URL,
		AircraftNow:      now,
		AircraftCacheTTL: 10 * time.Second,
		AircraftStaleFor: 60 * time.Second,
	})
}

func TestAircraftDisabledIs404(t *testing.T) {
	h := New(Config{TileDir: "testdata/tiles", WebDir: t.TempDir(), TileWorkers: 1, AircraftEnabled: false})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestAircraftServesOpenSkyAndCaches(t *testing.T) {
	var n atomic.Int32
	now := time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","DAL123  ",null,1,1,-89.08,30.41,1000,false,80,180,0,null,1000,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("fallback should not run")
	}, clock)
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("cc %s", rec.Header().Get("Cache-Control"))
		}
		var snap aircraft.Snapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Source != aircraft.SourceOpenSky || len(snap.Aircraft) != 1 {
			t.Fatalf("%+v", snap)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("upstream hits %d", n.Load())
	}
}

func TestAircraftHEADOmitsBody(t *testing.T) {
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {}, time.Now)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/api/aircraft", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("status %d len %d", rec.Code, rec.Body.Len())
	}
}

func TestAircraftPOSTIs405(t *testing.T) {
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("OpenSky must not be called")
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("adsb.lol must not be called")
	}, time.Now)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/aircraft", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestAircraftStaleCacheWhenBothDown(t *testing.T) {
	now := time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	var sky http.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) { sky(w, r) }, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}, clock)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	sky = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }
	now = now.Add(15 * time.Second) // TTL expired, stale window open
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("stale want 200 got %d", rec.Code)
	}
	now = now.Add(60 * time.Second) // beyond 60s from original fetch
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expired stale want 404 got %d", rec.Code)
	}
}

func TestReadyzOKWhenAircraftDisabled(t *testing.T) {
	h := New(Config{TileDir: "testdata/tiles", WebDir: t.TempDir(), TileWorkers: 1, AircraftEnabled: false})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestReadyzOKWhenAircraftEnabledDoesNotHitFeeds(t *testing.T) {
	h := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("OpenSky must not be called")
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("adsb.lol must not be called")
	}, time.Now)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestAircraftSingleflightCoalesces(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseUpstream := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseUpstream()
	var n atomic.Int32
	base := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		started <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("fallback should not run")
	}, time.Now)
	var entered sync.WaitGroup
	entered.Add(2)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered.Done()
		base.ServeHTTP(w, r)
	})
	done := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
			done <- rec.Code
		}()
	}
	allEntered := make(chan struct{})
	go func() {
		entered.Wait()
		close(allEntered)
	}()
	select {
	case <-allEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("requests did not enter ServeHTTP")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream did not start")
	}
	time.Sleep(20 * time.Millisecond)
	if n.Load() != 1 {
		t.Fatalf("upstream hits while blocked %d", n.Load())
	}
	select {
	case <-started:
		t.Fatal("second upstream fetch started before release")
	default:
	}
	releaseUpstream()
	for i := 0; i < 2; i++ {
		if code := <-done; code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("upstream hits %d", n.Load())
	}
}

func TestAircraftSingleflightFetchSurvivesFirstCallerCancellation(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseUpstream := func() {
		releaseOnce.Do(func() { close(release) })
	}
	defer releaseUpstream()
	upstreamCanceled := make(chan struct{})
	base := aircraftHandler(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
			close(upstreamCanceled)
			return
		case <-release:
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","X",null,1,1,-89.08,30.41,1,false,1,1,0,null,1,null,false,0]]}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("fallback should not run")
	}, time.Now)

	var entered sync.WaitGroup
	entered.Add(2)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered.Done()
		base.ServeHTTP(w, r)
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 2)
	go func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil).WithContext(ctx))
		done <- rec.Code
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream did not start")
	}
	go func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/aircraft", nil))
		done <- rec.Code
	}()
	allEntered := make(chan struct{})
	go func() {
		entered.Wait()
		close(allEntered)
	}()
	select {
	case <-allEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("requests did not enter ServeHTTP")
	}
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-upstreamCanceled:
	case <-time.After(50 * time.Millisecond):
	}
	releaseUpstream()

	for i := 0; i < 2; i++ {
		if code := <-done; code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
	}
}
