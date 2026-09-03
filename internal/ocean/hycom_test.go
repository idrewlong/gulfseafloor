package ocean

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/batchatco/go-native-netcdf/netcdf"
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
	if len(c.Steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(c.Steps))
	}
	step := c.Steps[0]
	if step.U[0] == nil || *step.U[0] < 0.04 || *step.U[0] > 0.05 {
		t.Fatalf("SW u %#v", step.U[0])
	}
	wantTime := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	if !c.ValidTime.Equal(wantTime) {
		t.Fatalf("validTime %s want %s", c.ValidTime.UTC().Format(time.RFC3339), wantTime.Format(time.RFC3339))
	}
	var missing int
	for _, u := range step.U {
		if u == nil {
			missing++
		}
	}
	if missing == 0 {
		t.Fatal("NaN land/missing cells must stay null")
	}
}

// TestNCTimeVarPrefersCFStandardNameOverAdHocNames guards against
// regressing to a hardcoded name list (time/time2/time1). A live single
// time= grid request against GLBy0.08/latest was observed to name the
// valid-time coordinate "time4" (with a "time4_run" companion for the
// forecast *reference* time) — a name outside that list, which made
// parseHYCOMNetCDF fail against the real service even though it worked
// against these vendored fixtures. There is no committed fixture with a
// "time4"-named variable (*.nc is gitignored, so a new binary fixture would
// never reach CI), so this locks in the mechanism instead: ncTimeVar must
// pick the variable by its CF standard_name ("time"), not by name, and
// must not be fooled by the run-time companion variable which sits right
// next to it and shares the same units.
func TestNCTimeVarPrefersCFStandardNameOverAdHocNames(t *testing.T) {
	data, err := os.ReadFile("testdata/hycom_time2.nc")
	if err != nil {
		t.Fatal(err)
	}
	tmp, err := os.CreateTemp("", "gulf-hycom-nctimevar-*.nc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatal(err)
	}
	nc, err := netcdf.Open(tmp.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()

	vr, err := ncTimeVar(nc)
	if err != nil {
		t.Fatalf("ncTimeVar: %v", err)
	}
	if got := ncAttrString(vr, "standard_name"); got != "time" {
		t.Fatalf("standard_name = %q, want %q (picked the run-time companion instead of the valid-time coordinate?)", got, "time")
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
	step := c.Steps[0]
	// index 0 = southwest (29.96, -89.68)
	if step.U[0] == nil || *step.U[0] != 0.10 {
		t.Fatalf("SW u %#v", step.U[0])
	}
	// last index = northeast row-major: y=1 x=1 → NaN → nil
	if step.U[3] != nil || step.V[3] != nil {
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
	step := c.Steps[0]
	if c.NX != 2 || c.NY != 2 || step.U[0] == nil || *step.U[0] != 0.10 {
		t.Fatalf("comment lines must not break the grid: nx=%d ny=%d u0=%v", c.NX, c.NY, step.U[0])
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
	step := c.Steps[0]
	if step.U[3] != nil || step.V[3] != nil {
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

func TestParseHYCOMCSVGroupsByTime(t *testing.T) {
	csv := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T12:00:00Z,30.0,-89.0,0.1234567,-0.05\n" +
		"2026-09-03T12:00:00Z,30.0,-88.0,0.2,-0.06\n" +
		"2026-09-03T15:00:00Z,30.0,-89.0,0.3,-0.07\n" +
		"2026-09-03T15:00:00Z,30.0,-88.0,0.4,-0.08\n"
	c, err := ParseHYCOMCSV(strings.NewReader(csv), Source{Name: "HYCOM"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(c.Steps) != 2 {
		t.Fatalf("steps = %d, want 2", len(c.Steps))
	}
	if c.NX != 2 || c.NY != 1 {
		t.Fatalf("shape = %dx%d, want 2x1", c.NX, c.NY)
	}
	if !c.Steps[0].ValidTime.Before(c.Steps[1].ValidTime) {
		t.Error("steps must be sorted ascending")
	}
	if got := *c.Steps[0].U[0]; got != 0.123 {
		t.Errorf("u = %v, want 0.123 (quantized to 1 mm/s)", got)
	}
	if got := *c.Steps[1].U[1]; got != 0.4 {
		t.Errorf("second step u = %v, want 0.4", got)
	}
}

func TestParseHYCOMCSVRejectsRaggedTimes(t *testing.T) {
	csv := "time,latitude[unit=degrees_north],longitude[unit=degrees_east],water_u[unit=m/s],water_v[unit=m/s]\n" +
		"2026-09-03T12:00:00Z,30.0,-89.0,0.1,-0.05\n" +
		"2026-09-03T12:00:00Z,30.0,-88.0,0.2,-0.06\n" +
		"2026-09-03T15:00:00Z,30.0,-89.0,0.3,-0.07\n"
	if _, err := ParseHYCOMCSV(strings.NewReader(csv), Source{Name: "HYCOM"}); err == nil {
		t.Fatal("a time with fewer cells than the grid must be an error")
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
