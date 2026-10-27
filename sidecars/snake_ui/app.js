(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const uiToken = urlParams.get('token') || '';
  const LOCAL_STORAGE_KEY = 'snake_arcade_state_v1';

  const GRID_COUNT = 22;
  const COMBO_WINDOW_MS = 4200;

  const MODE_META = {
    classic: {
      label: 'CLASSIC',
      desc: 'Solid arena walls • Pace accelerates as your snake grows',
      wrapWalls: false,
      hasMaze: false,
      timeLimitSec: 0,
    },
    wrap: {
      label: 'WRAP',
      desc: 'Portal edges wrap across the arena • Watch out for your own tail',
      wrapWalls: true,
      hasMaze: false,
      timeLimitSec: 0,
    },
    maze: {
      label: 'MAZE',
      desc: 'Tactical barrier blocks inside the arena • +25% bonus score',
      wrapWalls: false,
      hasMaze: true,
      timeLimitSec: 0,
    },
    blitz: {
      label: '90s BLITZ',
      desc: '90-second score attack • Dual apples & rapid power-up spawns',
      wrapWalls: true,
      hasMaze: false,
      timeLimitSec: 90,
    },
  };

  const SPEED_PRESETS = {
    chill: { baseMs: 145, minMs: 75, stepMs: 1.6 },
    normal: { baseMs: 112, minMs: 56, stepMs: 1.9 },
    turbo: { baseMs: 84, minMs: 44, stepMs: 2.1 },
  };

  // Theme synchronization with host iframe
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;color:var(--background, #0d1016)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncThemeScheme();

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'theme-change') {
      const styles =
        data.payload?.cssVariables || data.theme?.styles || data.styles || {};
      const root = document.documentElement;
      for (const [k, v] of Object.entries(styles)) {
        if (k.startsWith('--') && typeof v === 'string') {
          root.style.setProperty(k, v);
        }
      }
      syncThemeScheme();
      renderFrame(performance.now());
    }
  });

  // Procedural Web Audio Synthesizer
  class ArcadeAudio {
    constructor() {
      this.ctx = null;
      this.enabled = true;
    }

    #ensureContext() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.ctx = new AudioCtx();
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    tone(freq, durationSec, { type = 'triangle', gain = 0.08, slideTo = null, delaySec = 0 } = {}) {
      const ctx = this.#ensureContext();
      if (!ctx) return;
      try {
        const start = ctx.currentTime + delaySec;
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);
        if (slideTo) {
          osc.frequency.exponentialRampToValueAtTime(slideTo, start + durationSec);
        }
        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.linearRampToValueAtTime(gain, start + 0.01);
        amp.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);
        osc.connect(amp);
        amp.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + durationSec + 0.015);
      } catch {
        // Ignore audio context restrictions
      }
    }

    playEat(comboCount) {
      const base = 420 + Math.min(comboCount, 10) * 38;
      this.tone(base, 0.08, { type: 'triangle', gain: 0.09, slideTo: base * 1.28 });
    }

    playGolden() {
      this.tone(523.25, 0.09, { type: 'sine', gain: 0.1 });
      this.tone(659.25, 0.09, { type: 'sine', gain: 0.1, delaySec: 0.07 });
      this.tone(783.99, 0.14, { type: 'sine', gain: 0.11, delaySec: 0.14 });
    }

    playPowerUp() {
      this.tone(360, 0.11, { type: 'sine', gain: 0.09, slideTo: 720 });
    }

    playTurn() {
      this.tone(190, 0.025, { type: 'sine', gain: 0.025 });
    }

    playCrash() {
      this.tone(180, 0.22, { type: 'sawtooth', gain: 0.09, slideTo: 58 });
      this.tone(120, 0.28, { type: 'triangle', gain: 0.08, slideTo: 45, delaySec: 0.08 });
    }
  }

  const sfx = new ArcadeAudio();

  // Persistent State & Settings
  const serverState = {
    highScores: { classic: 0, wrap: 0, maze: 0, blitz: 0 },
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
    settings: {
      mode: 'classic',
      speedPreset: 'normal',
      soundEnabled: true,
      screenShake: true,
      showGrid: true,
    },
  };

  function saveLocalFallback() {
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serverState));
    } catch {
      // Ignore storage quota / sandbox restrictions
    }
  }

  function loadLocalFallback() {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        applyServerState(JSON.parse(raw), false);
      }
    } catch {
      // Ignore storage access errors
    }
  }

  // Active Game Session State
  const game = {
    phase: 'idle', // 'idle' | 'running' | 'paused' | 'gameover'
    mode: 'classic',
    snake: [],
    prevSnake: [],
    dir: { x: 1, y: 0 },
    inputQueue: [],
    obstacles: new Set(),
    items: [], // { x, y, kind: 'apple' | 'golden' | 'overdrive' | 'frost', spawnedAt, expiresAt }
    particles: [],
    floatingTexts: [],
    score: 0,
    apples: 0,
    goldenApples: 0,
    powerUps: 0,
    comboCount: 0,
    comboMultiplier: 1.0,
    peakCombo: 1.0,
    comboExpiresAt: 0,
    overdriveUntil: 0,
    frostUntil: 0,
    startedAtMs: 0,
    elapsedBeforePauseMs: 0,
    pausedAtMs: 0,
    lastRunAtMs: 0,
    lastStepAtMs: 0,
    stepIntervalMs: 112,
    cellPx: 26,
    boardPx: 572,
  };

  // DOM References
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const canvasStage = document.getElementById('canvasStage');
  const stageOverlay = document.getElementById('stageOverlay');
  const overlayBadge = document.getElementById('overlayBadge');
  const overlayHeading = document.getElementById('overlayHeading');
  const overlayMessage = document.getElementById('overlayMessage');
  const overlaySummaryGrid = document.getElementById('overlaySummaryGrid');
  const summaryScore = document.getElementById('summaryScore');
  const summaryCombo = document.getElementById('summaryCombo');
  const summaryLength = document.getElementById('summaryLength');
  const btnOverlayPrimary = document.getElementById('btnOverlayPrimary');
  const btnOverlaySecondary = document.getElementById('btnOverlaySecondary');
  const statusBanner = document.getElementById('statusBanner');

  const hudScore = document.getElementById('hudScore');
  const hudActiveEffectTag = document.getElementById('hudActiveEffectTag');
  const hudHighScore = document.getElementById('hudHighScore');
  const hudModeLabel = document.getElementById('hudModeLabel');
  const hudComboCount = document.getElementById('hudComboCount');
  const hudComboMultiplier = document.getElementById('hudComboMultiplier');
  const hudComboBar = document.getElementById('hudComboBar');
  const hudLength = document.getElementById('hudLength');
  const hudApplesCount = document.getElementById('hudApplesCount');
  const hudFifthLabel = document.getElementById('hudFifthLabel');
  const hudPaceSub = document.getElementById('hudPaceSub');
  const hudFifthValue = document.getElementById('hudFifthValue');
  const modeDescriptionText = document.getElementById('modeDescriptionText');

  const btnToggleSound = document.getElementById('btnToggleSound');
  const btnPauseResume = document.getElementById('btnPauseResume');
  const btnRestartGame = document.getElementById('btnRestartGame');
  const btnToggleGrid = document.getElementById('btnToggleGrid');
  const btnToggleShake = document.getElementById('btnToggleShake');
  const btnResetScores = document.getElementById('btnResetScores');
  const leaderboardList = document.getElementById('leaderboardList');

  const statGamesPlayed = document.getElementById('statGamesPlayed');
  const statApplesEaten = document.getElementById('statApplesEaten');
  const statBestCombo = document.getElementById('statBestCombo');
  const statLongestSnake = document.getElementById('statLongestSnake');

  // Helper: API requests with Sidecar Token
  async function apiCall(path, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (uiToken) {
      headers['X-Sidecar-Token'] = uiToken;
    }
    const url = uiToken ? `${path}?token=${encodeURIComponent(uiToken)}` : path;
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function showBanner(text) {
    if (!statusBanner) return;
    statusBanner.textContent = text;
    statusBanner.classList.add('visible');
    clearTimeout(statusBanner._timer);
    statusBanner._timer = setTimeout(() => {
      statusBanner.classList.remove('visible');
    }, 2100);
  }

  function cellKey(x, y) {
    return `${x},${y}`;
  }

  function buildMazeObstacles() {
    const set = new Set();
    if (!MODE_META[game.mode]?.hasMaze) return set;

    // Symmetrical 4-quadrant L-barriers + central gates with clear lanes
    const coords = [
      // Top-left L
      [4, 4], [5, 4], [6, 4], [4, 5], [4, 6],
      // Top-right L
      [17, 4], [16, 4], [15, 4], [17, 5], [17, 6],
      // Bottom-left L
      [4, 17], [5, 17], [6, 17], [4, 16], [4, 15],
      // Bottom-right L
      [17, 17], [16, 17], [15, 17], [17, 16], [17, 15],
      // Mid-upper & mid-lower twin pillars
      [9, 7], [12, 7],
      [9, 14], [12, 14],
    ];
    for (const [x, y] of coords) {
      set.add(cellKey(x, y));
    }
    return set;
  }

  function isCellOccupied(x, y) {
    if (game.obstacles.has(cellKey(x, y))) return true;
    for (const seg of game.snake) {
      if (seg.x === x && seg.y === y) return true;
    }
    for (const item of game.items) {
      if (item.x === x && item.y === y) return true;
    }
    return false;
  }

  function findFreeCell() {
    const candidates = [];
    for (let y = 0; y < GRID_COUNT; y++) {
      for (let x = 0; x < GRID_COUNT; x++) {
        if (!isCellOccupied(x, y)) {
          candidates.push({ x, y });
        }
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function spawnItem(kind, nowMs) {
    const pos = findFreeCell();
    if (!pos) return false;
    let ttlMs = 0;
    if (kind === 'golden') ttlMs = 8500;
    else if (kind === 'overdrive' || kind === 'frost') ttlMs = 9500;

    game.items.push({
      x: pos.x,
      y: pos.y,
      kind,
      spawnedAt: nowMs,
      expiresAt: ttlMs > 0 ? nowMs + ttlMs : 0,
    });
    return true;
  }

  function ensureCoreApples(nowMs) {
    const targetAppleCount = game.mode === 'blitz' ? 2 : 1;
    const currentApples = game.items.filter((i) => i.kind === 'apple').length;
    for (let i = currentApples; i < targetAppleCount; i++) {
      if (!spawnItem('apple', nowMs)) {
        break;
      }
    }
  }

  function computeStepIntervalMs(nowMs) {
    const preset = SPEED_PRESETS[serverState.settings.speedPreset] || SPEED_PRESETS.normal;
    const extraSegments = Math.max(0, game.snake.length - 3);
    let interval = Math.max(preset.minMs, preset.baseMs - extraSegments * preset.stepMs);
    if (nowMs < game.frostUntil) {
      interval *= 1.35;
    }
    return interval;
  }

  function getActiveElapsedMs(nowMs) {
    if (game.phase === 'running') {
      return game.elapsedBeforePauseMs + (nowMs - game.lastRunAtMs);
    }
    return game.elapsedBeforePauseMs;
  }

  function resetArenaState() {
    const nowMs = performance.now();
    game.mode = serverState.settings.mode || 'classic';
    const startY = Math.floor(GRID_COUNT / 2);
    const startX = 6;
    game.snake = [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ];
    game.prevSnake = game.snake.map((s) => ({ ...s }));
    game.dir = { x: 1, y: 0 };
    game.inputQueue = [];
    game.obstacles = buildMazeObstacles();
    game.items = [];
    game.particles = [];
    game.floatingTexts = [];
    game.score = 0;
    game.apples = 0;
    game.goldenApples = 0;
    game.powerUps = 0;
    game.comboCount = 0;
    game.comboMultiplier = 1.0;
    game.peakCombo = 1.0;
    game.comboExpiresAt = 0;
    game.overdriveUntil = 0;
    game.frostUntil = 0;
    game.startedAtMs = nowMs;
    game.elapsedBeforePauseMs = 0;
    game.pausedAtMs = 0;
    game.lastRunAtMs = nowMs;
    game.lastStepAtMs = nowMs;
    game.stepIntervalMs = computeStepIntervalMs(nowMs);
    ensureCoreApples(nowMs);
    updateHud(nowMs);
  }

  function startNewRun() {
    resetArenaState();
    const nowMs = performance.now();
    game.phase = 'running';
    game.startedAtMs = nowMs;
    game.lastRunAtMs = nowMs;
    game.lastStepAtMs = nowMs;
    hideOverlay();
    btnPauseResume.textContent = 'Pause';
    renderFrame(nowMs);
  }

  function pauseRunningGame() {
    if (game.phase !== 'running') return;
    const nowMs = performance.now();
    game.elapsedBeforePauseMs += nowMs - game.lastRunAtMs;
    game.pausedAtMs = nowMs;
    game.phase = 'paused';
    btnPauseResume.textContent = 'Resume';
    showOverlay({
      badge: 'PAUSED',
      heading: 'Arena Paused',
      message: 'Press Space or click Resume to continue your current run.',
      showSummary: false,
      primaryLabel: 'Resume Run (Space)',
      showSecondary: true,
    });
  }

  function togglePause() {
    const nowMs = performance.now();
    if (game.phase === 'idle' || game.phase === 'gameover') {
      startNewRun();
      return;
    }
    if (game.phase === 'running') {
      pauseRunningGame();
    } else if (game.phase === 'paused') {
      const pauseDelta = Math.max(0, nowMs - (game.pausedAtMs || game.lastStepAtMs));
      if (game.comboExpiresAt > 0) game.comboExpiresAt += pauseDelta;
      if (game.overdriveUntil > 0) game.overdriveUntil += pauseDelta;
      if (game.frostUntil > 0) game.frostUntil += pauseDelta;
      for (const item of game.items) {
        if (item.expiresAt > 0) item.expiresAt += pauseDelta;
      }
      game.pausedAtMs = 0;
      game.lastRunAtMs = nowMs;
      game.lastStepAtMs = nowMs;
      game.phase = 'running';
      btnPauseResume.textContent = 'Pause';
      hideOverlay();
    }
  }

  // Automatically pause when switching browser tabs or hiding the iframe
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.phase === 'running') {
      pauseRunningGame();
    }
  });

  function showOverlay({
    badge,
    heading,
    message,
    showSummary = false,
    primaryLabel = 'Start Run (Space)',
    showSecondary = false,
  }) {
    overlayBadge.textContent = badge;
    overlayHeading.textContent = heading;
    overlayMessage.textContent = message;
    overlaySummaryGrid.style.display = showSummary ? 'grid' : 'none';
    btnOverlayPrimary.textContent = primaryLabel;
    btnOverlaySecondary.style.display = showSecondary ? 'inline-flex' : 'none';
    stageOverlay.classList.add('visible');
  }

  function hideOverlay() {
    stageOverlay.classList.remove('visible');
  }

  function triggerScreenShake() {
    if (!serverState.settings.screenShake) return;
    canvasStage.classList.remove('shake');
    void canvasStage.offsetWidth;
    canvasStage.classList.add('shake');
  }

  function spawnParticles(gridX, gridY, color, count = 12) {
    const cx = (gridX + 0.5) * game.cellPx;
    const cy = (gridY + 0.5) * game.cellPx;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
      const speed = 1.2 + Math.random() * 2.8;
      game.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 2 + Math.random() * 2.5,
        alpha: 1,
        color,
      });
    }
  }

  function spawnFloatingText(gridX, gridY, text, color) {
    game.floatingTexts.push({
      x: (gridX + 0.5) * game.cellPx,
      y: (gridY + 0.2) * game.cellPx,
      text,
      color,
      alpha: 1,
      vy: -0.75,
    });
  }

  async function finishRun(causeLabel, reasonDetail) {
    const nowMs = performance.now();
    game.elapsedBeforePauseMs += nowMs - game.lastRunAtMs;
    game.phase = 'gameover';
    btnPauseResume.textContent = 'Pause';
    sfx.playCrash();
    triggerScreenShake();

    const durationSec = Math.max(1, Math.round(game.elapsedBeforePauseMs / 1000));
    const prevBest = serverState.highScores[game.mode] || 0;
    const isLocalRecord = game.score > prevBest;
    if (isLocalRecord) {
      serverState.highScores[game.mode] = game.score;
    }

    summaryScore.textContent = game.score.toLocaleString();
    summaryCombo.textContent = `${game.peakCombo.toFixed(1)}x`;
    summaryLength.textContent = String(game.snake.length);

    showOverlay({
      badge: isLocalRecord ? 'NEW MODE RECORD!' : causeLabel,
      heading: isLocalRecord ? `New Best: ${game.score.toLocaleString()} pts` : 'Run Complete',
      message: reasonDetail,
      showSummary: true,
      primaryLabel: 'Play Again (Space)',
      showSecondary: false,
    });

    updateHud(nowMs);
    saveLocalFallback();

    try {
      const res = await apiCall('/api/run', 'POST', {
        mode: game.mode,
        score: game.score,
        length: game.snake.length,
        apples: game.apples,
        goldenApples: game.goldenApples,
        powerUps: game.powerUps,
        maxCombo: game.peakCombo,
        durationSec,
        cause: causeLabel,
      });
      applyServerState(res);
    } catch {
      // Offline / local fallback
    }
  }

  function queueDirection(nx, ny) {
    if (game.phase === 'idle') {
      startNewRun();
    }
    if (game.phase !== 'running') return;

    const lastDir =
      game.inputQueue.length > 0
        ? game.inputQueue[game.inputQueue.length - 1]
        : game.dir;

    // Ignore duplicate direction or 180-degree reversal
    if (lastDir.x === nx && lastDir.y === ny) return;
    if (lastDir.x + nx === 0 && lastDir.y + ny === 0) return;

    if (game.inputQueue.length < 2) {
      game.inputQueue.push({ x: nx, y: ny });
      sfx.playTurn();
    }
  }

  function stepSimulation(nowMs) {
    // Expire timed items
    game.items = game.items.filter((item) => item.expiresAt === 0 || nowMs < item.expiresAt);
    ensureCoreApples(nowMs);

    // Check combo expiration
    if (game.comboCount > 0 && nowMs >= game.comboExpiresAt) {
      game.comboCount = 0;
      game.comboMultiplier = 1.0;
    }

    // Check Blitz time limit
    const modeCfg = MODE_META[game.mode] || MODE_META.classic;
    if (modeCfg.timeLimitSec > 0) {
      const elapsedSec = getActiveElapsedMs(nowMs) / 1000;
      if (elapsedSec >= modeCfg.timeLimitSec) {
        finishRun('TIME UP', '90-second Blitz timer expired! Great hustle.');
        return;
      }
    }

    game.prevSnake = game.snake.map((s) => ({ ...s }));

    if (game.inputQueue.length > 0) {
      game.dir = game.inputQueue.shift();
    }

    const head = game.snake[0];
    let nextX = head.x + game.dir.x;
    let nextY = head.y + game.dir.y;

    if (modeCfg.wrapWalls) {
      nextX = (nextX + GRID_COUNT) % GRID_COUNT;
      nextY = (nextY + GRID_COUNT) % GRID_COUNT;
    } else if (nextX < 0 || nextX >= GRID_COUNT || nextY < 0 || nextY >= GRID_COUNT) {
      finishRun('WALL IMPACT', 'You clipped the perimeter wall of the arena.');
      return;
    }

    if (game.obstacles.has(cellKey(nextX, nextY))) {
      finishRun('BARRIER IMPACT', 'You collided with an interior maze barrier.');
      return;
    }

    // Check item at target cell
    const itemIdx = game.items.findIndex((i) => i.x === nextX && i.y === nextY);
    const eatenItem = itemIdx >= 0 ? game.items[itemIdx] : null;
    const growCount =
      eatenItem?.kind === 'golden' ? 2 : eatenItem?.kind === 'apple' ? 1 : 0;

    // Self collision check (excluding tail if it moves away this step)
    const bodyToCheck =
      growCount > 0 ? game.snake : game.snake.slice(0, game.snake.length - 1);
    for (const seg of bodyToCheck) {
      if (seg.x === nextX && seg.y === nextY) {
        finishRun('SELF COLLISION', 'Your snake ran into its own body trail.');
        return;
      }
    }

    // Advance snake head
    game.snake.unshift({ x: nextX, y: nextY });
    if (growCount === 0) {
      game.snake.pop();
    } else if (growCount === 2) {
      // Duplicate tail segment so snake grows by 2 total
      const tail = game.snake[game.snake.length - 1];
      game.snake.push({ ...tail });
    }

    if (eatenItem) {
      game.items.splice(itemIdx, 1);
      handleItemCollected(eatenItem, nowMs);
      if (game.items.length === 0 && !findFreeCell()) {
        finishRun('ARENA CLEARED!', 'Incredible — you filled every available cell in the arena!');
        return;
      }
    }

    game.stepIntervalMs = computeStepIntervalMs(nowMs);
  }

  function handleItemCollected(item, nowMs) {
    const isMazeBonus = game.mode === 'maze' ? 1.25 : 1.0;
    const isOverdrive = nowMs < game.overdriveUntil ? 2.0 : 1.0;

    if (item.kind === 'apple' || item.kind === 'golden') {
      if (nowMs < game.comboExpiresAt) {
        game.comboCount += 1;
      } else {
        game.comboCount = 1;
      }
      game.comboExpiresAt = nowMs + COMBO_WINDOW_MS;
      game.comboMultiplier = Math.min(4.0, 1.0 + (game.comboCount - 1) * 0.5);
      if (game.comboMultiplier > game.peakCombo) {
        game.peakCombo = game.comboMultiplier;
      }

      const basePts = item.kind === 'golden' ? 50 : 10;
      const pts = Math.round(
        basePts * game.comboMultiplier * isMazeBonus * isOverdrive
      );
      game.score += pts;

      if (item.kind === 'golden') {
        game.goldenApples += 1;
        sfx.playGolden();
        spawnParticles(item.x, item.y, '#f59e0b', 18);
        spawnFloatingText(item.x, item.y, `+${pts} GOLD!`, '#fbbf24');
      } else {
        game.apples += 1;
        sfx.playEat(game.comboCount);
        spawnParticles(item.x, item.y, '#f43f5e', 12);
        spawnFloatingText(item.x, item.y, `+${pts}`, '#fb7185');
      }

      ensureCoreApples(nowMs);

      // Chance to spawn Golden Apple or Power-Up
      const hasSpecial = game.items.some((i) => i.kind !== 'apple');
      if (!hasSpecial) {
        const roll = Math.random();
        if (game.apples % 5 === 0 || roll < 0.22) {
          spawnItem('golden', nowMs);
        } else if (roll < 0.36) {
          spawnItem(Math.random() < 0.55 ? 'overdrive' : 'frost', nowMs);
        }
      }
    } else if (item.kind === 'overdrive') {
      game.powerUps += 1;
      game.overdriveUntil = nowMs + 8000;
      game.comboExpiresAt = Math.max(game.comboExpiresAt, nowMs + COMBO_WINDOW_MS);
      const pts = Math.round(25 * game.comboMultiplier);
      game.score += pts;
      sfx.playPowerUp();
      spawnParticles(item.x, item.y, '#10b981', 16);
      spawnFloatingText(item.x, item.y, '2× OVERDRIVE!', '#34d399');
      showBanner('Overdrive Active: 2× Score for 8s');
    } else if (item.kind === 'frost') {
      game.powerUps += 1;
      game.frostUntil = nowMs + 6000;
      const pts = Math.round(20 * game.comboMultiplier);
      game.score += pts;
      sfx.playPowerUp();
      spawnParticles(item.x, item.y, '#0ea5e9', 16);
      spawnFloatingText(item.x, item.y, 'CHRONO FROST!', '#38bdf8');
      showBanner('Chrono Frost: Pace slowed 30% for 6s');
    }

    if (game.score > (serverState.highScores[game.mode] || 0)) {
      serverState.highScores[game.mode] = game.score;
    }
  }

  function updateHud(nowMs) {
    const modeCfg = MODE_META[game.mode] || MODE_META.classic;
    hudScore.textContent = game.score.toLocaleString();
    hudHighScore.textContent = (serverState.highScores[game.mode] || 0).toLocaleString();
    hudModeLabel.textContent = modeCfg.label;
    modeDescriptionText.textContent = modeCfg.desc;

    if (nowMs < game.overdriveUntil) {
      const rem = Math.ceil((game.overdriveUntil - nowMs) / 1000);
      hudActiveEffectTag.textContent = `2× (${rem}s)`;
      hudActiveEffectTag.style.color = '#34d399';
    } else if (nowMs < game.frostUntil) {
      const rem = Math.ceil((game.frostUntil - nowMs) / 1000);
      hudActiveEffectTag.textContent = `FROST (${rem}s)`;
      hudActiveEffectTag.style.color = '#38bdf8';
    } else {
      hudActiveEffectTag.textContent = '';
    }

    const comboActive = game.comboCount > 0 && nowMs < game.comboExpiresAt;
    const mult = comboActive ? game.comboMultiplier : 1.0;
    hudComboMultiplier.textContent = `${mult.toFixed(1)}x`;
    hudComboCount.textContent = comboActive ? `${game.comboCount} streak` : '0 streak';
    const comboPct = comboActive
      ? Math.max(0, Math.min(100, ((game.comboExpiresAt - nowMs) / COMBO_WINDOW_MS) * 100))
      : 0;
    hudComboBar.style.width = `${comboPct}%`;

    hudLength.textContent = String(game.snake.length);
    hudApplesCount.textContent = `${game.apples + game.goldenApples} eaten`;

    const preset = SPEED_PRESETS[serverState.settings.speedPreset] || SPEED_PRESETS.normal;
    const paceRatio = preset.baseMs / Math.max(40, game.stepIntervalMs);
    const level = 1 + Math.floor((game.snake.length - 3) / 4);

    if (modeCfg.timeLimitSec > 0) {
      const elapsedSec = getActiveElapsedMs(nowMs) / 1000;
      const remainSec = Math.max(0, Math.ceil(modeCfg.timeLimitSec - elapsedSec));
      hudFifthLabel.textContent = 'Time Left';
      hudPaceSub.textContent = `${paceRatio.toFixed(1)}× speed`;
      hudFifthValue.textContent = `${remainSec}s`;
    } else {
      hudFifthLabel.textContent = 'Pace';
      hudPaceSub.textContent = `Level ${level}`;
      hudFifthValue.textContent = `${paceRatio.toFixed(2)}x`;
    }
  }

  // Responsive High-DPI Canvas Sizing
  function resizeCanvas() {
    if (!canvasStage) return;
    const rect = canvasStage.getBoundingClientRect();
    if (rect.width <= 20 || rect.height <= 20) return;

    const avail = Math.min(rect.width - 20, rect.height - 20);
    const cellPx = Math.max(12, Math.floor(avail / GRID_COUNT));
    const boardPx = cellPx * GRID_COUNT;
    const dpr = window.devicePixelRatio || 1;

    game.cellPx = cellPx;
    game.boardPx = boardPx;

    canvas.style.width = `${boardPx}px`;
    canvas.style.height = `${boardPx}px`;
    canvas.width = Math.round(boardPx * dpr);
    canvas.height = Math.round(boardPx * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderFrame(performance.now());
  }

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(canvasStage);
  window.addEventListener('resize', resizeCanvas);

  function drawRoundedRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function renderFrame(nowMs) {
    const size = game.boardPx;
    const cell = game.cellPx;
    const isLight = document.documentElement.dataset.theme === 'light';

    // Arena surface fill
    ctx.fillStyle = isLight ? '#f3f5f8' : '#0b0e14';
    ctx.fillRect(0, 0, size, size);

    // Subtle checkerboard / coordinate cells when Grid option is active
    if (serverState.settings.showGrid) {
      ctx.fillStyle = isLight ? 'rgba(15, 23, 42, 0.03)' : 'rgba(255, 255, 255, 0.02)';
      for (let y = 0; y < GRID_COUNT; y++) {
        for (let x = 0; x < GRID_COUNT; x++) {
          if ((x + y) % 2 === 1) {
            ctx.fillRect(x * cell, y * cell, cell, cell);
          }
        }
      }
    }

    // Wrap mode portal border indicator
    if (MODE_META[game.mode]?.wrapWalls) {
      ctx.save();
      ctx.strokeStyle = isLight ? 'rgba(14, 165, 233, 0.35)' : 'rgba(56, 189, 248, 0.28)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(1, 1, size - 2, size - 2);
      ctx.restore();
    }

    // Maze Obstacles
    if (game.obstacles.size > 0) {
      for (const key of game.obstacles) {
        const [ox, oy] = key.split(',').map(Number);
        const px = ox * cell + 1.5;
        const py = oy * cell + 1.5;
        const pw = cell - 3;
        drawRoundedRect(px, py, pw, pw, 4);
        ctx.fillStyle = isLight ? '#cbd5e1' : '#262f3f';
        ctx.fill();
        ctx.strokeStyle = isLight ? '#94a3b8' : '#3b475e';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Field Items (Apples, Golden Apples, Power-Ups)
    for (const item of game.items) {
      const cx = (item.x + 0.5) * cell;
      const cy = (item.y + 0.5) * cell;
      const pulse = 1 + Math.sin(nowMs * 0.007) * 0.08;
      const r = cell * 0.38 * pulse;

      let fill = '#f43f5e';
      let ring = 'rgba(244, 63, 94, 0.28)';
      if (item.kind === 'golden') {
        fill = '#f59e0b';
        ring = 'rgba(245, 158, 11, 0.34)';
      } else if (item.kind === 'overdrive') {
        fill = '#10b981';
        ring = 'rgba(16, 185, 129, 0.34)';
      } else if (item.kind === 'frost') {
        fill = '#0ea5e9';
        ring = 'rgba(14, 165, 233, 0.34)';
      }

      // Outer pulse ring
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.28, 0, Math.PI * 2);
      ctx.fillStyle = ring;
      ctx.fill();

      // Core orb
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      // Specular highlight
      ctx.beginPath();
      ctx.arc(cx - r * 0.28, cy - r * 0.28, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.fill();

      // Countdown arc for timed items
      if (item.expiresAt > 0) {
        const total = item.expiresAt - item.spawnedAt;
        const rem = Math.max(0, item.expiresAt - nowMs);
        const frac = rem / total;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.42, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.strokeStyle = fill;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }

    // Snake Segments
    const len = game.snake.length;
    const isOverdrive = nowMs < game.overdriveUntil;
    const isFrost = nowMs < game.frostUntil;

    for (let i = len - 1; i >= 0; i--) {
      const seg = game.snake[i];
      const pad = i === 0 ? 1.2 : 2.1;
      const sx = seg.x * cell + pad;
      const sy = seg.y * cell + pad;
      const sw = cell - pad * 2;
      const radius = i === 0 ? Math.max(5, cell * 0.3) : Math.max(4, cell * 0.22);

      const ratio = 1 - (i / Math.max(1, len)) * 0.55;
      if (isOverdrive) {
        ctx.fillStyle = i === 0 ? '#fbbf24' : `rgba(245, 158, 11, ${0.45 + ratio * 0.55})`;
      } else if (isFrost) {
        ctx.fillStyle = i === 0 ? '#38bdf8' : `rgba(14, 165, 233, ${0.45 + ratio * 0.55})`;
      } else {
        ctx.fillStyle =
          i === 0
            ? '#34d399'
            : `rgba(16, 185, 129, ${0.42 + ratio * 0.58})`;
      }

      drawRoundedRect(sx, sy, sw, sw, radius);
      ctx.fill();

      // Draw expressive directional eyes on head segment
      if (i === 0) {
        const hx = (seg.x + 0.5) * cell;
        const hy = (seg.y + 0.5) * cell;
        const fwd = cell * 0.16;
        const side = cell * 0.18;
        const perpX = -game.dir.y;
        const perpY = game.dir.x;

        const e1x = hx + game.dir.x * fwd + perpX * side;
        const e1y = hy + game.dir.y * fwd + perpY * side;
        const e2x = hx + game.dir.x * fwd - perpX * side;
        const e2y = hy + game.dir.y * fwd - perpY * side;

        ctx.fillStyle = '#052e16';
        ctx.beginPath();
        ctx.arc(e1x, e1y, Math.max(1.8, cell * 0.085), 0, Math.PI * 2);
        ctx.arc(e2x, e2y, Math.max(1.8, cell * 0.085), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Particles
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.032;
      if (p.alpha <= 0) {
        game.particles.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Floating Score Popups
    for (let i = game.floatingTexts.length - 1; i >= 0; i--) {
      const ft = game.floatingTexts[i];
      ft.y += ft.vy;
      ft.alpha -= 0.024;
      if (ft.alpha <= 0) {
        game.floatingTexts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = ft.alpha;
      ctx.font = `700 ${Math.max(11, Math.round(cell * 0.48))}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.restore();
    }
  }

  // Main Animation & Simulation Loop
  function tickLoop(nowMs) {
    if (game.phase === 'running') {
      // Clamp frame delta to prevent uncontrolled fast-forward after frame stalls
      if (nowMs - game.lastStepAtMs > game.stepIntervalMs * 2.5) {
        game.lastStepAtMs = nowMs - game.stepIntervalMs;
      }
      let stepsThisFrame = 0;
      while (
        nowMs - game.lastStepAtMs >= game.stepIntervalMs &&
        game.phase === 'running' &&
        stepsThisFrame < 2
      ) {
        game.lastStepAtMs += game.stepIntervalMs;
        stepsThisFrame++;
        stepSimulation(nowMs);
      }
      updateHud(nowMs);
    }
    renderFrame(nowMs);
    requestAnimationFrame(tickLoop);
  }

  // Sync UI Controls & Leaderboard from Server State
  function applyServerState(data, persistFallback = true) {
    if (!data || typeof data !== 'object') return;
    if (data.highScores) {
      Object.assign(serverState.highScores, data.highScores);
    }
    if (data.stats) {
      Object.assign(serverState.stats, data.stats);
    }
    if (Array.isArray(data.leaderboard)) {
      serverState.leaderboard = data.leaderboard;
    }
    if (data.settings) {
      Object.assign(serverState.settings, data.settings);
    }
    if (persistFallback) {
      saveLocalFallback();
    }

    sfx.enabled = serverState.settings.soundEnabled !== false;
    btnToggleSound.textContent = sfx.enabled ? 'SFX: On' : 'SFX: Off';
    btnToggleSound.classList.toggle('btn-active', sfx.enabled);

    btnToggleGrid.classList.toggle('btn-active', serverState.settings.showGrid !== false);
    btnToggleShake.classList.toggle('btn-active', serverState.settings.screenShake !== false);

    // Sync mode tabs
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === serverState.settings.mode);
    });

    // Sync speed buttons
    document.querySelectorAll('#speedPresetGroup .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.speed === serverState.settings.speedPreset);
    });

    // Render Leaderboard safely via DOM nodes
    renderLeaderboard();

    // Render Lifetime Stats
    statGamesPlayed.textContent = String(serverState.stats.gamesPlayed || 0);
    statApplesEaten.textContent = String(
      (serverState.stats.applesEaten || 0) + (serverState.stats.goldenApplesEaten || 0)
    );
    statBestCombo.textContent = `${Number(serverState.stats.bestCombo || 1).toFixed(1)}x`;
    statLongestSnake.textContent = String(serverState.stats.longestSnake || 3);

    updateHud(performance.now());
  }

  function renderLeaderboard() {
    const list = serverState.leaderboard || [];
    leaderboardList.replaceChildren();

    if (list.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'Complete a run to record your score on the leaderboard.';
      leaderboardList.appendChild(hint);
      return;
    }

    for (const [idx, entry] of list.slice(0, 8).entries()) {
      const row = document.createElement('div');
      row.className = 'lb-row';

      const rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = `#${idx + 1}`;

      const main = document.createElement('div');
      main.className = 'lb-main';

      const scoreEl = document.createElement('span');
      scoreEl.className = 'lb-score';
      scoreEl.textContent = Number(entry.score || 0).toLocaleString();

      const tagEl = document.createElement('span');
      tagEl.className = 'lb-mode-tag';
      tagEl.textContent = MODE_META[entry.mode]?.label || entry.mode || 'CLASSIC';

      main.append(scoreEl, tagEl);

      const meta = document.createElement('span');
      meta.className = 'lb-meta';
      meta.textContent = `len ${Number(entry.length || 3)} • ${Number(entry.maxCombo || 1).toFixed(1)}x`;

      row.append(rank, main, meta);
      leaderboardList.appendChild(row);
    }
  }

  async function persistSettings(partial) {
    Object.assign(serverState.settings, partial);
    applyServerState(serverState);
    try {
      const res = await apiCall('/api/settings', 'POST', partial);
      applyServerState(res);
    } catch {
      // Ignore offline error
    }
  }

  function selectMode(newMode) {
    if (!MODE_META[newMode]) return;
    serverState.settings.mode = newMode;
    game.mode = newMode;
    persistSettings({ mode: newMode });
    if (game.phase === 'idle' || game.phase === 'gameover') {
      resetArenaState();
      showOverlay({
        badge: `${MODE_META[newMode].label} MODE`,
        heading: 'Snake Arcade',
        message: MODE_META[newMode].desc,
        showSummary: false,
        primaryLabel: 'Start Run (Space)',
      });
    } else {
      startNewRun();
    }
  }

  // Event Listeners (blur buttons on click so Spacebar never re-triggers focused buttons)
  document.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.currentTarget.blur();
      selectMode(btn.dataset.mode);
    });
  });

  document.querySelectorAll('#speedPresetGroup .seg-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.currentTarget.blur();
      const speedPreset = btn.dataset.speed;
      persistSettings({ speedPreset });
      game.stepIntervalMs = computeStepIntervalMs(performance.now());
      updateHud(performance.now());
    });
  });

  btnToggleSound.addEventListener('click', (e) => {
    e.currentTarget.blur();
    persistSettings({ soundEnabled: !serverState.settings.soundEnabled });
  });

  btnToggleGrid.addEventListener('click', (e) => {
    e.currentTarget.blur();
    persistSettings({ showGrid: !serverState.settings.showGrid });
  });

  btnToggleShake.addEventListener('click', (e) => {
    e.currentTarget.blur();
    persistSettings({ screenShake: !serverState.settings.screenShake });
  });

  btnPauseResume.addEventListener('click', (e) => {
    e.currentTarget.blur();
    togglePause();
  });

  btnRestartGame.addEventListener('click', (e) => {
    e.currentTarget.blur();
    startNewRun();
  });

  btnOverlayPrimary.addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (game.phase === 'paused') {
      togglePause();
    } else {
      startNewRun();
    }
  });

  btnOverlaySecondary.addEventListener('click', (e) => {
    e.currentTarget.blur();
    startNewRun();
  });

  btnResetScores.addEventListener('click', async (e) => {
    e.currentTarget.blur();
    serverState.highScores = { classic: 0, wrap: 0, maze: 0, blitz: 0 };
    serverState.leaderboard = [];
    serverState.stats = {
      gamesPlayed: 0,
      applesEaten: 0,
      goldenApplesEaten: 0,
      powerUpsCollected: 0,
      bestCombo: 1,
      longestSnake: 3,
      totalScore: 0,
    };
    applyServerState(serverState);
    try {
      const res = await apiCall('/api/reset', 'POST', {});
      applyServerState(res);
      showBanner('High scores and career stats reset');
    } catch {
      showBanner('High scores reset locally');
    }
  });

  // D-Pad Controls
  document.getElementById('dpadUp').addEventListener('click', (e) => {
    e.currentTarget.blur();
    queueDirection(0, -1);
  });
  document.getElementById('dpadDown').addEventListener('click', (e) => {
    e.currentTarget.blur();
    queueDirection(0, 1);
  });
  document.getElementById('dpadLeft').addEventListener('click', (e) => {
    e.currentTarget.blur();
    queueDirection(-1, 0);
  });
  document.getElementById('dpadRight').addEventListener('click', (e) => {
    e.currentTarget.blur();
    queueDirection(1, 0);
  });

  // Pointer / Touch Swipe on Canvas
  let pointerStart = null;
  canvas.addEventListener('pointerdown', (e) => {
    pointerStart = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!pointerStart) return;
    const dx = e.clientX - pointerStart.x;
    const dy = e.clientY - pointerStart.y;
    pointerStart = null;
    if (Math.hypot(dx, dy) < 18) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      queueDirection(dx > 0 ? 1 : -1, 0);
    } else {
      queueDirection(0, dy > 0 ? 1 : -1);
    }
  });

  // Keyboard Controls
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      return;
    }
    const key = e.key;
    if (key === 'ArrowUp' || key === 'w' || key === 'W' || key === 'k' || key === 'K') {
      e.preventDefault();
      queueDirection(0, -1);
    } else if (key === 'ArrowDown' || key === 's' || key === 'S' || key === 'j' || key === 'J') {
      e.preventDefault();
      queueDirection(0, 1);
    } else if (key === 'ArrowLeft' || key === 'a' || key === 'A' || key === 'h' || key === 'H') {
      e.preventDefault();
      queueDirection(-1, 0);
    } else if (key === 'ArrowRight' || key === 'd' || key === 'D' || key === 'l' || key === 'L') {
      e.preventDefault();
      queueDirection(1, 0);
    } else if (key === ' ') {
      e.preventDefault();
      togglePause();
    } else if (key === 'r' || key === 'R') {
      e.preventDefault();
      startNewRun();
    } else if (key === 'm' || key === 'M') {
      e.preventDefault();
      persistSettings({ soundEnabled: !serverState.settings.soundEnabled });
    } else if (game.phase !== 'running') {
      if (key === '1') selectMode('classic');
      else if (key === '2') selectMode('wrap');
      else if (key === '3') selectMode('maze');
      else if (key === '4') selectMode('blitz');
    }
  });

  // Initial Boot
  async function init() {
    loadLocalFallback();
    resetArenaState();
    resizeCanvas();
    try {
      const stateData = await apiCall('/api/state', 'GET');
      applyServerState(stateData);
      game.mode = serverState.settings.mode || 'classic';
      resetArenaState();
    } catch {
      // Continue with local fallback state
    }
    requestAnimationFrame(tickLoop);
  }

  init();
})();
