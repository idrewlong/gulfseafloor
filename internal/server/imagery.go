package server

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Esri World Imagery XYZ (z/y/x). Public tiles; attribution required in the UI.
const defaultImageryTemplate = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%d/%d/%d"

const (
	imageryMaxBytes = 2 << 20
	imageryTimeout  = 12 * time.Second
)

func parseImageryXYZ(path string) (z, x, y int, ok bool) {
	p := strings.TrimPrefix(path, "/imagery/")
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
	if !strings.HasSuffix(parts[2], ".jpg") {
		return 0, 0, 0, false
	}
	yStr := strings.TrimSuffix(parts[2], ".jpg")
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
	if z < 0 || z > 15 || x < 0 || y < 0 {
		return 0, 0, 0, false
	}
	n := 1 << uint(z)
	if x >= n || y >= n {
		return 0, 0, 0, false
	}
	return z, x, y, true
}

func imageryURL(template string, z, x, y int) (string, error) {
	if template == "" {
		template = defaultImageryTemplate
	}
	if z < 0 || z > 15 || x < 0 || y < 0 {
		return "", fmt.Errorf("imagery: bad xyz")
	}
	raw := fmt.Sprintf(template, z, y, x)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("imagery: bad url")
	}
	return u.String(), nil
}

func (s *Server) handleImagery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.cfg.ImageryEnabled {
		http.NotFound(w, r)
		return
	}
	z, x, y, ok := parseImageryXYZ(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	src, err := imageryURL(s.cfg.ImageryTemplate, z, x, y)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	pinned, err := url.Parse(src)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	client := &http.Client{
		Timeout: imageryTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Host != pinned.Host {
				return http.ErrUseLastResponse
			}
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, src, nil)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	req.Header.Set("User-Agent", "gulf-seafloor-viewer/0.2 (public-tile-proxy)")
	req.Header.Set("Accept", "image/jpeg,image/png,image/*;q=0.8")

	res, err := client.Do(req)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		http.NotFound(w, r)
		return
	}
	ctype := res.Header.Get("Content-Type")
	if !strings.HasPrefix(ctype, "image/jpeg") && !strings.HasPrefix(ctype, "image/jpg") && !strings.HasPrefix(ctype, "image/png") {
		http.NotFound(w, r)
		return
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, imageryMaxBytes+1))
	if err != nil || len(body) == 0 || len(body) > imageryMaxBytes {
		http.NotFound(w, r)
		return
	}

	outType := "image/jpeg"
	if strings.HasPrefix(ctype, "image/png") {
		outType = "image/png"
	}
	w.Header().Set("Content-Type", outType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
