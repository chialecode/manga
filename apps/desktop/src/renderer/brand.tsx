/** Local vector mark; shares the shell accent and does not fetch an external asset. */
export function MangaMark({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M13 5H9a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h4a5 5 0 0 0 5-5v-2" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <path d="M19 27h4a5 5 0 0 0 5-5v-4a5 5 0 0 0-5-5h-4a5 5 0 0 0-5 5v2" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <path d="m12 20 8-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
  </svg>;
}
