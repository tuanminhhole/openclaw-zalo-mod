## [2.4.14] - 2026-05-06

### Changed
- Keep private architecture notes out of Git and ClawHub packages while retaining the runtime hook activation fix.

## [2.4.13] - 2026-05-06

### Fixed
- Force `zalo-mod` into the OpenClaw gateway startup plugin plan with `activation.onStartup` and `activation.onCapabilities: ["hook"]`, so `before_dispatch` is registered before Zalo messages reach the model.
- Fix permission self-healing to keep directories at `755` and files at `644`; the previous chmod pass could make `node_modules/` and `data/` non-traversable after plugin load.

### Docs
- Updated `docs/ARCHITECTURE.md` to match the verified OpenClaw v2026.5.4 behavior: successful startup now shows `4 plugins: browser, memory-core, zalo-mod, zalouser`.

## [2.4.11] - 2026-05-06

### Fixed
- OpenClaw v2026.5.x compatibility: removed deprecated `kind: "runtime"` from `definePluginEntry` and `openclaw.plugin.json`.
- Auto-fix world-writable permissions caused by Windows bind mounts with pure Node `fs.chmodSync`.
- Improved `_openclawHome` path resolution for both `extensions/` and legacy `npm/node_modules/` install paths.
- Added fallback hooks with `before_model_resolve` and `before_agent_reply` for the `im admin` command.

### Changed
- Plugin must be installed with `openclaw plugins install` inside Docker so the `openclaw` peer dependency symlink points at the container runtime.

## [2.4.10] - 2026-05-05

### Fixed
- Added `.clawhubignore` so ClawHub packaging skips development-only files.

## [2.4.9] - 2026-05-05

### Fixed
- Kept runtime ID `zalo-mod` for ClawHub compatibility while package name remains `openclaw-zalo-mod`.
- Setup script migrates wrong config entry `openclaw-zalo-mod` to runtime entry `zalo-mod`.

## [2.4.8] - 2026-05-05

### Fixed
- Changed `package.json.name` back to `openclaw-zalo-mod` so ClawHub publishes under the correct package ID.

## [2.4.7] - 2026-05-05

### Fixed
- Synchronized plugin ID across runtime, setup script, and docs.

## [2.4.6] - 2026-05-05

### Added
- Added `bump-version.js` to synchronize versions.
- Added `.agent/workflows/update.md`.
- Added `i'm admin` owner claim support.

### Removed
- Removed `PUBLISHING.md`.
