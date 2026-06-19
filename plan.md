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

**Rules implemented**
- exact match (ingredient(s) + strength + dosage form found in one NLEM listing)
  → **scheduled**
- nothing in NLEM → **new drug**
- molecule in NLEM but strength / dosage form differs → **new drug**
- only some components of a combination are in NLEM → **new drug**

Deterministic (no LLM): each decision carries an exact, auditable reason and
cites the matching NLEM `sl_no`. Handles single molecules, NLEM's 24 FDC
listings (`X (A) + Y (B)` notation), salt-stripping for name matching, and
dosage-form / strength normalization.

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

**Verified** on a 10-row MRP Rev slice → 1 scheduled (Baclofen 20 mg → NLEM
[1.4.2]), 9 new drug, each with a specific reason.

**Known limits / open items**
- Emits only `scheduled` / `new drug` — never `non scheduled` (by the rules
  above). Splitting non-scheduled from new drug is Step 3 (needs a 2nd reference).
- Name-variant gaps: a molecule NLEM lists under a different name/salt than the
  sheet can read as "not in NLEM" (e.g. `Valproic Acid` vs NLEM's valproate
  entry). Candidate for an LLM-assisted name reconciliation later.
- Ceiling price is not yet attached to scheduled rows (next obvious add).

## Step 3 — Non-Scheduled vs potential New Drug  ⬜ TODO

For non-NLEM products, distinguish established formulations (**Non-Scheduled**)
from genuinely new FDCs/strengths (**New Drug**). Needs a second reference
(approved-drugs master / CDSCO list / prior-year catalog); without it, everything
non-NLEM collapses into one "needs human review" bucket.

## Later  ⬜

- Persist results + expose via API / chatbot.
- Confidence scoring + human-review queue for low-confidence matches.
