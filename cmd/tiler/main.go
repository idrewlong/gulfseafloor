// tiler writes a Terrarium-encoded XYZ tile pyramid.
//
//	tiler synth -out data/tiles -zmin 6 -zmax 14
//
// The synthetic surface is a Mississippi Bight stand-in so the
// viewer runs with the network unplugged. Real NOAA rasters go through
// scripts/build-tiles.sh (GDAL) when available.
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

	for _, t := range jobs {
		ch <- t
	}
	close(ch)
	wg.Wait()
	close(errCh)
	if err := <-errCh; err != nil {
		return err
	}
	fmt.Printf("wrote %d tiles to %s (z %d–%d)\n", written.Load(), *out, *zmin, *zmax)
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
	path := filepath.Join(dir, fmt.Sprintf("%d.png", t.Y))
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
