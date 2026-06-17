from django.db import models
from django.contrib.auth.models import User


class FormFiveJob(models.Model):
    STATUS_PENDING        = 'pending'
    STATUS_RUNNING        = 'running'
    STATUS_WAITING_REVIEW = 'waiting_review'
    STATUS_DONE           = 'done'
    STATUS_FAILED         = 'failed'

    STATUS_CHOICES = [
        (STATUS_PENDING,        'Pending'),
        (STATUS_RUNNING,        'Running'),
        (STATUS_WAITING_REVIEW, 'Waiting for Review'),
        (STATUS_DONE,           'Done'),
        (STATUS_FAILED,         'Failed'),
    ]

    excel_file    = models.FileField(upload_to='form5_uploads/')
    status        = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)
    current_group = models.CharField(max_length=255, blank=True, default='')
    log           = models.TextField(default='')
    flagged_rows  = models.JSONField(null=True, blank=True)
    created_by    = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    created_at    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
