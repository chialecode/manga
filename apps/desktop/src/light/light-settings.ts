/**
 * The player's and reader's own settings in light open (volume, rate, subtitles; layout, fit, direction). They live in light open's own browser
 * profile (`<app data root>\light\runtime`), never in the library's settings.
 */
export function readLightSettings<T extends object>(kind: "video" | "comic", defaults: T): T {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`manga.light.${kind}`) ?? "null") as Partial<T> | null;
    return saved && typeof saved === "object" ? { ...defaults, ...saved } : defaults;
  } catch {
    return defaults;
  }
}

export function writeLightSettings(kind: "video" | "comic", value: object): void {
  try { window.localStorage.setItem(`manga.light.${kind}`, JSON.stringify(value)); } catch { /* the next change writes it again */ }
}
