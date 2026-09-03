package server

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

// tileStore reads pre-generated terrain-RGB PNGs. Concurrent requests for the
// same z/x/y are collapsed with singleflight; disk work is bounded by a pool.
type tileStore struct {
	root string
	sf   singleflight.Group
	sem  chan struct{}
}

type tileBytes struct {
	data    []byte
	modTime time.Time
	size    int64
}

func newTileStore(root string, workers int) *tileStore {
	if workers < 1 {
		workers = 1
	}
	return &tileStore{root: root, sem: make(chan struct{}, workers)}
}

func (s *tileStore) get(z, x, y int) (*tileBytes, error) {
	key := fmt.Sprintf("%d/%d/%d", z, x, y)
	v, err, _ := s.sf.Do(key, func() (any, error) {
		s.sem <- struct{}{}
		defer func() { <-s.sem }()
		return s.readDisk(z, x, y)
	})
	if err != nil {
		return nil, err
	}
	tb, ok := v.(*tileBytes)
	if !ok || tb == nil {
		return nil, os.ErrNotExist
	}
	return tb, nil
}

func (s *tileStore) readDisk(z, x, y int) (*tileBytes, error) {
	path, err := tilePath(s.root, z, x, y)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 32<<20))
	if err != nil {
		return nil, err
	}
	return &tileBytes{data: data, modTime: info.ModTime(), size: info.Size()}, nil
}

func (tb *tileBytes) etag() string {
	return fmt.Sprintf(`"%x-%x"`, tb.modTime.UnixNano(), tb.size)
}

func tilePath(root string, z, x, y int) (string, error) {
	// Integers only — never concatenate unsanitised path segments.
	path := filepath.Join(root, strconv.Itoa(z), strconv.Itoa(x), strconv.Itoa(y)+".png")
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", errTraversal
	}
	return absPath, nil
}

var errTraversal = errors.New("tile path escapes root")

// parseTileXYZ extracts z/x/y from /tiles/{z}/{x}/{y}.png.
// Every component is strconv'd; ".." and any non-integer segment are rejected.
func parseTileXYZ(path string) (z, x, y int, ok bool) {
	p := strings.TrimPrefix(path, "/tiles/")
	if p == path || p == "" {
		return 0, 0, 0, false
	}
	if strings.Contains(p, "..") || strings.Contains(p, "\\") {
		return 0, 0, 0, false
	}
	parts := strings.Split(p, "/")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	if !strings.HasSuffix(parts[2], ".png") {
		return 0, 0, 0, false
	}
	yStr := strings.TrimSuffix(parts[2], ".png")
	if yStr == "" || strings.Contains(yStr, ".") {
		return 0, 0, 0, false
	}
	var err error
	if z, err = strconv.Atoi(parts[0]); err != nil {
		return 0, 0, 0, false
	}
	if x, err = strconv.Atoi(parts[1]); err != nil {
		return 0, 0, 0, false
	}
	if y, err = strconv.Atoi(yStr); err != nil {
		return 0, 0, 0, false
	}
	if z < 0 || x < 0 || y < 0 {
		return 0, 0, 0, false
	}
	return z, x, y, true
}

func (s *Server) handleTile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	z, x, y, ok := parseTileXYZ(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	tb, err := s.tiles.get(z, x, y)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, errTraversal) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "tile unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", tileCacheControl)
	w.Header().Set("ETag", tb.etag())
	http.ServeContent(w, r, fmt.Sprintf("%d.png", y), tb.modTime, bytes.NewReader(tb.data))
}
