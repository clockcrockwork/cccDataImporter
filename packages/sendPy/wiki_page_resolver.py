import random
import wikipedia


SELECTION_FIRST = "first"
SELECTION_RANDOM = "random"
ALLOWED_SELECTION_RULES = (SELECTION_FIRST, SELECTION_RANDOM)
MAX_DISAMBIGUATION_RETRIES = 2


def _normalize_candidates(candidates):
    normalized = []
    seen = set()
    for candidate in candidates:
        title = (candidate or "").strip()
        if not title or title in seen:
            continue
        seen.add(title)
        normalized.append(title)
    return normalized


def _pick_title(candidates, selection_rule: str):
    if selection_rule == SELECTION_RANDOM:
        return random.choice(candidates)
    return candidates[0]


def resolve_page_with_disambiguation(query: str, selection_rule: str = SELECTION_FIRST):
    """Resolve a Wikipedia page, retrying with search candidates on disambiguation."""
    if not isinstance(query, str) or not query.strip():
        raise ValueError("Query must be a non-empty string.")
    if selection_rule not in ALLOWED_SELECTION_RULES:
        raise ValueError(
            f"Unsupported selection_rule '{selection_rule}'. "
            f"Allowed: {ALLOWED_SELECTION_RULES}"
        )

    current_query = query
    for _ in range(MAX_DISAMBIGUATION_RETRIES + 1):
        try:
            return wikipedia.page(current_query)
        except wikipedia.exceptions.DisambiguationError:
            candidates = _normalize_candidates(wikipedia.search(current_query))
            top3 = candidates[:3]
            print(f"Disambiguation candidates (top 3) for '{current_query}': {top3}")

            if not candidates:
                raise RuntimeError(f"No disambiguation candidates found for query: {current_query}")

            selected_title = _pick_title(candidates, selection_rule)
            print(
                f"Disambiguation resolved by '{selection_rule}' selection: {selected_title}"
            )
            current_query = selected_title

    raise RuntimeError(f"Disambiguation retry limit exceeded for query: {query}")
