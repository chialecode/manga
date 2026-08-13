import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import ts from 'typescript'
import { sourceFiles } from './source-files.mjs'

function importsOf(source, fileName) {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const imports = []
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) imports.push(node.moduleSpecifier.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return imports
}

export async function moduleBoundaryViolations(root) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    const portable = relative(root, file).split(sep).join('/')
    const imports = importsOf(await readFile(file, 'utf8'), portable)
    for (const specifier of imports) {
      const inDomain = portable.startsWith('packages/domain/')
      if (inDomain && (specifier.startsWith('node:') || specifier === 'electron')) {
        violations.push(`${portable}: domain cannot import ${specifier}`)
      }
      if (
        portable.startsWith('packages/contract/') &&
        specifier.startsWith('@manga/') &&
        specifier !== '@manga/domain'
      ) violations.push(`${portable}: contract cannot import ${specifier}`)
      if (portable.startsWith('packages/features/') && specifier === '@manga/data') {
        violations.push(`${portable}: features cannot import data`)
      }
      if (
        specifier === 'electron' &&
        portable.startsWith('packages/rpc/') &&
        portable !== 'packages/rpc/src/transport/electron.ts'
      ) violations.push(`${portable}: electron transport import is not isolated`)
    }
  }
  return violations
}
