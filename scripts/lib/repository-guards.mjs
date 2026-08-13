import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import ts from 'typescript'
import { sourceFiles } from './source-files.mjs'

const DERIVED_WRITE = /INSERT\s+INTO\s+(?:transcript|ai_message|ai_artifact)/iu

export function derivedInvariantViolations(source) {
  return DERIVED_WRITE.test(source) && !/evidence_link/iu.test(source) ? ['derived write lacks evidence_link'] : []
}

export async function repositoryDerivedViolations(root) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, 'utf8')
    for (const violation of derivedInvariantViolations(source)) violations.push(`${relative(root, file)}: ${violation}`)
  }
  return violations
}

export function offlineViolations(source) {
  return /\b(?:fetch|connect|request)\s*\(/u.test(source) ? ['outbound connection in offline mode'] : []
}

export async function repositoryOfflineViolations(root) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    const name = relative(root, file).split(sep).join('/')
    if (!name.startsWith('apps/') && !name.startsWith('packages/')) continue
    for (const violation of offlineViolations(await readFile(file, 'utf8'))) violations.push(`${name}: ${violation}`)
  }
  return violations
}

function objectKeys(source, fileName) {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const keys = []
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))) keys.push(property.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return keys.sort()
}

export function i18nViolations(catalogs) {
  const expected = catalogs[0]?.join(',') ?? ''
  return catalogs.slice(1).filter((keys) => keys.join(',') !== expected).map(() => 'i18n keys differ')
}

export async function repositoryI18nViolations(root) {
  const directory = `${root}/packages/ui/src/i18n`
  const files = ['zh-CN.ts', 'en.ts', 'ja.ts']
  return i18nViolations(await Promise.all(files.map(async (file) => objectKeys(await readFile(`${directory}/${file}`, 'utf8'), file))))
}

export function ipcSourceViolations(source) {
  const violations = []
  const calls = source.split(/\bmethod\s*\(/u).slice(1)
  if (calls.length === 0) violations.push('no registered methods found')
  for (const call of calls) {
    const name = /name\s*:\s*['"]([^'"]+)/u.exec(call)?.[1] ?? '<unknown>'
    if (!/\binput\s*:/u.test(call)) violations.push(`${name}: missing input schema`)
    if (!/\boutput\s*:/u.test(call)) violations.push(`${name}: missing output schema`)
    const output = /\boutput\s*:\s*z\.object\s*\(\s*\{([^}]*)\}/su.exec(call)?.[1] ?? ''
    if (/api.?key|token|secret|password|credential/iu.test(output)) violations.push(`${name}: credential output field`)
  }
  return violations
}
