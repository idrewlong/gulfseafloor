// Command ocean fetches a HYCOM + NDBC snapshot into data/ocean.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/ocean"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func main() {
	out := flag.String("out", "data/ocean", "snapshot output directory")
	hycomURL := flag.String("hycom-url", "", "HYCOM NCSS URL (full query or base)")
	ndbcBase := flag.String("ndbc-base", "https://www.ndbc.noaa.gov", "NDBC site origin")
	flag.Parse()

	if strings.TrimSpace(*hycomURL) == "" {
		fmt.Fprintln(os.Stderr, "ocean: -hycom-url is required")
		os.Exit(1)
	}

	hycom := *hycomURL
	if !strings.Contains(hycom, "?") {
		hycom += fmt.Sprintf(
			"?var=water_u&var=water_v&north=%g&west=%g&east=%g&south=%g&time=latest&accept=csv",
			tiles.AOI.North, tiles.AOI.West, tiles.AOI.East, tiles.AOI.South,
		)
	}

	ndbc := strings.TrimRight(*ndbcBase, "/")
	ep := ocean.Endpoints{
		HYCOM:           hycom,
		StationTable:    ndbc + "/data/stations/station_table.txt",
		Realtime2Prefix: ndbc + "/data/realtime2/",
	}
	aoi := ocean.BBox{
		West:  tiles.AOI.West,
		South: tiles.AOI.South,
		East:  tiles.AOI.East,
		North: tiles.AOI.North,
	}
	client := &http.Client{Timeout: 30 * time.Second}
	if err := ocean.FetchSnapshot(context.Background(), client, ep, aoi, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	f, err := os.Open(filepath.Join(*out, "buoys.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	b, err := ocean.DecodeBuoys(f)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d stations to %s\n", len(b.Stations), *out)
}
