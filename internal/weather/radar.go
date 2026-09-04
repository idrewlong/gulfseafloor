// Package weather ingests NOAA radar imagery and NWS gridded forecasts for
// the chart's AOI.
//
// Radar arrives as pictures, not numbers. NOAA's time-enabled image service
// renders a colour-mapped reflectivity mosaic; the bytes we store are that
// rendering, so the viewer can drape and animate them but cannot report a
// dBZ under the cursor. That limit is deliberate and is stated in the UI —
// the alternative, decoding MRMS GRIB2, buys real values at a cost this
// slice does not pay.
package weather

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

const (
	// RadarManifest is the file describing the loop, written beside the
	// frame directory.
	RadarManifest = "radar.json"
	radarDir      = "radar"

	userAgent    = "gulf-seafloor-viewer/weather (https://github.com/idrewlong/gulfseafloor)"
	maxFrameSize = 8 << 20
	maxMetaSize  = 1 << 20
	// A single NWS gridpoint document is ~200 KB of time series.
	maxGridpointSize = 4 << 20
)

// DefaultRadarService is NOAA's time-enabled base reflectivity mosaic. Its
// own time extent is the history available — roughly the last two hours —
// which is why the viewer can show a loop on its first boot rather than
// having to accumulate one.
const DefaultRadarService = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer"

// Source names the service a layer came from.
type Source struct {
	Name    string `json:"name"`
	Dataset string `json:"dataset"`
	URL     string `json:"url"`
}

// Frame is one rendered radar image and the time it is valid for.
type Frame struct {
	ValidTime time.Time `json:"validTime"`
	File      string    `json:"file"`
}

// Radar is a loop of frames sharing one bbox and pixel shape, oldest first.
type Radar struct {
	Source    Source     `json:"source"`
	BBox      tiles.BBox `json:"bbox"`
	Width     int        `json:"width"`
	Height    int        `json:"height"`
	Frames    []Frame    `json:"frames"`
	Retrieved time.Time  `json:"retrieved"`
}

// Options tunes one radar ingest.
type Options struct {
	// Step between frames. The upstream updates about every two minutes;
	// a coarser step trades smoothness for bytes on disk.
	Step time.Duration
	// MaxFrames caps the loop. The cap drops the oldest frames.
	MaxFrames int
	Width     int
	Height    int
	// MaxAge refuses a service window whose newest instant is older than
	// this. Zero disables the check.
	MaxAge time.Duration
}

// parseTimeExtent reads the service's own advertised history window.
func parseTimeExtent(body []byte) (start, end time.Time, err error) {
	var doc struct {
		TimeInfo struct {
			TimeExtent []int64 `json:"timeExtent"`
		} `json:"timeInfo"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("radar service metadata: %w", err)
	}
	ext := doc.TimeInfo.TimeExtent
	if len(ext) < 2 {
		return time.Time{}, time.Time{}, errors.New("radar service metadata: no timeExtent")
	}
	return time.UnixMilli(ext[0]).UTC(), time.UnixMilli(ext[1]).UTC(), nil
}

// frameTimes walks back from the newest instant in step increments, then
// returns them oldest-first.
//
// Walking back from the newest rather than forward from the oldest matters:
// the newest frame is the one the chart opens on, so when the cap bites it
// must drop history, never the present.
func frameTimes(start, end time.Time, step time.Duration, max int) []time.Time {
	if end.Before(start) {
		return nil
	}
	if step <= 0 {
		step = time.Minute
	}
	var out []time.Time
	for t := end; !t.Before(start) && len(out) < max; t = t.Add(-step) {
		out = append(out, t)
	}
	// Reverse in place: collected newest-first, served oldest-first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// exportURL renders one instant of the mosaic clipped to box.
func exportURL(service string, box tiles.BBox, width, height int, at time.Time) string {
	q := url.Values{}
	q.Set("bbox", fmt.Sprintf("%g,%g,%g,%g", box.West, box.South, box.East, box.North))
	q.Set("bboxSR", "4326")
	q.Set("imageSR", "4326")
	q.Set("size", strconv.Itoa(width)+","+strconv.Itoa(height))
	// png32, not png: the plain encoder hands back 8-bit RGB, and a radar
	// layer without alpha paints an opaque sheet over the sea.
	q.Set("format", "png32")
	q.Set("transparent", "true")
	q.Set("f", "image")
	q.Set("time", strconv.FormatInt(at.UnixMilli(), 10))
	return strings.TrimRight(service, "/") + "/exportImage?" + q.Encode()
}

// frameFile is the on-disk name for an instant: sortable, and readable as a
// timestamp without opening the manifest.
func frameFile(at time.Time) string {
	return at.UTC().Format("20060102T150405Z") + ".png"
}

func get(ctx context.Context, client *http.Client, u string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: http %d", u, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, limit))
}

// FetchRadar downloads the loop the service currently offers and writes it
// under outDir as a frame directory plus a manifest.
//
// A frame that fails is skipped rather than fatal: ingest runs every few
// minutes, and a loop with a hole in it is worth more than no loop. Losing
// every frame is a real outage and returns an error without writing a
// manifest, so the manifest on disk never claims images that are not there.
func FetchRadar(ctx context.Context, client *http.Client, service string, box tiles.BBox, outDir string, opt Options) (*Radar, error) {
	if client == nil {
		client = http.DefaultClient
	}
	if opt.MaxFrames <= 0 {
		opt.MaxFrames = 12
	}
	if opt.Width <= 0 || opt.Height <= 0 {
		return nil, errors.New("radar: image size must be positive")
	}

	meta, err := get(ctx, client, strings.TrimRight(service, "/")+"?f=json", maxMetaSize)
	if err != nil {
		return nil, err
	}
	start, end, err := parseTimeExtent(meta)
	if err != nil {
		return nil, err
	}
	// The eventdriven service has been seen advertising a window days out of
	// date. Its frames still render, so nothing downstream could tell they
	// were history — refuse here, and leave whatever is on disk alone.
	if age := time.Since(end); opt.MaxAge > 0 && age > opt.MaxAge {
		return nil, fmt.Errorf("radar: service window is stale by %s (newest %s)",
			age.Round(time.Minute), end.Format(time.RFC3339))
	}

	frameRoot := filepath.Join(outDir, radarDir)
	if err := os.MkdirAll(frameRoot, 0o755); err != nil {
		return nil, err
	}

	times := frameTimes(start, end, opt.Step, opt.MaxFrames)
	set := &Radar{
		Source: Source{
			Name:    "NOAA/NWS",
			Dataset: "radar_base_reflectivity_time",
			URL:     service,
		},
		BBox:      box,
		Width:     opt.Width,
		Height:    opt.Height,
		Retrieved: time.Now().UTC(),
	}
	for _, at := range times {
		body, err := get(ctx, client, exportURL(service, box, opt.Width, opt.Height, at), maxFrameSize)
		if err != nil {
			continue
		}
		name := frameFile(at)
		if err := os.WriteFile(filepath.Join(frameRoot, name), body, 0o644); err != nil {
			continue
		}
		set.Frames = append(set.Frames, Frame{ValidTime: at.UTC(), File: name})
	}
	if len(set.Frames) == 0 {
		return nil, errors.New("radar: no frame could be fetched")
	}

	// Keep one extra loop-length of history beyond what this manifest
	// references. The client polls the manifest on its own cadence, so at
	// any moment a browser may still be requesting frames from the previous
	// one; pruning to exactly the live set made those 404 and punched holes
	// in the loop after every refresh.
	if err := pruneFrames(frameRoot, set.Frames, retentionFor(opt)); err != nil {
		return nil, err
	}
	body, err := json.MarshalIndent(set, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(outDir, RadarManifest), body, 0o644); err != nil {
		return nil, err
	}
	return set, nil
}

// retentionFor is how far back of history to keep beyond the live manifest:
// one further loop-length, so a client that is one manifest behind still
// resolves every frame its copy names.
func retentionFor(opt Options) time.Duration {
	step := opt.Step
	if step <= 0 {
		step = DefaultRadarStep
	}
	n := opt.MaxFrames
	if n <= 0 {
		n = DefaultRadarFrames
	}
	return time.Duration(n) * step
}

// parseFrameName reads the instant back out of a frame's file name. It is
// the inverse of frameFile, and reports false for anything that is not one
// of ours — a stray file is left alone rather than deleted.
func parseFrameName(name string) (time.Time, bool) {
	base, ok := strings.CutSuffix(name, ".png")
	if !ok {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation("20060102T150405Z", base, time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// pruneFrames deletes images the manifest no longer references and that are
// older than grace behind the loop it does reference. Frames age out of the
// upstream's own window every few minutes; without this an air-gapped tree
// would grow a frame every poll, forever.
//
// The grace exists because the manifest and the images are fetched by the
// client independently: a browser holding the previous manifest is still
// entitled to the frames that one names. Deleting to exactly the live set
// made those requests 404 and left visible gaps in the loop for one poll
// interval after every refresh.
func pruneFrames(dir string, keep []Frame, grace time.Duration) error {
	live := make(map[string]struct{}, len(keep))
	oldest := time.Time{}
	for _, f := range keep {
		live[f.File] = struct{}{}
		if oldest.IsZero() || f.ValidTime.Before(oldest) {
			oldest = f.ValidTime
		}
	}
	cutoff := oldest.Add(-grace)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".png") {
			continue
		}
		if _, ok := live[e.Name()]; ok {
			continue
		}
		at, ok := parseFrameName(e.Name())
		if !ok {
			// Not a frame this package wrote. Leave it.
			continue
		}
		// Inside the grace window: a client one manifest behind may still
		// ask for it.
		if !oldest.IsZero() && at.After(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// Ingest defaults. The radar service republishes about every two minutes;
// a five-minute step keeps a two-hour loop at a couple of dozen frames.
const (
	DefaultRadarStep   = 5 * time.Minute
	DefaultRadarFrames = 24
	DefaultRadarWidth  = 1024
	// The advertised window is about two hours; three is generous slack
	// for a service that is briefly behind.
	DefaultRadarMaxAge = 3 * time.Hour

	// ForecastManifest is the gridded outlook, written beside radar.json.
	ForecastManifest = "forecast.json"

	DefaultForecastNX    = 5
	DefaultForecastNY    = 3
	DefaultForecastSteps = 168 // seven days, hourly
)

// DefaultPeriodsPoint is Biloxi. The plain-language outlook has to be read
// somewhere on land — NWS returns "Marine Forecast Not Supported" for a
// point on the water, and the chart's centre is water.
var DefaultPeriodsPoint = LonLat{Lon: -88.89, Lat: 30.40}

// RadarHeightFor keeps the exported image at the AOI's aspect ratio, so the
// frame drapes onto the chart without stretching.
func RadarHeightFor(box tiles.BBox, width int) int {
	w := box.East - box.West
	h := box.North - box.South
	if w <= 0 || h <= 0 || width <= 0 {
		return width
	}
	out := int(float64(width) * h / w)
	if out < 1 {
		return 1
	}
	return out
}
