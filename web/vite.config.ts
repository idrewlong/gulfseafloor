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

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
  },
  plugins: [serveLocalTiles()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
