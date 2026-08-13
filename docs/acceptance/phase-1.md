# Phase 1 acceptance

- Date: 2026-08-13
- Branch: `phase-1-foundation`
- Result: **complete**

## Verified in this worktree

- E1: traversal/token suite includes existing outside-root targets, Unicode normalization, Windows 8.3 aliases, overlong paths, exact reserved-device rejection, valid redemption, and renewal.
- E2/E3: `pnpm demo:guards` rejected all 20 counterexamples with nonzero exits; evidence is in `guard-counterexamples.json`. The `no-bare-new-browserwindow` demonstration uses the member-expression bypass attempt `new electron.BrowserWindow({})`.
- Hook bootstrap: after temporarily pointing `core.hooksPath` at an invalid directory, `pnpm install --frozen-lockfile` ran `postinstall`, restored `.githooks`, and left both `pre-commit` and `pre-push` present. This demonstrates the first install after `git init` installs the hooks automatically.
- E4: packaged executable Fuses and both CSP strings pass repository guards.
- E6/E7: 1000 random kills passed with `integrity=ok`, zombies 0, lost transactions 0. The crash harness calls the production `recoverExpiredTasks` function and asserts a positive recovered count before checking for zero running tasks. Migration replay, freeze, validation, Online Backup, and three-backup retention passed.
- E8: pinned LGPL FFmpeg manifest and installed hashes pass; tampering counterexamples are rejected.
- E9: real Electron renderer/preload/main smoke ran for 60 seconds with one chunk consumed every 500 ms. Host cancellation was 0 ms, chunks stayed 3 to 3 after cancel, host RSS growth was 0 bytes, and renderer traceId matched the local host log. The slow stream received 144 and consumed 120 chunks, proving that client credit replenishment continued beyond the initial 32-credit window. See `../bench/rpc-e9.json`.
- M1.4 Range: 32 production `mediaResponse` calls streamed 2 GiB through 64 MiB Range responses. Throughput and request-setup latency both passed their 400 MB/s and 2 ms thresholds; see `../bench/range-0.0.1.json`.
- Packaged utility smoke: ordinary packaged dev build launched the supervised Electron `svc-db`, created `data.sqlite`, and passed SQLite `integrity_check: ok` (`node scripts/smoke/packaged-svc-db.mjs`).
- E5: a dedicated `BUILD_STARTUP_BENCHMARK=1` package was measured with 20 real Windows launches; P95 was 229 ms against the 1200 ms threshold (`../bench/0.0.1.json`).
- E12: stable and dev installers both returned exit `0` into distinct roots and created separate uninstall entries. Both installed executables ran concurrently; each channel's second launch exited while both first instances remained alive. They created separate databases, registered `manga://` and `manga-dev://` to the corresponding installed executable, and `Get-StartApps` reported stable AppID `app.manga.desktop`. After uninstalling dev with `/DATA=all`, the stable process, executable, database, and `manga://` registration remained while the dev scheme was removed. The earlier packaged-root smoke independently confirms isolated `APPDATA`/`LOCALAPPDATA` behavior (`node scripts/smoke/channel-isolation.mjs`).
- E10: real Windows 11 per-user NSIS matrix passed in isolated roots. 0.0.1 install exit `0`; 0.0.2 install exit `0`, registry version `0.0.2`, and a pre-existing data marker remained; attempting the 0.0.1 installer afterward returned exit `2` (downgrade rejected). Uninstall `/DATA=keep` removed the application and preserved the marker; `/DATA=cache` removed cache/log markers while preserving the database marker; `/DATA=all` removed both local and roaming application-owned markers. User media paths were not in scope and were not touched.
- E11: V3 and V5 conclusions remain recorded in ADR 0003 and ADR 0001.
- Network isolation uses a structured, reason-bearing allowlist containing only the user-triggered signed updater transport. A temporary second outbound source is rejected by the guard test.
- The renderer debug panel described in the original M1.1 deliverable was intentionally omitted to honor the Phase 1 no-UI boundary; the deviation and future typed/redacted diagnostic constraint are recorded in `../roadmap/phase-1-known-gaps.md`.
- Scope audit: renderer source is `export {}` and its HTML body is empty; no Phase 3+ dependency (`sharp`, `pdfjs-dist`, CodeMirror, Radix, JASSUB, or `@parcel/watcher`) occurs in any package manifest or the lockfile.
- Identity audit: the static identity guard and direct source-tree search found no application-name, appId, application-directory, or protocol literals outside `packages/contract/src/identity.ts`.

- Final verification: `pnpm test:all`, `pnpm test:db`, `pnpm test:migration`, `pnpm test:supervisor`, `pnpm demo:guards`, packaged utility smoke, channel-isolation smoke, and `pnpm --filter @manga/desktop make` all passed; the complete diff was reviewed with `git diff --check`.

No Phase 3 UI or dependencies were added. Renderer output remains an empty body.
