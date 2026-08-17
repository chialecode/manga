# ADR 0001: Dependency admission and TypeScript baseline

- Status: accepted
- Date: 2026-08-13

## Decision

Dependencies follow `docs/dev-rules/dependency-admission.md`: only format or numerical kernels,
platform primitives, language/build tooling, and accessibility primitives are admissible. Phase 1
uses TypeScript 6.0.3 with typescript-eslint 8.67.0.

## V5 evidence

On 2026-08-13, a clean `pnpm install` with TypeScript 7.0.2 and typescript-eslint 8.67.0 failed
strict peer-dependency validation. The parser and project-service packages declare TypeScript
support as `>=4.8.4 <6.1.0`. The required type-aware lint chain therefore cannot use TypeScript 7.

Re-evaluate after typescript-eslint declares TypeScript 7 support. Until then, 6.0.3 is the newest
compatible exact release and `@typescript-eslint/no-floating-promises` remains enabled as an error.

## Consequences

The repository gets a supported type-aware lint pipeline. Upgrading TypeScript requires an isolated
change that proves install, typecheck, and lint all pass without suppressing peer checks.
