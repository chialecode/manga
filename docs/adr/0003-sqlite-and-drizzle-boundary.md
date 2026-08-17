# ADR 0003: SQLite and Drizzle boundary

- Status: accepted
- Date: 2026-08-13

Phase 1 uses better-sqlite3 13.0.3 for runtime access and drizzle-orm 0.45.2 only as the schema
type source. Runtime queries use prepared SQL. The native build uses node-gyp 13.0.1 because the
Forge-transitive node-gyp 10.2.0 does not recognize Visual Studio 18.

`packages/data` alone sets `skipLibCheck` because drizzle 0.45.2 publishes declarations for optional
Gel, MySQL, and SingleStore adapters whose peer types are absent, and several declarations are not
compatible with TypeScript 6 exact optional checks. Repository source remains fully checked. Remove
the exception when an admitted drizzle release typechecks without installing unrelated database
drivers.

## V3 evidence

better-sqlite3 embeds SQLite 3.53.4 with `ENABLE_FTS5`. The Phase 1 probe was also run in Electron's
main process:

```text
pnpm exec electron scripts/probes/electron-sqlite-fts5.cjs
{"electron":"43.4.0","node":"24.18.1","sqlite":"3.53.1","fts5":true}
```

The probe executes `CREATE VIRTUAL TABLE probe USING fts5(content)` against an in-memory
`node:sqlite` database. Electron 43.4.0 therefore provides a viable FTS5 fallback. Phase 1 retains
better-sqlite3; this result only closes the R3 fallback question.
