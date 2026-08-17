import { readFile } from 'node:fs/promises'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import ts from 'typescript'

const EXPECTED_FUSES = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
])

const EXPECTED_CSP = {
  APP_CSP: ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' <media>: data: blob:", "media-src 'self' <media>: blob:", "font-src 'self'", "connect-src 'self'", "frame-src <book>:", "worker-src 'self' blob:", "form-action 'none'", "base-uri 'none'"],
  BOOK_CSP: ["default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline' <book>:", "img-src <book>: data:", "font-src <book>:"],
}

export function cspViolations(actual) {
  const violations = []
  for (const [name, expected] of Object.entries(EXPECTED_CSP)) {
    if (JSON.stringify(actual[name]) !== JSON.stringify(expected)) violations.push(`${name} does not exactly match the locked CSP`)
  }
  return violations
}

export function parseCspConstants(source) {
  const tree = ts.createSourceFile('csp.ts', source, ts.ScriptTarget.Latest, true)
  const result = {}
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text in EXPECTED_CSP && node.initializer && ts.isCallExpression(node.initializer)) {
      const array = node.initializer.expression.expression
      if (array && ts.isArrayLiteralExpression(array)) result[node.name.text] = array.elements.map((element) => normalizeCspElement(element))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return result
}

function normalizeCspElement(element) {
  if (ts.isStringLiteral(element)) return element.text
  if (!ts.isTemplateExpression(element)) return '<invalid>'
  let value = element.head.text
  for (const span of element.templateSpans) {
    const replacement = span.expression.getText() === 'SCHEME_MEDIA' ? '<media>' : span.expression.getText() === 'SCHEME_BOOK' ? '<book>' : '<invalid>'
    value += replacement + span.literal.text
  }
  return value
}

export function fuseConfigViolations(config) {
  const violations = []
  for (const [key, expected] of EXPECTED_FUSES) {
    if (config[key] !== expected) violations.push(`${FuseV1Options[key]} expected ${expected}`)
  }
  return violations
}

export async function packagedFuseViolations(exe) {
  return fuseConfigViolations(await getCurrentFuseWire(exe))
}

export async function repositoryCspViolations(root) {
  return cspViolations(parseCspConstants(await readFile(`${root}/apps/desktop/src/main/security/csp.ts`, 'utf8')))
}
