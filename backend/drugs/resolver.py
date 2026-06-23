"""
Agentic molecule-name resolver (the on-miss fallback for classify).

Deterministic matching (exact + fuzzy) handles the easy majority of ingredient
names. It cannot handle cases that need *knowledge* rather than string similarity:

  - salts not in our strip-list:  "Clopidogrel Bisulphate" -> Clopidogrel
  - synonyms / brand actives:     "Aspirin" -> Acetylsalicylic acid
  - abbreviations:                "CPM" -> Chlorpheniramine, "Para" -> Paracetamol

This module gives the LLM a single tool — `search_nlem(query)` over the real
449 NLEM molecules — and asks it to resolve a raw ingredient name to a canonical
NLEM molecule. The guardrail that prevents hallucinated matches: the answer is
only accepted if it is an actual NLEM member (we re-check against the index), so
the model can suggest but never invent a scheduled match.

Used only when deterministic matching misses, results are cached, and any error
falls back to "not resolved" so the pipeline never breaks.
"""

import json
import os

from django.conf import settings

from drugs.classify import normalize_name
from drugs.llm_client import get_client

# Resolved names persist across runs: repeated molecules never re-hit the LLM,
# and reruns are fast. Misses (None) are cached too. Delete the file to reset.
_CACHE_PATH = os.path.join(os.path.dirname(__file__), ".resolver_cache.json")


def _load_cache() -> dict:
    try:
        with open(_CACHE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict) -> None:
    tmp = _CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f, ensure_ascii=False, indent=0)
    os.replace(tmp, _CACHE_PATH)

RESOLVER_SYSTEM_PROMPT = """You map a raw drug ingredient name (as written on an Indian price sheet) to its canonical molecule in the NLEM essential-medicines list.

You have one tool: search_nlem(query) — it returns NLEM molecules matching the query, each as {"nlem_name", "medicine", "sl_no"}.

Method:
- A salt form maps to its base molecule: "Clopidogrel Bisulphate" -> search "Clopidogrel".
- A synonym/brand active maps to its generic (INN): "Aspirin" -> the molecule is "Acetylsalicylic acid", so search "Acetylsalicylic acid". "Para" -> "Paracetamol". "CPM" -> "Chlorpheniramine".
- Always search using the generic/chemical name you believe is correct. If the first search returns nothing, reconsider the molecule's other names and search again.

Finish by replying with ONLY a JSON object (no tool call, no prose):
  {"nlem_name": "<exact nlem_name value from a tool result>"}   when you found the molecule in NLEM
  {"nlem_name": null}                                            when it is genuinely not an essential medicine in NLEM

Never put a name in nlem_name that was not returned by search_nlem."""

_TOOLS = [{
    "type": "function",
    "function": {
        "name": "search_nlem",
        "description": "Search the NLEM essential-medicines list for molecules matching a query (partial names allowed).",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "molecule name to search for"}},
            "required": ["query"],
        },
    },
}]


def _member_display(index: dict) -> dict:
    """member key -> (sl_no, medicine) for human-readable tool results."""
    info = {}
    for key, entries in index["single"].items():
        info[key] = (entries[0][0].sl_no, entries[0][0].medicine)
    for fset, (entry, _) in index["combo"].items():
        for k in fset:
            info.setdefault(k, (entry.sl_no, entry.medicine))
    return info


def make_resolver(index: dict, max_steps: int = 5):
    """
    Build a resolver callable: resolve(raw_name) -> canonical_member_key | None.
    Caches results. Returns None on any failure (caller falls back to a miss).
    """
    import difflib

    info = _member_display(index)
    members_list = index["members_list"]
    cache: dict[str, str | None] = _load_cache()

    def search_nlem(query: str) -> list[dict]:
        qn = normalize_name(query)
        if not qn:
            return []
        hits = [m for m in members_list if qn in m or m in qn]
        for m in difflib.get_close_matches(qn, members_list, n=5, cutoff=0.7):
            if m not in hits:
                hits.append(m)
        out = []
        for m in hits[:8]:
            sl_no, medicine = info.get(m, ("", m))
            out.append({"nlem_name": m, "medicine": medicine, "sl_no": sl_no})
        return out

    def resolve(raw_name: str) -> str | None:
        cache_key = (raw_name or "").strip().lower()
        if cache_key in cache:
            return cache[cache_key]

        result = None
        try:
            client = get_client()
            messages = [
                {"role": "system", "content": RESOLVER_SYSTEM_PROMPT},
                {"role": "user", "content": f"Resolve this ingredient: {raw_name}"},
            ]
            for _ in range(max_steps):
                resp = client.chat.completions.create(
                    model=settings.OLLAMA_MODEL,
                    messages=messages,
                    tools=_TOOLS,
                    temperature=0,
                    max_tokens=400,
                )
                msg = resp.choices[0].message
                if msg.tool_calls:
                    messages.append({
                        "role": "assistant",
                        "content": msg.content or "",
                        "tool_calls": [{
                            "id": tc.id, "type": "function",
                            "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                        } for tc in msg.tool_calls],
                    })
                    for tc in msg.tool_calls:
                        try:
                            args = json.loads(tc.function.arguments or "{}")
                        except json.JSONDecodeError:
                            args = {}
                        found = search_nlem(args.get("query", ""))
                        messages.append({
                            "role": "tool", "tool_call_id": tc.id,
                            "content": json.dumps(found),
                        })
                    continue
                # Final answer expected as JSON.
                raw = (msg.content or "").strip()
                if raw.startswith("```"):
                    raw = "\n".join(l for l in raw.splitlines() if not l.startswith("```")).strip()
                try:
                    name = json.loads(raw).get("nlem_name")
                except (json.JSONDecodeError, AttributeError):
                    name = None
                # Grounding guardrail: only accept a real NLEM member.
                if isinstance(name, str):
                    cand = normalize_name(name)
                    result = cand if cand in index["members"] else None
                break
        except Exception:  # noqa: BLE001 — never let resolution break the pipeline
            result = None

        cache[cache_key] = result
        _save_cache(cache)  # persist incrementally so progress survives a crash
        return result

    return resolve
