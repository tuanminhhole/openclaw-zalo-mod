## [2.4.11] - 2026-05-06

### Fixed
- **OpenClaw v2026.5.x compatibility**: Removed deprecated kind: 'runtime' from definePluginEntry and openclaw.plugin.json (PluginKind only accepts memory|context-engine in v2026.5.x).
- **Auto-fix 777 permissions**: Plugin now self-heals world-writable permissions caused by Windows bind-mount, using pure s.chmodSync (no child_process, ClawHub-safe).
- **_openclawHome path resolution**: Improved to handle both extensions/ and legacy 
pm/node_modules/ install paths.
- **Fallback hooks**: Added efore_model_resolve + efore_agent_reply as backup interception path for "im admin" command in environments where efore_dispatch is unavailable.

### Changed
- Plugin must be installed via openclaw plugins install CLI (not manual copy) to correctly link openclaw peerDependency.

# CHANGELOG

## [2.4.10] - 2026-05-05
### Fixed
- Them `.clawhubignore` de ClawHub package khong upload file/dev folder khong can thiet.

## [2.4.9] - 2026-05-05
### Fixed
- Giu runtime ID `zalo-mod` theo rang buoc ClawHub, nhung package name van la `openclaw-zalo-mod`.
- Setup script migrate config entry sai `openclaw-zalo-mod` sang runtime entry `zalo-mod`.

## [2.4.8] - 2026-05-05
### Fixed
- Doi `package.json.name` ve `openclaw-zalo-mod` de ClawHub publish dung package ID.

## [2.4.7] - 2026-05-05
### Fixed
- Dong bo plugin ID thanh `openclaw-zalo-mod` trong runtime, setup script va docs.

## [2.4.6] - 2026-05-05
### Added
- ThÃªm script `bump-version.js` tá»± Ä‘á»™ng cáº­p nháº­t version.
- ThÃªm workflow `.agent/workflows/update.md` cho AI agent.
- Há»— trá»£ cÃ¢u lá»‡nh "i'm admin" Ä‘á»ƒ xÃ¡c nháº­n ownerId.

### Removed
- XÃ³a `PUBLISHING.md`.
