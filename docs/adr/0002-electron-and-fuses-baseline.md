# ADR 0002: Electron and Fuses baseline

- Status: accepted
- Date: 2026-08-13

Electron is pinned to 43.4.0 and reviewed on an eight-week cadence. All eight documented Fuses are
set explicitly and verified from packaged artifacts. Upgrades are isolated changes.

`@electron-forge/plugin-fuses` 7.11.2 declares the stale peer range `@electron/fuses ^1.0.0` while
the architecture baseline requires 2.1.3. pnpm permits only version 2.1.3 for that peer; strict peer
validation remains enabled globally. Remove the exception when Forge updates its peer metadata.
