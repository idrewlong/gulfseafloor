package ocean

import (
	"bytes"
	"fmt"
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
	prev := readSnapshotFiles(t, dir)
	bad := good
	bad.Grid = "edges"
	if err := WriteSnapshot(dir, bad, buoys, time.Now().UTC()); err == nil {
		t.Fatal("expected reject")
	}
	assertSnapshotUnchanged(t, dir, prev)
}

func TestWriteSnapshotSwapFailureLeavesPreviousSnapshot(t *testing.T) {
	dir := t.TempDir()
	u0, v0 := 0.1, 0.0
	u1 := 0.9
	good := Currents{ValidTime: time.Now().UTC(), Source: Source{Name: "HYCOM", URL: "x"}, BBox: BBox{West: -2, South: 1, East: -1, North: 2}, NX: 1, NY: 1, Grid: "centers", U: []*float64{&u0}, V: []*float64{&v0}}
	next := good
	next.U = []*float64{&u1}
	buoys := Buoys{ValidTime: time.Now().UTC(), Source: Source{Name: "NDBC", URL: "y"}, Stations: nil}
	if err := WriteSnapshot(dir, good, buoys, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	prev := readSnapshotFiles(t, dir)

	orig := rename
	t.Cleanup(func() { rename = orig })
	n := 0
	rename = func(oldpath, newpath string) error {
		n++
		if n == 2 {
			return fmt.Errorf("injected rename failure")
		}
		return orig(oldpath, newpath)
	}

	if err := WriteSnapshot(dir, next, buoys, time.Now().UTC()); err == nil {
		t.Fatal("expected swap failure")
	}
	assertSnapshotUnchanged(t, dir, prev)
}

func readSnapshotFiles(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, name := range []string{"currents.json", "buoys.json", "manifest.json"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		out[name] = b
	}
	return out
}

func assertSnapshotUnchanged(t *testing.T, dir string, prev map[string][]byte) {
	t.Helper()
	now := readSnapshotFiles(t, dir)
	for _, name := range []string{"currents.json", "buoys.json", "manifest.json"} {
		if !bytes.Equal(prev[name], now[name]) {
			t.Fatalf("failed write must not replace %s", name)
		}
	}
}
