/**
 * @fileoverview Snake Arcade Sidecar Backend Server.
 *
 * Serves the Snake Arcade UI for both `SIDECAR_UI_ENTRYPOINT_SIDEBAR` (`/`)
 * and `SIDECAR_UI_ENTRYPOINT_AUX_PANE` (`/aux`), and provides JSON API routes
 * for persisting high scores, leaderboards, run telemetry, and user settings.
 */

import { readFileSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpResponse, RawSidecarServer } from '../../lib/sidecar_http.mjs';
import { SnakeStore } from '../../lib/snake_store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

export function createSnakeSidecarApp({ storagePath, allowDefaultPort = false } = {}) {
  const app = new RawSidecarServer({ allowDefaultPort });
  const store = new SnakeStore(storagePath);

  const serveIndex = () => readFileSync(join(__dirname, 'index.html'), 'utf-8');
  app.page('/', serveIndex);
  app.page('/index.html', serveIndex);
  app.page('/aux', serveIndex);
  app.page('/sidebar', serveIndex);

  for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
    app.api(
      route,
      () => new HttpResponse(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
      'GET'
    );
  }

  app.api(
    '/api/state',
    async () => ({
      ok: true,
      ...store.getState(),
      timestamp: Date.now(),
    }),
    'GET'
  );

  app.api(
    '/api/run',
    async (data) => {
      const result = store.recordRun(data);
      return {
        ok: true,
        isNewRecord: result.isNewRecord,
        entry: result.entry,
        ...result.state,
      };
    },
    'POST'
  );

  app.api(
    '/api/settings',
    async (data) => {
      const state = store.updateSettings(data);
      return {
        ok: true,
        ...state,
      };
    },
    'POST'
  );

  app.api(
    '/api/reset',
    async () => {
      const state = store.resetScores();
      return {
        ok: true,
        ...state,
      };
    },
    'POST'
  );

  return { app, store };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { app } = createSnakeSidecarApp();

  watchFile(join(__dirname, 'main.mjs'), { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      process.exit(0);
    }
  }).unref();

  app.run();
}
