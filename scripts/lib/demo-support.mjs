export function demonstrateRejection(guard, violations) {
  if (process.env.MANGA_DEMO_GUARD !== guard) return
  if (violations.length === 0) throw new Error(`${guard} accepted its counterexample`)
  process.stderr.write(`REJECTED ${guard}: ${violations.join('; ')}\n`)
  process.exitCode = 1
}
