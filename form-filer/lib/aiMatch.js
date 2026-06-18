'use strict';

/**
 * Disambiguation + verification for product dropdown selection.
 *
 * The brand name alone is often ambiguous against the portal (e.g. "Laregab-AT-LS"
 * could match several similarly-named entries), but the *strength* is not. We use
 * the drug strengths in the Excel composition as the decisive signal:
 *   - to PICK the right option among candidates (deterministic; LLM only for ties), and
 *   - to VERIFY the auto-filled composition after selection (deterministic).
 */

// "100/10", "40/50" — slash-grouped strengths
const SLASH_RE = /\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)+/g;
// a number immediately followed by a dose unit
const UNIT_RE  = /(\d+(?:\.\d+)?)\s*(?:mg|mcg|µg|ug|g|ml|iu|%)\b/gi;

/** Extract the multiset of dose strengths from a composition / option label. */
function extractStrengths(text) {
  const s = String(text || '').toLowerCase();
  const nums = [];

  let remainder = s;
  for (const group of s.match(SLASH_RE) || []) {
    for (const part of group.split('/')) {
      const v = parseFloat(part.trim());
      if (!Number.isNaN(v)) nums.push(v);
    }
    remainder = remainder.replace(group, ' '); // don't double-count below
  }

  let m;
  while ((m = UNIT_RE.exec(remainder)) !== null) {
    const v = parseFloat(m[1]);
    if (!Number.isNaN(v)) nums.push(v);
  }

  return nums;
}

function uniqSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a - b);
}

/** True only when both sides have strengths and the same distinct set of them. */
function setEqual(a, b) {
  const x = uniqSorted(a);
  const y = uniqSorted(b);
  return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Verify the portal's auto-filled composition against the Excel composition.
 * Returns true (match), false (mismatch), or null (can't tell — no strengths found).
 */
function compositionsMatch(excelComposition, portalComposition) {
  const a = extractStrengths(excelComposition);
  const b = extractStrengths(portalComposition);
  if (a.length === 0 || b.length === 0) return null;
  return setEqual(a, b);
}

/** Ask the local LLM to pick the best candidate index. Returns -1 on any failure. */
async function pickByLLM({ brand, composition, candidates }) {
  const base  = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  const model = process.env.OLLAMA_MODEL    || 'llama3.2';

  const list = candidates.map((c, i) => `${i}: ${c}`).join('\n');
  const prompt =
`You match a pharmaceutical product from a spreadsheet to the correct option in a government portal dropdown.

Spreadsheet product:
- Brand name: ${brand}
- Composition: ${composition}

Portal dropdown options:
${list}

Pick the single option that is the same drug AND the same strength as the spreadsheet product. Strength must match exactly. Reply with ONLY the integer index of the best option, or -1 if none match.`;

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 10,
      }),
    });
    if (!res.ok) return -1;
    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const match = text.match(/-?\d+/);
    if (!match) return -1;
    const idx = parseInt(match[0], 10);
    return idx >= 0 && idx < candidates.length ? idx : -1;
  } catch (_) {
    return -1;
  }
}

/**
 * Choose the best candidate option for a row.
 * Strategy: exact strength match first (deterministic); LLM only breaks ties.
 * Returns { idx, how }.
 */
async function chooseCandidate(row, candidates) {
  const excelStrengths = extractStrengths(row.composition);

  const strengthMatches = [];
  candidates.forEach((label, i) => {
    if (setEqual(extractStrengths(label), excelStrengths)) strengthMatches.push(i);
  });

  if (strengthMatches.length === 1) {
    return { idx: strengthMatches[0], how: 'strength' };
  }

  const llmIdx = await pickByLLM({
    brand: row.brandName,
    composition: row.composition,
    candidates,
  });
  if (llmIdx >= 0) return { idx: llmIdx, how: 'ai' };

  if (strengthMatches.length > 1) return { idx: strengthMatches[0], how: 'strength(first-of-many)' };
  return { idx: 0, how: 'first(fallback)' };
}

module.exports = { extractStrengths, setEqual, compositionsMatch, pickByLLM, chooseCandidate };
