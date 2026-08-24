package server

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

var reservedPrefixes = []string{
	"/tiles/",
	"/imagery/",
	"/api/",
	"/healthz",
	"/readyz",
	"/soundings/",
}

func isReserved(p string) bool {
	if p == "/healthz" || p == "/readyz" {
		return true
	}
	for _, prefix := range reservedPrefixes {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

func resolveWeb(cfg Config) fs.FS {
	if cfg.WebDir != "" {
		if _, err := os.Stat(filepath.Join(cfg.WebDir, "index.html")); err == nil {
			return os.DirFS(cfg.WebDir)
		}
	}
	if cfg.Embed != nil {
		if f, err := cfg.Embed.Open("index.html"); err == nil {
			_ = f.Close()
			return cfg.Embed
		}
	}
	return nil
}

func handleSPA(root fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if isReserved(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		if root == nil {
			http.Error(w, "frontend not built — run make web", http.StatusServiceUnavailable)
			return
		}
		serveSPA(w, r, root)
	}
}

func serveSPA(w http.ResponseWriter, r *http.Request, root fs.FS) {
	clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if clean == "." || clean == "" {
		clean = "index.html"
	}
	if strings.HasPrefix(clean, "..") {
		http.NotFound(w, r)
		return
	}

	f, err := root.Open(clean)
	if err != nil {
		serveIndex(w, r, root)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		serveIndex(w, r, root)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), sectionReader(f, info.Size()))
}

func serveIndex(w http.ResponseWriter, r *http.Request, root fs.FS) {
	f, err := root.Open("index.html")
	if err != nil {
		http.Error(w, "frontend not built — run make web", http.StatusServiceUnavailable)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, "frontend not built — run make web", http.StatusServiceUnavailable)
		return
	}
	http.ServeContent(w, r, "index.html", info.ModTime(), sectionReader(f, info.Size()))
}

func sectionReader(f fs.File, size int64) io.ReadSeeker {
	if rs, ok := f.(io.ReadSeeker); ok {
		return rs
	}
	data, err := io.ReadAll(io.LimitReader(f, 16<<20))
	if err != nil {
		return bytes.NewReader(nil)
	}
	_ = size
	return bytes.NewReader(data)
}
