package server

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

// etagCache holds one marshalled JSON document and its ETag.
//
// Every live layer follows the same shape: a background refresher fetches on
// a ticker and publishes here, and the request path only ever reads memory or
// falls back to disk. Refresh never happens on the request path, so a stalled
// upstream can never become request latency.
//
// The currents layer owns one of these. The buoys
// layer needs its decoded struct published atomically alongside the bytes —
// the currents write-through reads it — so it keeps its own type rather than
// bolting a second lock onto this one.
type etagCache struct {
	mu   sync.RWMutex
	body []byte
	etag string
}

func newETagCache() *etagCache { return &etagCache{} }

// get reports the published document. An empty cache reports false, which is
// the caller's cue to fall back to the on-disk snapshot.
func (c *etagCache) get() ([]byte, string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.body) == 0 {
		return nil, "", false
	}
	return c.body, c.etag, true
}

// set publishes body and derives its ETag. The tag is the content hash, so a
// refresh that fetched identical bytes keeps the same tag and clients stay on
// their 304s.
func (c *etagCache) set(body []byte) {
	sum := sha256.Sum256(body)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.body = body
	c.etag = etagFor(sum)
}

// etagFor renders a content hash as a quoted ETag value.
func etagFor(sum [sha256.Size]byte) string {
	return `"` + hex.EncodeToString(sum[:]) + `"`
}
