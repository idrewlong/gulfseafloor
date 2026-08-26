package aircraft

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

const UserAgent = "gulf-seafloor-viewer/0.2 (public-adsb-proxy)"
const MaxBodyBytes = 2 << 20
const FetchTimeout = 6 * time.Second

type Endpoints struct {
	OpenSky string
	AdsbLol string
}

func DefaultEndpoints() Endpoints {
	return Endpoints{
		OpenSky: "https://opensky-network.org/api/states/all",
		AdsbLol: "https://api.adsb.lol",
	}
}

func CoverRadiusNmi(b tiles.BBox) float64 {
	midLat := (b.South + b.North) / 2
	widthNmi := (b.East - b.West) * 60 * math.Cos(midLat*math.Pi/180)
	heightNmi := (b.North - b.South) * 60
	return math.Ceil(math.Hypot(widthNmi, heightNmi)/2 + 10)
}

func OpenSkyURL(base string, b tiles.BBox) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	q.Set("lamin", formatCoordinate(b.South))
	q.Set("lomin", formatCoordinate(b.West))
	q.Set("lamax", formatCoordinate(b.North))
	q.Set("lomax", formatCoordinate(b.East))
	u.RawQuery = q.Encode()
	return u.String()
}

func AdsbLolURL(origin string, b tiles.BBox) string {
	u, err := url.Parse(origin)
	if err != nil {
		return origin
	}
	midLat := (b.South + b.North) / 2
	midLon := (b.West + b.East) / 2
	u.Path = path.Join(
		u.Path,
		"v2",
		"lat",
		formatCoordinate(midLat),
		"lon",
		formatCoordinate(midLon),
		"dist",
		strconv.FormatFloat(CoverRadiusNmi(b), 'f', 0, 64),
	)
	return u.String()
}

func NewClient() *http.Client {
	return &http.Client{
		Timeout: FetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) == 0 {
				return nil
			}
			if req.URL.Host != via[0].URL.Host {
				return http.ErrUseLastResponse
			}
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
}

func Fetch(ctx context.Context, client *http.Client, ep Endpoints, clip tiles.BBox, now time.Time) (Snapshot, error) {
	openSkyRaw, openSkyErr := getCapped(ctx, client, OpenSkyURL(ep.OpenSky, clip))
	if openSkyErr == nil {
		snapshot, err := ParseOpenSky(openSkyRaw, now, clip)
		if err == nil {
			return snapshot, nil
		}
		openSkyErr = err
	}

	adsbLolRaw, adsbLolErr := getCapped(ctx, client, AdsbLolURL(ep.AdsbLol, clip))
	if adsbLolErr == nil {
		snapshot, err := ParseAdsbLol(adsbLolRaw, now, clip)
		if err == nil {
			return snapshot, nil
		}
		adsbLolErr = err
	}

	return Snapshot{}, fmt.Errorf("aircraft: fetch failed: opensky: %v; adsb.lol: %w", openSkyErr, adsbLolErr)
}

func getCapped(ctx context.Context, client *http.Client, endpoint string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	req.Header.Set("User-Agent", UserAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %s", resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	if len(raw) > MaxBodyBytes {
		return nil, fmt.Errorf("body exceeds %d bytes", MaxBodyBytes)
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("empty body")
	}
	return raw, nil
}

func formatCoordinate(v float64) string {
	return strings.TrimSuffix(strconv.FormatFloat(v, 'f', 6, 64), ".000000")
}
