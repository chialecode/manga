import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import ts from 'typescript'
import { sourceFiles } from './source-files.mjs'

function portable(root, path) {
  return relative(root, path).split(sep).join('/')
}

function ast(source, file) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

export async function directImportViolations(root, moduleName, allowedPrefixes) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    const name = portable(root, file)
    if (allowedPrefixes.some((prefix) => name.startsWith(prefix))) continue
    const tree = ast(await readFile(file, 'utf8'), name)
    tree.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === moduleName) {
        violations.push(`${name}: direct ${moduleName} import`)
      }
    })
  }
  return violations
}

export async function hardcodedUrlViolations(root) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    const name = portable(root, file)
    if (name.includes('/__tests__/') || name.includes('/fixtures/')) continue
    const tree = ast(await readFile(file, 'utf8'), name)
    function visit(node) {
      if (ts.isStringLiteralLike(node) && /https?:\/\//iu.test(node.text)) violations.push(`${name}: hardcoded URL`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return violations
}

export async function hardcodedCopyViolations(root) {
  const violations = []
  for (const file of await sourceFiles(root)) {
    if (!file.endsWith('.tsx')) continue
    const name = portable(root, file)
    const tree = ast(await readFile(file, 'utf8'), name)
    function visit(node) {
      if (ts.isJsxText(node) && /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/u.test(node.text.trim())) violations.push(`${name}: hardcoded JSX copy`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return violations
}
