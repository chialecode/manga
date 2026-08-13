export const ERROR_CODES = ['invalid_input', 'cancelled', 'internal'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export type WireError = Readonly<{
  code: ErrorCode
  message: string
  retryable: boolean
  traceId: string
  details?: Readonly<Record<string, string | number | boolean>>
}>
