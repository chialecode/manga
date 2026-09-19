import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A dependency-free check for this repository's documented Markdown conventions.
// It deliberately does not claim full Markdown parsing or semantic verification.
const ignoredDirectories = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', '.cache',
]);
const statuses = new Set(['active', 'draft', 'reference', 'superseded']);
const kinds = new Set([
  'entry', 'index', 'rule', 'requirements', 'design', 'plan',
  'status', 'decision', 'research', 'evidence', 'template',
]);

function outside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function withoutCode(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map((line) => {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opening) {
      fence = opening[1];
      return '';
    }
    if (fence) {
      const closing = line.trim();
      if (closing[0] === fence[0] && closing.length >= fence.length
          && [...closing].every((char) => char === fence[0])) fence = null;
      return '';
    }
    return line;
  }).join('\n');
}

function anchors(markdown) {
  const result = new Set();
  const occurrences = new Map();
  const content = withoutCode(markdown);
  for (const match of content.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    const count = occurrences.get(slug) ?? 0;
    occurrences.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of content.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)) {
    result.add(match[1]);
  }
  return result;
}

function tableIds(markdown, pattern) {
  return [...markdown.matchAll(new RegExp(`^\\|\\s*(${pattern})\\s*\\|`, 'gm'))]
    .map((match) => match[1]);
}

function section(markdown, start, end, errors, label) {
  const from = markdown.indexOf(start);
  const to = from < 0 ? -1 : markdown.indexOf(end, from + start.length);
  if (from < 0 || to < 0) {
    errors.push(`${label}: missing required section boundaries`);
    return '';
  }
  return markdown.slice(from, to);
}

export function validateRepository(directory) {
  const root = fs.realpathSync(directory);
  const errors = [];
  const markdown = new Map();
  function scan(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, item.name);
      if (item.isSymbolicLink()) {
        if (item.name.endsWith('.md')) errors.push(`${absolute}: symlink Markdown is not supported`);
      } else if (item.isDirectory()) {
        if (!ignoredDirectories.has(item.name)) scan(absolute);
      } else if (/\.md$/i.test(item.name)) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        markdown.set(relative, fs.readFileSync(absolute, 'utf8'));
      }
    }
  }
  scan(root);

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/governance/document-registry.json'), 'utf8'));
  } catch (error) {
    return { errors: [`Cannot read document registry: ${error.message}`], stats: { documents: markdown.size } };
  }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.documents)) {
    return { errors: ['Registry must contain schemaVersion 1 and documents array'], stats: { documents: markdown.size } };
  }
  const registered = new Set();
  for (const doc of registry.documents) {
    if (!doc || typeof doc !== 'object') {
      errors.push('Registry contains a non-object document');
      continue;
    }
    for (const key of ['path', 'kind', 'status', 'owner', 'scope', 'reviewed', 'basis']) {
      if (typeof doc[key] !== 'string' || !doc[key].trim()) errors.push(`Registry ${doc.path ?? '?'}: missing ${key}`);
    }
    if (typeof doc.path !== 'string') continue;
    if (registered.has(doc.path)) errors.push(`Duplicate registry path: ${doc.path}`);
    registered.add(doc.path);
    if (!markdown.has(doc.path)) errors.push(`Registered document missing or path casing differs: ${doc.path}`);
    if (!statuses.has(doc.status)) errors.push(`${doc.path}: invalid document status ${doc.status}`);
    if (!kinds.has(doc.kind)) errors.push(`${doc.path}: invalid kind ${doc.kind}`);
    const timestamp = Date.parse(`${doc.reviewed}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.reviewed ?? '') || !Number.isFinite(timestamp)
        || new Date(timestamp).toISOString().slice(0, 10) !== doc.reviewed) {
      errors.push(`${doc.path}: invalid reviewed date`);
    }
    if (doc.status === 'superseded'
        && (!markdown.has(doc.supersededBy) || doc.supersededBy === doc.path)) {
      errors.push(`${doc.path}: superseded document needs an existing replacement`);
    }
  }
  for (const relative of markdown.keys()) {
    if (!registered.has(relative)) errors.push(`Unregistered Markdown: ${relative}`);
  }
  if ((markdown.get('CLAUDE.md') ?? '').trim() !== '@AGENTS.md') {
    errors.push('CLAUDE.md must contain only @AGENTS.md');
  }

  const anchorSets = new Map([...markdown].map(([name, value]) => [name, anchors(value)]));
  let localLinks = 0;
  for (const [relative, content] of markdown) {
    const clean = withoutCode(content).replace(/`[^`\n]+`/g, '');
    const links = [
      ...[...clean.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g)].map((m) => m[1]),
      ...[...clean.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)].map((m) => m[1]),
    ];
    for (let href of links) {
      href = href.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      localLinks++;
      let decoded;
      try { decoded = decodeURIComponent(href); }
      catch { errors.push(`${relative}: malformed link ${href}`); continue; }
      const hash = decoded.indexOf('#');
      const file = (hash < 0 ? decoded : decoded.slice(0, hash)).split('?')[0];
      const fragment = hash < 0 ? '' : decoded.slice(hash + 1);
      if (file.startsWith('/') || file.includes('\\')) {
        errors.push(`${relative}: use repository-relative forward-slash link ${href}`);
        continue;
      }
      const destination = path.resolve(root, path.dirname(relative), file || path.basename(relative));
      if (outside(root, destination) || !fs.existsSync(destination)) {
        errors.push(`${relative}: broken or escaping local link ${href}`);
        continue;
      }
      if (outside(root, fs.realpathSync(destination))) {
        errors.push(`${relative}: link resolves outside repository ${href}`);
        continue;
      }
      const target = path.relative(root, destination).split(path.sep).join('/');
      if (/\.md$/i.test(target) && !markdown.has(target)) errors.push(`${relative}: Markdown path casing differs ${href}`);
      if (fragment && anchorSets.has(target) && !anchorSets.get(target).has(fragment)) {
        errors.push(`${relative}: missing anchor ${href}`);
      }
    }
  }

  const requirements = markdown.get('docs/product/requirements.md') ?? '';
  const roadmap = markdown.get('docs/delivery/roadmap-and-acceptance.md') ?? '';
  const requirementIds = tableIds(requirements, '[A-Z]+-\\d+');
  const acceptance = section(roadmap, '## 5. 验收用例', '## 6. 需求追踪矩阵', errors, 'Acceptance definitions');
  const traceability = section(roadmap, '## 6. 需求追踪矩阵', '## 7. 质量检查', errors, 'Traceability matrix');
  const proof = section(roadmap, '## 3. M0 验证任务', '### 3.1 ', errors, 'POC definitions');
  const acceptanceIds = tableIds(acceptance, 'AT-\\d+');
  const proofIds = tableIds(proof, 'POC-\\d+');
  const tracedIds = tableIds(traceability, '[A-Z]+-\\d+');
  for (const [label, ids] of [
    ['requirements', requirementIds], ['AT definitions', acceptanceIds],
    ['POC definitions', proofIds], ['traceability', tracedIds],
  ]) {
    if (!ids.length) errors.push(`No ${label} found`);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`Duplicate ${label} ID: ${id}`);
      seen.add(id);
    }
  }
  for (const id of requirementIds) if (!tracedIds.includes(id)) errors.push(`Requirement missing from traceability: ${id}`);
  for (const id of tracedIds) if (!requirementIds.includes(id)) errors.push(`Unknown requirement in traceability: ${id}`);
  for (const line of traceability.split('\n')) {
    if (!/^\|\s*[A-Z]+-\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4 || !cells[1] || !cells[3] || !/AT-\d+/.test(cells[2] ?? '')) {
      errors.push(`Incomplete traceability row: ${line}`);
    }
  }
  const definitions = new Set([...acceptanceIds, ...proofIds]);
  for (const [relative, content] of markdown) {
    for (const id of new Set(withoutCode(content).match(/\b(?:AT|POC)-\d+\b/g) ?? [])) {
      if (!definitions.has(id)) errors.push(`${relative}: Unknown AT/POC reference ${id}`);
    }
  }
  const trackedProofs = tableIds(markdown.get('docs/delivery/status.md') ?? '', 'POC-\\d+');
  for (const id of proofIds) if (!trackedProofs.includes(id)) errors.push(`POC missing from execution status: ${id}`);
  for (const id of trackedProofs) if (!proofIds.includes(id)) errors.push(`Unknown POC in execution status: ${id}`);

  return {
    errors,
    stats: {
      documents: markdown.size, localLinks, requirements: requirementIds.length,
      acceptanceCases: acceptanceIds.length, proofs: proofIds.length,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateRepository(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    for (const error of result.errors) console.error(`ERROR ${error}`);
    console.log(JSON.stringify({ status: result.errors.length ? 'failed' : 'passed', ...result.stats }));
    process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) {
    console.error(`ERROR ${error.message}`);
    process.exitCode = 1;
  }
}
