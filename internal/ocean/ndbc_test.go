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

func TestParseStationTableReadsPlatformKind(t *testing.T) {
	// Every TTYPE below is copied verbatim from the live station_table.txt.
	// The column is free text with ~65 spellings, not an enum, so this is
	// the vocabulary the classifier actually has to survive.
	table := `# STATION_ID | OWNER | TTYPE | HULL | NAME | PAYLOAD | LOCATION | TIMEZONE | FORECAST | NOTE
#
wycm6|NOS|Water Level Observation Network||Gulfport Harbor||30.360 N 89.081 W|C| |
kata1|N|C-MAN Station||Katrina Cut||30.230 N 88.100 W|C| |
gdxm6|NERRS|NERRS Weather Station||Grand Bay||30.410 N 88.400 W|C| |
dpha1|N|Coastal Marine Station||Dauphin Island Sea Lab||30.250 N 88.070 W|C| |
42012|N|3-meter discus buoy|3D90|Orange Beach||30.061 N 87.547 W|C| |
42067|US|2.2-meter buoy ||USM-R1||30.050 N 88.583 W|C| |
42354|N|Waverider Buoy||Chandeleur SE||30.100 N 88.900 W|C| |
42357|N|Spotter Buoy||DISL Spotter||30.200 N 88.200 W|C| |
rig001|N|Oil Platform||A Platform||30.300 N 88.300 W|C| |
dart01|N|2.6 meter DART buoy||A DART||30.310 N 88.310 W|C| |
tsu001|N|STB - SAIC Tsunami Buoy||A Tsunami Buoy||30.320 N 88.320 W|C| |
usv001|N|Uncrewed Surface Vehicle||A Saildrone||30.330 N 88.330 W|C| |
ferry1|N|Long Island Ferry||A Ferry||30.340 N 88.340 W|C| |
blank1|N|||No Type Given||30.350 N 88.350 W|C| |
`
	margin := Expand(BBox{West: -89.7, South: 29.95, East: -87.85, North: 30.52}, 0.5)
	rows, err := ParseStationTable(strings.NewReader(table), margin)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]StationKind{}
	for _, r := range rows {
		got[r.ID] = r.Kind
	}

	want := map[string]StationKind{
		// Shore and pier installations. NOS tide gauges dominate this AOI.
		"WYCM6": KindFixed,
		"KATA1": KindFixed,
		"GDXM6": KindFixed,
		"DPHA1": KindFixed,
		// The four that genuinely float out on the water.
		"42012":  KindBuoy,
		"42067":  KindBuoy,
		"42354":  KindBuoy,
		"42357":  KindBuoy,
		"RIG001": KindRig,
		// Both DART spellings contain "buoy" and must not be classified as
		// one — this is why the checks are ordered.
		"DART01": KindDart,
		"TSU001": KindDart,
		// Not classifiable from the text, but still real stations: they get
		// a glyph rather than disappearing.
		"USV001": KindOther,
		"FERRY1": KindOther,
		"BLANK1": KindOther,
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d rows, want %d: %v", len(got), len(want), got)
	}
	for id, kind := range want {
		if got[id] != kind {
			t.Errorf("%s: kind %q, want %q", id, got[id], kind)
		}
	}
}

// The table lists ids in lower case; realtime2 files are served under upper
// case. A row whose id is not normalized would request the wrong URL.
func TestParseStationTableUppercasesIDs(t *testing.T) {
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
	found := false
	for _, r := range rows {
		if r.ID == "WYCM6" {
			found = true
		}
		if r.ID != strings.ToUpper(r.ID) {
			t.Errorf("id %q is not upper case", r.ID)
		}
	}
	if !found {
		t.Fatalf("wycm6 did not normalize to WYCM6: %+v", rows)
	}
}

func TestDecodeBuoysDefaultsMissingKind(t *testing.T) {
	// A buoys.json written before the kind field existed. It must decode to
	// KindOther, never to the empty string, or the viewer has no glyph rule
	// to apply to a snapshot that predates this field.
	const legacy = `{
	  "validTime": "2026-08-26T00:40:00Z",
	  "source": {"name": "NDBC"},
	  "stations": [
	    {"id": "WYCM6", "lon": -89.081, "lat": 30.360, "obsTime": "2026-08-26T00:18:00Z"},
	    {"id": "BOGUS", "lon": -89.1, "lat": 30.1, "kind": "spaceship"}
	  ]
	}`
	b, err := DecodeBuoys(strings.NewReader(legacy))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range b.Stations {
		if s.Kind != KindOther {
			t.Errorf("%s: kind %q, want %q", s.ID, s.Kind, KindOther)
		}
	}
}
