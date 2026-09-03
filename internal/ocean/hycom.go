package ocean

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const hycomCSVLimit = 8 << 20 // 8 MiB

var hycomUnit = regexp.MustCompile(`(?i)\[unit=[^\]]*\]`)

type hycomCell struct {
	lon, lat float64
	u, v     *float64
}

// ParseHYCOMCSV reads a HYCOM NCSS CSV of surface water_u/water_v into a
// cell-center velocity grid. Unique longitudes are west to east, unique
// latitudes south to north; missing and NaN velocities become nil cells.
func ParseHYCOMCSV(r io.Reader, src Source) (Currents, error) {
	data, err := io.ReadAll(io.LimitReader(r, hycomCSVLimit))
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: %w", err)
	}
	filtered, err := dropHYCOMComments(data)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: %w", err)
	}
	cr := csv.NewReader(bytes.NewReader(filtered))
	cr.LazyQuotes = true
	recs, err := cr.ReadAll()
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: csv: %w", err)
	}
	if len(recs) == 0 {
		return Currents{}, fmt.Errorf("ocean: hycom: empty grid")
	}
	timeCol, latCol, lonCol, uCol, vCol, err := hycomColumns(recs[0])
	if err != nil {
		return Currents{}, err
	}
	rows := recs[1:]
	if len(rows) == 0 {
		return Currents{}, fmt.Errorf("ocean: hycom: empty grid")
	}

	need := timeCol
	for _, i := range []int{latCol, lonCol, uCol, vCol} {
		if i > need {
			need = i
		}
	}

	byTime := map[time.Time][]hycomCell{}
	var lons, lats []float64
	lonSeen := map[float64]struct{}{}
	latSeen := map[float64]struct{}{}
	var firstTime time.Time

	for i, rec := range rows {
		if len(rec) <= need {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: too few columns", i+2)
		}
		t, err := parseHYCOMTime(rec[timeCol])
		if err != nil {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: time: %w", i+2, err)
		}
		lat, err := strconv.ParseFloat(strings.TrimSpace(rec[latCol]), 64)
		if err != nil {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: lat: %w", i+2, err)
		}
		if !finite(lat) {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: lat: non-finite", i+2)
		}
		lon, err := strconv.ParseFloat(strings.TrimSpace(rec[lonCol]), 64)
		if err != nil {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: lon: %w", i+2, err)
		}
		if !finite(lon) {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: lon: non-finite", i+2)
		}
		lon = wrapLon180(lon)
		u, err := parseVelocity(rec[uCol])
		if err != nil {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: u: %w", i+2, err)
		}
		v, err := parseVelocity(rec[vCol])
		if err != nil {
			return Currents{}, fmt.Errorf("ocean: hycom: row %d: v: %w", i+2, err)
		}
		if firstTime.IsZero() {
			firstTime = t
		}
		// Axis discovery runs on the first time only, so the grid shape is
		// one time's worth of cells rather than the whole file's.
		if t.Equal(firstTime) {
			if _, ok := lonSeen[lon]; !ok {
				lonSeen[lon] = struct{}{}
				lons = append(lons, lon)
			}
			if _, ok := latSeen[lat]; !ok {
				latSeen[lat] = struct{}{}
				lats = append(lats, lat)
			}
		}
		byTime[t] = append(byTime[t], hycomCell{lon: lon, lat: lat, u: u, v: v})
	}

	if len(lons) == 0 || len(lats) == 0 {
		return Currents{}, fmt.Errorf("ocean: hycom: empty grid")
	}
	sort.Float64s(lons)
	sort.Float64s(lats)
	nx, ny := len(lons), len(lats)

	times := make([]time.Time, 0, len(byTime))
	for t := range byTime {
		times = append(times, t)
	}
	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })

	want := len(byTime[times[0]])
	steps := make([]Step, 0, len(times))
	for _, t := range times {
		cells := byTime[t]
		if len(cells) != want {
			return Currents{}, fmt.Errorf("ocean: hycom: time %s has %d cells, want %d", t.Format(time.RFC3339), len(cells), want)
		}
		u, v := stepFromCells(cells, lons, lats)
		steps = append(steps, Step{ValidTime: t, U: u, V: v})
	}

	return Currents{
		ValidTime: times[0],
		Source:    src,
		BBox:      BBox{West: lons[0], South: lats[0], East: lons[nx-1], North: lats[ny-1]},
		NX:        nx,
		NY:        ny,
		Grid:      "centers",
		Steps:     steps,
	}, nil
}

func wrapLon180(lon float64) float64 {
	for lon > 180 {
		lon -= 360
	}
	for lon < -180 {
		lon += 360
	}
	return lon
}

// stepFromCells lays cells out row-major, west-to-east, south-to-north.
// lons and lats must already be sorted ascending.
func stepFromCells(cells []hycomCell, lons, lats []float64) ([]*float64, []*float64) {
	nx, ny := len(lons), len(lats)
	lonIdx := make(map[float64]int, nx)
	latIdx := make(map[float64]int, ny)
	for i, lon := range lons {
		lonIdx[lon] = i
	}
	for j, lat := range lats {
		latIdx[lat] = j
	}
	u := make([]*float64, nx*ny)
	v := make([]*float64, nx*ny)
	for _, c := range cells {
		idx := latIdx[c.lat]*nx + lonIdx[c.lon]
		u[idx] = quantizePtr(c.u)
		v[idx] = quantizePtr(c.v)
	}
	return u, v
}

// quantizePtr rounds to 1 mm/s. Sub-millimetre precision on a 1/12-degree
// model is noise, and it roughly halves the serialized payload.
func quantizePtr(v *float64) *float64 {
	if v == nil {
		return nil
	}
	q := math.Round(*v*1000) / 1000
	return &q
}

func gridFromCells(cells []hycomCell, lons, lats []float64, validTime time.Time, src Source) (Currents, error) {
	sort.Float64s(lons)
	sort.Float64s(lats)
	nx, ny := len(lons), len(lats)
	u, v := stepFromCells(cells, lons, lats)
	return Currents{
		ValidTime: validTime,
		Source:    src,
		BBox: BBox{
			West:  lons[0],
			South: lats[0],
			East:  lons[nx-1],
			North: lats[ny-1],
		},
		NX:    nx,
		NY:    ny,
		Grid:  "centers",
		Steps: []Step{{ValidTime: validTime, U: u, V: v}},
	}, nil
}

// ParseHYCOM reads an NCSS CSV or classic NetCDF-3 subset.
func ParseHYCOM(r io.Reader, src Source) (Currents, error) {
	data, err := io.ReadAll(io.LimitReader(r, hycomCSVLimit))
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: %w", err)
	}
	if bytes.HasPrefix(data, []byte("CDF")) {
		return parseHYCOMNetCDF(data, src)
	}
	if len(data) >= 4 && data[0] == 0x89 && bytes.HasPrefix(data[1:], []byte("HDF")) {
		return Currents{}, fmt.Errorf("ocean: hycom: netcdf4 is not supported; request accept=netcdf")
	}
	return ParseHYCOMCSV(bytes.NewReader(data), src)
}

func dropHYCOMComments(data []byte) ([]byte, error) {
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), hycomCSVLimit)
	for sc.Scan() {
		line := sc.Text()
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func hycomColumns(header []string) (timeCol, latCol, lonCol, uCol, vCol int, err error) {
	timeCol, latCol, lonCol, uCol, vCol = -1, -1, -1, -1, -1
	for i, h := range header {
		k := normalizeHYCOMHeader(h)
		switch {
		case timeCol < 0 && strings.Contains(k, "time"):
			timeCol = i
		case latCol < 0 && strings.Contains(k, "lat"):
			latCol = i
		case lonCol < 0 && strings.Contains(k, "lon"):
			lonCol = i
		case uCol < 0 && (strings.Contains(k, "water_u") || strings.Contains(k, "_u")):
			uCol = i
		case vCol < 0 && (strings.Contains(k, "water_v") || strings.Contains(k, "_v")):
			vCol = i
		}
	}
	if timeCol < 0 || latCol < 0 || lonCol < 0 || uCol < 0 || vCol < 0 {
		return 0, 0, 0, 0, 0, fmt.Errorf("ocean: hycom: missing required columns")
	}
	return timeCol, latCol, lonCol, uCol, vCol, nil
}

func normalizeHYCOMHeader(h string) string {
	h = strings.TrimSpace(h)
	h = hycomUnit.ReplaceAllString(h, "")
	return strings.ToLower(strings.TrimSpace(h))
}

func parseHYCOMTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return time.Time{}, err
		}
	}
	return t.UTC(), nil
}

func parseVelocity(s string) (*float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil, err
	}
	if math.IsNaN(v) {
		return nil, nil
	}
	if math.IsInf(v, 0) {
		return nil, fmt.Errorf("non-finite")
	}
	return &v, nil
}
