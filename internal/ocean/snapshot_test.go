package ocean

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteSnapshotDoesNotClobberOnFailure(t *testing.T) {
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
	bad := good
	bad.Grid = "edges"
	if err := WriteSnapshot(dir, bad, buoys, time.Now().UTC()); err == nil {
		t.Fatal("expected reject")
	}
	now, err := os.ReadFile(filepath.Join(dir, "currents.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(prev, now) {
		t.Fatal("failed write must not replace currents.json")
	}
}
