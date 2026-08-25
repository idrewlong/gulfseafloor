package ocean

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
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

	hycomBody, status, err := getCapped(ctx, client, ep.HYCOM, hycomCSVLimit)
	if err != nil {
		return fmt.Errorf("ocean: fetch hycom: %w", err)
	}
	if status != http.StatusOK {
		return fmt.Errorf("ocean: fetch hycom: HTTP %d", status)
	}
	currents, err := ParseHYCOMCSV(bytes.NewReader(hycomBody), Source{
		Name: "HYCOM",
		URL:  ep.HYCOM,
	})
	if err != nil {
		return err
	}
	if !currents.BBox.Intersects(aoi) {
		return fmt.Errorf("ocean: fetch hycom: bbox does not intersect AOI")
	}

	tableBody, status, err := getCapped(ctx, client, ep.StationTable, stationTableLimit)
	if err != nil {
		return fmt.Errorf("ocean: fetch station table: %w", err)
	}
	if status != http.StatusOK {
		return fmt.Errorf("ocean: fetch station table: HTTP %d", status)
	}
	rows, err := ParseStationTable(bytes.NewReader(tableBody), Expand(aoi, StationMarginDeg))
	if err != nil {
		return err
	}

	stations, err := fetchStations(ctx, client, ep, rows)
	if err != nil {
		return err
	}
	buoys := Buoys{
		ValidTime: BuoysValidTime(stations, retrieved),
		Source:    Source{Name: "NDBC", URL: ep.StationTable},
		Stations:  stations,
	}
	return WriteSnapshot(outDir, currents, buoys, retrieved)
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

			url := prefix + row.ID + ".txt"
			body, status, err := getCapped(ctx, client, url, realtime2Limit)
			if err != nil || status == http.StatusNotFound || status != http.StatusOK {
				return
			}
			st, err := ParseRealtime2(row.ID, bytes.NewReader(body))
			if err != nil {
				return
			}
			st.Name = row.Name
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

func getCapped(ctx context.Context, client *http.Client, rawURL string, limit int64) ([]byte, int, error) {
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
		return nil, res.StatusCode, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return data, res.StatusCode, nil
}
