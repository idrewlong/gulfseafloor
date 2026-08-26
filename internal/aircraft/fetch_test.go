package aircraft

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestCoverRadiusCoversAOI(t *testing.T) {
	r := CoverRadiusNmi(tiles.AOI)
	if r < 80 || r > 120 {
		t.Fatalf("radius %v nmi, expected ~90", r)
	}
}

func TestFetchUsesOpenSkyWhenOK(t *testing.T) {
	var hits []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		if r.Header.Get("User-Agent") != UserAgent {
			t.Errorf("ua %q", r.Header.Get("User-Agent"))
		}
		if !strings.Contains(r.URL.RawQuery, "lamin=") {
			t.Errorf("query %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","DAL123  ",null,1,1,-89.08,30.41,1000,false,80,180,0,null,1000,null,false,0]]}`)
	}))
	t.Cleanup(up.Close)
	got, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: up.URL + "/states/all", AdsbLol: "http://127.0.0.1:1"}, tiles.AOI, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceOpenSky || len(got.Aircraft) != 1 {
		t.Fatalf("%+v", got)
	}
	if len(hits) != 1 {
		t.Fatalf("hits %v", hits)
	}
}

func TestFetchFallsBackOnOpenSky429(t *testing.T) {
	sky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(sky.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/v2/lat/") {
			t.Errorf("path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ac":[{"hex":"abc123","lat":30.41,"lon":-89.08,"gs":10,"track":0,"ground":false}]}`)
	}))
	t.Cleanup(lol.Close)
	got, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: sky.URL, AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceAdsbLol {
		t.Fatalf("source %s", got.Source)
	}
}

func TestFetchBothFail(t *testing.T) {
	sky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(sky.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(lol.Close)
	if _, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: sky.URL, AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC()); err == nil {
		t.Fatal("expected error")
	}
}

func TestFetchDoesNotFollowOffHostRedirect(t *testing.T) {
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("followed off-host redirect")
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(evil.Close)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/secret", http.StatusFound)
	}))
	t.Cleanup(up.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(lol.Close)
	if _, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: up.URL, AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC()); err == nil {
		t.Fatal("redirect must not parse as success")
	}
}
