import json

from django.conf import settings
from openai import OpenAI

SQL_SYSTEM_PROMPT = """You are a SQL query generator for a DPCO (Drug Price Control Order) ceiling price database in India.

The database has exactly one table:

Table: drugs_ceilingprice
Columns:
  id                         INTEGER   Primary key
  so_number                  TEXT      Statutory Order number, e.g. "1568(E)"
  so_date                    DATE      Date of the statutory order (nullable)
  medicine_name              TEXT      Name of the medicine/drug (indexed)
  dosage_form_and_strength   TEXT      Dosage form and strength, e.g. "Tablet 500mg"
  unit                       TEXT      Unit of measure, e.g. "1 Tablet", "1 ml"
  ceiling_price              DECIMAL   Maximum permissible retail price in INR
  wpi_rate                   DECIMAL   Wholesale Price Index revision rate for that year (nullable)
  effective_from             DATE      Date from which the price is effective (indexed)
  financial_year             TEXT      Financial year, e.g. "2023-24" (indexed)
  source_sheet               TEXT      Source year sheet name
  row_number                 INTEGER   Row number in the source file (nullable)

Rules you MUST follow:
1. Output ONLY a single SELECT statement. No INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, or any other statement type, ever.
2. Use ILIKE for case-insensitive text matching (PostgreSQL syntax).
3. Always include a LIMIT clause. Default LIMIT 20. For aggregate/summary queries LIMIT 100.
4. Return raw SQL only — no markdown fences, no explanation, no comments.
5. If the question cannot be answered from this table, return exactly: CANNOT_ANSWER"""

ANSWER_SYSTEM_PROMPT = """You are a helpful assistant that answers questions about DPCO (Drug Price Control Order) ceiling prices in India.

You are given the user's question, the SQL that was executed, and the query results as JSON.

Rules:
1. Answer in clear, concise natural language based only on the data provided.
2. Format prices with the ₹ symbol.
3. Include relevant details like effective date and S.O. number when present.
4. If results are empty, say so and suggest the user try a broader search term.
5. Do not speculate or invent data not present in the results.
6. Do not mention SQL, databases, or any technical implementation details."""


def _get_client() -> OpenAI:
    return OpenAI(
        base_url=getattr(settings, 'OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
        api_key="ollama",
    )


def generate_sql(question: str, prior_messages: list[dict]) -> str:
    """
    Step 1: Convert a natural language question to SQL.
    Returns a SQL string, or "CANNOT_ANSWER".
    """
    client = _get_client()

    messages = [{"role": m["role"], "content": m["content"]} for m in prior_messages]
    messages.append({"role": "user", "content": question})

    response = client.chat.completions.create(
        model=settings.OLLAMA_MODEL,
        messages=[{"role": "system", "content": SQL_SYSTEM_PROMPT}] + messages,
        max_tokens=512,
        temperature=0,
    )

    sql = response.choices[0].message.content.strip()

    # Strip accidental markdown fences
    if sql.startswith("```"):
        sql = "\n".join(
            line for line in sql.splitlines()
            if not line.startswith("```")
        ).strip()

    return sql


def generate_answer(question: str, sql: str, rows: list[dict]) -> str:
    """
    Step 2: Convert SQL results to a natural language answer.
    """
    client = _get_client()

    result_summary = json.dumps(rows[:20], indent=2, default=str)
    user_content = (
        f"Question: {question}\n\n"
        f"SQL executed:\n{sql}\n\n"
        f"Results ({len(rows)} rows):\n{result_summary}"
    )

    response = client.chat.completions.create(
        model=settings.OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": ANSWER_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        max_tokens=1024,
        temperature=0.3,
    )

    return response.choices[0].message.content.strip()
