package ocean

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseHYCOMCSVBuildsSouthToNorthGrid(t *testing.T) {
	f, err := os.Open("testdata/hycom.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c, err := ParseHYCOMCSV(f, Source{Name: "HYCOM", Dataset: "test", URL: "https://example.invalid/ncss"})
	if err != nil {
		t.Fatal(err)
	}
	if c.NX != 2 || c.NY != 2 || c.Grid != "centers" {
		t.Fatalf("nx=%d ny=%d grid=%s", c.NX, c.NY, c.Grid)
	}
	// index 0 = southwest (29.96, -89.68)
	if c.U[0] == nil || *c.U[0] != 0.10 {
		t.Fatalf("SW u %#v", c.U[0])
	}
	// last index = northeast row-major: y=1 x=1 → NaN → nil
	if c.U[3] != nil || c.V[3] != nil {
		t.Fatal("NaN must become null cells")
	}
	if c.BBox.West != -89.68 || c.BBox.North != 30.04 {
		t.Fatalf("centers bbox %+v", c.BBox)
	}
}

func TestParseHYCOMCSVSkipsCommentLines(t *testing.T) {
	raw := `# ncss metadata
time,latitude,longitude,water_u,water_v
2026-08-24T18:00:00Z,29.96,-89.68,0.10,-0.02
2026-08-24T18:00:00Z,29.96,-89.60,0.12,-0.01
2026-08-24T18:00:00Z,30.04,-89.68,0.08,0.03
2026-08-24T18:00:00Z,30.04,-89.60,NaN,NaN
`
	c, err := ParseHYCOMCSV(strings.NewReader(raw), Source{Name: "HYCOM", Dataset: "test", URL: "https://example.invalid/ncss"})
	if err != nil {
		t.Fatal(err)
	}
	if c.NX != 2 || c.NY != 2 || c.U[0] == nil || *c.U[0] != 0.10 {
		t.Fatalf("comment lines must not break the grid: nx=%d ny=%d u0=%v", c.NX, c.NY, c.U[0])
	}
}

func TestParseHYCOMCSVRejectsEmptyGrid(t *testing.T) {
	raw := `time,latitude,longitude,water_u,water_v
`
	if _, err := ParseHYCOMCSV(strings.NewReader(raw), Source{Name: "HYCOM"}); err == nil {
		t.Fatal("empty grid must be an error")
	}
}

func TestParseHYCOMCSVPassesDecodeCurrents(t *testing.T) {
	f, err := os.Open("testdata/hycom.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c, err := ParseHYCOMCSV(f, Source{Name: "HYCOM", Dataset: "test", URL: "https://example.invalid/ncss"})
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)
	if !c.ValidTime.Equal(want) {
		t.Fatalf("validTime %v", c.ValidTime)
	}
	_, off := c.ValidTime.Zone()
	if off != 0 {
		t.Fatalf("validTime must be UTC, offset=%d", off)
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCurrents(bytes.NewReader(raw)); err != nil {
		t.Fatalf("DecodeCurrents rejected parse output: %v", err)
	}
}
