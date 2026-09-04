// Command weather fetches a NOAA radar loop and an NWS gridded forecast
// into data/weather. It is the air-gap seed: the server's refreshers keep
// the same files current while it has a route out, and serve whatever this
// wrote when it does not.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
	"github.com/idrewlong/gulfseafloor/internal/weather"
)

func main() {
	out := flag.String("out", "data/weather", "snapshot output directory")
	radarURL := flag.String("radar-url", weather.DefaultRadarService, "NOAA radar ImageServer")
	nwsBase := flag.String("nws-base", weather.NWSAPI, "NWS API origin")
	flag.Parse()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	client := &http.Client{Timeout: 90 * time.Second}
	ctx := context.Background()

	set, err := weather.FetchRadar(ctx, client, *radarURL, tiles.AOI, *out, weather.Options{
		Step:      weather.DefaultRadarStep,
		MaxFrames: weather.DefaultRadarFrames,
		Width:     weather.DefaultRadarWidth,
		Height:    weather.RadarHeightFor(tiles.AOI, weather.DefaultRadarWidth),
		MaxAge:    weather.DefaultRadarMaxAge,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "radar:", err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d radar frames (%s → %s) to %s\n", len(set.Frames),
		set.Frames[0].ValidTime.Format(time.RFC3339),
		set.Frames[len(set.Frames)-1].ValidTime.Format(time.RFC3339), *out)

	fc, err := weather.FetchForecast(ctx, client, *nwsBase, tiles.AOI, weather.ForecastOptions{
		NX:        weather.DefaultForecastNX,
		NY:        weather.DefaultForecastNY,
		From:      time.Now().UTC().Truncate(time.Hour),
		Steps:     weather.DefaultForecastSteps,
		Step:      time.Hour,
		PeriodsAt: &weather.DefaultPeriodsPoint,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "forecast:", err)
		os.Exit(1)
	}
	body, err := json.MarshalIndent(fc, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(filepath.Join(*out, weather.ForecastManifest), body, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	filled := 0
	for _, v := range fc.Steps[0].Sky {
		if v != nil {
			filled++
		}
	}
	fmt.Printf("wrote forecast %dx%d, %d steps, %d periods (%d/%d cells reporting at step 0)\n",
		fc.NX, fc.NY, len(fc.Steps), len(fc.Periods), filled, len(fc.Points))
}
