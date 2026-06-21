# DPCO Agentic Classification — Plan & Progress

Goal: given a client's annual product/price sheet (e.g. `Form-5-SampleFilings.xlsx`)
and our reference data (NLEM + DPCO ceiling prices), automatically classify each
product as **Scheduled**, **Non-Scheduled**, or a **potential New Drug** — building
it bottom-up as a pipeline of small, verifiable steps.

The client sheet's `Drug (Composition DCA)` column is free text and messy
(inconsistent units, salts, `(ER)` modifiers, `IP`/`USP`/`BP` tags, `eq. to`
equivalences, dosage form baked in, excipient/colour noise). Every later step
depends on first turning that into structured data.

---

## Step 1 — Normalize composition  ✅ DONE

Turn a free-text composition string into structured JSON:

```json
{
  "ingredients": [
    {"name": "Empagliflozin", "strength": "10 mg"},
    {"name": "Linagliptin",  "strength": "5 mg"}
  ],
  "dosage_form": "tablet"
}
```

**Files**
- `backend/drugs/normalize.py` — `normalize_composition(text) -> dict`. Uses the
  same OpenAI→Ollama client as `chat/llm.py` (`qwen2.5:14b`, `temperature=0`,
  JSON mode) with few-shot examples; shape-validates the output and drops
  empty/junk ingredients.
- `backend/drugs/management/commands/normalize_compositions.py` — runs the
  normalizer over a sheet and prints `source` vs `parsed` for each row.
  Read-only: writes nothing to the DB or the Excel file.

**How to run** (from `backend/`, with Ollama running + `qwen2.5:14b` pulled)
```bash
source venv/bin/activate
python manage.py normalize_compositions ~/Desktop/DPCO/Form-5-SampleFilings.xlsx --sheet "MRP Rev"
# --sheet "New Products" | --limit N
```

**Verified on** both `MRP Rev` (63 rows) and `New Products` (16 rows) of
`Form-5-SampleFilings.xlsx`. Handles: `+`/`;` separators, salt forms kept,
`(ER)/(SR)` stripped, `IP/USP/BP` stripped, `X eq. to Y <strength>` resolved to
the active base Y, excipient/colour boilerplate discarded.

**Known design choices / open items**
- Salt form kept in `name` (e.g. `Metformin Hydrochloride`). Step 2 matching will
  likely want a separate base-molecule field to key NLEM lookups on.
- `dosage_form` is `null` when the composition omits it. The sheet has a separate
  `Dosage (Product Type)` column we can backfill from at the matching step.
- Output is currently print-only (not persisted). Decide where normalized results
  should live (new Excel column vs database) when a later step needs them.

---

## Step 2 — Classify against NLEM (Scheduled vs New Drug)  ✅ DONE

The **classify node**: takes a normalized composition, matches it against the
NLEM reference (`drugs.models.NLEMEntry`, 449 rows / 2022), and returns
`{classification, reason}`.

**Decision tree (3-way; reproduces the human/KMCO labels)**
- exact NLEM listing (single or combo, strength + form match) → **scheduled**
- touches NLEM *partially* — molecule in NLEM but off strength/form, OR a
  combination where only some ingredients are in NLEM → **new drug**
- touches NLEM *nowhere* (no ingredient listed) → **non scheduled**

The partial-overlap heuristic IS the non-scheduled vs new-drug discriminator, so
no second reference is needed for these three buckets. (Originally "nothing in
NLEM → new drug"; corrected to → non scheduled after checking KMCO labels.)
Full tree is the docstring of `drugs/classify.py`.

Deterministic (no LLM): each decision carries an exact, auditable reason and
cites the matching NLEM `sl_no`. Handles single molecules, NLEM's 24 FDC
listings (`X (A) + Y (B)` notation), salt-stripping for name matching, and
dosage-form / strength normalization.

Validated 7/7 against known KMCO labels (Acerab SR, Empagliflozin combos,
Amlodipine on/off-strength, Amoxicillin+Clavulanic).

**Files**
- `backend/drugs/classify.py` — `build_nlem_index()` (build once) and
  `classify_composition(norm, index) -> {classification, reason}`. Pure node.
- `backend/drugs/management/commands/classify_products.py` — full pipeline over
  a sheet: `composition → normalize (LLM) → classify (rules)`, then writes a
  **copy** of the workbook with three new columns: `Normalized Composition`,
  `Classification`, `Reason`. Original file is never modified.

**How to run** (from `backend/`, Ollama running)
```bash
python manage.py classify_products ~/Desktop/DPCO/Form-5-SampleFilings.xlsx --sheet "MRP Rev"
# --limit N | --out <path>   default out: <name>-classified.xlsx
```

**Verified** on a 10-row MRP Rev slice and 7/7 labeled KMCO cases.

**Refinements added (validated 11/11 incl. regressions)**
- Fuzzy name matching (difflib, cutoff 0.87) for spelling variants:
  `amoxycillin→amoxicillin`, `cetrizine→cetirizine`. Reason notes when a fuzzy
  match was used. Guarded against false hits (`aceclofenac` ≠ `diclofenac`).
- Solid-oral form equivalence: tablet ≈ capsule (KMCO treats Amoxicillin 250 DT
  as scheduled vs NLEM's capsule). `liquid → oral liquid` synonym (fixes
  Azithromycin / Cetirizine syrups).
- Combination "scheduled" now verifies component strengths (numeric-subset vs
  NLEM's `(A)+(B)` notation): Amoxicillin+Clavulanic 250+62.5 → new drug,
  500+125 → scheduled.

**Known limits / open items**
- Fuzzy matching is a heuristic; cutoff 0.87 — audit the spelling-note reasons.
- Combo strength check is numeric-subset, not positional pairing (a cross-paired
  strength set could over-match in rare cases).
- Ceiling price is not yet attached to scheduled rows (next obvious add).
- Name reconciliation still misses true synonyms that aren't spelling-close
  (e.g. `Valproic Acid` vs a `Sodium valproate` listing). LLM-assisted candidate.

## Step 2.5 — Column-mapping node (any sheet format)  ✅ DONE

Makes intake format-agnostic. Instead of hardcoded header names, the LLM is
shown the top of the sheet and returns which columns hold the composition /
brand / dosage form, plus the header row.

    sheet -> map_columns (LLM) -> normalize (LLM) -> classify (rules) -> write

**Files**
- `backend/drugs/sheet_mapper.py` — `map_columns(ws)` returns
  `{"header_row", "columns": {"composition", "brand", "dosage_form"}}`
  (composition required; brand/dosage_form nullable). 0-based column indices.
- `classify_products.py` now calls `map_columns` instead of fixed header lists.

**Verified** it auto-detects all three tabs of the sample file despite different
layouts: MRP Rev (header row 1, comp col 2), New Products (header row 2 after a
blank banner row, comp col 3), Mfg Details (comp col 10). End-to-end classify
runs unchanged on both MRP Rev and New Products.

**Known limits**
- Maps composition to a single column. A sheet that splits molecule/strength
  across multiple columns, or one ingredient per row, is not yet handled.

## Step 3 — Non-Scheduled vs New Drug  ✅ DONE (via partial-overlap heuristic)

Resolved inside the Step 2 decision tree: partial NLEM overlap → new drug, zero
overlap → non scheduled. Matches KMCO labels without a second reference. A future
refinement could still add a CDSCO/prior-catalogue cross-check to catch genuinely
new molecules that happen to have zero NLEM overlap.

## Step 4 — Agentic name resolver (tool-grounded LLM)  🚧 IN PROGRESS

The first genuinely agentic piece: an LLM with a tool, used as the **on-miss
fallback** for molecule-name matching. Deterministic exact/fuzzy still runs
first; only when it misses does the LLM get involved.
Handles what string rules cannot (needs knowledge, not similarity):
- salts not in our list: `Clopidogrel Bisulphate` → `clopidogrel`
- synonyms / brand actives: `Aspirin` → `acetylsalicylic acid`
- abbreviations: `Para` → `paracetamol`

**File** `backend/drugs/resolver.py` — `make_resolver(index)` returns
`resolve(raw_name) -> canonical_member | None`. The LLM (qwen2.5:14b, tool-calling
via Ollama) has one tool, `search_nlem(query)`, over the real 449 NLEM molecules.

**Guardrail (anti-hallucination):** the answer is accepted only if it is a real
NLEM member (re-checked against the index), so the model can *suggest* but never
*invent* a scheduled match. Verified: `Empagliflozin`, `CPM` (Chlorpheniramine
not in NLEM), random text → `None`.

**Wiring:** `classify._resolve(raw_name, index, resolver=None)` →
exact → fuzzy → resolver (lookup) → none; `classify_composition(.., resolver=)`;
`classify_products` builds it once and passes it. `resolver=None` keeps the
deterministic path (and all unit tests) intact.

**Cost:** ~6.8s/row (was ~1s) — the resolver fires on every miss and runs a
multi-step tool loop. Results cached per run. Verified end-to-end: Clopisil-AP
(Clopidogrel Bisulphate + Aspirin) `non scheduled` → `new drug` (matches KMCO).

**Accuracy on `Test 2.xlsx`: 91.8% (180/196), up from 90.8% baseline.** The
resolver fixed exactly the name-miss class it targets — Clopisil-AP, Shinecal,
Tramocid, Trijet, Coldspan now correct. Remaining 16 are other categories
(concentration, Esomeprazole, partial-overlap domain ceiling), not name misses.

**+ concentration/strength bucket → 93.4% (183/196, 13 wrong).** `classify`
canonicalizes concentration→mg/mL / percent / bare numbers (`strengths_match`,
flat-mg↔concentration); normalizer preserves concentrations + never drops a
named ingredient. Fixed: Dexasil, Gentaband, OROLET, NOSTROSIL, ITROSIL.
Net +3 (two flipped: Amoxon = LLM jitter; Gentablue = domain — 10mg/mL is in
NLEM but KMCO calls it PND).

Remaining 13: Esomeprazole fuzzy false-match (1, fix = 2-char prefix guard);
Amoxon jitter (1); over-match needing release-form/injection-only logic
(Gentablue, Metololol ER ×2, Pantolet); partial-overlap **domain ceiling**
(Pregaday, Zeptokof ×3, Losocut-H, Montospan ×2 — needs a 2nd reference).

**Hardening applied (first run hung 7h on a leaked/stuck call):**
- Shared LLM client — `drugs/llm_client.py` `get_client()` (lru_cached singleton
  + 60s timeout). normalize/sheet_mapper/resolver all use it. Fixes the httpx
  connection leak (was opening a new client per call → 12+ stuck sockets).
- 60s per-call timeout → a stuck request fails instead of hanging forever;
  `classify_products` reports it cleanly.
- Persistent resolver cache — `drugs/.resolver_cache.json` (gitignored). Resolved
  names (and misses) survive across runs: cached lookup 6.3s → 0.000s. Delete the
  file to reset.

## Next candidates  ⬜

- Persist/cache resolver results across runs (kills latency + the LLM jitter).
- Attach ceiling price to scheduled rows (flag MRP > ceiling).
- Remaining error classes: concentration handling, over-match (Metoprolol ER),
  partial-overlap domain ceiling (Losartan+HCTZ).

## Later  ⬜

- Persist results + expose via API / chatbot.
- Confidence scoring + human-review queue for low-confidence matches.
