package ocean

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// StationMarginDeg is the extra padding applied to the Mississippi Sound AOI
// when selecting NDBC stations.
const StationMarginDeg = 0.5

const realtime2Limit = 256 * 1024

var stationLoc = regexp.MustCompile(`([0-9.]+)\s*([NS])\s+([0-9.]+)\s*([EW])`)

// TableRow is one NDBC station_table.txt record after location parse.
type TableRow struct {
	ID   string
	Name string
	Lon  float64
	Lat  float64
}

// Expand returns b padded by deg degrees on each side.
func Expand(b BBox, deg float64) BBox {
	return BBox{
		West:  b.West - deg,
		South: b.South - deg,
		East:  b.East + deg,
		North: b.North + deg,
	}
}

// Contains reports whether (lon, lat) lies inside b, inclusive of the edges.
func (b BBox) Contains(lon, lat float64) bool {
	return lon >= b.West && lon <= b.East && lat >= b.South && lat <= b.North
}

// ParseStationTable keeps pipe-delimited NDBC station rows whose location
// falls in margin. Comment lines starting with # are skipped.
func ParseStationTable(r io.Reader, margin BBox) ([]TableRow, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("ocean: ndbc: station table: %w", err)
	}
	if looksLikeHTML(data) {
		return nil, fmt.Errorf("ocean: ndbc: station table: html payload")
	}
	var rows []TableRow
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "|")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		if len(parts) == 0 || parts[0] == "" {
			continue
		}
		m := stationLoc.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		lat, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		lon, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			continue
		}
		if strings.EqualFold(m[2], "S") {
			lat = -lat
		}
		if strings.EqualFold(m[4], "W") {
			lon = -lon
		}
		if !margin.Contains(lon, lat) {
			continue
		}
		name := ""
		if len(parts) > 4 {
			name = parts[4]
		}
		rows = append(rows, TableRow{ID: parts[0], Name: name, Lon: lon, Lat: lat})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("ocean: ndbc: station table: %w", err)
	}
	return rows, nil
}

// ParseRealtime2 reads a standard meteorological realtime2 text file and
// returns the last parseable data row. MM and empty cells are omitted.
func ParseRealtime2(id string, r io.Reader) (Station, error) {
	data, err := io.ReadAll(io.LimitReader(r, realtime2Limit))
	if err != nil {
		return Station{}, fmt.Errorf("ocean: ndbc: realtime2: %w", err)
	}
	if looksLikeHTML(data) {
		return Station{}, fmt.Errorf("ocean: ndbc: realtime2: html payload")
	}
	var last *Station
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		st, ok := parseRealtime2Row(id, line)
		if !ok {
			continue
		}
		row := st
		last = &row
	}
	if err := sc.Err(); err != nil {
		return Station{}, fmt.Errorf("ocean: ndbc: realtime2: %w", err)
	}
	if last == nil {
		return Station{}, fmt.Errorf("ocean: ndbc: realtime2: no parseable data row")
	}
	return *last, nil
}

// BuoysValidTime is the latest station ObsTime, or retrieved when none exist.
func BuoysValidTime(stations []Station, retrieved time.Time) time.Time {
	var max time.Time
	found := false
	for _, s := range stations {
		if s.ObsTime == nil {
			continue
		}
		t := s.ObsTime.UTC()
		if !found || t.After(max) {
			max = t
			found = true
		}
	}
	if !found {
		return retrieved
	}
	return max
}

func looksLikeHTML(data []byte) bool {
	return bytes.Contains(bytes.ToLower(data), []byte("<html"))
}

func parseRealtime2Row(id, line string) (Station, bool) {
	fields := strings.Fields(line)
	if len(fields) < 5 {
		return Station{}, false
	}
	year, err1 := strconv.Atoi(fields[0])
	month, err2 := strconv.Atoi(fields[1])
	day, err3 := strconv.Atoi(fields[2])
	hour, err4 := strconv.Atoi(fields[3])
	minute, err5 := strconv.Atoi(fields[4])
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
		return Station{}, false
	}
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return Station{}, false
	}
	obs := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC)
	st := Station{ID: id, ObsTime: &obs}
	st.WDir = optionalFloat(fields, 5)
	st.WSpd = optionalFloat(fields, 6)
	st.Gst = optionalFloat(fields, 7)
	st.WVHT = optionalFloat(fields, 8)
	st.WTMP = optionalFloat(fields, 14)
	return st, true
}

func optionalFloat(fields []string, i int) *float64 {
	if i >= len(fields) {
		return nil
	}
	s := fields[i]
	if s == "" || s == "MM" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &v
}
