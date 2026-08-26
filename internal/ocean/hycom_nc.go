package ocean

import (
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	"github.com/batchatco/go-native-netcdf/netcdf"
	"github.com/batchatco/go-native-netcdf/netcdf/api"
)

func parseHYCOMNetCDF(data []byte, src Source) (Currents, error) {
	tmp, err := os.CreateTemp("", "gulf-hycom-*.nc")
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: %w", err)
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return Currents{}, fmt.Errorf("ocean: hycom: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: %w", err)
	}

	nc, err := netcdf.Open(name)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: netcdf: %w", err)
	}
	defer nc.Close()

	latVar, err := ncVar(nc, "lat", "latitude")
	if err != nil {
		return Currents{}, err
	}
	lonVar, err := ncVar(nc, "lon", "longitude")
	if err != nil {
		return Currents{}, err
	}
	uVar, err := ncVar(nc, "water_u", "ssu")
	if err != nil {
		return Currents{}, err
	}
	vVar, err := ncVar(nc, "water_v", "ssv")
	if err != nil {
		return Currents{}, err
	}
	timeVar, err := ncVar(nc, "time", "time2", "time1")
	if err != nil {
		return Currents{}, err
	}

	lats, err := float1D(latVar.Values)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: lat: %w", err)
	}
	lonsRaw, err := float1D(lonVar.Values)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: lon: %w", err)
	}
	times, err := float1D(timeVar.Values)
	if err != nil {
		return Currents{}, fmt.Errorf("ocean: hycom: time: %w", err)
	}
	if len(times) == 0 {
		return Currents{}, fmt.Errorf("ocean: hycom: empty time")
	}
	units := ncAttrString(timeVar, "units")
	validTime, err := parseCFTime(times[0], units)
	if err != nil {
		return Currents{}, err
	}

	ny, nx := len(lats), len(lonsRaw)
	if nx == 0 || ny == 0 {
		return Currents{}, fmt.Errorf("ocean: hycom: empty grid")
	}

	cells := make([]hycomCell, 0, nx*ny)
	lons := make([]float64, 0, nx)
	lonSeen := map[float64]struct{}{}
	latSeen := map[float64]struct{}{}
	var uniqueLats []float64

	for j, lat := range lats {
		if !finite(lat) {
			return Currents{}, fmt.Errorf("ocean: hycom: lat: non-finite")
		}
		if _, ok := latSeen[lat]; !ok {
			latSeen[lat] = struct{}{}
			uniqueLats = append(uniqueLats, lat)
		}
		for i, rawLon := range lonsRaw {
			if !finite(rawLon) {
				return Currents{}, fmt.Errorf("ocean: hycom: lon: non-finite")
			}
			lon := wrapLon180(rawLon)
			if _, ok := lonSeen[lon]; !ok {
				lonSeen[lon] = struct{}{}
				lons = append(lons, lon)
			}
			u, uOk := ncVelocity(uVar.Values, j, i)
			v, vOk := ncVelocity(vVar.Values, j, i)
			cells = append(cells, hycomCell{lon: lon, lat: lat, u: uOkThen(u, uOk), v: uOkThen(v, vOk)})
		}
	}

	return gridFromCells(cells, lons, uniqueLats, validTime, src)
}

func uOkThen(v float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	return &v
}

func ncVar(nc api.Group, names ...string) (*api.Variable, error) {
	for _, name := range names {
		vr, err := nc.GetVariable(name)
		if err != nil || vr == nil {
			continue
		}
		return vr, nil
	}
	return nil, fmt.Errorf("ocean: hycom: missing %s", strings.Join(names, "/"))
}

func ncAttrString(vr *api.Variable, key string) string {
	if vr == nil || vr.Attributes == nil {
		return ""
	}
	v, ok := vr.Attributes.Get(key)
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case []byte:
		return string(t)
	default:
		return fmt.Sprint(t)
	}
}

func float1D(values any) ([]float64, error) {
	switch t := values.(type) {
	case []float64:
		return t, nil
	case []float32:
		out := make([]float64, len(t))
		for i, v := range t {
			out[i] = float64(v)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unexpected type %T", values)
	}
}

func ncVelocity(values any, j, i int) (float64, bool) {
	var x float64
	switch t := values.(type) {
	case [][][][]float32:
		if len(t) == 0 || len(t[0]) == 0 || j >= len(t[0][0]) || i >= len(t[0][0][j]) {
			return 0, false
		}
		x = float64(t[0][0][j][i])
	case [][][][]float64:
		if len(t) == 0 || len(t[0]) == 0 || j >= len(t[0][0]) || i >= len(t[0][0][j]) {
			return 0, false
		}
		x = t[0][0][j][i]
	case [][][]float32:
		if len(t) == 0 || j >= len(t[0]) || i >= len(t[0][j]) {
			return 0, false
		}
		x = float64(t[0][j][i])
	case [][]float32:
		if j >= len(t) || i >= len(t[j]) {
			return 0, false
		}
		x = float64(t[j][i])
	default:
		return 0, false
	}
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0, false
	}
	return x, true
}

func parseCFTime(value float64, units string) (time.Time, error) {
	units = strings.TrimSpace(units)
	parts := strings.SplitN(strings.ToLower(units), " since ", 2)
	if len(parts) != 2 {
		return time.Time{}, fmt.Errorf("ocean: hycom: time units %q", units)
	}
	origin := strings.TrimSpace(parts[1])
	origin = strings.TrimSuffix(origin, " utc")
	origin = strings.TrimSpace(origin)
	origin = strings.TrimSuffix(origin, "z")
	origin = strings.TrimSpace(origin)
	layouts := []string{
		"2006-01-02 15:04:05.000",
		"2006-01-02 15:04:05",
		"2006-01-02t15:04:05",
		"2006-01-02",
	}
	var t0 time.Time
	var err error
	for _, layout := range layouts {
		t0, err = time.Parse(layout, origin)
		if err == nil {
			break
		}
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("ocean: hycom: time origin %q", origin)
	}
	var d time.Duration
	switch parts[0] {
	case "seconds":
		d = time.Duration(value * float64(time.Second))
	case "minutes":
		d = time.Duration(value * float64(time.Minute))
	case "hours":
		d = time.Duration(value * float64(time.Hour))
	case "days":
		d = time.Duration(value * 24 * float64(time.Hour))
	default:
		return time.Time{}, fmt.Errorf("ocean: hycom: time unit %q", parts[0])
	}
	return t0.Add(d).UTC(), nil
}
