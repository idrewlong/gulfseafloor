package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/idrewlong/gulfseafloor/internal/ocean"
)

const (
	oceanCacheControl = "public, max-age=300"
	oceanMaxBytes     = 8 << 20
)

func (s *Server) handleOcean(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/api/ocean/")
	switch name {
	case "manifest", "currents", "buoys":
	default:
		http.NotFound(w, r)
		return
	}
	path, err := oceanFilePath(s.cfg.OceanDir, name)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		slog.Error("ocean file", "name", name, "err", err)
		http.Error(w, "ocean snapshot unavailable", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, oceanMaxBytes))
	if err != nil {
		slog.Error("ocean file", "name", name, "err", err)
		http.Error(w, "ocean snapshot unavailable", http.StatusInternalServerError)
		return
	}
	if err := decodeOcean(name, data); err != nil {
		slog.Error("ocean file", "name", name, "err", err)
		http.Error(w, "ocean snapshot unavailable", http.StatusInternalServerError)
		return
	}
	sum := sha256.Sum256(data)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", oceanCacheControl)
	w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(data)
}

func decodeOcean(name string, data []byte) error {
	r := bytes.NewReader(data)
	switch name {
	case "currents":
		_, err := ocean.DecodeCurrents(r)
		return err
	case "buoys":
		_, err := ocean.DecodeBuoys(r)
		return err
	case "manifest":
		_, err := ocean.DecodeManifest(r)
		return err
	default:
		return errTraversal
	}
}

func oceanFilePath(root, name string) (string, error) {
	path := filepath.Join(root, name+".json")
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
