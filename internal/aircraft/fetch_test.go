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

// adsb.lol is the primary feed: it has no daily credit ceiling, so it can
// carry a 10 s poll for a whole session. OpenSky must not even be contacted
// while adsb.lol answers — anonymous OpenSky allows 400 credits a day and a
// full session would burn that in well under an hour.
func TestFetchUsesAdsbLolWhenOKAndDoesNotTouchOpenSky(t *testing.T) {
	var lolHits, skyHits int
	sky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		skyHits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[]}`)
	}))
	t.Cleanup(sky.Close)
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lolHits++
		if r.Header.Get("User-Agent") != UserAgent {
			t.Errorf("ua %q", r.Header.Get("User-Agent"))
		}
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
	if got.Source != SourceAdsbLol || len(got.Aircraft) != 1 {
		t.Fatalf("%+v", got)
	}
	if lolHits != 1 {
		t.Fatalf("adsb.lol hits %d, want 1", lolHits)
	}
	if skyHits != 0 {
		t.Fatalf("OpenSky was polled %d times while adsb.lol was healthy", skyHits)
	}
}

func TestFetchFallsBackToOpenSkyWhenAdsbLolFails(t *testing.T) {
	lol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(lol.Close)
	sky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "lamin=") {
			t.Errorf("query %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"time":1,"states":[["abc123","DAL123  ",null,1,1,-89.08,30.41,1000,false,80,180,0,null,1000,null,false,0]]}`)
	}))
	t.Cleanup(sky.Close)
	got, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: sky.URL + "/states/all", AdsbLol: lol.URL}, tiles.AOI, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceOpenSky || len(got.Aircraft) != 1 {
		t.Fatalf("%+v", got)
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
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/secret", http.StatusFound)
	}))
	t.Cleanup(redirecting.Close)
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(dead.Close)
	// Both legs must refuse the off-host hop, so aim it at each in turn.
	if _, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: dead.URL, AdsbLol: redirecting.URL}, tiles.AOI, time.Now().UTC()); err == nil {
		t.Fatal("adsb.lol redirect must not parse as success")
	}
	if _, err := Fetch(context.Background(), NewClient(), Endpoints{OpenSky: redirecting.URL, AdsbLol: dead.URL}, tiles.AOI, time.Now().UTC()); err == nil {
		t.Fatal("OpenSky redirect must not parse as success")
	}
}
