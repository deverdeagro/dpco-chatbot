"""
Report-upload API: drop an .xlsx, classify it in the background, poll for
results, download the classified workbook, and chat about the results.
"""

import json
import os
import threading

from django.conf import settings
from django.db import close_old_connections
from django.http import FileResponse, Http404
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import IsAuthenticated

from .models import ReportJob
from .pipeline import classify_workbook
from .llm_client import get_client


def _run_job(job_id: int) -> None:
    """Background thread: run the classification pipeline and store results."""
    close_old_connections()
    job = ReportJob.objects.get(id=job_id)
    try:
        job.status = ReportJob.STATUS_RUNNING
        job.save(update_fields=["status"])

        in_path = job.excel_file.path
        out_dir = os.path.join(settings.MEDIA_ROOT, "report_outputs")
        os.makedirs(out_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(job.original_name or job.excel_file.name))[0]
        out_name = f"{stem}-classified.xlsx"
        out_path = os.path.join(out_dir, f"{job_id}_{out_name}")

        def on_progress(done, total):
            # Throttle DB writes: update every 5 rows (and the last).
            if done % 5 == 0 or done == total:
                ReportJob.objects.filter(id=job_id).update(processed=done, total=total)

        rows, summary = classify_workbook(
            in_path, out_path, sheet=job.sheet or None, on_progress=on_progress)

        job.refresh_from_db()
        job.rows = rows
        job.summary = summary
        job.total = summary["total"]
        job.processed = summary["total"]
        job.output_file.name = f"report_outputs/{job_id}_{out_name}"
        job.status = ReportJob.STATUS_DONE
        job.save()
    except Exception as exc:  # noqa: BLE001
        try:
            job.refresh_from_db()
            job.status = ReportJob.STATUS_FAILED
            job.error = str(exc)
            job.save(update_fields=["status", "error"])
        except Exception:
            pass


def _job_payload(job: ReportJob) -> dict:
    return {
        "id": job.id,
        "original_name": job.original_name,
        "status": job.status,
        "processed": job.processed,
        "total": job.total,
        "summary": job.summary,
        "rows": job.rows,
        "error": job.error,
        "download_url": f"/api/v1/reports/{job.id}/download/" if job.output_file else None,
    }


class ReportCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        """List the current user's previous reports (most recent first)."""
        jobs = ReportJob.objects.filter(created_by=request.user)[:50]
        return Response([{
            "id": j.id,
            "original_name": j.original_name,
            "status": j.status,
            "total": j.total,
            "counts": (j.summary or {}).get("counts", {}),
            "created_at": j.created_at.isoformat(),
        } for j in jobs])

    def post(self, request):
        f = request.FILES.get("file") or request.FILES.get("excel_file")
        if not f:
            return Response({"error": "file is required."}, status=status.HTTP_400_BAD_REQUEST)
        if not f.name.endswith(".xlsx"):
            return Response({"error": "Only .xlsx files are accepted."}, status=status.HTTP_400_BAD_REQUEST)

        job = ReportJob.objects.create(
            excel_file=f,
            original_name=f.name,
            sheet=request.data.get("sheet", ""),
            created_by=request.user,
        )
        threading.Thread(target=_run_job, args=(job.id,), daemon=True).start()
        return Response(_job_payload(job), status=status.HTTP_201_CREATED)


class ReportDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            job = ReportJob.objects.get(pk=pk)
        except ReportJob.DoesNotExist:
            return Response({"error": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(_job_payload(job))


class ReportDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            job = ReportJob.objects.get(pk=pk)
        except ReportJob.DoesNotExist:
            raise Http404
        if not job.output_file:
            raise Http404
        stem = os.path.splitext(job.original_name or "report")[0]
        return FileResponse(
            job.output_file.open("rb"),
            as_attachment=True,
            filename=f"{stem}-classified.xlsx",
        )


REPORT_CHAT_SYSTEM = """You answer questions about a drug price-sheet classification report.

Each product was classified as 'scheduled' (price-controlled under DPCO),
'non scheduled', or 'new drug' (potential new drug), with a reason.

You CANNOT see the rows directly — you must use the tools to get exact answers.
NEVER guess or count from memory. Tools:
- get_counts(): exact totals per classification.
- list_products(classification): exact list of brands in a category
  (classification is one of 'scheduled', 'non scheduled', 'new drug').
- find_product(name): the classification + reason for products matching a name.

For "how many" use get_counts. For "list/which" use list_products. For "why is X..."
use find_product. Be concise and answer only from tool results."""

REPORT_TOOLS = [
    {"type": "function", "function": {
        "name": "get_counts",
        "description": "Exact count of products per classification, and the total.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "list_products",
        "description": "List the brand names of every product in a given classification.",
        "parameters": {"type": "object", "properties": {
            "classification": {"type": "string", "enum": ["scheduled", "non scheduled", "new drug"]}},
            "required": ["classification"]},
    }},
    {"type": "function", "function": {
        "name": "find_product",
        "description": "Find products whose brand matches a name; returns classification and reason.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string"}}, "required": ["name"]},
    }},
]


def _make_report_tools(job):
    rows = job.rows or []
    counts = (job.summary or {}).get("counts", {})
    total = (job.summary or {}).get("total", len(rows))

    def get_counts(**_):
        return {"total": total, **counts}

    def list_products(classification=None, **_):
        c = (classification or "").strip().lower()
        return [r.get("brand") or "(no brand)" for r in rows if r["classification"] == c]

    def find_product(name=None, **_):
        q = (name or "").strip().lower()
        hits = [{"brand": r.get("brand"), "classification": r["classification"], "reason": r["reason"]}
                for r in rows if q and q in (r.get("brand") or "").lower()]
        return hits[:8] or {"note": f"No product matching {name!r}."}

    return {"get_counts": get_counts, "list_products": list_products, "find_product": find_product}


class ReportChatView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        question = (request.data.get("question") or "").strip()
        if not question:
            return Response({"error": "question is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            job = ReportJob.objects.get(pk=pk)
        except ReportJob.DoesNotExist:
            return Response({"error": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        if job.status != ReportJob.STATUS_DONE or not job.rows:
            return Response({"error": "Report is not ready yet."}, status=status.HTTP_400_BAD_REQUEST)

        tools = _make_report_tools(job)
        messages = [
            {"role": "system", "content": REPORT_CHAT_SYSTEM},
            {"role": "user", "content": question},
        ]
        try:
            client = get_client()
            for _ in range(5):
                resp = client.chat.completions.create(
                    model=settings.OLLAMA_MODEL, messages=messages,
                    tools=REPORT_TOOLS, temperature=0.1, max_tokens=600,
                )
                msg = resp.choices[0].message
                if not msg.tool_calls:
                    return Response({"answer": (msg.content or "").strip()})
                messages.append({
                    "role": "assistant", "content": msg.content or "",
                    "tool_calls": [{"id": tc.id, "type": "function",
                                    "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                                   for tc in msg.tool_calls],
                })
                for tc in msg.tool_calls:
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    fn = tools.get(tc.function.name)
                    result = fn(**args) if fn else {"error": "unknown tool"}
                    messages.append({"role": "tool", "tool_call_id": tc.id,
                                     "content": json.dumps(result, ensure_ascii=False)})
            return Response({"answer": "Sorry, I couldn't resolve that from the report."})
        except Exception:  # noqa: BLE001
            return Response({"error": "Could not generate an answer. Please try again."},
                            status=status.HTTP_502_BAD_GATEWAY)
