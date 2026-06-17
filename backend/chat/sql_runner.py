import re
from decimal import Decimal
from datetime import date, datetime

from django.db import connection

DANGEROUS_KEYWORDS = re.compile(
    r'\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL|MERGE)\b',
    re.IGNORECASE,
)
MAX_ROWS = 50


class SQLValidationError(Exception):
    pass


def _serialize_row(row_dict):
    result = {}
    for k, v in row_dict.items():
        if isinstance(v, Decimal):
            result[k] = float(v)
        elif isinstance(v, (date, datetime)):
            result[k] = v.isoformat()
        else:
            result[k] = v
    return result


def validate_and_run(sql: str) -> list[dict]:
    """
    Validates that sql is a SELECT-only statement and executes it.

    NOTE: The ultimate security layer is the PostgreSQL DB_USER having only
    SELECT privilege on drugs_ceilingprice. This function is defence-in-depth.

    Raises SQLValidationError on invalid SQL.
    Returns list of row dicts on success.
    """
    stripped = sql.strip().lstrip(';').strip()

    if not re.match(r'^SELECT\b', stripped, re.IGNORECASE):
        raise SQLValidationError("Only SELECT statements are permitted.")

    match = DANGEROUS_KEYWORDS.search(stripped)
    if match:
        raise SQLValidationError(f"Query contains forbidden keyword: {match.group().upper()}")

    with connection.cursor() as cursor:
        cursor.execute(stripped)
        columns = [col[0] for col in cursor.description]
        rows = cursor.fetchmany(MAX_ROWS)

    return [_serialize_row(dict(zip(columns, row))) for row in rows]
