package shelf

import (
	_ "embed"
	"encoding/json"
	"sort"
	"sync"
)

//go:embed outlines.json
var outlinesJSON []byte

type outlineData struct {
	Attribution string                 `json:"attribution"`
	Coast       [][]float64            `json:"coast"`
	Mainland    [][]float64            `json:"mainland"`
	Bays        [][][]float64          `json:"bays"`
	Islands     map[string][][]float64 `json:"islands"`
	// Marsh holds the closed coastline rings — the Louisiana marsh islets that
	// carry no name. gen_outlines.py area-filters them; they are land, but low
	// and flat, so they get their own height model rather than the barrier
	// chain's ridge.
	Marsh [][][]float64 `json:"marsh"`
}

var (
	outlinesOnce sync.Once
	loaded       outlineData
)

func data() outlineData {
	outlinesOnce.Do(func() {
		if err := json.Unmarshal(outlinesJSON, &loaded); err != nil {
			panic("shelf outlines.json: " + err.Error())
		}
	})
	return loaded
}

// islandRings returns every named island in outlines.json.
//
// This used to walk a hardcoded list of the eight Sound barrier islands, so
// anything added to the generator was silently ignored on the Go side: Grand
// Isle and Point au Fer were written to outlines.json, drawn by the web
// overlay, and still sampled as open water by the tiler. Reading the map's own
// keys removes that failure mode. They are sorted so the ring order — and so
// the tiles — stay reproducible.
func islandRings() [][][]float64 {
	d := data()
	order := make([]string, 0, len(d.Islands))
	for name := range d.Islands {
		order = append(order, name)
	}
	sort.Strings(order)
	out := make([][][]float64, 0, len(order))
	for _, name := range order {
		if r := d.Islands[name]; len(r) >= 4 {
			out = append(out, r)
		}
	}
	return out
}
