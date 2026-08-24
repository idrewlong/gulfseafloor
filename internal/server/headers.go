package server

import "net/http"

// Production CSP: same-origin scripts/styles/wasm/workers/img. No wildcard connect-src.
// Vite HMR is not in this policy — serve the built SPA, not the dev server.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self'; " +
	"connect-src 'self'; " +
	"worker-src 'self' blob:; " +
	"child-src 'self' blob:; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

// Tile URLs are not content-addressed, so `immutable` would pin a stale
// heightfield in the browser for a year every time the tiler is re-run. Cache
// hard but let the ETag revalidate.
const tileCacheControl = "public, max-age=600, stale-while-revalidate=86400"

func securityHeaders(next http.Handler, corsOrigin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		// Wildcard CORS is never set — even if an operator exports GULF_CORS_ORIGIN=*.
		if corsOrigin != "" && corsOrigin != "*" {
			h.Set("Access-Control-Allow-Origin", corsOrigin)
			h.Set("Vary", "Origin")
		}
		next.ServeHTTP(w, r)
	})
}
