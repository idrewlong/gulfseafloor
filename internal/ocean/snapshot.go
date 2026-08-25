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
func EncodeManifest(c Currents, b Buoys, retrieved time.Time) Manifest {
	cv := c.ValidTime.UTC()
	bv := b.ValidTime.UTC()
	return Manifest{
		RetrievedAt: retrieved.UTC(),
		Currents: LayerInfo{
			Present:   true,
			ValidTime: &cv,
		},
		Buoys: LayerInfo{
			Present:   true,
			ValidTime: &bv,
			Count:     len(b.Stations),
		},
		Attribution: []string{
			"HYCOM consortium; dataset " + c.Source.Dataset,
			"NDBC / NOAA. Not an official NOAA product.",
		},
	}
}

// WriteSnapshot validates currents and buoys JSON, then atomically replaces
// dir. A validation or swap error leaves the previous snapshot unchanged.
func WriteSnapshot(dir string, c Currents, b Buoys, retrieved time.Time) error {
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
	mJSON, err := json.MarshalIndent(EncodeManifest(c, b, retrieved), "", "  ")
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
