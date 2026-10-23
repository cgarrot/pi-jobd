# Changelog

## 0.1.0 (unreleased)

- per-user detached job daemon (unix socket / state-scoped Windows named pipe, 0600)
- `run` / `status` / `list` / `log` / `stop` / `pause` / `resume`
- honest states: `running`, `paused`, `stopped`, `exited`, `failed`, `lost`
- adoption after a real daemon crash (pid + start token + boot id), identity
  re-checked before every signal; unprovable → `lost`; adopted exits keep
  `exitCode: null`
- Windows `taskkill /T`, `pause = not_supported` (experimental; CI ubuntu+macOS)
- remote control from pi-mesh via the local `mesh-ctl` event bus (`job_*`,
  owner must equal `PI_MESH_ALIAS`)
- 31 tests + real-process smoke + cross-package ctl smoke
