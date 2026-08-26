package main

import (
	"fmt"
	"math"
	"time"
)

func formatProgress(done, total int64, elapsed time.Duration) string {
	if total <= 0 {
		return "0/0 (0%) — starting"
	}
	if done <= 0 {
		return fmt.Sprintf("0/%d (0%%) — starting", total)
	}
	if done >= total {
		return fmt.Sprintf("%d/%d (100%%) in %s", total, total, formatElapsed(elapsed))
	}
	pct := int(math.Round(100 * float64(done) / float64(total)))
	if elapsed <= 0 {
		return fmt.Sprintf("%d/%d (%d%%)", done, total, pct)
	}
	remain := time.Duration(float64(total-done) / (float64(done) / elapsed.Seconds()) * float64(time.Second))
	return fmt.Sprintf("%d/%d (%d%%) ~%s left", done, total, pct, formatETA(remain))
}

func formatETA(d time.Duration) string {
	if d < time.Minute {
		s := int(math.Round(d.Seconds()))
		if s < 1 {
			return "<1s"
		}
		return fmt.Sprintf("%ds", s)
	}
	if d < time.Hour {
		m := int(math.Round(d.Minutes()))
		if m < 1 {
			return "<1m"
		}
		return fmt.Sprintf("%dm", m)
	}
	h := int(d.Hours())
	m := int(math.Round(d.Minutes())) % 60
	if m == 0 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dh%dm", h, m)
}

func formatElapsed(d time.Duration) string {
	d = d.Round(time.Second)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	switch {
	case h > 0 && m == 0 && s == 0:
		return fmt.Sprintf("%dh", h)
	case h > 0 && s == 0:
		return fmt.Sprintf("%dh%dm", h, m)
	case h > 0:
		return fmt.Sprintf("%dh%dm%ds", h, m, s)
	case m > 0 && s == 0:
		return fmt.Sprintf("%dm", m)
	case m > 0:
		return fmt.Sprintf("%dm%ds", m, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}
