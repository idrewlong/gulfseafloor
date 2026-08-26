package ocean

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

func TestFetchSnapshotRejectsDisjointCurrentsBBox(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ncss", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`time,latitude,longitude,water_u,water_v
2026-08-24T18:00:00Z,0.00,0.00,0.10,-0.02
2026-08-24T18:00:00Z,0.00,1.00,0.12,-0.01
2026-08-24T18:00:00Z,1.00,0.00,0.08,0.03
2026-08-24T18:00:00Z,1.00,1.00,0.09,0.01
`))
	})
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/station_table.txt")
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
	if err == nil {
		t.Fatal("HYCOM bbox that does not intersect the AOI must be an error")
	}
	if _, statErr := os.Stat(filepath.Join(out, "currents.json")); !os.IsNotExist(statErr) {
		t.Fatal("disjoint HYCOM bbox must not write a snapshot")
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

func TestFetchSnapshotUppercasesRealtime2ID(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ncss", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/hycom.csv")
	})
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("#id|owner|ttype|hull|name|payload|location|timezone|forecast|note\n" +
			"wycm6|NWLON|fixed|n/a|Gulfport Harbor|stdmet|30.360 N 89.081 W|CST|n/a|n/a\n"))
	})
	mux.HandleFunc("/data/realtime2/WYCM6.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/realtime2_wycm6.txt")
	})
	mux.HandleFunc("/data/realtime2/wycm6.txt", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ndbc files are uppercase", http.StatusNotFound)
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
	f, err := os.Open(filepath.Join(out, "buoys.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	b, err := DecodeBuoys(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Stations) != 1 || b.Stations[0].ID != "WYCM6" {
		t.Fatalf("lowercase table id must fetch uppercase realtime2: %+v", b.Stations)
	}
}

func TestFetchSnapshotTruncatesOversizedRealtime2(t *testing.T) {
	var body strings.Builder
	body.WriteString("#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP\n")
	body.WriteString("2026 08 25 23 48 280 2.6 4.1 MM MM MM MM 1014.0 MM 31.2\n")
	old := "2026 07 10 00 10 MM MM MM 0.3 MM MM MM MM MM 31.4\n"
	for body.Len() <= int(realtime2Limit)+64 {
		body.WriteString(old)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ncss", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/hycom.csv")
	})
	mux.HandleFunc("/data/stations/station_table.txt", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "testdata/station_table.txt")
	})
	mux.HandleFunc("/data/realtime2/WYCM6.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body.String()))
	})
	mux.HandleFunc("/data/realtime2/42040.txt", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
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
	f, err := os.Open(filepath.Join(out, "buoys.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	b, err := DecodeBuoys(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Stations) != 1 {
		t.Fatalf("oversized realtime2 must still ingest: %+v", b.Stations)
	}
	want := time.Date(2026, 8, 25, 23, 48, 0, 0, time.UTC)
	if b.Stations[0].ObsTime == nil || !b.Stations[0].ObsTime.Equal(want) {
		t.Fatalf("truncated file must keep the newest row, got %v", b.Stations[0].ObsTime)
	}
}
