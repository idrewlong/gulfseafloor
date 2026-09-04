package ocean

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	userAgent         = "gulf-seafloor-viewer/ocean (https://github.com/idrewlong/gulfseafloor)"
	stationTableLimit = 2 << 20
	ndbcMaxConcurrent = 8
)

// Endpoints are the HTTP URLs fetched for one snapshot.
type Endpoints struct {
	HYCOM           string
	StationTable    string
	Realtime2Prefix string // directory URL; station id + ".txt" is appended
}

// FetchSnapshot downloads HYCOM currents and NDBC stations into outDir.
// HYCOM or station-table failure is fatal and does not write. A realtime 404
// skips that station. An empty station list is written if the table succeeded.
func FetchSnapshot(ctx context.Context, client *http.Client, ep Endpoints, aoi BBox, outDir string) error {
	if client == nil {
		client = http.DefaultClient
	}
	retrieved := time.Now().UTC()

	currents, err := fetchHYCOM(ctx, client, ep.HYCOM, aoi)
	if err != nil {
		return err
	}

	buoys, err := FetchBuoys(ctx, client, ep, aoi, retrieved)
	if err != nil {
		return err
	}
	// A one-shot make-ocean ingest fetches currents and buoys in the same
	// pass, so both layers were genuinely retrieved at this instant.
	return WriteSnapshot(outDir, currents, buoys, true, retrieved, &retrieved)
}

// FetchBuoys downloads the NDBC station table, keeps the stations inside aoi,
// and pulls each one's realtime2 observation. A station whose realtime2 file
// is missing or unparseable is skipped; only a station-table failure is
// fatal, since without the table there is no station list to speak of.
//
// retrieved is the fallback ValidTime for a snapshot in which no station
// reported an obs time at all.
//
// This is the half of FetchSnapshot that the server's background refresher
// reuses, so the scheduled poll and the one-shot `make ocean` ingest cannot
// drift apart in which stations they select or how they parse them.
func FetchBuoys(ctx context.Context, client *http.Client, ep Endpoints, aoi BBox, retrieved time.Time) (Buoys, error) {
	if client == nil {
		client = http.DefaultClient
	}
	tableBody, status, err := getCapped(ctx, client, ep.StationTable, stationTableLimit, false)
	if err != nil {
		return Buoys{}, fmt.Errorf("ocean: fetch station table: %w", err)
	}
	if status != http.StatusOK {
		return Buoys{}, fmt.Errorf("ocean: fetch station table: HTTP %d", status)
	}
	rows, err := ParseStationTable(bytes.NewReader(tableBody), Expand(aoi, StationMarginDeg))
	if err != nil {
		return Buoys{}, err
	}

	stations, err := fetchStations(ctx, client, ep, rows)
	if err != nil {
		return Buoys{}, err
	}
	return Buoys{
		ValidTime: BuoysValidTime(stations, retrieved),
		Source:    Source{Name: "NDBC", URL: ep.StationTable},
		Stations:  stations,
	}, nil
}

func fetchStations(ctx context.Context, client *http.Client, ep Endpoints, rows []TableRow) ([]Station, error) {
	prefix := ep.Realtime2Prefix
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	sem := make(chan struct{}, ndbcMaxConcurrent)
	var wg sync.WaitGroup
	var mu sync.Mutex
	stations := make([]Station, 0, len(rows))

	for _, row := range rows {
		row := row
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			id := strings.ToUpper(row.ID)
			url := prefix + id + ".txt"
			body, status, err := getCapped(ctx, client, url, realtime2Limit, true)
			if err != nil || status == http.StatusNotFound || status != http.StatusOK {
				return
			}
			st, err := ParseRealtime2(id, bytes.NewReader(body))
			if err != nil {
				return
			}
			st.Name = row.Name
			st.Kind = row.Kind
			st.Lon = row.Lon
			st.Lat = row.Lat
			mu.Lock()
			stations = append(stations, st)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return stations, nil
}

func getCapped(ctx context.Context, client *http.Client, rawURL string, limit int64, truncate bool) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, res.StatusCode, err
	}
	if int64(len(data)) > limit {
		if !truncate {
			return nil, res.StatusCode, fmt.Errorf("response exceeds %d bytes", limit)
		}
		data = data[:limit]
	}
	return data, res.StatusCode, nil
}

func hycomDatasetFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	for i, s := range segs {
		if strings.HasPrefix(s, "GLB") && i+1 < len(segs) {
			return segs[i] + "/" + segs[i+1]
		}
	}
	return ""
}

// DefaultNDBCBase is the NDBC site origin.
const DefaultNDBCBase = "https://www.ndbc.noaa.gov"

// NDBCEndpoints derives the station-table and realtime2 URLs from a site
// origin. The one-shot ingest and the server's background refresher both
// build their endpoints here so the two cannot drift onto different paths.
// HYCOM is left empty; FetchBuoys does not read it.
func NDBCEndpoints(base string) Endpoints {
	if strings.TrimSpace(base) == "" {
		base = DefaultNDBCBase
	}
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	return Endpoints{
		StationTable:    base + "/data/stations/station_table.txt",
		Realtime2Prefix: base + "/data/realtime2/",
	}
}
