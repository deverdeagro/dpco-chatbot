"""
Step 2.5 of the pipeline: the column-mapping node.

Client sheets all carry the same information (a drug composition, a brand name,
a dosage form) but label and arrange their columns differently. Rather than
hardcode the header names we have seen, this node shows the LLM the top of the
sheet and asks which columns map to our canonical fields. That makes intake
format-agnostic, the same way normalize made the composition string
format-agnostic.

    sheet -> map_columns (LLM) -> normalize (LLM) -> classify (rules) -> write

Output:
    {
        "header_row": 1,                 # 1-based row index of the header
        "columns": {
            "composition": 2,            # 0-based; REQUIRED
            "brand": 1,                  # 0-based or None
            "dosage_form": 3             # 0-based or None
        }
    }
"""

import json

from django.conf import settings

from drugs.llm_client import get_client

MAP_SYSTEM_PROMPT = """You identify columns in a pharmaceutical product spreadsheet.

You are given the first several rows of a sheet. Cells are shown as "[col N] value", where N is the 0-based column index. Rows are 1-based.

Find:
1. header_row: the 1-based row number that holds the column titles (there may be blank or banner rows above it).
2. composition: the 0-based column index of the column holding the full drug COMPOSITION — active ingredient name(s) with their strengths (e.g. "Empagliflozin 10 mg + Linagliptin 5 mg", "Each tablet contains Baclofen IP 20mg"). This is REQUIRED. Pick the single best column.
3. brand: the 0-based column index of the brand / product NAME (e.g. "Empashield-10"), or null if there is none.
4. dosage_form: the 0-based column index of a column dedicated to the dosage form / product type (e.g. "Tabs", "Injection"), or null if there is none. This is NOT the composition column.

Rules:
- Output ONLY a JSON object, no markdown, no commentary.
- Use 0-based indices for columns, 1-based for header_row.
- composition must never be null; if unsure, choose the column whose values contain ingredient names and strengths.
- Schema: {"header_row": int, "columns": {"composition": int, "brand": int|null, "dosage_form": int|null}}"""


def _grid_preview(ws, max_rows=12, max_cols=40, cell_len=55) -> str:
    lines = []
    for r, row in enumerate(ws.iter_rows(min_row=1, max_row=max_rows, values_only=True), start=1):
        cells = []
        for c, v in enumerate(row[:max_cols]):
            if v is None:
                continue
            text = str(v).strip().replace("\n", " ")
            if len(text) > cell_len:
                text = text[:cell_len] + "…"
            cells.append(f"[col {c}] {text}")
        if cells:
            lines.append(f"Row {r}: " + " | ".join(cells))
    return "\n".join(lines)


def map_columns(ws) -> dict:
    """Ask the LLM which columns are composition / brand / dosage_form."""
    preview = _grid_preview(ws)
    if not preview:
        raise ValueError("Sheet appears to be empty.")

    client = get_client()
    response = client.chat.completions.create(
        model=settings.OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": MAP_SYSTEM_PROMPT},
            {"role": "user", "content": preview},
        ],
        max_tokens=300,
        temperature=0,
        response_format={"type": "json_object"},
    )

    raw = response.choices[0].message.content.strip()
    if raw.startswith("```"):
        raw = "\n".join(l for l in raw.splitlines() if not l.startswith("```")).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Column mapper did not return valid JSON: {raw!r}") from exc

    cols = data.get("columns") or {}

    def _idx(value):
        return value if isinstance(value, int) and value >= 0 else None

    composition = _idx(cols.get("composition"))
    if composition is None:
        raise ValueError(f"Column mapper could not find a composition column. Got: {data!r}")

    header_row = data.get("header_row")
    if not isinstance(header_row, int) or header_row < 1:
        header_row = 1

    return {
        "header_row": header_row,
        "columns": {
            "composition": composition,
            "brand": _idx(cols.get("brand")),
            "dosage_form": _idx(cols.get("dosage_form")),
        },
    }
