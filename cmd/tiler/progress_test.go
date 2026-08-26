package main

import (
	"strings"
	"testing"
	"time"
)

func TestFormatProgressHasNoETABeforeTheFirstTile(t *testing.T) {
	got := formatProgress(0, 11665, 0)
	if !strings.Contains(got, "0/11665") {
		t.Fatalf("count: %q", got)
	}
	if strings.Contains(got, "left") {
		t.Fatalf("ETA with zero tiles is a divide-by-zero lie: %q", got)
	}
}

func TestFormatProgressEstimatesRemainingFromRate(t *testing.T) {
	// 1,166 tiles in 2 min → ~9.7/s → ~18 min for the remaining 10,499.
	got := formatProgress(1166, 11665, 2*time.Minute)
	if !strings.Contains(got, "1166/11665") {
		t.Fatalf("count: %q", got)
	}
	if !strings.Contains(got, "10%") {
		t.Fatalf("percent: %q", got)
	}
	if !strings.Contains(got, "~18m left") {
		t.Fatalf("eta: %q", got)
	}
}

func TestFormatProgressDoneReportsElapsed(t *testing.T) {
	got := formatProgress(11665, 11665, 21*time.Minute+4*time.Second)
	if !strings.Contains(got, "11665/11665") {
		t.Fatalf("count: %q", got)
	}
	if !strings.Contains(got, "in 21m4s") {
		t.Fatalf("elapsed: %q", got)
	}
	if strings.Contains(got, "left") {
		t.Fatalf("finished job should not estimate remaining: %q", got)
	}
}
