package shelf

import "math"

// The outlines carry ~9k coastline vertices, and the tiler samples every pixel
// of every tile in the pyramid. Linear scans over the rings are far too slow at
// that scale, so both queries the sampler needs — "is this point inside a ring"
// and "how far is the nearest shore" — go through an index.

const (
	mPerDegLat = 111_320.0
	// Reference latitude for the local equirectangular projection. The AOI is
	// 0.6° tall, so a single scale factor is well inside the error already
	// accepted by a synthetic heightfield.
	projRefLat = 30.28
)

var mPerDegLon = mPerDegLat * math.Cos(projRefLat*math.Pi/180)

func project(lon, lat float64) (x, y float64) {
	return lon * mPerDegLon, lat * mPerDegLat
}

// ringIndex answers even-odd point-in-polygon in time proportional to the
// number of edges crossing the query latitude rather than the whole ring.
type ringIndex struct {
	edges  []ringEdge
	bands  [][]int32
	minLat float64
	bandH  float64
}

type ringEdge struct {
	x1, y1, x2, y2 float64
}

func newRingIndex(ring [][]float64) *ringIndex {
	pts := ringClosed(ring)
	if len(pts) < 3 {
		return &ringIndex{}
	}

	minLat, maxLat := math.Inf(1), math.Inf(-1)
	edges := make([]ringEdge, 0, len(pts))
	j := len(pts) - 1
	for i := 0; i < len(pts); i++ {
		x1, y1 := pts[j][0], pts[j][1]
		x2, y2 := pts[i][0], pts[i][1]
		j = i
		if y1 == y2 {
			// Horizontal edges never cross a horizontal ray.
			continue
		}
		edges = append(edges, ringEdge{x1, y1, x2, y2})
		minLat = math.Min(minLat, math.Min(y1, y2))
		maxLat = math.Max(maxLat, math.Max(y1, y2))
	}
	if len(edges) == 0 {
		return &ringIndex{}
	}

	nb := len(edges) / 2
	if nb < 1 {
		nb = 1
	}
	if nb > 8192 {
		nb = 8192
	}
	span := maxLat - minLat
	if span <= 0 {
		span = 1e-9
	}
	idx := &ringIndex{
		edges:  edges,
		bands:  make([][]int32, nb),
		minLat: minLat,
		bandH:  span / float64(nb),
	}
	for i, e := range edges {
		lo, hi := idx.band(math.Min(e.y1, e.y2)), idx.band(math.Max(e.y1, e.y2))
		for b := lo; b <= hi; b++ {
			idx.bands[b] = append(idx.bands[b], int32(i))
		}
	}
	return idx
}

func (r *ringIndex) band(lat float64) int {
	b := int((lat - r.minLat) / r.bandH)
	if b < 0 {
		return 0
	}
	if b >= len(r.bands) {
		return len(r.bands) - 1
	}
	return b
}

// contains reports whether the point is inside the ring, counting crossings of
// the ray running east from the point.
func (r *ringIndex) contains(lon, lat float64) bool {
	if len(r.bands) == 0 || lat < r.minLat || lat > r.minLat+r.bandH*float64(len(r.bands)) {
		return false
	}
	inside := false
	for _, ei := range r.bands[r.band(lat)] {
		e := r.edges[ei]
		if (e.y1 > lat) != (e.y2 > lat) {
			xInt := (e.x2-e.x1)*(lat-e.y1)/(e.y2-e.y1) + e.x1
			if lon < xInt {
				inside = !inside
			}
		}
	}
	return inside
}

// segIndex answers "metres to the nearest segment" over a bucketed grid.
type segIndex struct {
	segs       []segment
	buckets    [][]int32
	minX, minY float64
	cell       float64
	nx, ny     int
}

type segment struct {
	x1, y1, x2, y2 float64
}

func (s segment) distTo(x, y float64) float64 {
	dx, dy := s.x2-s.x1, s.y2-s.y1
	if dx == 0 && dy == 0 {
		return math.Hypot(x-s.x1, y-s.y1)
	}
	t := ((x-s.x1)*dx + (y-s.y1)*dy) / (dx*dx + dy*dy)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	return math.Hypot(x-(s.x1+t*dx), y-(s.y1+t*dy))
}

// newSegIndex indexes open polylines. Pass rings through ringSegments first.
func newSegIndex(lines [][][]float64) *segIndex {
	var segs []segment
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, line := range lines {
		for i := 1; i < len(line); i++ {
			x1, y1 := project(line[i-1][0], line[i-1][1])
			x2, y2 := project(line[i][0], line[i][1])
			segs = append(segs, segment{x1, y1, x2, y2})
			minX = math.Min(minX, math.Min(x1, x2))
			minY = math.Min(minY, math.Min(y1, y2))
			maxX = math.Max(maxX, math.Max(x1, x2))
			maxY = math.Max(maxY, math.Max(y1, y2))
		}
	}
	if len(segs) == 0 {
		return &segIndex{}
	}

	// Aim for roughly one segment per bucket.
	w, h := math.Max(maxX-minX, 1), math.Max(maxY-minY, 1)
	cell := math.Sqrt(w * h / float64(len(segs)))
	if cell < 1 {
		cell = 1
	}
	nx := int(w/cell) + 1
	ny := int(h/cell) + 1

	idx := &segIndex{
		segs:    segs,
		buckets: make([][]int32, nx*ny),
		minX:    minX,
		minY:    minY,
		cell:    cell,
		nx:      nx,
		ny:      ny,
	}
	for i, s := range segs {
		x0 := idx.col(math.Min(s.x1, s.x2))
		x1 := idx.col(math.Max(s.x1, s.x2))
		y0 := idx.row(math.Min(s.y1, s.y2))
		y1 := idx.row(math.Max(s.y1, s.y2))
		for gy := y0; gy <= y1; gy++ {
			for gx := x0; gx <= x1; gx++ {
				idx.buckets[gy*nx+gx] = append(idx.buckets[gy*nx+gx], int32(i))
			}
		}
	}
	return idx
}

// ringSegments closes a ring so its final edge is indexed too.
func ringSegments(ring [][]float64) [][]float64 {
	pts := ringClosed(ring)
	if len(pts) < 2 {
		return nil
	}
	out := make([][]float64, 0, len(pts)+1)
	out = append(out, pts...)
	out = append(out, pts[0])
	return out
}

func (s *segIndex) col(x float64) int {
	c := int((x - s.minX) / s.cell)
	if c < 0 {
		return 0
	}
	if c >= s.nx {
		return s.nx - 1
	}
	return c
}

func (s *segIndex) row(y float64) int {
	r := int((y - s.minY) / s.cell)
	if r < 0 {
		return 0
	}
	if r >= s.ny {
		return s.ny - 1
	}
	return r
}

// nearest returns metres to the closest indexed segment. Rings of buckets are
// scanned outward from the query cell and the search stops as soon as the next
// ring cannot beat what has already been found.
func (s *segIndex) nearest(lon, lat float64) float64 {
	if len(s.segs) == 0 {
		return math.Inf(1)
	}
	x, y := project(lon, lat)
	cx := int(math.Floor((x - s.minX) / s.cell))
	cy := int(math.Floor((y - s.minY) / s.cell))

	maxR := max(abs(cx), abs(cx-(s.nx-1)))
	if r := max(abs(cy), abs(cy-(s.ny-1))); r > maxR {
		maxR = r
	}

	best := math.Inf(1)
	for r := 0; r <= maxR; r++ {
		// Every bucket in ring r+1 lies at least r cells away, so once that
		// bound exceeds the best hit no further ring can improve it.
		if !math.IsInf(best, 1) && float64(r-1)*s.cell > best {
			break
		}
		for gy := cy - r; gy <= cy+r; gy++ {
			if gy < 0 || gy >= s.ny {
				continue
			}
			for gx := cx - r; gx <= cx+r; gx++ {
				// Only the perimeter of the ring is new.
				if r > 0 && gx != cx-r && gx != cx+r && gy != cy-r && gy != cy+r {
					continue
				}
				if gx < 0 || gx >= s.nx {
					continue
				}
				for _, si := range s.buckets[gy*s.nx+gx] {
					if d := s.segs[si].distTo(x, y); d < best {
						best = d
					}
				}
			}
		}
	}
	return best
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
