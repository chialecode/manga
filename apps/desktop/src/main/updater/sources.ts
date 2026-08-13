export type UpdateSources = Readonly<{ primary: URL; fallback: URL }>

export function updateSources(primary: string, fallback: string): UpdateSources {
  return { primary: new URL(primary), fallback: new URL(fallback) }
}
