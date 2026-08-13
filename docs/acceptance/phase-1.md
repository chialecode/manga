# Phase 1 acceptance

- Date: 2026-08-13
- Branch: `phase-1-foundation`
- Host: Windows 11 x64
- Result: E1-E12 passed

## Exit conditions

| Exit | Evidence |
|---|---|
| E1 | `pnpm test:unit`: traversal suite rejected all 19 attack cases; zero attacks were accepted. |
| E2 | `pnpm test:guard`: 36/36 tests passed. `pnpm demo:guards` ran every authoritative guard in an isolated child process; all 16 returned a nonzero rejection. Machine-readable output is in `guard-counterexamples.json`. |
| E3 | A real `git commit` containing `packages/domain/src/index.ts -> node:fs` reached `.githooks/pre-commit` and was rejected by `module-boundary`. No hook bypass was used. |
| E4 | `electron-fuses read` on the final packaged exe reported the eight locked values. `csp-assert` parses both CSP arrays and compares every directive and its order exactly. |
| E5 | Final packaged dev exe, 20 valid samples: P95 235 ms (limit 1200 ms). See `../bench/0.0.1.json`. Benchmark mode did not register an OS protocol or create the normal profile roots. |
| E6 | `pnpm test:db`: 1000 random kills, committed 122447, `integrity=ok`, zombies 0, committed transactions lost 0. |
| E7 | `pnpm test:migration`: replay, schema, frozen hash, recovery, and index plans passed. |
| E8 | A tampered temporary FFmpeg copy was rejected with `ffmpeg.exe: sha256 mismatch`. The installed LGPL shared build and every runtime file hash passed. |
| E9 | RPC tests passed: cancellation stopped within 200 ms, credit backpressure remained bounded, and renderer errors contained no source path. |
| E10 | Fresh per-user install/start passed. Upgrade 0.0.1 to 0.0.2 preserved roaming and cache sentinels. A 0.0.1 downgrade attempt exited 2 and left 0.0.2 installed. All three uninstall choices were exercised: keep all, remove cache/logs/crashes only, remove all application-owned data. |
| E11 | V3 and V5 conclusions are in ADR 0003 and ADR 0001. Electron 43.4.0 / Node 24.18.1 / SQLite 3.53.1 accepted FTS5 DDL. |
| E12 | Stable and dev installed to separate lowercase directories, ran simultaneously, and each enforced one instance. Roaming data, local data, logs/crashes, AppUserModelId, protocol commands, install/uninstall identity, and single-instance state were isolated. Uninstalling dev preserved stable data and `manga://`; final uninstall removed each channel's protocol registration. |

## Additional gates

- `pnpm install --frozen-lockfile` ran `scripts/install-hooks.mjs` first in `postinstall` and set `core.hooksPath=.githooks`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:guard`, `pnpm test:migration`, `pnpm test:db`, `pnpm test:supervisor`, and final `pnpm make` passed.
- Supervisor restart timestamps demonstrated 1/2/4 second backoff followed by an open circuit. Killing the parent process removed both the test child and Job Object helper.
- Runtime identity literals exist only in `packages/contract/src/identity.ts`; the independent identity guard passed.
- No `sharp`, `@parcel/watcher`, `pdfjs-dist`, JASSUB, CodeMirror, or Radix dependency exists in workspace manifests or the lockfile.
- Renderer source is an empty HTML body and an empty TypeScript module. No application shell or other UI was implemented.
- Final machine cleanup found zero MANGA uninstall entries and neither OS protocol key; application-owned acceptance data was removed. No user media path was read or modified.
