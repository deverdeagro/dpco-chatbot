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

## Step 2 — Match against NLEM / ceiling prices → Scheduled vs not  ⬜ TODO

Match the normalized key (molecule set + strength + dosage form) against the
NLEM / `drugs_ceilingprice` data. Exact match → **Scheduled** (+ attach ceiling
price, flag if MRP exceeds it). No match → goes to Step 3.

## Step 3 — Non-Scheduled vs potential New Drug  ⬜ TODO

For non-NLEM products, distinguish established formulations (**Non-Scheduled**)
from genuinely new FDCs/strengths (**New Drug**). Needs a second reference
(approved-drugs master / CDSCO list / prior-year catalog); without it, everything
non-NLEM collapses into one "needs human review" bucket.

## Later  ⬜

- Persist results + expose via API / chatbot.
- Confidence scoring + human-review queue for low-confidence matches.
