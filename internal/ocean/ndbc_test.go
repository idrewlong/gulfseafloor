package ocean

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestExpandAndContains(t *testing.T) {
	b := Expand(BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}, 0.5)
	if b.West != -90.2 || b.North != 31.02 {
		t.Fatalf("%+v", b)
	}
	if !b.Contains(-88.207, 29.50) {
		t.Fatal("(-88.207, 29.50) is inside 0.5° margin of the Sound")
	}
	if b.Contains(-80.180, 28.500) {
		t.Fatal("(-80.180, 28.500) is outside 0.5° margin of the Sound")
	}
}

func TestParseStationTableFiltersMargin(t *testing.T) {
	f, err := os.Open("testdata/station_table.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	margin := Expand(BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}, 0.5)
	rows, err := ParseStationTable(f, margin)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range rows {
		got[r.ID] = true
	}
	if !got["WYCM6"] || !got["42040"] || got["41009"] {
		t.Fatalf("%v", got)
	}
}

func TestParseRealtime2LatestRow(t *testing.T) {
	f, err := os.Open("testdata/realtime2_wycm6.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, err := ParseRealtime2("WYCM6", f)
	if err != nil {
		t.Fatal(err)
	}
	if st.WDir == nil || *st.WDir != 180 || st.WSpd == nil || *st.WSpd != 6.2 {
		t.Fatalf("%+v", st)
	}
	if st.WVHT == nil || *st.WVHT != 0.4 || st.WTMP == nil || *st.WTMP != 29.1 {
		t.Fatalf("waves/temp %+v", st)
	}
	want := time.Date(2026, 8, 24, 19, 50, 0, 0, time.UTC)
	if st.ObsTime == nil || !st.ObsTime.Equal(want) {
		t.Fatalf("obs %v", st.ObsTime)
	}
}

func TestParseRealtime2OmitsMM(t *testing.T) {
	raw := `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC
2026 08 24 19 50  MM   6.2  8.1    MM    MM    MM  MM     MM    MM   29.1
`
	st, err := ParseRealtime2("WYCM6", strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if st.WDir != nil || st.WVHT != nil {
		t.Fatalf("MM fields must be omitted: %+v", st)
	}
	if st.WSpd == nil || *st.WSpd != 6.2 || st.Gst == nil || *st.Gst != 8.1 || st.WTMP == nil || *st.WTMP != 29.1 {
		t.Fatalf("numeric fields: %+v", st)
	}
}

func TestParseRealtime2LatestObsTimeWins(t *testing.T) {
	// NDBC realtime2 is newest-first. The last parseable row is the oldest.
	raw := `#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP
2026 08 24 19 00 20 2.0 3.0 0.2 MM MM MM MM MM 21.0
not-a-row
2026 07 10 00 10 10 1.0 2.0 0.1 MM MM MM MM MM 20.0
`
	st, err := ParseRealtime2("42040", strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if st.ID != "42040" || st.WDir == nil || *st.WDir != 20 || st.ObsTime == nil || !st.ObsTime.Equal(time.Date(2026, 8, 24, 19, 0, 0, 0, time.UTC)) {
		t.Fatalf("%+v", st)
	}
}

func TestParseRealtime2SkipsRowWithInvalidHour(t *testing.T) {
	raw := `#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP
2026 08 24 18 00 10 1.0 2.0 0.1 MM MM MM MM MM 20.0
2026 08 24 99 00 20 2.0 3.0 0.2 MM MM MM MM MM 21.0
`
	st, err := ParseRealtime2("42040", strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)
	if st.ObsTime == nil || !st.ObsTime.Equal(want) || st.WDir == nil || *st.WDir != 10 {
		t.Fatalf("hour=99 must not replace the previous row: %+v", st)
	}
}

func TestParseRealtime2SkipsRowWithNonNumericMeasurement(t *testing.T) {
	raw := `#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP
2026 08 24 18 00 10 1.0 2.0 0.1 MM MM MM MM MM 20.0
2026 08 24 19 00 20 abc 3.0 0.2 MM MM MM MM MM 21.0
`
	st, err := ParseRealtime2("42040", strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)
	if st.ObsTime == nil || !st.ObsTime.Equal(want) || st.WSpd == nil || *st.WSpd != 1.0 {
		t.Fatalf("WSPD=abc must skip that row: %+v", st)
	}
}

func TestParseRealtime2RejectsHTML(t *testing.T) {
	_, err := ParseRealtime2("WYCM6", strings.NewReader("<html><body>not ndbc</body></html>"))
	if err == nil {
		t.Fatal("HTML payload must be an error")
	}
}

func TestParseStationTableRejectsHTML(t *testing.T) {
	_, err := ParseStationTable(strings.NewReader("<html><body>not a table</body></html>"), BBox{})
	if err == nil {
		t.Fatal("HTML payload must be an error")
	}
}

func TestBuoysValidTime(t *testing.T) {
	retrieved := time.Date(2026, 8, 24, 20, 0, 0, 0, time.UTC)
	if got := BuoysValidTime(nil, retrieved); !got.Equal(retrieved) {
		t.Fatalf("empty stations: %v", got)
	}
	if got := BuoysValidTime([]Station{{ID: "x"}}, retrieved); !got.Equal(retrieved) {
		t.Fatalf("nil obs: %v", got)
	}
	early := time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)
	late := time.Date(2026, 8, 24, 19, 50, 0, 0, time.UTC)
	got := BuoysValidTime([]Station{
		{ID: "a", ObsTime: &early},
		{ID: "b"},
		{ID: "c", ObsTime: &late},
	}, retrieved)
	if !got.Equal(late) {
		t.Fatalf("max obs: %v", got)
	}
}
