package ocean

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFetchSnapshotUsesFixtures(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ncss", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/hycom.csv")
	})
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/station_table.txt")
	})
	mux.HandleFunc("/data/realtime2/WYCM6.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/realtime2_wycm6.txt")
	})
	mux.HandleFunc("/data/realtime2/42040.txt", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", 404)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	out := t.TempDir()
	aoi := BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}
	err := FetchSnapshot(context.Background(), srv.Client(), Endpoints{
		HYCOM:           srv.URL + "/ncss",
		StationTable:    srv.URL + "/data/stations/station_table.txt",
		Realtime2Prefix: srv.URL + "/data/realtime2/",
	}, aoi, out)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCurrentsFile(filepath.Join(out, "currents.json")); err != nil {
		t.Fatal(err)
	}
}

func TestFetchSnapshotRejectsOversizedBody(t *testing.T) {
	dir := t.TempDir()
	u0, v0 := 0.1, 0.0
	good := Currents{ValidTime: time.Now().UTC(), Source: Source{Name: "HYCOM", URL: "x"}, BBox: BBox{West: -2, South: 1, East: -1, North: 2}, NX: 1, NY: 1, Grid: "centers", U: []*float64{&u0}, V: []*float64{&v0}}
	buoys := Buoys{ValidTime: time.Now().UTC(), Source: Source{Name: "NDBC", URL: "y"}, Stations: nil}
	if err := WriteSnapshot(dir, good, buoys, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	prev, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ncss", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/hycom.csv")
	})
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		line := []byte("# x\n")
		n := int(stationTableLimit)/len(line) + 2
		_, _ = w.Write(bytes.Repeat(line, n))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	aoi := BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}
	err = FetchSnapshot(context.Background(), srv.Client(), Endpoints{
		HYCOM:           srv.URL + "/ncss",
		StationTable:    srv.URL + "/data/stations/station_table.txt",
		Realtime2Prefix: srv.URL + "/data/realtime2/",
	}, aoi, dir)
	if err == nil {
		t.Fatal("expected oversized reject")
	}
	now, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(prev, now) {
		t.Fatal("oversized fetch must not replace currents.json")
	}
}
