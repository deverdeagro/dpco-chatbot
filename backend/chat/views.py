import logging

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import IsAuthenticated

from .llm import generate_sql, generate_answer
from .sql_runner import validate_and_run, SQLValidationError

logger = logging.getLogger(__name__)


class ChatView(APIView):
    permission_classes = [IsAuthenticated]

    """
    POST /api/v1/chat/

    Request body:
      question (str, required)  — natural language question
      messages (list, optional) — prior turns for context: [{role, content}, ...]

    Response:
      answer    (str|null)   — natural language answer
      sql       (str|null)   — SQL that was executed
      row_count (int)        — number of rows returned
      error     (str|null)   — error message if something went wrong
    """

    def post(self, request):
        question = request.data.get("question", "").strip()
        if not question:
            return Response(
                {"answer": None, "sql": None, "row_count": 0, "error": "question is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(question) > 1000:
            return Response(
                {"answer": None, "sql": None, "row_count": 0, "error": "question must be 1000 characters or fewer"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        prior_messages = request.data.get("messages", [])

        # Step 1: Generate SQL
        try:
            sql = generate_sql(question, prior_messages)
        except Exception as exc:
            logger.error("SQL generation failed: %s", exc, exc_info=True)
            return Response({
                "answer": None, "sql": None, "row_count": 0,
                "error": "Failed to generate a query. Please try again.",
            })

        if sql.strip() == "CANNOT_ANSWER":
            return Response({
                "answer": "I can only answer questions about DPCO drug ceiling prices. Try asking about a specific medicine, price range, financial year, or S.O. number.",
                "sql": None, "row_count": 0, "error": None,
            })

        # Step 2: Execute SQL safely
        try:
            rows = validate_and_run(sql)
        except SQLValidationError as exc:
            logger.warning("SQL validation failed: %s | SQL: %s", exc, sql)
            return Response({
                "answer": None, "sql": sql, "row_count": 0,
                "error": f"Query validation failed: {exc}",
            })
        except Exception as exc:
            logger.error("SQL execution failed: %s | SQL: %s", exc, sql, exc_info=True)
            return Response({
                "answer": None, "sql": sql, "row_count": 0,
                "error": "Query execution failed. Please try rephrasing your question.",
            })

        # Step 3: Generate natural language answer
        try:
            answer = generate_answer(question, sql, rows)
        except Exception as exc:
            logger.error("Answer generation failed: %s", exc, exc_info=True)
            return Response({
                "answer": None, "sql": sql, "row_count": len(rows),
                "error": "Failed to generate an answer. Please try again.",
            })

        return Response({
            "answer": answer,
            "sql": sql,
            "row_count": len(rows),
            "error": None,
        })
