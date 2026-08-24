package shelf

import "math"

func ringClosed(ring [][]float64) [][]float64 {
	n := len(ring)
	if n >= 2 && ring[0][0] == ring[n-1][0] && ring[0][1] == ring[n-1][1] {
		return ring[:n-1]
	}
	return ring
}

func ringContains(ring [][]float64, lon, lat float64) bool {
	pts := ringClosed(ring)
	n := len(pts)
	if n < 3 {
		return false
	}
	inside := false
	j := n - 1
	for i := 0; i < n; i++ {
		xi, yi := pts[i][0], pts[i][1]
		xj, yj := pts[j][0], pts[j][1]
		if (yi > lat) != (yj > lat) {
			xint := (xj-xi)*(lat-yi)/(yj-yi) + xi
			if lon < xint {
				inside = !inside
			}
		}
		j = i
	}
	return inside
}

// distToPolylineMetres is the linear reference that segIndex is checked
// against. Sample itself always goes through the index.
func distToPolylineMetres(line [][]float64, lon, lat float64) float64 {
	if len(line) < 2 {
		return math.Inf(1)
	}
	x, y := project(lon, lat)
	min := math.Inf(1)
	for i := 1; i < len(line); i++ {
		x1, y1 := project(line[i-1][0], line[i-1][1])
		x2, y2 := project(line[i][0], line[i][1])
		if d := (segment{x1, y1, x2, y2}).distTo(x, y); d < min {
			min = d
		}
	}
	return min
}
