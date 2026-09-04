package weather

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// Opt-in probe against the live service; skipped unless WEATHER_LIVE=1.
func TestLiveRadarExtent(t *testing.T) {
	if os.Getenv("WEATHER_LIVE") != "1" {
		t.Skip("set WEATHER_LIVE=1 to probe the live service")
	}
	c := &http.Client{Timeout: 60 * time.Second}
	meta, err := get(context.Background(), c, DefaultRadarService+"?f=json", maxMetaSize)
	if err != nil {
		t.Fatal(err)
	}
	start, end, err := parseTimeExtent(meta)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("extent  %s -> %s", start.Format(time.RFC3339), end.Format(time.RFC3339))
	t.Logf("now     %s", time.Now().UTC().Format(time.RFC3339))
	times := frameTimes(start, end, DefaultRadarStep, DefaultRadarFrames)
	t.Logf("frames  %d, first %s last %s", len(times),
		times[0].Format(time.RFC3339), times[len(times)-1].Format(time.RFC3339))
	t.Logf("url     %s", exportURL(DefaultRadarService, tiles.AOI, 1024, 499, times[len(times)-1]))
}
