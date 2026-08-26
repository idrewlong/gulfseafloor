package ocean

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestWrapLon180FoldsHYCOMModulo360(t *testing.T) {
	if got := wrapLon180(270.32); got < -89.69 || got > -89.67 {
		t.Fatalf("270.32 → %g, want ~-89.68", got)
	}
	if got := wrapLon180(-89.68); got != -89.68 {
		t.Fatalf("already-signed lon moved: %g", got)
	}
}

func TestParseHYCOMCSVWrapsZeroTo360Longitudes(t *testing.T) {
	raw := `time,latitude,longitude,water_u,water_v
2026-08-24T18:00:00Z,29.96,270.32,0.10,-0.02
2026-08-24T18:00:00Z,29.96,270.40,0.12,-0.01
2026-08-24T18:00:00Z,30.04,270.32,0.08,0.03
2026-08-24T18:00:00Z,30.04,270.40,NaN,NaN
`
	c, err := ParseHYCOMCSV(strings.NewReader(raw), Source{Name: "HYCOM", Dataset: "test", URL: "https://example.invalid/ncss"})
	if err != nil {
		t.Fatal(err)
	}
	aoi := BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}
	if !c.BBox.Intersects(aoi) {
		t.Fatalf("wrapped bbox %+v must intersect the Sound", c.BBox)
	}
	if c.BBox.West > 0 {
		t.Fatalf("west should be signed degrees, got %g", c.BBox.West)
	}
}

func TestParseHYCOMNetCDFBuildsSouthToNorthGrid(t *testing.T) {
	f, err := os.Open("testdata/hycom.nc")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c, err := ParseHYCOM(f, Source{Name: "HYCOM", Dataset: "GLBy0.08/latest", URL: "https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest"})
	if err != nil {
		t.Fatal(err)
	}
	if c.NX != 24 || c.NY != 15 || c.Grid != "centers" {
		t.Fatalf("nx=%d ny=%d grid=%s", c.NX, c.NY, c.Grid)
	}
	aoi := BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}
	if !c.BBox.Intersects(aoi) {
		t.Fatalf("netcdf bbox %+v must intersect the Sound (lons are 0–360 in the file)", c.BBox)
	}
	if c.U[0] == nil || *c.U[0] < 0.04 || *c.U[0] > 0.05 {
		t.Fatalf("SW u %#v", c.U[0])
	}
	wantTime := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	if !c.ValidTime.Equal(wantTime) {
		t.Fatalf("validTime %s want %s", c.ValidTime.UTC().Format(time.RFC3339), wantTime.Format(time.RFC3339))
	}
	var missing int
	for _, u := range c.U {
		if u == nil {
			missing++
		}
	}
	if missing == 0 {
		t.Fatal("NaN land/missing cells must stay null")
	}
}

func TestParseHYCOMNetCDFReadsTime2Coordinate(t *testing.T) {
	f, err := os.Open("testdata/hycom_time2.nc")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	c, err := ParseHYCOM(f, Source{Name: "HYCOM", Dataset: "GLBy0.08/latest", URL: "https://ncss.hycom.org/thredds/ncss/grid/GLBy0.08/latest"})
	if err != nil {
		t.Fatal(err)
	}
	aoi := BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}
	if !c.BBox.Intersects(aoi) {
		t.Fatalf("bbox %+v", c.BBox)
	}
	if c.ValidTime.IsZero() {
		t.Fatal("time2 must yield a validTime")
	}
}

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

func TestParseHYCOMCSVRejectsMixedTimes(t *testing.T) {
	raw := `time,latitude,longitude,water_u,water_v
2026-08-24T18:00:00Z,29.96,-89.68,0.10,-0.02
2026-08-24T21:00:00Z,29.96,-89.60,0.12,-0.01
`
	if _, err := ParseHYCOMCSV(strings.NewReader(raw), Source{Name: "HYCOM"}); err == nil {
		t.Fatal("later row with a different time must be an error")
	}
}

func TestParseHYCOMCSVRejectsEmptyGrid(t *testing.T) {
	raw := `time,latitude,longitude,water_u,water_v
`
	if _, err := ParseHYCOMCSV(strings.NewReader(raw), Source{Name: "HYCOM"}); err == nil {
		t.Fatal("empty grid must be an error")
	}
}

func TestParseHYCOMCSVRejectsNonFiniteLatLon(t *testing.T) {
	src := Source{Name: "HYCOM"}
	cases := []struct {
		name string
		csv  string
	}{
		{"NaN lat", hycomCSVWith("NaN", "-89.68", "0.10", "-0.02")},
		{"Inf lat", hycomCSVWith("Inf", "-89.68", "0.10", "-0.02")},
		{"NaN lon", hycomCSVWith("29.96", "NaN", "0.10", "-0.02")},
		{"Inf lon", hycomCSVWith("29.96", "Inf", "0.10", "-0.02")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseHYCOMCSV(strings.NewReader(tc.csv), src); err == nil {
				t.Fatal("non-finite lat/lon must be an error")
			}
		})
	}
}

func TestParseHYCOMCSVRejectsMalformedVelocity(t *testing.T) {
	src := Source{Name: "HYCOM"}
	cases := []struct {
		name string
		csv  string
		col  string
	}{
		{"invalid u", hycomCSVWith("29.96", "-89.68", "invalid", "-0.02"), "u"},
		{"invalid v", hycomCSVWith("29.96", "-89.68", "0.10", "invalid"), "v"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseHYCOMCSV(strings.NewReader(tc.csv), src)
			if err == nil {
				t.Fatal("malformed velocity must be an error")
			}
			msg := err.Error()
			if !strings.Contains(msg, "row") || !strings.Contains(msg, tc.col) {
				t.Fatalf("error must name row and column %s: %v", tc.col, err)
			}
		})
	}
}

func TestParseHYCOMCSVBlankVelocityIsNil(t *testing.T) {
	raw := hycomCSVWith("30.04", "-89.60", "", "")
	c, err := ParseHYCOMCSV(strings.NewReader(raw), Source{Name: "HYCOM", Dataset: "test", URL: "https://example.invalid/ncss"})
	if err != nil {
		t.Fatal(err)
	}
	if c.U[3] != nil || c.V[3] != nil {
		t.Fatal("blank velocity must become null cells")
	}
}

func hycomCSVWith(lat, lon, u, v string) string {
	return "time,latitude,longitude,water_u,water_v\n" +
		"2026-08-24T18:00:00Z,29.96,-89.68,0.10,-0.02\n" +
		"2026-08-24T18:00:00Z,29.96,-89.60,0.12,-0.01\n" +
		"2026-08-24T18:00:00Z,30.04,-89.68,0.08,0.03\n" +
		"2026-08-24T18:00:00Z," + lat + "," + lon + "," + u + "," + v + "\n"
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
