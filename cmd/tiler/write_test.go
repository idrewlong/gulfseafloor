package main

import (
	"image"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/idrewlong/gulfseafloor/internal/tiles"
)

// The server reads data/tiles while `make tiles` writes it, and two tilers
// aimed at one directory race each other outright. A tile written in place is
// visible to a reader while it is still short, so the reader decodes a
// truncated PNG and the shader lifts garbage depths. Writing to a temp name and
// renaming makes the destination flip atomically: readers see the old tile or
// the new one, never half of either.
func TestWriteTileIsAtomicForConcurrentReaders(t *testing.T) {
	root := t.TempDir()
	tile := tiles.Tile{Z: 11, X: 517, Y: 842}

	// Seed a complete tile so the reader always has something valid to open.
	if err := writeTile(root, tile, 256); err != nil {
		t.Fatalf("seed: %v", err)
	}
	path := filepath.Join(root, "11", "517", "842.png")

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 40; i++ {
			if err := writeTile(root, tile, 256); err != nil {
				t.Errorf("write %d: %v", i, err)
				break
			}
		}
		close(stop)
	}()

	var reads, failures int
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			f, err := os.Open(path)
			if err != nil {
				failures++
				t.Errorf("open: %v", err)
				return
			}
			_, _, err = image.Decode(f)
			f.Close()
			reads++
			if err != nil {
				failures++
				t.Errorf("reader saw a partial tile after %d clean reads: %v", reads-1, err)
				return
			}
		}
	}()
	wg.Wait()

	if reads == 0 {
		t.Fatal("reader never got a read in; the race was not exercised")
	}
	t.Logf("%d concurrent reads, %d failures", reads, failures)
}

// A rename-based write must not leave its scratch file behind.
func TestWriteTileLeavesNoTempFiles(t *testing.T) {
	root := t.TempDir()
	if err := writeTile(root, tiles.Tile{Z: 6, X: 15, Y: 26}, 64); err != nil {
		t.Fatal(err)
	}
	var stray []string
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() && !strings.HasSuffix(p, ".png") {
			stray = append(stray, p)
		}
		return nil
	})
	if len(stray) > 0 {
		t.Errorf("left scratch files behind: %v", stray)
	}
}
