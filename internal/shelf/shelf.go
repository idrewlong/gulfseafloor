// Package shelf is a Mississippi Sound stand-in.
// Island and bay planforms are simplified OpenStreetMap outlines (ODbL).
// Depths are metres, negative down, and are procedural — not NOAA data.
package shelf

import (
	"math"
	"sync"

	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

const padDeg = 0.04

var (
	gulfportChannel = [][]float64{
		{-89.086, 30.365},
		{-89.075, 30.28},
		{-89.04, 30.22},
	}
	pascagoulaChannel = [][]float64{
		{-88.556, 30.345},
		{-88.545, 30.26},
		{-88.52, 30.20},
	}
	mobileChannel = [][]float64{
		{-88.04, 30.40},
		{-88.03, 30.28},
		{-88.02, 30.22},
	}

	// River courses that drain the coastal plain, mouth first. Approximate
	// centrelines — enough to break up the plain, not a hydrography product.
	rivers = [][][]float64{
		{ // Pearl, along the Louisiana line
			{-89.545, 30.205}, {-89.575, 30.255}, {-89.610, 30.310},
			{-89.645, 30.380}, {-89.675, 30.450}, {-89.700, 30.560},
		},
		{ // Jourdan, into Bay St. Louis
			{-89.345, 30.375}, {-89.375, 30.425}, {-89.400, 30.480}, {-89.415, 30.560},
		},
		{ // Wolf, into Bay St. Louis
			{-89.310, 30.375}, {-89.295, 30.430}, {-89.275, 30.480}, {-89.265, 30.560},
		},
		{ // Biloxi, into Back Bay
			{-88.945, 30.420}, {-88.975, 30.455}, {-88.995, 30.495}, {-89.005, 30.560},
		},
		{ // Tchoutacabouffa, into Back Bay
			{-88.850, 30.425}, {-88.825, 30.460}, {-88.800, 30.495}, {-88.785, 30.560},
		},
		{ // Pascagoula
			{-88.560, 30.350}, {-88.565, 30.410}, {-88.575, 30.465}, {-88.580, 30.560},
		},
		{ // Escatawpa, joining the Pascagoula
			{-88.565, 30.425}, {-88.530, 30.460}, {-88.500, 30.495}, {-88.480, 30.560},
		},
		{ // Mobile River, into the head of Mobile Bay
			{-88.020, 30.480}, {-88.015, 30.500}, {-88.010, 30.560},
		},
	}
)

// fields is the outline geometry in the form Sample queries it: rings for
// inside/outside tests, segment indexes for shore distance. Built once.
type fields struct {
	mainland    *ringIndex
	islands     []*ringIndex
	bays        []*ringIndex
	coast       *segIndex
	islandShore *segIndex
	channels    *segIndex
	rivers      *segIndex
}

var (
	fieldsOnce sync.Once
	fieldsData *fields
)

func indexed() *fields {
	fieldsOnce.Do(func() {
		o := data()
		isl := islandRings()

		f := &fields{
			mainland:    newRingIndex(o.Mainland),
			islands:     make([]*ringIndex, 0, len(isl)),
			bays:        make([]*ringIndex, 0, len(o.Bays)),
			coast:       newSegIndex([][][]float64{o.Coast}),
			channels:    newSegIndex([][][]float64{gulfportChannel, pascagoulaChannel, mobileChannel}),
			rivers:      newSegIndex(rivers),
			islandShore: newSegIndex(islandShoreLines(isl)),
		}
		for _, ring := range isl {
			f.islands = append(f.islands, newRingIndex(ring))
		}
		for _, bay := range o.Bays {
			f.bays = append(f.bays, newRingIndex(bay))
		}
		fieldsData = f
	})
	return fieldsData
}

func islandShoreLines(rings [][][]float64) [][][]float64 {
	out := make([][][]float64, 0, len(rings))
	for _, r := range rings {
		if line := ringSegments(r); line != nil {
			out = append(out, line)
		}
	}
	return out
}

// hash2 is a deterministic 32-bit integer hash used as the lattice for the
// value noise below.
func hash2(x, y int) float64 {
	h := uint32(x)*0x1657_5F0D ^ uint32(y)*0x2779_2F2D
	h ^= h >> 15
	h *= 0x85EB_CA6B
	h ^= h >> 13
	h *= 0xC2B2_AE35
	h ^= h >> 16
	return float64(h) / float64(^uint32(0))
}

// valueNoise is smooth 2D noise in [0,1] on a unit lattice.
func valueNoise(x, y float64) float64 {
	xi, yi := math.Floor(x), math.Floor(y)
	fx, fy := x-xi, y-yi
	ux := fx * fx * fx * (fx*(fx*6-15) + 10)
	uy := fy * fy * fy * (fy*(fy*6-15) + 10)
	ix, iy := int(xi), int(yi)

	a := hash2(ix, iy)
	b := hash2(ix+1, iy)
	c := hash2(ix, iy+1)
	d := hash2(ix+1, iy+1)
	top := a + (b-a)*ux
	bot := c + (d-c)*ux
	return top + (bot-top)*uy
}

// fbm sums octaves of valueNoise into [0,1]. Trigonometric terrain detail
// tiles into a visible diamond grid at map scale; noise does not.
func fbm(x, y float64, octaves int) float64 {
	sum, amp, norm := 0.0, 1.0, 0.0
	for i := 0; i < octaves; i++ {
		sum += amp * valueNoise(x, y)
		norm += amp
		amp *= 0.5
		x, y = x*2.03+11.7, y*2.01-5.3
	}
	return sum / norm
}

// Sample returns elevation in metres at a WGS84 point.
func Sample(lon, lat float64) float64 {
	if lon < tiles.AOI.West-padDeg || lon > tiles.AOI.East+padDeg ||
		lat < tiles.AOI.South-padDeg || lat > tiles.AOI.North+padDeg {
		return terrain.MinMetres
	}

	f := indexed()
	ripples := 0.28 * (2*fbm(lon*95, lat*112, 3) - 1)

	for _, isl := range f.islands {
		if isl.contains(lon, lat) {
			inland := f.islandShore.nearest(lon, lat)
			// These islands are a few hundred metres wide, so the ridge has to
			// rise inside ~100 m or the interior stays a wet berm.
			h := 1.2 + 3.6*smoothstep(0, 140, inland)
			if h > 6.4 {
				h = 6.4
			}
			return h + ripples*0.15
		}
	}

	inBay := false
	for _, bay := range f.bays {
		if bay.contains(lon, lat) {
			inBay = true
			break
		}
	}

	// The waterline is the real OSM coastline, so the bays, bayous and river
	// mouths are already cut out of the mainland ring. Lakes that OSM does not
	// treat as coastline (Pontchartrain, Perdido) are punched through here.
	if !inBay && f.mainland.contains(lon, lat) {
		// Distance runs against the waterline alone. Measuring to the ring
		// would also measure to the synthetic edges that close it, which made
		// the plain fall back to sea level at the top of the map.
		inland := f.coast.nearest(lon, lat)
		h := mainlandHeight(lon, lat, inland)
		// Valleys lower the plain but never breach it: the tidal reach that is
		// genuinely water is already outside the ring.
		valley := 1 - smoothstep(60, 900, f.rivers.nearest(lon, lat))
		h -= 0.62 * h * valley
		if h < 0.3 {
			h = 0.3
		}
		if h > 12 {
			h = 12
		}
		return h + ripples*0.2
	}

	// Water: Sound, bays, Pontchartrain, Borgne, and the Gulf.
	coastDist := f.coast.nearest(lon, lat)
	islandDist := f.islandShore.nearest(lon, lat)
	shore := math.Min(coastDist, islandDist)

	sound := -2.6 - 2.4*smoothstep(0, 9_000, shore)
	lagoon := -1.6 - 1.6*smoothstep(0, 3_000, shore)
	lw := lagoonWeight(lon, lat)
	if inBay {
		lw = 1
	}
	depth := sound*(1-lw) + lagoon*lw

	// Open shelf south of the barrier chain, and the Alabama gulf east of
	// Dauphin. NDBC 42354 is 20 m — this shelf is wide and shallow.
	inner := -8.0 - 9*smoothstep(0, 22_000, shore)
	outerT := 1 - smoothstep(29.50, 30.08, lat)
	along := 1.8 * (2*fbm(lon*14, lat*17, 3) - 1) * outerT
	shelf := inner - 4*outerT + along
	sw := shelfWeight(lon, lat) * (1 - lw)
	depth = depth*(1-sw) + shelf*sw

	// Surf zone only. A 1.4 km / +2.2 m shoal pinned the Sound to the −0.4 m
	// clamp and painted the Mississippi beaches as a sand plate.
	depth += 1.0 * (1 - smoothstep(40, 500, coastDist))

	// Sand platform carrying the barrier chain, so each island sits on a shoal
	// instead of rising straight out of open water. Blended rather than added,
	// so it cannot pile onto the beach term and flatten against the clamp.
	if t := smoothstep(150, 1_800, islandDist); t < 1 {
		depth = depth*t + (-0.55-5.0*t)*(1-t)
	}

	depth -= 9 * (1 - smoothstep(0, 420, f.channels.nearest(lon, lat)))

	depth += ripples
	if depth > -0.4 {
		depth = -0.4
	}
	if depth < -40 {
		depth = -40
	}
	return depth
}

// mainlandHeight is metres above the waterline. The MS/AL pine coast rises
// off the berm; the Pontchartrain bowl stays low. The two are mixed across
// the Pearl so the chart does not grow a vertical colour seam.
func mainlandHeight(lon, lat, inland float64) float64 {
	delta := 0.5 + 1.6*smoothstep(0, 2_200, inland)
	delta += 0.35 * (2*fbm(lon*23, lat*27, 4) - 1) * smoothstep(200, 2_000, inland)
	if delta < 0.3 {
		delta = 0.3
	}
	if delta > 2.6 {
		delta = 2.6
	}
	pine := 1.4 + 4.2*smoothstep(0, 400, inland) + 5.0*smoothstep(400, 9_000, inland)
	pine += 1.6 * (2*fbm(lon*23, lat*27, 4) - 1) * smoothstep(600, 5_000, inland)
	if pine < 0.6 {
		pine = 0.6
	}
	w := smoothstep(-89.70, -89.36, lon)
	return delta*(1-w) + pine*w
}

// lagoonWeight is 1 over Borgne / Breton / Chandeleur and 0 in the Sound
// and the open bight south of Cat and Ship. Edges fade so they do not
// render as a rectangular tile of the wrong depth.
func lagoonWeight(lon, lat float64) float64 {
	e := 1 - smoothstep(-88.95, -88.72, lon)
	n := 1 - smoothstep(30.02, 30.16, lat)
	s := smoothstep(29.68, 29.82, lat)
	bx := smoothstep(-89.32, -89.12, lon) * (1 - smoothstep(-88.95, -88.78, lon))
	by := smoothstep(29.98, 30.06, lat) * (1 - smoothstep(30.12, 30.18, lat))
	w := e * n * s * (1 - 0.92*bx*by)
	if w < 0 {
		w = 0
	}
	if w > 1 {
		w = 1
	}
	return w
}

// shelfWeight is 1 on the open gulf south of the islands and on the Alabama
// gulf east of Dauphin. It fades across ~10 km so the Sound does not end on
// a latitude line.
func shelfWeight(lon, lat float64) float64 {
	south := 1 - smoothstep(30.12, 30.22, lat)
	alabama := smoothstep(-88.20, -87.92, lon) * (1 - smoothstep(30.30, 30.40, lat))
	if alabama > south {
		return alabama
	}
	return south
}

func smoothstep(edge0, edge1, x float64) float64 {
	t := (x - edge0) / (edge1 - edge0)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	return t * t * (3 - 2*t)
}
