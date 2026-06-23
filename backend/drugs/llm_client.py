"""
Shared LLM client (OpenAI SDK pointed at the local Ollama).

One cached client is reused across all calls — creating a fresh OpenAI() per
call (as the modules used to) leaks httpx connections, which over a long run
piles up open sockets to Ollama and degrades throughput.

`timeout` makes a single stuck request fail instead of hanging forever.
"""

import functools

from django.conf import settings
from openai import OpenAI


@functools.lru_cache(maxsize=1)
def get_client() -> OpenAI:
    return OpenAI(
        base_url=getattr(settings, "OLLAMA_BASE_URL", "http://localhost:11434/v1"),
        api_key="ollama",
        timeout=60.0,      # seconds; a stuck call fails instead of hanging
        max_retries=2,
    )
