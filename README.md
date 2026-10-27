# Snake Arcade (`snake-arcade`)

Interactive arcade Snake game UI plugin for the **Extensions** sidebar (`SIDECAR_UI_ENTRYPOINT_SIDEBAR`) and per-conversation **Auxiliary Pane** (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).

## Key Features

- **Dual UI Entrypoints**:
  - **Sidebar Full-Pane View (`SIDECAR_UI_ENTRYPOINT_SIDEBAR`)**: Registers under the left sidebar's **Extensions** section (`/`) and opens as a full-pane arcade cabinet view.
  - **Auxiliary Pane View (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)**: Opens at `/aux` inside the conversation side panel so you can play alongside an active chat session.
- **Game Modes**:
  - **Classic**: Solid perimeter walls where movement pace scales up as your snake grows.
  - **Wrap**: Portal edges that wrap seamlessly across opposite sides of the arena.
  - **Maze**: Symmetrical interior barrier blocks with a `+25%` score bonus.
  - **90s Blitz**: 90-second score attack with dual core apples and rapid item spawns.
- **Combo Streak & Arena Items**:
  - **Combo Streak Window (`4.2s`)**: Chain apples before the streak bar drains to scale your multiplier from `1.0x` up to `4.0x`.
  - **Core Apple**: `+10 * combo` points, `+1` length.
  - **Golden Apple**: Timed bonus worth `+50 * combo` points, `+2` length.
  - **Overdrive**: Temporary `2x` score multiplier for `8s`.
  - **Chrono Frost**: Slows movement pace by `30%` for `6s`.
- **Responsive Controls & Web Audio**:
  - `Arrow Keys`, `WASD`, or `HJKL` (Vim) directional controls with a 2-step turn input queue, plus on-screen D-Pad and touch/pointer swipe gestures.
  - Procedural Web Audio synthesizer SFX (`M` to mute/unmute) and automatic pause when switching browser tabs.
  - Crash-safe persistent per-mode high scores, top runs leaderboard, and career telemetry stored in `ANTIGRAVITY_EXECUTABLE_DATA_DIR`.

## Installation

Clone or symlink this repository into `~/.gemini/config/plugins/snake-arcade`:

```bash
git clone git@github.com:wdhongtw/snake-arcade.git ~/.gemini/config/plugins/snake-arcade
```

## Testing

Run the standalone unit and HTTP integration test suite with Node.js:

```bash
node tests/snake_arcade.test.mjs
```
