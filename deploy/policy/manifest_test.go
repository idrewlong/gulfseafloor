package policy

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The shipped Deployment, as opposed to the JSON fixtures the OPA tests use.
// Nothing was reading this file, which is how it came to declare a read-only
// root filesystem while leaving the live layers' snapshot directories
// pointing at it.
func manifest(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(policyDir(t), "..", "k8s", "deployment.yaml"))
	if err != nil {
		t.Fatalf("read deployment.yaml: %v", err)
	}
	// Comments are stripped before scanning. The patterns below match
	// adjacent lines, and YAML lets a comment sit between any two of them —
	// which is not a difference this test should have an opinion about.
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

var (
	// Deliberately narrow scans rather than a YAML parse: this repo keeps a
	// three-module dependency set, and a parser earns its place in the
	// binary, not in one test. The patterns are anchored to the exact shapes
	// the manifest uses, and every one of them is asserted to match at least
	// once, so a reformat that breaks them fails loudly instead of silently
	// passing.
	envRe    = regexp.MustCompile(`(?m)^\s*- name: (GULF_\w+)\n\s*value: (\S+)`)
	mountRe  = regexp.MustCompile(`(?m)^\s*- name: (\S+)\n\s*mountPath: (\S+)`)
	volumeRe = regexp.MustCompile(`(?m)^\s{8}- name: (\S+)\n\s{10}(emptyDir|configMap|secret|persistentVolumeClaim):`)
)

func TestDeploymentGivesEveryWritableDirAVolume(t *testing.T) {
	m := manifest(t)

	if !strings.Contains(m, "readOnlyRootFilesystem: true") {
		t.Skip("root filesystem is not read-only; this invariant does not apply")
	}

	env := map[string]string{}
	for _, mt := range envRe.FindAllStringSubmatch(m, -1) {
		env[mt[1]] = strings.Trim(mt[2], `"`)
	}
	if len(env) == 0 {
		t.Fatal("no GULF_* env vars matched; the scan below is stale")
	}

	mountPaths := map[string]string{} // path -> volume name
	for _, mt := range mountRe.FindAllStringSubmatch(m, -1) {
		mountPaths[mt[2]] = mt[1]
	}
	if len(mountPaths) == 0 {
		t.Fatal("no volumeMounts matched; the scan above is stale")
	}

	volumes := map[string]bool{}
	for _, mt := range volumeRe.FindAllStringSubmatch(m, -1) {
		volumes[mt[1]] = true
	}
	if len(volumes) == 0 {
		t.Fatal("no volumes matched; the scan above is stale")
	}

	// Every directory the server writes through to. Left at their defaults
	// these resolve onto the read-only root: the ocean layers then lose
	// durability, and radar cannot create its frame directory at all, so the
	// weather layers report themselves permanently unavailable in the pod.
	for _, key := range []string{"GULF_OCEAN_DIR", "GULF_WEATHER_DIR"} {
		dir, ok := env[key]
		if !ok {
			t.Errorf("%s is unset, so it defaults onto the read-only root filesystem", key)
			continue
		}
		vol, mounted := mountPaths[dir]
		if !mounted {
			t.Errorf("%s=%s is not a volumeMount, so it is not writable", key, dir)
			continue
		}
		if !volumes[vol] {
			t.Errorf("%s=%s mounts volume %q, which is not declared", key, dir, vol)
		}
	}
}

// The tile pyramid is the opposite case and the comment in the manifest says
// so: it ships inside the image, and an emptyDir over it once served a chart
// with zero tiles. Guard against that being "fixed" back in.
func TestDeploymentDoesNotMaskTheBakedInTilePyramid(t *testing.T) {
	m := manifest(t)
	tileDir := ""
	for _, mt := range envRe.FindAllStringSubmatch(m, -1) {
		if mt[1] == "GULF_TILE_DIR" {
			tileDir = strings.Trim(mt[2], `"`)
		}
	}
	if tileDir == "" {
		t.Fatal("GULF_TILE_DIR is unset")
	}
	for _, mt := range mountRe.FindAllStringSubmatch(m, -1) {
		if mt[2] == tileDir {
			t.Errorf("a volume is mounted at %s; it would hide the pyramid baked into the image", tileDir)
		}
	}
}
