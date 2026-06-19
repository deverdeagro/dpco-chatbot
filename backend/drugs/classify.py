"""
Step 2 of the agentic classification pipeline: the classify node.

Input  : a normalized composition (output of drugs.normalize.normalize_composition)
Against : the NLEM reference data (drugs.models.NLEMEntry)
Output  : {"classification": "scheduled" | "new drug", "reason": str}

Decision rules (as specified):
  - exact match (every ingredient + its strength + the dosage form is found in a
    single NLEM listing)                                  -> "scheduled"
  - nothing in the composition is found in NLEM           -> "new drug"
  - molecule(s) found in NLEM but strength / dosage form differ -> "new drug"
  - only some ingredients of a combination are in NLEM    -> "new drug"

Note: these rules never emit "non scheduled". Distinguishing non-scheduled from
new drug needs a second reference (approved-drugs / prior catalogue) and is a
later step. See plan.md.

This is deterministic on purpose: each decision carries an exact, auditable
reason and costs no tokens. It is written as a pure node — build the NLEM index
once, then call classify_composition() per row — so it drops cleanly into a
graph later.
"""

import re

from drugs.models import NLEMEntry

# Salt / form words stripped when comparing a molecule name to NLEM's base name.
_SALT_WORDS = {
    "hydrochloride", "dihydrochloride", "hydrobromide", "sodium", "disodium",
    "potassium", "calcium", "magnesium", "besylate", "mesylate", "maleate",
    "succinate", "sulphate", "sulfate", "phosphate", "acetate", "citrate",
    "tartrate", "fumarate", "gluconate", "lactate", "nitrate", "bromide",
    "hydrate", "monohydrate", "anhydrous",
}

# Canonical dosage-form buckets. Anything containing the key maps to the value.
_FORM_SYNONYMS = [
    ("tablet", "tablet"), ("tab", "tablet"),
    ("capsule", "capsule"), ("cap", "capsule"),
    ("injection", "injection"), ("inj", "injection"), ("vial", "injection"),
    ("oral liquid", "oral liquid"), ("syrup", "oral liquid"),
    ("suspension", "oral liquid"), ("solution", "oral liquid"),
    ("cream", "cream"), ("ointment", "ointment"), ("gel", "gel"),
    ("lotion", "lotion"), ("drops", "drops"), ("powder", "powder"),
]

_STRENGTH_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(mcg|mg|g|iu|ml|%|units?)", re.IGNORECASE
)


def normalize_name(name: str) -> str:
    """Lowercase, drop bracketed notes / (A)(B) markers and salt words."""
    s = name.lower()
    s = re.sub(r"\(.*?\)", " ", s)   # (A), (B), (p), (As per IP)
    s = re.sub(r"\[.*?\]", " ", s)
    s = s.replace("-", " ")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    tokens = [t for t in s.split() if t and t not in _SALT_WORDS]
    return " ".join(tokens).strip()


def normalize_form(form: str | None) -> str | None:
    if not form:
        return None
    s = form.lower()
    for needle, canon in _FORM_SYNONYMS:
        if needle in s:
            return canon
    return s.strip()


def normalize_strength(strength: str | None) -> str | None:
    """'10 mg' / '10mg' -> '10mg'. Returns None if no number+unit present."""
    if not strength:
        return None
    m = _STRENGTH_RE.search(strength)
    if not m:
        return None
    unit = m.group(2).lower().rstrip("s")  # unit/units -> unit
    return f"{float(m.group(1)):g}{unit}"


def _parse_variants(dosage_field: str):
    """A NLEM dosage_form_and_strength blob -> set of (canon_form, strength)."""
    variants = set()
    for line in (dosage_field or "").splitlines():
        line = line.strip()
        if not line:
            continue
        m = _STRENGTH_RE.search(line)
        strength = normalize_strength(m.group(0)) if m else None
        form_text = line[: m.start()] if m else line
        variants.add((normalize_form(form_text), strength))
    return variants


def build_nlem_index(version: str = "2022") -> dict:
    """
    Build the lookup index once.

    Returns:
      {
        "single": { molecule_name: [(NLEMEntry, {(form, strength), ...}), ...] },
        "combo":  { frozenset(component_names): (NLEMEntry, variants) },
        "members": set(all component names appearing in any entry),
      }
    """
    single, combo, members = {}, {}, set()
    qs = NLEMEntry.objects.filter(nlem_version=version)
    for entry in qs:
        variants = _parse_variants(entry.dosage_form_and_strength)
        # Split combination entries on '+'; single entries yield one component.
        parts = [normalize_name(p) for p in re.split(r"\+", entry.medicine)]
        parts = [p for p in parts if p]
        if not parts:
            continue
        members.update(parts)
        if len(parts) == 1:
            single.setdefault(parts[0], []).append((entry, variants))
        else:
            combo[frozenset(parts)] = (entry, variants)
    return {"single": single, "combo": combo, "members": members}


def _fmt(name, strength, form):
    bits = [name]
    if strength:
        bits.append(strength)
    if form:
        bits.append(form)
    return " ".join(bits)


def classify_composition(norm: dict, index: dict) -> dict:
    """Apply the rules. `norm` is the normalize_composition() output."""
    ingredients = norm.get("ingredients") or []
    raw_form = norm.get("dosage_form")
    form = normalize_form(raw_form)

    if not ingredients:
        return {"classification": "new drug", "reason": "No ingredients could be parsed from the composition."}

    names = [normalize_name(i["name"]) for i in ingredients]

    # --- single-ingredient formulation ---
    if len(ingredients) == 1:
        ing, key = ingredients[0], names[0]
        entries = index["single"].get(key)
        if not entries:
            in_combo = key in index["members"]
            extra = " (only appears inside an NLEM combination)" if in_combo else ""
            return {"classification": "new drug",
                    "reason": f"'{ing['name']}' is not listed in NLEM{extra}."}

        want_str = normalize_strength(ing.get("strength"))
        for entry, variants in entries:
            for vform, vstr in variants:
                if vstr == want_str and (vform == form or form is None or vform is None):
                    return {"classification": "scheduled",
                            "reason": f"Exact NLEM match: {_fmt(ing['name'], ing.get('strength'), raw_form)} "
                                      f"= NLEM [{entry.sl_no}] {entry.medicine}."}
        avail = sorted({f"{f or '?'} {s or '?'}" for _, vs in entries for f, s in vs})
        return {"classification": "new drug",
                "reason": f"'{ing['name']}' is in NLEM [{entries[0][0].sl_no}] but the "
                          f"strength/dosage form ({ing.get('strength')}, {raw_form}) is not among "
                          f"NLEM's variants ({', '.join(avail) or 'none listed'})."}

    # --- combination (FDC) formulation ---
    nameset = frozenset(names)
    combo = index["combo"].get(nameset)
    if combo is not None:
        entry, _ = combo
        return {"classification": "scheduled",
                "reason": f"Combination matches NLEM listing [{entry.sl_no}] {entry.medicine}."}

    matched = [ingredients[i]["name"] for i, k in enumerate(names) if k in index["members"]]
    if not matched:
        return {"classification": "new drug",
                "reason": "No ingredient of this combination is listed in NLEM."}
    return {"classification": "new drug",
            "reason": f"Combination is not an NLEM listing; only some components are in NLEM "
                      f"({', '.join(matched)})."}
