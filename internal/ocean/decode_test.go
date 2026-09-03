package ocean

import (
	"strings"
	"testing"
	"time"
)

// validCurrentsJSON is the flat, single-step shape already on disk today.
const validCurrentsJSON = `{
  "validTime": "2026-08-24T18:00:00Z",
  "source": {"name": "HYCOM", "dataset": "test", "url": "https://example.invalid/ncss"},
  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
  "nx": 2, "ny": 1, "grid": "centers",
  "u": [0.12, null],
  "v": [-0.04, null]
}`

func TestDecodeCurrentsAcceptsCentersGrid(t *testing.T) {
	raw := `{
	  "validTime": "2026-08-24T18:00:00Z",
	  "source": {"name": "HYCOM", "dataset": "test", "url": "https://example.invalid/ncss"},
	  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
	  "nx": 2, "ny": 1, "grid": "centers",
	  "u": [0.12, null],
	  "v": [-0.04, null]
	}`
	c, err := DecodeCurrents(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if c.NX != 2 || c.NY != 1 || c.Grid != "centers" {
		t.Fatalf("got nx=%d ny=%d grid=%q", c.NX, c.NY, c.Grid)
	}
	// U/V are decode-only; DecodeCurrents lifts them into Steps and nils them.
	if c.U != nil || c.V != nil {
		t.Fatalf("legacy u/v must be nilled after decode: u=%#v v=%#v", c.U, c.V)
	}
	if got := c.Steps[0].U; got[0] == nil || *got[0] != 0.12 || got[1] != nil {
		t.Fatalf("u cells: %#v", got)
	}
	if !c.ValidTime.Equal(time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)) {
		t.Fatalf("validTime %s", c.ValidTime)
	}
}

func TestDecodeCurrentsRejectsBadGridAndLength(t *testing.T) {
	if _, err := DecodeCurrents(strings.NewReader(`{
	  "validTime":"2026-08-24T18:00:00Z","source":{"name":"HYCOM","url":"x"},
	  "bbox":{"west":-89,"south":29,"east":-88,"north":30},
	  "nx":2,"ny":1,"grid":"edges","u":[0,0],"v":[0,0]
	}`)); err == nil {
		t.Fatal("edges must be rejected")
	}
	if _, err := DecodeCurrents(strings.NewReader(`{
	  "validTime":"2026-08-24T18:00:00Z","source":{"name":"HYCOM","url":"x"},
	  "bbox":{"west":-89,"south":29,"east":-88,"north":30},
	  "nx":2,"ny":1,"grid":"centers","u":[0],"v":[0,0]
	}`)); err == nil {
		t.Fatal("len(u) != nx*ny must be rejected")
	}
}

func TestDecodeBuoysOmitsMissingFields(t *testing.T) {
	raw := `{
	  "validTime": "2026-08-24T19:50:00Z",
	  "source": {"name": "NDBC", "url": "https://www.ndbc.noaa.gov/"},
	  "stations": [{"id": "WYCM6", "lon": -89.081, "lat": 30.36, "wdir": 180, "wspd": 6.2}]
	}`
	b, err := DecodeBuoys(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Stations) != 1 || b.Stations[0].ID != "WYCM6" {
		t.Fatalf("%+v", b.Stations)
	}
	if b.Stations[0].WVHT != nil || b.Stations[0].WSpd == nil || *b.Stations[0].WSpd != 6.2 {
		t.Fatalf("optional fields: %+v", b.Stations[0])
	}
}

func TestDecodeTimesRequireUTC(t *testing.T) {
	want := time.Date(2026, 8, 24, 18, 0, 0, 0, time.UTC)
	plusZero := `{
	  "validTime": "2026-08-24T18:00:00+00:00",
	  "source": {"name": "HYCOM", "dataset": "test", "url": "https://example.invalid/ncss"},
	  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
	  "nx": 2, "ny": 1, "grid": "centers",
	  "u": [0.12, null],
	  "v": [-0.04, null]
	}`
	c, err := DecodeCurrents(strings.NewReader(plusZero))
	if err != nil {
		t.Fatal(err)
	}
	if !c.ValidTime.Equal(want) {
		t.Fatalf("validTime %s", c.ValidTime)
	}

	offset := `{
	  "validTime": "2026-08-24T18:00:00-05:00",
	  "source": {"name": "HYCOM", "dataset": "test", "url": "https://example.invalid/ncss"},
	  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
	  "nx": 2, "ny": 1, "grid": "centers",
	  "u": [0.12, null],
	  "v": [-0.04, null]
	}`
	if _, err := DecodeCurrents(strings.NewReader(offset)); err == nil {
		t.Fatal("currents validTime -05:00 must be rejected")
	}
	if _, err := DecodeBuoys(strings.NewReader(`{
	  "validTime": "2026-08-24T19:50:00-05:00",
	  "source": {"name": "NDBC", "url": "https://www.ndbc.noaa.gov/"},
	  "stations": []
	}`)); err == nil {
		t.Fatal("buoys validTime -05:00 must be rejected")
	}
	if _, err := DecodeBuoys(strings.NewReader(`{
	  "validTime": "2026-08-24T19:50:00Z",
	  "source": {"name": "NDBC", "url": "https://www.ndbc.noaa.gov/"},
	  "stations": [{"id": "WYCM6", "lon": -89.081, "lat": 30.36, "obsTime": "2026-08-24T19:50:00-05:00"}]
	}`)); err == nil {
		t.Fatal("station obsTime -05:00 must be rejected")
	}
	if _, err := DecodeManifest(strings.NewReader(`{
	  "retrievedAt": "2026-08-24T20:01:00-05:00",
	  "currents": {"present": false},
	  "buoys": {"present": false}
	}`)); err == nil {
		t.Fatal("manifest retrievedAt -05:00 must be rejected")
	}
	if _, err := DecodeManifest(strings.NewReader(`{
	  "retrievedAt": "2026-08-24T20:01:00Z",
	  "currents": {"present": true, "validTime": "2026-08-24T18:00:00-05:00"},
	  "buoys": {"present": false}
	}`)); err == nil {
		t.Fatal("layer validTime -05:00 must be rejected")
	}
}

const twoStepCurrentsJSON = `{
  "validTime": "2026-09-03T12:00:00Z",
  "source": {"name": "HYCOM", "dataset": "GLBy0.08/latest", "url": "https://example.invalid/ncss"},
  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
  "nx": 2, "ny": 1, "grid": "centers",
  "steps": [
    {"validTime": "2026-09-03T12:00:00Z", "u": [0.12, null], "v": [-0.04, null]},
    {"validTime": "2026-09-03T15:00:00Z", "u": [0.20, null], "v": [-0.08, null]}
  ]
}`

func TestDecodeCurrentsMultiStep(t *testing.T) {
	c, err := DecodeCurrents(strings.NewReader(twoStepCurrentsJSON))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(c.Steps) != 2 {
		t.Fatalf("steps = %d, want 2", len(c.Steps))
	}
	if !c.Steps[1].ValidTime.Equal(time.Date(2026, 9, 3, 15, 0, 0, 0, time.UTC)) {
		t.Errorf("step 1 validTime = %v", c.Steps[1].ValidTime)
	}
	if c.Steps[0].U[1] != nil {
		t.Error("null cell must stay nil")
	}
	if !c.ValidTime.Equal(c.Steps[0].ValidTime) {
		t.Error("validTime must equal the first step")
	}
}

// The snapshot already on disk is the flat shape. It must keep working.
func TestDecodeCurrentsLegacyLiftsToOneStep(t *testing.T) {
	c, err := DecodeCurrents(strings.NewReader(validCurrentsJSON))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(c.Steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(c.Steps))
	}
	if !c.Steps[0].ValidTime.Equal(c.ValidTime) {
		t.Error("lifted step must carry the top-level validTime")
	}
	if got := *c.Steps[0].U[0]; got != 0.12 {
		t.Errorf("u[0] = %v, want 0.12", got)
	}
}

func TestDecodeCurrentsRejectsBadSteps(t *testing.T) {
	cases := map[string]string{
		"step length mismatch":   `"steps": [{"validTime": "2026-09-03T12:00:00Z", "u": [0.1], "v": [0.1, 0.1]}]`,
		"non-monotonic times":    `"steps": [{"validTime": "2026-09-03T15:00:00Z", "u": [0.1, 0.1], "v": [0.1, 0.1]}, {"validTime": "2026-09-03T12:00:00Z", "u": [0.1, 0.1], "v": [0.1, 0.1]}]`,
		"empty steps":            `"steps": []`,
		"step missing validTime": `"steps": [{"u": [0.1, 0.1], "v": [0.1, 0.1]}]`,
	}
	for name, steps := range cases {
		t.Run(name, func(t *testing.T) {
			body := `{
  "validTime": "2026-09-03T12:00:00Z",
  "source": {"name": "HYCOM"},
  "bbox": {"west": -89.7, "south": 29.95, "east": -87.85, "north": 30.52},
  "nx": 2, "ny": 1, "grid": "centers",` + steps + `}`
			if _, err := DecodeCurrents(strings.NewReader(body)); err == nil {
				t.Fatal("want error, got nil")
			}
		})
	}
}

func TestDecodeManifestAcceptsAbsentLayers(t *testing.T) {
	raw := `{
	  "retrievedAt": "2026-08-24T20:01:00Z",
	  "currents": {"present": false},
	  "buoys": {"present": false}
	}`
	m, err := DecodeManifest(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !m.RetrievedAt.Equal(time.Date(2026, 8, 24, 20, 1, 0, 0, time.UTC)) {
		t.Fatalf("retrievedAt %s", m.RetrievedAt)
	}
	if m.Currents.Present || m.Buoys.Present {
		t.Fatalf("layers should be absent: %+v %+v", m.Currents, m.Buoys)
	}
}
