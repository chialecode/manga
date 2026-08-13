export function releaseArtifactViolations(source) {
  const forbidden = ['APP_STARTUP_MARKER', 'Startup benchmark support is not present']
  return forbidden.filter((value) => source.includes(value)).map((value) => `release bundle contains ${value}`)
}
