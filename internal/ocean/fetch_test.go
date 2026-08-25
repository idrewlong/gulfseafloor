package ocean

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
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
