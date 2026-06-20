"""
Step 1 of the agentic classification pipeline: normalize a free-text drug
composition string into a structured form.

Input (free text, as it appears in client sheets):
    "Empagliflozin 10 mg + Linagliptin 5 mg tablet"

Output (structured):
    {
        "ingredients": [
            {"name": "Empagliflozin", "strength": "10 mg"},
            {"name": "Linagliptin", "strength": "5 mg"}
        ],
        "dosage_form": "tablet"
    }

This is intentionally just the normalizer. Matching against NLEM / ceiling
prices and the scheduled / non-scheduled / new-drug decision are later steps.
"""

import json

from django.conf import settings
from openai import OpenAI

NORMALIZE_SYSTEM_PROMPT = """You normalize Indian pharmaceutical product compositions into structured JSON.

You are given a single "composition" string exactly as it appears on a manufacturer's price sheet. These strings are messy: inconsistent spacing, mixed separators (+, ;), salt forms, pharmacopoeia tags (IP, BP, USP), release modifiers like (ER)/(SR)/(XR), and the dosage form is often baked into the text.

Ignore all boilerplate. The active ingredients and their strengths are the only content that matters. Discard:
- lead-in phrases: "Each film coated tablet contains:", "Each ... contains", etc.
- excipient/colour noise: "Excipients q.s.", "q.s.", "Colour:", "Color:", "Titanium Dioxide", "Ferric Oxide", "Sunset Yellow", "Tartrazine", and similar.

Extract:
1. ingredients: an ordered list of active ingredients, each with:
   - name: the active ingredient.
       * For "X eq. to Y <strength>" (e.g. "Divalproex Sodium IP eq. to Valproic Acid 250 mg", "Rosuvastatin Calcium IP Eq to Rosuvastatin 40mg"), use the EQUIVALENT base Y as the name (e.g. "Valproic Acid", "Rosuvastatin") and <strength> as its strength.
       * Otherwise keep the salt form if present (e.g. "Metformin Hydrochloride").
       * Always remove pharmacopoeia tags (IP, BP, USP, USP-NF) and release modifiers (ER), (SR), (XR).
   - strength: ONLY the amount, normalized as "<number> <unit>" with a single space (e.g. "10 mg", "0.03 mg", "2 g"). Never put words like "eq. to" in this field. If no strength is stated, use null.
2. dosage_form: the singular lowercase dosage form (e.g. "tablet", "capsule", "injection", "vial", "syrup"). Infer it from words like Tabs/Tablets/Inj/Vial. If it cannot be determined, use null.

Rules:
- Output ONLY a JSON object. No markdown fences, no commentary.
- Preserve the order ingredients appear in the source.
- Never emit an ingredient with an empty name.
- Do NOT invent ingredients or strengths that are not present.
- Schema: {"ingredients": [{"name": string, "strength": string|null}], "dosage_form": string|null}"""

# A couple of few-shot examples grounded in the real sheet, to pin the format.
_FEWSHOT = [
    {
        "role": "user",
        "content": "Empagliflozin 10 mg + Linagliptin 5 mg tablet",
    },
    {
        "role": "assistant",
        "content": json.dumps({
            "ingredients": [
                {"name": "Empagliflozin", "strength": "10 mg"},
                {"name": "Linagliptin", "strength": "5 mg"},
            ],
            "dosage_form": "tablet",
        }),
    },
    {
        "role": "user",
        "content": "Ceftriaxone 1000mg+ Disodium Edetate 37mg+ Sulbactam 500mg; Vial",
    },
    {
        "role": "assistant",
        "content": json.dumps({
            "ingredients": [
                {"name": "Ceftriaxone", "strength": "1000 mg"},
                {"name": "Disodium Edetate", "strength": "37 mg"},
                {"name": "Sulbactam", "strength": "500 mg"},
            ],
            "dosage_form": "vial",
        }),
    },
    {
        "role": "user",
        "content": (
            "Each Film Coated extended release tablet Contains: Divalproex Sodium IP "
            "eq. to Valproic Acid 250 mg Excipients q.s. Colours: Sunset Yellow and Titanium Dioxide IP"
        ),
    },
    {
        "role": "assistant",
        "content": json.dumps({
            "ingredients": [
                {"name": "Valproic Acid", "strength": "250 mg"},
            ],
            "dosage_form": "tablet",
        }),
    },
]


def _get_client() -> OpenAI:
    return OpenAI(
        base_url=getattr(settings, 'OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
        api_key="ollama",
    )


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = "\n".join(
            line for line in text.splitlines() if not line.startswith("```")
        ).strip()
    return text


def normalize_composition(composition: str) -> dict:
    """
    Normalize one composition string into the structured form.

    Returns a dict: {"ingredients": [{"name", "strength"}], "dosage_form"}.
    Raises ValueError if the model output cannot be parsed as the expected JSON.
    """
    composition = (composition or "").strip()
    if not composition:
        return {"ingredients": [], "dosage_form": None}

    client = _get_client()
    response = client.chat.completions.create(
        model=settings.OLLAMA_MODEL,
        messages=(
            [{"role": "system", "content": NORMALIZE_SYSTEM_PROMPT}]
            + _FEWSHOT
            + [{"role": "user", "content": composition}]
        ),
        max_tokens=512,
        temperature=0,
        response_format={"type": "json_object"},
    )

    raw = _strip_fences(response.choices[0].message.content)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model did not return valid JSON: {raw!r}") from exc

    # Light shape validation / coercion so callers get a predictable structure.
    ingredients = []
    for item in data.get("ingredients") or []:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        if not name:  # drop junk/empty ingredients the model sometimes emits
            continue
        ingredients.append({
            "name": name,
            "strength": (item.get("strength").strip()
                         if isinstance(item.get("strength"), str) else None),
        })

    dosage_form = data.get("dosage_form")
    if isinstance(dosage_form, str):
        dosage_form = dosage_form.strip().lower() or None

    return {"ingredients": ingredients, "dosage_form": dosage_form}
