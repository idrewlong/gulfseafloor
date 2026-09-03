package ocean

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

var rename = os.Rename

// EncodeManifest builds the snapshot inventory for currents and buoys.
// currentsRetrieved is when THIS call fetched currents — always true, since
// callers only reach here after a successful currents fetch. buoysPresent
// and buoysRetrieved describe the buoys layer independently: a background
// currents-only refresh may have no buoys data to report at all (buoysPresent
// false), or may be write-through-ing a buoys snapshot it did not itself
// fetch (buoysRetrieved carries that layer's own, possibly older, retrieval
// time, or is nil if that time is unknown). This keeps the manifest from
// ever claiming a re-fetch that did not happen.
func EncodeManifest(c Currents, b Buoys, buoysPresent bool, currentsRetrieved time.Time, buoysRetrieved *time.Time) Manifest {
	cv := c.ValidTime.UTC()
	cr := currentsRetrieved.UTC()
	m := Manifest{
		// Legacy top-level field, kept for readers that predate per-layer
		// RetrievedAt. It mirrors the currents layer, which is the layer
		// every call to this function actually just retrieved.
		RetrievedAt: cr,
		Currents: LayerInfo{
			Present:     true,
			ValidTime:   &cv,
			RetrievedAt: &cr,
		},
		Buoys: LayerInfo{
			Present: buoysPresent,
		},
		Attribution: []string{
			"HYCOM consortium; dataset " + c.Source.Dataset,
			"NDBC / NOAA. Not an official NOAA product.",
		},
	}
	if buoysPresent {
		bv := b.ValidTime.UTC()
		m.Buoys.ValidTime = &bv
		m.Buoys.Count = len(b.Stations)
		if buoysRetrieved != nil {
			br := buoysRetrieved.UTC()
			m.Buoys.RetrievedAt = &br
		}
	}
	return m
}

// WriteSnapshot validates currents and buoys JSON, then atomically replaces
// dir. A validation or swap error leaves the previous snapshot unchanged.
// buoysPresent and buoysRetrieved feed EncodeManifest — see its doc comment.
func WriteSnapshot(dir string, c Currents, b Buoys, buoysPresent bool, retrieved time.Time, buoysRetrieved *time.Time) error {
	cJSON, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("ocean: snapshot: currents: %w", err)
	}
	if _, err := DecodeCurrents(bytes.NewReader(cJSON)); err != nil {
		return err
	}
	bJSON, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return fmt.Errorf("ocean: snapshot: buoys: %w", err)
	}
	if _, err := DecodeBuoys(bytes.NewReader(bJSON)); err != nil {
		return err
	}
	mJSON, err := json.MarshalIndent(EncodeManifest(c, b, buoysPresent, retrieved, buoysRetrieved), "", "  ")
	if err != nil {
		return fmt.Errorf("ocean: snapshot: manifest: %w", err)
	}
	if _, err := DecodeManifest(bytes.NewReader(mJSON)); err != nil {
		return err
	}

	parent := filepath.Dir(dir)
	if parent == "" {
		parent = "."
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("ocean: snapshot: %w", err)
	}
	tmp, err := os.MkdirTemp(parent, "ocean-new-*")
	if err != nil {
		return fmt.Errorf("ocean: snapshot: %w", err)
	}
	defer os.RemoveAll(tmp)

	files := []struct {
		name string
		data []byte
	}{
		{"currents.json", cJSON},
		{"buoys.json", bJSON},
		{"manifest.json", mJSON},
	}
	for _, f := range files {
		if err := writeFileSync(filepath.Join(tmp, f.name), f.data); err != nil {
			return fmt.Errorf("ocean: snapshot: %w", err)
		}
	}
	if err := replaceDir(tmp, dir); err != nil {
		return fmt.Errorf("ocean: snapshot: %w", err)
	}
	return nil
}

// DecodeCurrentsFile opens path and runs DecodeCurrents.
func DecodeCurrentsFile(path string) (Currents, error) {
	f, err := os.Open(path)
	if err != nil {
		return Currents{}, err
	}
	defer f.Close()
	return DecodeCurrents(f)
}

// DecodeBuoysFile opens path and runs DecodeBuoys.
func DecodeBuoysFile(path string) (Buoys, error) {
	f, err := os.Open(path)
	if err != nil {
		return Buoys{}, err
	}
	defer f.Close()
	return DecodeBuoys(f)
}

// DecodeManifestFile opens path and runs DecodeManifest.
func DecodeManifestFile(path string) (Manifest, error) {
	f, err := os.Open(path)
	if err != nil {
		return Manifest{}, err
	}
	defer f.Close()
	return DecodeManifest(f)
}

func replaceDir(tmp, dir string) error {
	_, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return rename(tmp, dir)
		}
		return err
	}
	backup := filepath.Join(filepath.Dir(dir), "."+filepath.Base(dir)+"-old-"+filepath.Base(tmp))
	if err := rename(dir, backup); err != nil {
		return err
	}
	if err := rename(tmp, dir); err != nil {
		if rb := rename(backup, dir); rb != nil {
			return fmt.Errorf("%w (rollback: %v)", err, rb)
		}
		return err
	}
	os.RemoveAll(backup)
	return nil
}

func writeFileSync(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
