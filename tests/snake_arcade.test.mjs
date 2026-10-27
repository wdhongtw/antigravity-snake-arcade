/**
 * @fileoverview Standalone unit & integration test suite for Snake Arcade
 * (`SnakeStore` persistence and `createSnakeSidecarApp` HTTP contract).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnakeSidecarApp } from '../sidecars/snake_ui/main.mjs';
import { SnakeStore } from '../lib/snake_store.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}:`, err);
  }
}

await test('SnakeStore records runs, updates high scores, leaderboard, and settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snake-test-'));
  try {
    const file = join(dir, 'state.json');
    const store = new SnakeStore(file);

    const initial = store.getState();
    assert.equal(initial.highScores.classic, 0);
    assert.equal(initial.stats.gamesPlayed, 0);

    const r1 = store.recordRun({
      mode: 'classic',
      score: 420,
      length: 14,
      apples: 10,
      goldenApples: 1,
      powerUps: 2,
      maxCombo: 2.5,
      durationSec: 48,
      cause: 'WALL IMPACT',
    });
    assert.equal(r1.isNewRecord, true);
    assert.equal(r1.state.highScores.classic, 420);
    assert.equal(r1.state.stats.gamesPlayed, 1);
    assert.equal(r1.state.stats.longestSnake, 14);
    assert.equal(r1.state.leaderboard.length, 1);

    const r2 = store.recordRun({
      mode: 'classic',
      score: 210,
      length: 9,
      apples: 7,
      maxCombo: 1.5,
      durationSec: 25,
    });
    assert.equal(r2.isNewRecord, false);
    assert.equal(r2.state.highScores.classic, 420);
    assert.equal(r2.state.leaderboard[0].score, 420);

    // Reload from disk to verify atomic persistence
    const reloaded = new SnakeStore(file);
    assert.equal(reloaded.getState().highScores.classic, 420);
    assert.equal(reloaded.getState().stats.gamesPlayed, 2);

    reloaded.updateSettings({ mode: 'maze', speedPreset: 'turbo', soundEnabled: false });
    assert.equal(reloaded.getState().settings.mode, 'maze');
    assert.equal(reloaded.getState().settings.speedPreset, 'turbo');
    assert.equal(reloaded.getState().settings.soundEnabled, false);

    const afterReset = reloaded.resetScores();
    assert.equal(afterReset.highScores.classic, 0);
    assert.equal(afterReset.leaderboard.length, 0);
    assert.equal(afterReset.settings.mode, 'maze');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('Sidecar HTTP server serves /, /aux, static assets, and token-protected POST APIs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snake-http-'));
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'test-secret-token';
  try {
    const { app } = createSnakeSidecarApp({
      storagePath: join(dir, 'scores.json'),
      allowDefaultPort: true,
    });
    const server = await app.run();
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // GET / (SIDECAR_UI_ENTRYPOINT_SIDEBAR)
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Snake Arcade'));

    // GET /aux (SIDECAR_UI_ENTRYPOINT_AUX_PANE)
    const auxRes = await fetch(`${baseUrl}/aux`);
    assert.equal(auxRes.status, 200);

    // GET /styles.css and /app.js
    const cssRes = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);
    const jsRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(jsRes.status, 200);

    // POST /api/run without token -> 401
    const unauthRes = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'wrap', score: 880, length: 19 }),
    });
    assert.equal(unauthRes.status, 401);

    // POST /api/run with wrong token length -> 401
    const wrongLenRes = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'short',
      },
      body: JSON.stringify({ mode: 'wrap', score: 880, length: 19 }),
    });
    assert.equal(wrongLenRes.status, 401);

    // POST /api/run with malformed JSON -> 400
    const badJsonRes = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'test-secret-token',
      },
      body: '{bad json',
    });
    assert.equal(badJsonRes.status, 400);

    // POST /api/run with valid X-Sidecar-Token -> 200
    const authRes = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'test-secret-token',
      },
      body: JSON.stringify({ mode: 'wrap', score: 880, length: 19, maxCombo: 3.0 }),
    });
    assert.equal(authRes.status, 200);
    const authJson = await authRes.json();
    assert.equal(authJson.highScores.wrap, 880);

    await app.close();
  } finally {
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} test(s) passed.`);
}
