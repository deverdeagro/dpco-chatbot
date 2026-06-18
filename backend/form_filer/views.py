import json
import os
import subprocess
import threading

from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import IsAuthenticated

from .models import FormFiveJob

# Module-level map of job_id → running Popen process (dev server only)
_processes: dict[int, subprocess.Popen] = {}


def _run_job(job_id: int, excel_path: str) -> None:
    """Background thread: spawn the Node.js filer and stream its stdout into the DB."""
    from django.db import close_old_connections
    close_old_connections()

    job = FormFiveJob.objects.get(id=job_id)

    try:
        # Pass the same local LLM config the chatbot uses, so the filer can ask
        # it to disambiguate ambiguous product dropdown options.
        child_env = {
            **os.environ,
            'OLLAMA_BASE_URL': getattr(settings, 'OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
            'OLLAMA_MODEL': getattr(settings, 'OLLAMA_MODEL', 'llama3.2'),
        }

        proc = subprocess.Popen(
            ['node', str(settings.FORM_FILER_SCRIPT), excel_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=child_env,
        )
        _processes[job_id] = proc

        job.status = FormFiveJob.STATUS_RUNNING
        job.save(update_fields=['status'])

        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if not line:
                continue

            job.refresh_from_db()
            job.log = job.log + line + '\n'

            if line.startswith('[WAITING_FOR_SUBMIT:'):
                manufacturer = line[len('[WAITING_FOR_SUBMIT:'):-1]
                job.status = FormFiveJob.STATUS_WAITING_REVIEW
                job.current_group = manufacturer

            elif line.startswith('[FLAGGED_ROWS:'):
                try:
                    job.flagged_rows = json.loads(line[len('[FLAGGED_ROWS:'):])
                except json.JSONDecodeError:
                    pass

            elif '[DONE]' in line:
                job.status = FormFiveJob.STATUS_DONE

            job.save(update_fields=['log', 'status', 'current_group', 'flagged_rows'])

        proc.wait()
        _processes.pop(job_id, None)

        job.refresh_from_db()
        if job.status not in (FormFiveJob.STATUS_DONE, FormFiveJob.STATUS_WAITING_REVIEW):
            job.status = FormFiveJob.STATUS_DONE if proc.returncode == 0 else FormFiveJob.STATUS_FAILED
            job.save(update_fields=['status'])

    except Exception as exc:
        _processes.pop(job_id, None)
        try:
            job.refresh_from_db()
            job.status = FormFiveJob.STATUS_FAILED
            job.log = job.log + f'\nFATAL: {exc}\n'
            job.save(update_fields=['status', 'log'])
        except Exception:
            pass


class FormFiveJobCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        excel_file = request.FILES.get('excel_file')
        if not excel_file:
            return Response({'error': 'excel_file is required.'}, status=status.HTTP_400_BAD_REQUEST)
        if not excel_file.name.endswith('.xlsx'):
            return Response({'error': 'Only .xlsx files are accepted.'}, status=status.HTTP_400_BAD_REQUEST)

        job = FormFiveJob.objects.create(
            excel_file=excel_file,
            created_by=request.user,
        )

        thread = threading.Thread(
            target=_run_job,
            args=(job.id, job.excel_file.path),
            daemon=True,
        )
        thread.start()

        return Response({'id': job.id, 'status': job.status}, status=status.HTTP_201_CREATED)


class FormFiveJobDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            job = FormFiveJob.objects.get(pk=pk)
        except FormFiveJob.DoesNotExist:
            return Response({'error': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

        return Response({
            'id': job.id,
            'status': job.status,
            'current_group': job.current_group,
            'log': job.log,
            'flagged_rows': job.flagged_rows,
        })


class FormFiveJobContinueView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        try:
            job = FormFiveJob.objects.get(pk=pk)
        except FormFiveJob.DoesNotExist:
            return Response({'error': 'Not found.'}, status=status.HTTP_404_NOT_FOUND)

        if job.status != FormFiveJob.STATUS_WAITING_REVIEW:
            return Response({'error': 'Job is not waiting for review.'}, status=status.HTTP_400_BAD_REQUEST)

        proc = _processes.get(pk)
        if not proc or proc.poll() is not None:
            return Response({'error': 'Process is not running.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            proc.stdin.write('\n')
            proc.stdin.flush()
        except Exception as exc:
            return Response({'error': str(exc)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        job.status = FormFiveJob.STATUS_RUNNING
        job.save(update_fields=['status'])
        return Response({'ok': True})
