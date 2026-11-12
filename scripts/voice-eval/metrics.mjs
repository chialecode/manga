// Evaluation metrics for voice dictation (`stage-plan.md` 4.11):
// - Punctuation-normalized Character Error Rate (`cer`)
// - Proper-noun recall (`entityRecall` = deterministic replacement + recalled candidates; `directEntityRecall` = text only)
// - Non-entity sentence false-modification rate (`falseModifyRate`)
// - Latency summary (`meanMs`, `p50Ms`, `p95Ms`)

const STRIP_PUNCT_WS_RE = /[\p{P}\p{S}\s]+/gu;

export function normalizeForCer(text) {
  return String(text ?? "")
    .replace(STRIP_PUNCT_WS_RE, "")
    .toLowerCase();
}

export function charEditDistance(refNorm, hypNorm) {
  const ref = Array.from(refNorm);
  const hyp = Array.from(hypNorm);
  const n = ref.length;
  const m = hyp.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;

  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    const rCh = ref[i - 1];
    for (let j = 1; j <= m; j += 1) {
      const subCost = rCh === hyp[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + subCost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

export function containsCanonicalEntity(text, entity) {
  if (!text || !entity) return false;
  if (/^[A-Za-z0-9_.-]+$/.test(entity)) {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(text);
  }
  return text.includes(entity);
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return Number(sortedValues[idx].toFixed(2));
}

export function summarizeTimings(valuesMs) {
  if (!valuesMs || valuesMs.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0 };
  }
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  return {
    count: sorted.length,
    meanMs: Number(mean.toFixed(2)),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

/**
 * Compute aggregate CER, entity recall, and Group C false-modify rate over evaluated sentence records.
 * Each record:
 *   `{ group, referenceText, expectedEntities, baselineRawText, outputText, candidateTerms?: string[] }`
 */
export function evaluateRecords(records, { checkFalseModifyAgainstBaseline = false } = {}) {
  let totalRefChars = 0;
  let totalEdits = 0;
  let totalEntities = 0;
  let directHits = 0;
  let combinedHits = 0;
  let nonEntityTotal = 0;
  let nonEntityFalseModified = 0;

  for (const rec of records) {
    const refNorm = normalizeForCer(rec.referenceText);
    const hypNorm = normalizeForCer(rec.outputText);
    totalRefChars += refNorm.length;
    totalEdits += charEditDistance(refNorm, hypNorm);

    const entities = rec.expectedEntities ?? [];
    const candSet = new Set((rec.candidateTerms ?? []).map((t) => t.toLowerCase()));
    for (const ent of entities) {
      totalEntities += 1;
      const inText = containsCanonicalEntity(rec.outputText, ent);
      if (inText) {
        directHits += 1;
        combinedHits += 1;
      } else if (candSet.has(ent.toLowerCase())) {
        combinedHits += 1;
      }
    }

    if (rec.group === "C" && entities.length === 0) {
      nonEntityTotal += 1;
      if (checkFalseModifyAgainstBaseline) {
        if (normalizeForCer(rec.outputText) !== normalizeForCer(rec.baselineRawText)) {
          nonEntityFalseModified += 1;
        }
      }
    }
  }

  return {
    utterances: records.length,
    cer: totalRefChars > 0 ? Number((totalEdits / totalRefChars).toFixed(4)) : 0,
    entityTotal: totalEntities,
    directEntityHits: directHits,
    combinedEntityHits: combinedHits,
    directEntityRecall: totalEntities > 0 ? Number((directHits / totalEntities).toFixed(4)) : 1,
    entityRecall: totalEntities > 0 ? Number((combinedHits / totalEntities).toFixed(4)) : 1,
    nonEntitySentences: nonEntityTotal,
    nonEntityFalseModified,
    falseModifyRate: nonEntityTotal > 0 ? Number((nonEntityFalseModified / nonEntityTotal).toFixed(4)) : 0,
  };
}
