const CREDENTIAL_FIELD = /api.?key|token|secret|password|credential/i

function schemaFields(schema) {
  const shape = schema?._zod?.def?.shape
  if (!shape || typeof shape !== 'object') return []
  return Object.keys(shape)
}

export function ipcContractViolations(methods) {
  const violations = []
  for (const method of methods) {
    if (!method || typeof method !== 'object') {
      violations.push('registered method is not an object')
      continue
    }
    if (!('input' in method) || !method.input?.safeParse) violations.push(`${method.name ?? '<unknown>'}: missing input schema`)
    if (!('output' in method) || !method.output?.safeParse) violations.push(`${method.name ?? '<unknown>'}: missing output schema`)
    if ('output' in method) {
      for (const field of schemaFields(method.output)) {
        if (CREDENTIAL_FIELD.test(field)) violations.push(`${method.name ?? '<unknown>'}: credential output field ${field}`)
      }
    }
  }
  return violations
}
