package shelf

import (
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"sync"
)

// The AOI clip of the GEBCO global grid, written by scripts/fetch-gebco.py.
// GEBCO is public domain and requires attribution; see docs/data-sources.md.
// Ice-surface elevation in metres above MSL, negative down.
//
//go:embed gebco.bin
var gebcoBin []byte

//go:embed gebco.json
var gebcoMeta []byte

type gebcoGrid struct {
	Grid  string  `json:"grid"`
	West  float64 `json:"west"`
	South float64 `json:"south"`
	Res   float64 `json:"res"`
	Cols  int     `json:"cols"`
	Rows  int     `json:"rows"`

	cells []int16
}

var (
	gebcoOnce sync.Once
	gebcoData *gebcoGrid
)

func gebco() *gebcoGrid {
	gebcoOnce.Do(func() {
		g := &gebcoGrid{}
		if err := json.Unmarshal(gebcoMeta, g); err != nil {
			panic("shelf: gebco.json is unreadable: " + err.Error())
		}
		want := g.Cols * g.Rows * 2
		if len(gebcoBin) != want {
			panic("shelf: gebco.bin does not match gebco.json dimensions")
		}
		g.cells = make([]int16, g.Cols*g.Rows)
		for i := range g.cells {
			g.cells[i] = int16(binary.LittleEndian.Uint16(gebcoBin[i*2:]))
		}
		gebcoData = g
	})
	return gebcoData
}

// gebcoAt returns bilinearly interpolated GEBCO elevation in metres at a WGS84
// point, and whether the point falls inside the clip. The grid is
// pixel-centre-registered, so cell (0,0) is centred on (West, South).
func gebcoAt(lon, lat float64) (float64, bool) {
	g := gebco()

	x := (lon - g.West) / g.Res
	y := (lat - g.South) / g.Res
	if x < 0 || y < 0 || x > float64(g.Cols-1) || y > float64(g.Rows-1) {
		return 0, false
	}

	x0, y0 := int(x), int(y)
	if x0 > g.Cols-2 {
		x0 = g.Cols - 2
	}
	if y0 > g.Rows-2 {
		y0 = g.Rows - 2
	}
	fx, fy := x-float64(x0), y-float64(y0)

	at := func(col, row int) float64 { return float64(g.cells[row*g.Cols+col]) }
	bottom := at(x0, y0) + (at(x0+1, y0)-at(x0, y0))*fx
	top := at(x0, y0+1) + (at(x0+1, y0+1)-at(x0, y0+1))*fx
	return bottom + (top-bottom)*fy, true
}
