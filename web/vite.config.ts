import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const tileRoot = path.resolve(webRoot, '../data/tiles');

/** Serve `data/tiles/{z}/{x}/{y}.png` during `npm run dev` without the Go server. */
function serveLocalTiles(): Plugin {
  return {
    name: 'serve-local-tiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/tiles/')) {
          next();
          return;
        }

        const rel = decodeURIComponent(url.slice('/tiles/'.length).split('?')[0] ?? '');
        if (rel.includes('\0') || rel.split('/').includes('..')) {
          res.statusCode = 403;
          res.end();
          return;
        }

        const file = path.resolve(tileRoot, rel);
        if (!file.startsWith(tileRoot + path.sep) && file !== tileRoot) {
          res.statusCode = 403;
          res.end();
          return;
        }

        fs.readFile(file, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.end(data);
        });
      });
    },
  };
}

function vendorCesium(): Plugin {
  const src = path.resolve(webRoot, 'node_modules/cesium/Build/Cesium');
  const dirs = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

  return {
    name: 'vendor-cesium',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/cesium/')) {
          next();
          return;
        }
        const rel = decodeURIComponent(url.slice('/cesium/'.length).split('?')[0] ?? '');
        if (rel.includes('\0') || rel.split('/').includes('..')) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const file = path.resolve(src, rel);
        if (!file.startsWith(src + path.sep) && file !== src) {
          res.statusCode = 403;
          res.end();
          return;
        }
        fs.readFile(file, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const ext = path.extname(file).toLowerCase();
          const mime: Record<string, string> = {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.wasm': 'application/wasm',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.ktx2': 'image/ktx2',
            '.bin': 'application/octet-stream',
          };
          const type = mime[ext];
          if (type) {
            res.setHeader('Content-Type', type);
          }
          res.end(data);
        });
      });
    },
    closeBundle() {
      const dest = path.resolve(webRoot, 'dist/cesium');
      for (const dir of dirs) {
        fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
  },
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium/'),
  },
  optimizeDeps: {
    exclude: ['cesium'],
  },
  plugins: [serveLocalTiles(), vendorCesium()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
