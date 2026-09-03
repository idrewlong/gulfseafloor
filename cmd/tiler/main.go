// tiler writes a terrain-RGB-encoded XYZ tile pyramid.
//
//	tiler synth -out data/tiles -zmin 6 -zmax 14
//
// The surface is GEBCO 2024 on the open shelf and a procedural stand-in
// inside the Sound, the bays and the lagoons, where GEBCO's 460 m cells do
// not resolve the water. The GEBCO clip is vendored, so this runs with the
// network unplugged. Real NOAA rasters go through scripts/build-tiles.sh
// (GDAL) when available.
package main

import (
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/idrewlong/gulfseafloor/internal/shelf"
	"github.com/idrewlong/gulfseafloor/internal/terrain"
	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: tiler synth [flags]\n")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "synth":
		if err := synth(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

func synth(args []string) error {
	fs := flag.NewFlagSet("synth", flag.ExitOnError)
	out := fs.String("out", "data/tiles", "output directory")
	zmin := fs.Int("zmin", 6, "min zoom")
	zmax := fs.Int("zmax", 14, "max zoom")
	size := fs.Int("size", 256, "tile size in pixels")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *zmin < 0 || *zmax < *zmin || *zmax > 15 {
		return fmt.Errorf("invalid zoom range %d-%d", *zmin, *zmax)
	}

	var jobs []tiles.Tile
	for z := *zmin; z <= *zmax; z++ {
		jobs = append(jobs, tiles.Covering(tiles.AOI, z)...)
	}

	workers := runtime.GOMAXPROCS(0)
	total := int64(len(jobs))
	start := time.Now()
	fmt.Fprintf(os.Stderr, "synth: %d tiles, z %d–%d, %d workers\n", total, *zmin, *zmax, workers)
	fmt.Fprintln(os.Stderr, formatProgress(0, total, 0))

	ch := make(chan tiles.Tile)
	var wg sync.WaitGroup
	var written atomic.Int64
	errCh := make(chan error, workers)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range ch {
				if err := writeTile(*out, t, *size); err != nil {
					errCh <- err
					return
				}
				written.Add(1)
			}
		}()
	}

	stop := make(chan struct{})
	var report sync.WaitGroup
	report.Add(1)
	go func() {
		defer report.Done()
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				fmt.Fprintln(os.Stderr, formatProgress(written.Load(), total, time.Since(start)))
			}
		}
	}()

	for _, t := range jobs {
		ch <- t
	}
	close(ch)
	wg.Wait()
	close(stop)
	report.Wait()
	close(errCh)
	if err := <-errCh; err != nil {
		return err
	}
	fmt.Printf("wrote %d tiles to %s (z %d–%d) in %s\n", written.Load(), *out, *zmin, *zmax, formatElapsed(time.Since(start)))
	return nil
}

func writeTile(root string, t tiles.Tile, size int) error {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			lon, lat := tiles.PixelLonLat(t, px, py, size)
			elev := shelf.Sample(lon, lat)
			img.SetNRGBA(px, py, terrain.EncodeNRGBA(elev))
		}
	}
	dir := filepath.Join(root, fmt.Sprintf("%d", t.Z), fmt.Sprintf("%d", t.X))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Write to a scratch name and rename into place. os.Create truncates the
	// destination first, so an in-place write is visible to a reader while it
	// is still short — and the server reads this directory live. Rename within
	// one directory is atomic, so a reader gets the old tile or the new one.
	path := filepath.Join(dir, fmt.Sprintf("%d.png", t.Y))
	f, err := os.CreateTemp(dir, fmt.Sprintf(".%d.png.*", t.Y))
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		// No-op once the rename has happened.
		_ = os.Remove(tmp)
	}()
	if err := png.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
