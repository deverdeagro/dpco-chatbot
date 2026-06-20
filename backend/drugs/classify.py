"""
Step 2 of the agentic classification pipeline: the classify node.

Input  : a normalized composition (output of drugs.normalize.normalize_composition)
Against : the NLEM reference data (drugs.models.NLEMEntry)
Output  : {"classification": "scheduled" | "new drug", "reason": str}

Decision tree:

  normalized composition (ingredients + dosage_form)
  |
  |-- no ingredients parsed --------------------------------> "new drug" (unparsable; edge case)
  |
  |-- SINGLE ingredient
  |     |-- molecule has a standalone NLEM listing?
  |     |     |-- yes: strength AND form match an NLEM variant?
  |     |     |          |-- yes -------------------------> "scheduled"
  |     |     |          |-- no  -------------------------> "new drug"  (in NLEM, different strength/form)
  |     |     |-- no:
  |     |            |-- molecule appears only inside an NLEM combo --> "new drug"
  |     |            |-- molecule not in NLEM at all --------------> "non scheduled"
  |
  |-- COMBINATION (2+ ingredients)
        |-- whole set matches an NLEM combination listing -------> "scheduled"
        |-- at least one ingredient in NLEM (not a full match) --> "new drug"  (partial overlap)
        |-- no ingredient in NLEM ------------------------------> "non scheduled"

Rationale: an exact NLEM listing is price-controlled (scheduled). Mixing a
scheduled/essential molecule with extra molecules, or changing its strength/form,
creates a "new drug" (the NPPA flag for stepping outside an essential listing).
A formulation that touches NLEM nowhere is simply non-scheduled.

This is deterministic on purpose: each decision carries an exact, auditable
reason and costs no tokens. It is written as a pure node — build the NLEM index
once, then call classify_composition() per row — so it drops cleanly into a
graph later.
"""

import difflib
import re

from drugs.models import NLEMEntry

# When an exact molecule name is not in NLEM, accept the closest NLEM name above
# this similarity (catches spelling variants: amoxycillin->amoxicillin,
# cetrizine->cetirizine). Kept high to avoid matching genuinely different drugs.
FUZZY_CUTOFF = 0.87

# Dosage forms KMCO treats as interchangeable for scheduling (solid oral).
_SOLID_ORAL = {"tablet", "capsule"}

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
    ("liquid", "oral liquid"),
    ("cream", "cream"), ("ointment", "ointment"), ("gel", "gel"),
    ("lotion", "lotion"), ("drops", "drops"), ("powder", "powder"),
]

_STRENGTH_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(mcg|mg|g|iu|ml|%|units?)", re.IGNORECASE
)

# Bare numeric values, used to compare combination strengths against NLEM's
# messy "(A) + (B)" notation without trying to parse it positionally.
_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def _numbers(text: str | None) -> set:
    return {float(x) for x in _NUM_RE.findall(text or "")}


def forms_compatible(a, b) -> bool:
    """Equal forms, either side unknown, or both solid-oral (tablet/capsule)."""
    if a is None or b is None or a == b:
        return True
    return a in _SOLID_ORAL and b in _SOLID_ORAL


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
    return {"single": single, "combo": combo, "members": members,
            "members_list": sorted(members)}


def _fmt(name, strength, form):
    bits = [name]
    if strength:
        bits.append(strength)
    if form:
        bits.append(form)
    return " ".join(bits)


def _resolve(name_key: str, index: dict):
    """
    Map a (normalized) molecule name to its canonical NLEM name.
    Returns (canonical_name, was_fuzzy). Falls back to the input when no close
    NLEM name exists.
    """
    if name_key in index["members"]:
        return name_key, False
    close = difflib.get_close_matches(
        name_key, index["members_list"], n=1, cutoff=FUZZY_CUTOFF)
    if close:
        return close[0], True
    return name_key, False


def classify_composition(norm: dict, index: dict) -> dict:
    """Apply the rules. `norm` is the normalize_composition() output."""
    ingredients = norm.get("ingredients") or []
    raw_form = norm.get("dosage_form")
    form = normalize_form(raw_form)

    if not ingredients:
        return {"classification": "new drug", "reason": "No ingredients could be parsed from the composition."}

    # Resolve each name to its canonical NLEM spelling (fuzzy if needed).
    resolved = [_resolve(normalize_name(i["name"]), index) for i in ingredients]
    keys = [r[0] for r in resolved]

    def spell_note(i):
        rkey, fuzzy = resolved[i]
        return f" (read as NLEM '{rkey.title()}')" if fuzzy else ""

    # --- single-ingredient formulation ---
    if len(ingredients) == 1:
        ing, key = ingredients[0], keys[0]
        entries = index["single"].get(key)
        if not entries:
            if key in index["members"]:
                return {"classification": "new drug",
                        "reason": f"'{ing['name']}' is not listed in NLEM on its own, "
                                  f"only as part of an NLEM combination."}
            return {"classification": "non scheduled",
                    "reason": f"'{ing['name']}' is not listed in NLEM."}

        want_str = normalize_strength(ing.get("strength"))
        for entry, variants in entries:
            for vform, vstr in variants:
                if vstr == want_str and forms_compatible(vform, form):
                    return {"classification": "scheduled",
                            "reason": f"Exact NLEM match: {_fmt(ing['name'], ing.get('strength'), raw_form)} "
                                      f"= NLEM [{entry.sl_no}] {entry.medicine}{spell_note(0)}."}
        avail = sorted({f"{f or '?'} {s or '?'}" for _, vs in entries for f, s in vs})
        return {"classification": "new drug",
                "reason": f"'{ing['name']}' is in NLEM [{entries[0][0].sl_no}]{spell_note(0)} but the "
                          f"strength/dosage form ({ing.get('strength')}, {raw_form}) is not among "
                          f"NLEM's variants ({', '.join(avail) or 'none listed'})."}

    # --- combination (FDC) formulation ---
    combo = index["combo"].get(frozenset(keys))
    if combo is not None:
        entry, variants = combo
        prod_nums = set().union(*[_numbers(i.get("strength")) for i in ingredients])
        entry_nums = _numbers(entry.dosage_form_and_strength)
        entry_forms = {f for f, _ in variants}
        strengths_ok = bool(prod_nums) and prod_nums <= entry_nums
        form_ok = form is None or any(forms_compatible(form, f) for f in entry_forms)
        if strengths_ok and form_ok:
            return {"classification": "scheduled",
                    "reason": f"Combination matches NLEM listing [{entry.sl_no}] {entry.medicine}."}
        return {"classification": "new drug",
                "reason": f"Combination is the NLEM listing [{entry.sl_no}] {entry.medicine}, but the "
                          f"strengths/dosage form differ (product strengths "
                          f"{sorted(prod_nums) or '—'} vs NLEM {sorted(entry_nums)})."}

    matched = [ingredients[i]["name"] for i, k in enumerate(keys) if k in index["members"]]
    if not matched:
        return {"classification": "non scheduled",
                "reason": "No ingredient of this combination is listed in NLEM."}
    return {"classification": "new drug",
            "reason": f"Combination is not an NLEM listing; only some components are in NLEM "
                      f"({', '.join(matched)})."}
