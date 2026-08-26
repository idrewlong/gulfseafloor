package aircraft

import (
	"fmt"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func TestParseOpenSkyKeepsInBoxDropsNullPosition(t *testing.T) {
	raw := []byte(`{
	  "time": 1,
	  "states": [
	    ["abc123","DAL123  ","United States",1,1,-89.08,30.41,3200,false,120.0,270.0,0,null,3200,null,false,0],
	    ["dead00","NONE    ","United States",1,1,null,null,null,false,null,null,null,null,null,null,false,0],
	    ["outbox","XYZ000  ","United States",1,1,-80.0,40.0,1000,false,50.0,90.0,0,null,1000,null,false,0]
	  ]
	}`)
	got, err := ParseOpenSky(raw, time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC), tiles.AOI)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceOpenSky || len(got.Aircraft) != 1 {
		t.Fatalf("source=%s n=%d", got.Source, len(got.Aircraft))
	}
	a := got.Aircraft[0]
	if a.ICAO24 != "abc123" || a.Callsign != "DAL123" || a.Lon != -89.08 || a.Lat != 30.41 {
		t.Fatalf("%+v", a)
	}
	if a.AltBaroM == nil || *a.AltBaroM != 3200 || a.GsMps == nil || *a.GsMps != 120 || a.TrackDeg == nil || *a.TrackDeg != 270 {
		t.Fatalf("kinematics %+v", a)
	}
	if a.OnGround == nil || *a.OnGround {
		t.Fatalf("onGround %+v", a.OnGround)
	}
}

func TestParseAdsbLolConvertsUnits(t *testing.T) {
	raw := []byte(`{"ac":[{"hex":"a1b2c3","flight":"SWA45 ","lat":30.41,"lon":-89.08,"alt_baro":10000,"track":90,"gs":194.384,"ground":false}]}`)
	got, err := ParseAdsbLol(raw, time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC), tiles.AOI)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceAdsbLol || len(got.Aircraft) != 1 {
		t.Fatalf("%+v", got)
	}
	a := got.Aircraft[0]
	if a.Callsign != "SWA45" {
		t.Fatalf("callsign %q", a.Callsign)
	}
	if a.AltBaroM == nil || *a.AltBaroM != 3048 {
		t.Fatalf("alt %v", a.AltBaroM)
	}
	if a.GsMps == nil || *a.GsMps < 99.9 || *a.GsMps > 100.1 {
		t.Fatalf("gs %v want ~100", a.GsMps)
	}
}

func TestParseAdsbLolGroundAltOmitsAltitude(t *testing.T) {
	raw := []byte(`{"ac":[{"hex":"abc123","lat":30.41,"lon":-89.08,"alt_baro":"ground","ground":true}]}`)
	got, err := ParseAdsbLol(raw, time.Now().UTC(), tiles.AOI)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Aircraft) != 1 || got.Aircraft[0].AltBaroM != nil {
		t.Fatalf("%+v", got.Aircraft)
	}
	if got.Aircraft[0].OnGround == nil || !*got.Aircraft[0].OnGround {
		t.Fatal("ground flag")
	}
}

func TestClipAndCapSortsAndTruncates(t *testing.T) {
	rows := make([]Aircraft, 0, 202)
	for i := 200; i >= 0; i-- {
		rows = append(rows, Aircraft{ICAO24: fmt.Sprintf("%03d", i), Lon: -89, Lat: 30.2})
	}
	rows = append(rows, Aircraft{ICAO24: "zzzzzz", Lon: 0, Lat: 0})
	got := ClipAndCap(rows, tiles.AOI)
	if len(got) != MaxAircraft {
		t.Fatalf("len %d", len(got))
	}
	if got[0].ICAO24 != "000" || got[len(got)-1].ICAO24 != "199" {
		t.Fatalf("range %s..%s", got[0].ICAO24, got[len(got)-1].ICAO24)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].ICAO24 > got[i].ICAO24 {
			t.Fatalf("unsorted %s then %s", got[i-1].ICAO24, got[i].ICAO24)
		}
	}
}

func TestParseOpenSkyRejectsGarbage(t *testing.T) {
	if _, err := ParseOpenSky([]byte(`{"states": "nope"}`), time.Now().UTC(), tiles.AOI); err == nil {
		t.Fatal("expected error")
	}
}
