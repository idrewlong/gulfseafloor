package shelf

import (
	_ "embed"
	"encoding/json"
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

func islandRings() [][][]float64 {
	d := data()
	order := []string{"cat", "westShip", "eastShip", "horn", "petitBois", "dauphin", "deer", "round"}
	out := make([][][]float64, 0, len(order))
	for _, name := range order {
		if r := d.Islands[name]; len(r) >= 4 {
			out = append(out, r)
		}
	}
	return out
}
