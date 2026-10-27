/**
 * @fileoverview Persistent high-score, run history, and settings store for Snake Arcade.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const VALID_MODES = ['classic', 'wrap', 'maze', 'blitz'];

export function createDefaultState() {
  return {
    highScores: {
      classic: 0,
      wrap: 0,
      maze: 0,
      blitz: 0,
    },
    stats: {
      gamesPlayed: 0,
      applesEaten: 0,
      goldenApplesEaten: 0,
      powerUpsCollected: 0,
      bestCombo: 1,
      longestSnake: 3,
      totalScore: 0,
    },
    leaderboard: [],
    recentRuns: [],
    settings: {
      mode: 'classic',
      speedPreset: 'normal',
      soundEnabled: true,
      screenShake: true,
      showGrid: true,
    },
  };
}

export class SnakeStore {
  #filePath;
  #state;

  constructor(storagePath) {
    const defaultDir =
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
      join(homedir(), '.gemini', 'sidecar_data', 'snake-arcade', 'data');
    this.#filePath = storagePath || join(defaultDir, 'snake_state.json');
    this.#state = this.#load();
  }

  get filePath() {
    return this.#filePath;
  }

  #load() {
    const base = createDefaultState();
    try {
      if (!existsSync(this.#filePath)) {
        return base;
      }
      const raw = JSON.parse(readFileSync(this.#filePath, 'utf-8'));
      return {
        highScores: { ...base.highScores, ...(raw.highScores || {}) },
        stats: { ...base.stats, ...(raw.stats || {}) },
        leaderboard: Array.isArray(raw.leaderboard) ? raw.leaderboard.slice(0, 15) : [],
        recentRuns: Array.isArray(raw.recentRuns) ? raw.recentRuns.slice(0, 15) : [],
        settings: { ...base.settings, ...(raw.settings || {}) },
      };
    } catch {
      return base;
    }
  }

  #save() {
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      const tmpPath = `${this.#filePath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(this.#state, null, 2), 'utf-8');
      renameSync(tmpPath, this.#filePath);
    } catch {
      // Ignore write failures in read-only environments
    }
  }

  getState() {
    return structuredClone(this.#state);
  }

  recordRun(runInput = {}) {
    const mode = VALID_MODES.includes(runInput.mode) ? runInput.mode : 'classic';
    const score = Math.max(0, Math.floor(Number(runInput.score) || 0));
    const length = Math.max(1, Math.floor(Number(runInput.length) || 3));
    const apples = Math.max(0, Math.floor(Number(runInput.apples) || 0));
    const goldenApples = Math.max(0, Math.floor(Number(runInput.goldenApples) || 0));
    const powerUps = Math.max(0, Math.floor(Number(runInput.powerUps) || 0));
    const maxCombo = Math.max(1, Number(runInput.maxCombo) || 1);
    const durationSec = Math.max(0, Math.round(Number(runInput.durationSec) || 0));
    const cause = typeof runInput.cause === 'string' ? runInput.cause.slice(0, 32) : 'collision';

    const isNewRecord = score > (this.#state.highScores[mode] || 0);
    if (isNewRecord) {
      this.#state.highScores[mode] = score;
    }

    this.#state.stats.gamesPlayed += 1;
    this.#state.stats.applesEaten += apples;
    this.#state.stats.goldenApplesEaten += goldenApples;
    this.#state.stats.powerUpsCollected += powerUps;
    this.#state.stats.totalScore += score;
    if (maxCombo > this.#state.stats.bestCombo) {
      this.#state.stats.bestCombo = maxCombo;
    }
    if (length > this.#state.stats.longestSnake) {
      this.#state.stats.longestSnake = length;
    }

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      mode,
      score,
      length,
      apples,
      maxCombo,
      durationSec,
      cause,
      isNewRecord,
      timestamp: new Date().toISOString(),
    };

    this.#state.recentRuns = [entry, ...this.#state.recentRuns].slice(0, 15);
    if (score > 0) {
      this.#state.leaderboard = [...this.#state.leaderboard, entry]
        .sort((a, b) => b.score - a.score || b.length - a.length)
        .slice(0, 15);
    }

    this.#save();
    return {
      isNewRecord,
      entry,
      state: this.getState(),
    };
  }

  updateSettings(partial = {}) {
    const next = { ...this.#state.settings };
    if (VALID_MODES.includes(partial.mode)) {
      next.mode = partial.mode;
    }
    if (['chill', 'normal', 'turbo'].includes(partial.speedPreset)) {
      next.speedPreset = partial.speedPreset;
    }
    if (typeof partial.soundEnabled === 'boolean') {
      next.soundEnabled = partial.soundEnabled;
    }
    if (typeof partial.screenShake === 'boolean') {
      next.screenShake = partial.screenShake;
    }
    if (typeof partial.showGrid === 'boolean') {
      next.showGrid = partial.showGrid;
    }
    this.#state.settings = next;
    this.#save();
    return this.getState();
  }

  resetScores() {
    const currentSettings = { ...this.#state.settings };
    this.#state = createDefaultState();
    this.#state.settings = currentSettings;
    this.#save();
    return this.getState();
  }
}
