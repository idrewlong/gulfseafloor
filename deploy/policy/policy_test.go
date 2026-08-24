package policy

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func TestOPAIfInstalled(t *testing.T) {
	opa, err := exec.LookPath("opa")
	if err != nil {
		t.Skip("opa not on PATH; Go fixture checks still run")
	}
	dir := policyDir(t)
	cmd := exec.Command(opa, "test", dir, "-v")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("opa test failed: %v\n%s", err, out)
	}
}

func TestNonCompliantManifestDenied(t *testing.T) {
	bad := loadFixture(t, "testdata/bad.json")
	violations := evaluate(bad)
	if len(violations) == 0 {
		t.Fatal("expected non-compliant Deployment to be denied")
	}
}

func TestCompliantManifestAllowed(t *testing.T) {
	good := loadFixture(t, "testdata/good.json")
	violations := evaluate(good)
	if len(violations) != 0 {
		t.Fatalf("expected compliant Deployment to pass, got %v", violations)
	}
}

func loadFixture(t *testing.T, rel string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(policyDir(t), rel))
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(b, &obj); err != nil {
		t.Fatal(err)
	}
	return obj
}

func policyDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller")
	}
	return filepath.Dir(file)
}

// evaluate mirrors the Rego required-field checks so `go test ./...`
// still proves a bad manifest is denied when opa is not installed.
func evaluate(obj map[string]any) []string {
	var msgs []string
	spec := podSpec(obj)
	if spec == nil {
		return []string{"missing pod spec"}
	}
	psc := asMap(spec["securityContext"])
	if !isBool(psc["runAsNonRoot"], true) {
		msgs = append(msgs, "pod runAsNonRoot")
	}
	if !isNumber(psc["runAsUser"], 65532) {
		msgs = append(msgs, "pod runAsUser")
	}
	seccomp := asMap(psc["seccompProfile"])
	if str(seccomp["type"]) != "RuntimeDefault" {
		msgs = append(msgs, "pod seccompProfile")
	}
	if isBool(spec["hostNetwork"], true) {
		msgs = append(msgs, "hostNetwork")
	}
	for _, raw := range asSlice(spec["containers"]) {
		c := asMap(raw)
		csc := asMap(c["securityContext"])
		name := str(c["name"])
		if !isBool(csc["runAsNonRoot"], true) {
			msgs = append(msgs, name+": runAsNonRoot")
		}
		if !isNumber(csc["runAsUser"], 65532) {
			msgs = append(msgs, name+": runAsUser")
		}
		if !isBool(csc["allowPrivilegeEscalation"], false) {
			msgs = append(msgs, name+": allowPrivilegeEscalation")
		}
		if !isBool(csc["readOnlyRootFilesystem"], true) {
			msgs = append(msgs, name+": readOnlyRootFilesystem")
		}
		if !dropAll(csc) {
			msgs = append(msgs, name+": capabilities.drop ALL")
		}
		cseccomp := asMap(csc["seccompProfile"])
		if str(cseccomp["type"]) != "RuntimeDefault" {
			msgs = append(msgs, name+": seccompProfile")
		}
		if isBool(csc["privileged"], true) {
			msgs = append(msgs, name+": privileged")
		}
	}
	return msgs
}

func podSpec(obj map[string]any) map[string]any {
	if str(obj["kind"]) == "Deployment" {
		spec := asMap(obj["spec"])
		tmpl := asMap(spec["template"])
		return asMap(tmpl["spec"])
	}
	return asMap(obj["spec"])
}

func dropAll(csc map[string]any) bool {
	caps := asMap(csc["capabilities"])
	for _, d := range asSlice(caps["drop"]) {
		if str(d) == "ALL" {
			return true
		}
	}
	return false
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func isBool(v any, want bool) bool {
	b, ok := v.(bool)
	return ok && b == want
}

func isNumber(v any, want int) bool {
	switch n := v.(type) {
	case float64:
		return int(n) == want
	case json.Number:
		i, err := n.Int64()
		return err == nil && int(i) == want
	case int:
		return n == want
	case string:
		i, err := strconv.Atoi(n)
		return err == nil && i == want
	default:
		return false
	}
}
